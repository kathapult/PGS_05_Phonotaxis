#version 300 es
precision highp float;
precision highp sampler2D; 

// -----------------------------------------------------------------------
// Declarations
// -----------------------------------------------------------------------
// input from js
uniform vec2 u_resolution;
uniform vec2 u_rings[4];
uniform float u_slowSource;
uniform float u_loudness;
uniform float u_waveTime;
uniform float u_time;        
uniform sampler2D u_seeds;   
uniform int u_texWidth;      
uniform int u_seedCount;     
uniform int u_seedOffset;    
uniform float u_minSeedSize; 
uniform float u_flow;        

// output
out vec2 v_local;       
out vec2 v_corner;      
out vec4 v_timbre;      
out float v_ring;
out vec2 v_seed;        

#define TAU 6.28318530718 // TAU = 2π = full turn

// variables + parameters
const float FILL = 1.0; // screen size of flower
const float BUILDUP_SEEDS = 500.0; // Initial scale = 500 seeds

// seeds
const float SEED_SIZE = 0.6;
const float GROW_TIME = 1.5;

// sine function for wave displacement
const float SINE_LOBES = 3.0;
const float SINE_LOBES_SECOND = 8.0;
const float RING_SPEED = 12.0;
const float RING_WIDTH = 1.5;
const float RANDOM_STRENGTH = 0.5;

const float QUAD_SIZE = 3.0;    

// JS seed texture -> vec4
vec4 fetchData(int i) {
    return texelFetch(u_seeds, ivec2(i % u_texWidth, i / u_texWidth), 0); // RGBA = loudness, brightness, noise, birth
}

// -----------------------------------------------------------------------
// Blossom displacement functions
// -----------------------------------------------------------------------
// Smooth randomness -> wave variation
float softRandom(float x) {
    float i = floor(x);
    float t = smoothstep(0.0, 1.0, fract(x));
    float a = fract(sin(i * 127.1) * 43758.5453);
    float b = fract(sin((i + 1.0) * 127.1) * 43758.5453);
    return 2.0 * mix(a, b, t) - 1.0;
}

// Triangle wave -> sharper displacement
float triangleWave(float phase) {
    return 1.0 - 4.0 * abs(fract(phase / TAU + 0.25) - 0.5);
}

// -----------------------------------------------------------------------
// MAIN FUNCTION
// -----------------------------------------------------------------------
void main() {

    // seeds + corners
    int n = u_seedOffset + gl_InstanceID;  // Global seed index
    int k = u_seedCount - 1 - n;    // Seeds added after n
    
    vec2 corners[6] = vec2[](                                 // Seed quad = 2 triangles
        vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
        vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
    );

    vec2 corner = corners[gl_VertexID]; // 6 vertex calls/seed -> one per triangle vertex

    // get sound data
    int slot = gl_InstanceID;
    vec4 seed = fetchData(slot * 3);
    vec4 seed2 = fetchData(slot * 3 + 1);
    vec4 seed3 = fetchData(slot * 3 + 2);
    float sourceValue = seed3.g; // selected source at seed birth

    float loudness   = seed.r;
    float birth      = seed.a;
    float seedTurns  = seed2.r; 

    // aspect + full-bloom view
    float aspect = u_resolution.x / u_resolution.y;
    float age = max(float(k) - u_flow, 0.0);
    float viewRadius = 0.5 * aspect * FILL;
    float visibleCount = BUILDUP_SEEDS;
    float quadMargin = QUAD_SIZE * sqrt(2.0);
    float pixelMargin = quadMargin * u_minSeedSize;
    float spacing = max(viewRadius - pixelMargin, 0.000001)
                  / (sqrt(visibleCount) + quadMargin * SEED_SIZE);
    // Full bloom -> fit within initial view
    float fullRadius = 0.475 * min(aspect, 1.0);
    float fullSpacing = max(fullRadius - pixelMargin, 0.000001)
                      / (sqrt(max(float(u_seedCount - 1), 1.0)) + quadMargin * SEED_SIZE);
    
    spacing = min(spacing, fullSpacing); // Full bloom -> always visible

    // ---------------------------------------------------------------------
    // Vogel formula -> position + modulation A-B
    float theta = TAU * seedTurns;

    vec2 outward = vec2(cos(theta), sin(theta));
    float travelTime = mix(5.0, 1.0, loudness);
    float travel = smoothstep(birth, birth + travelTime, u_time);
    //----------------------------------------------------------------------

    
    // Quiet audio -> relaxed bloom
    // Live loudness = smoothed per frame
    float deformation = smoothstep(0.0, 1.0, clamp(u_loudness, 0.0, 1.0));

    // Spiral bands + random field
    float randomOffset = RANDOM_STRENGTH * seed.b * deformation
                       * softRandom(dot(outward, vec2(2.0, 3.0)) + u_time * 0.15);
    float radialPhase = mix(0.2, 0.5, u_slowSource) * sqrt(age);
    float phaseOffset = radialPhase + randomOffset - u_waveTime;

    // Symmetry = 3 + 8 lobes
    float phaseA = SINE_LOBES * theta + phaseOffset;
    float phaseB = SINE_LOBES_SECOND * theta + phaseOffset;
    float sine = mix(sin(phaseA), sin(phaseB), u_slowSource);
    float triangle = mix(triangleWave(phaseA), triangleWave(phaseB), u_slowSource);

    // Sine + triangle
    float baseWave = mix(sine, triangle, u_slowSource * deformation);

    // Brightness -> wave exponent
    float hill = 0.5 + 0.5 * baseWave;
    float exponent = mix(1.0, 4.0, seed.g * deformation);
    float wave = 2.0 * pow(hill, exponent) - 1.0;

    // Stored source × slow live source
    float seedAmplitude = mix(0.06, 0.10, sourceValue);
    float amplitude = seedAmplitude * mix(0.8, 1.0, u_slowSource) * deformation;
    float radialFactor = 1.0 + amplitude * wave;
    vec2 pos = spacing * sqrt(age) * travel * radialFactor * outward;

    
    // Traveling beat rings
    float ringLight = 0.0;
    float seedRadius = sqrt(age) * travel * radialFactor;
    for (int i = 0; i < 4; i++) {
        float beatAge = max(u_time - u_rings[i].x, 0.0);
        float distanceToRing = seedRadius - RING_SPEED * beatAge;
        ringLight += u_rings[i].y * exp(-pow(distanceToRing / RING_WIDTH, 2.0))
                   * exp(-0.5 * beatAge);
    }
    v_ring = clamp(ringLight, 0.0, 1.0);

    // Size | Modulation C
    float grow = smoothstep(birth, birth + GROW_TIME, u_time);

    float naturalSize = spacing * SEED_SIZE * mix(0.3, 1.0, loudness);
    float size = max(naturalSize, u_minSeedSize) * grow;

    // Orientation | Modulation D
    vec2 sideways = vec2(-outward.y, outward.x);
    vec2 local = corner * QUAD_SIZE;                                    
    vec2 p = pos + (local.x * outward + local.y * sideways) * size;

    // Output
    gl_Position = vec4(p.x * 2.0 / aspect, p.y * 2.0, 0.0, 1.0);

    v_local = local;
    v_corner = corner;
    v_seed = vec2(seed.g, sourceValue); // brightness + palette shift 
    v_timbre = vec4(seed2.gba, seed3.r);
}
