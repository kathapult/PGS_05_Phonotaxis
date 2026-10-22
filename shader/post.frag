#version 300 es

precision highp float;
precision highp sampler2D;

// Inputs
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_loudness;

out vec4 fragColor;

// Parameters
const vec3 HAZE_COLOR = vec3(0.015, 0.045, 0.05);
const float HAZE_PULSE = 1.5;

void main() {

    // Coordinates
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float r = length(uv);

    // Image sampling | Modulation H
    vec3 col = texelFetch(u_image, ivec2(gl_FragCoord.xy), 0).rgb;

    // Haze | Modulation I
    col += HAZE_COLOR * (1.0 + HAZE_PULSE * u_loudness) * exp(-r * 3.0);

    // Tone mapping
    col = 1.0 - exp(-col);

    fragColor = vec4(col, 1.0);
}
