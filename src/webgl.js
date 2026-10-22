// webgl.js | GPU setup + rendering helpers for sketch.js

// ============================================================
// 1. WEBGL SETUP + SHADER PROGRAMS
// ============================================================

const FULLSCREEN_VERTEX_SHADER = `#version 300 es // Fullscreen triangle -> post.frag
void main() {
    vec2 corners[3] = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}`;

let canRenderFloat = false; // Float target -> light > 1 -> tone mapping

function initWebGL(canvas) { // WebGL2 -> check float targets
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }); // Preserve canvas -> image capture
  if (!gl) {
    showError('This browser does not support WebGL2.');
    return null;
  }
  canRenderFloat = gl.getExtension('EXT_color_buffer_float') !== null;

  canvas.addEventListener('webglcontextlost', () => { // Context lost -> error
    showError('GPU overloaded. Reduce QUAD_SIZE in shader/seed.vert and reload.');
  });
  return gl;
}

function createShader(gl, vertexSource, fragmentSource, vertexName, fragmentName) { // Vertex + fragment -> compile + link
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, vertexName);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, fragmentName);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    showError('Error linking ' + vertexName + ' and ' + fragmentName + ':\n' + gl.getProgramInfoLog(program)); // Mismatched shader I/O -> link error
    return null;
  }
  return { gl, program };
}

function compile(gl, type, source, fileName) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    showError('Error in ' + fileName + ':\n' + gl.getShaderInfoLog(shader)); // Compiler line numbers = shader source lines
    return null;
  }
  return shader;
}


// ============================================================
// 2. UNIFORMS: JS -> GLSL
// ============================================================
function setFloat(shader, name, value) { // Name = GLSL uniform; missing/unused -> ignored
  const { gl, program } = shader;
  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, name), value);
}

function setInt(shader, name, value) {
  const { gl, program } = shader;
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, name), value);
}

function setVec2(shader, name, x, y) {
  const { gl, program } = shader;
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, name), x, y);
}


// ============================================================
// 3. SEED DATA TEXTURE
// ============================================================
function createSeedTexture(gl, width, height) { // Float32Array -> RGBA32F -> fetchData(); seed = 3 texels
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

function updateSeedTexture(gl, texture, data, width, firstRow, rows) { // Changed seeds -> upload affected rows
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, firstRow, width, rows, gl.RGBA, gl.FLOAT,
    data.subarray(firstRow * width * 4, (firstRow + rows) * width * 4));
}


// ============================================================
// 4. INTERMEDIATE IMAGE
// ============================================================
function createRenderTarget(gl) { // Seed light -> target -> u_image
  return { framebuffer: gl.createFramebuffer(), texture: gl.createTexture(), width: 0, height: 0, useFloat: canRenderFloat };
}

function resizeRenderTarget(gl, target, w, h) { // Size change -> reallocate; float unsupported -> RGBA8
  if (target.width === w && target.height === h) return;
  target.width = w;
  target.height = h;

  gl.bindTexture(gl.TEXTURE_2D, target.texture);
  if (target.useFloat) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}


// ============================================================
// 5. DRAW CALLS
// ============================================================

function resizeCanvas(gl, pixelRatio) { // Render size = CSS size × pixel ratio
  const canvas = gl.canvas;
  const w = Math.round(canvas.clientWidth * pixelRatio);
  const h = Math.round(canvas.clientHeight * pixelRatio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function drawSeeds(shader, target, seedTexture, count, clear = true) { // Pass 1: seed texture -> instanced quads -> target
  const { gl, program } = shader;

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, target.width, target.height);
  if (clear) {
    gl.clearColor(0, 0, 0, 1); // black background
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, seedTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_seeds'), 0);

  gl.enable(gl.BLEND); // Overlapping seeds -> added light
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count); // Seed = 6 vertices = 2 triangles; instances = count
  gl.disable(gl.BLEND);
}

function drawPost(shader, target) { // Pass 2: target -> post.frag -> canvas
  const { gl, program } = shader;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, target.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 1);
  gl.activeTexture(gl.TEXTURE0); // restore the seed data texture unit

  gl.drawArrays(gl.TRIANGLES, 0, 3); // 3 vertices = fullscreen triangle
}


// ============================================================
// ERROR DISPLAY
// ============================================================
function showError(message) { // Error -> page + console
  document.getElementById('error').textContent = message;
  console.error(message);
}
