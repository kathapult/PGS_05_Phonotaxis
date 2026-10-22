#version 300 es

precision highp float;

// Inputs
in vec2 v_local;        
in vec2 v_corner;       
in vec4 v_timbre;       
in float v_ring;
in vec2 v_seed;         

out vec4 fragColor;

// Parameters

const float BRIGHTNESS_LIGHT_MIN = 0.25; 
const float BRIGHTNESS_LIGHT_MAX = 1.0;  
const float RING_LIGHT = 0.6;
const float CORE = 0.9;           
const float GLOW_STRENGTH = 0.55; 
const float GLOW_RADIUS = 0.5;    

const vec4 TIMBRE_WEIGHTS = vec4(0.5, 0.25, 0.15, 0.1);
const float GRADIENT_MIN = 0.15;
const float GRADIENT_MAX = 0.85;
const float COLOR_SHIFT_STRENGTH = 0.18;

// Color control | Modulation F
vec2 colorControl() {
    float timbre = dot(v_timbre, TIMBRE_WEIGHTS);
    float gradient = smoothstep(GRADIENT_MIN, GRADIENT_MAX, timbre);
    return vec2(gradient, v_seed.y); 
}

// Palette
vec3 palette(float t, float sourceShift) {
    vec3 deepPetrol = vec3(0.025, 0.22, 0.26);
    vec3 petrol = vec3(0.045, 0.40, 0.42);
    vec3 seaGlass = vec3(0.28, 0.62, 0.56);
    vec3 copper = vec3(0.95, 0.22, 0.055);

    float shade = clamp(t + COLOR_SHIFT_STRENGTH * sourceShift, 0.0, 1.0);
    vec3 color = mix(deepPetrol, petrol, smoothstep(0.0, 0.6, shade));
    color = mix(color, seaGlass, smoothstep(0.5, 1.0, shade));
    float accent = smoothstep(0.6, 0.85, shade);
    return mix(color, copper, accent);
}

void main() {
    float brightness = v_seed.x;

    // Shape | Modulation E
    float d = length(v_local);

    // Light | Modulation G
    float core = 1.0 - smoothstep(0.5, 1.0, d);   
    float glow = exp(-d / GLOW_RADIUS);           

    // Color + brightness
    vec2 controls = colorControl();
    vec3 color = max(palette(controls.x, controls.y), vec3(0.0));
    float paletteLuminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color /= max(paletteLuminance, 0.0001);

    float colorLight = mix(BRIGHTNESS_LIGHT_MIN, BRIGHTNESS_LIGHT_MAX,
                           clamp(brightness, 0.0, 1.0));

    // Edge + output
    float edge = 1.0 - smoothstep(0.8, 1.0, length(v_corner));

    vec3 light = color * colorLight * (CORE * core + GLOW_STRENGTH * glow) * edge;
    light *= 1.0 + RING_LIGHT * v_ring;
    fragColor = vec4(light, 1.0);
}
