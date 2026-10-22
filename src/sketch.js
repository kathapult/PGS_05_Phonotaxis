// sketch.js | sound -> seeds -> shaders

// ============================================================
// 1. SETTINGS
// ============================================================

// Seeds + growth
const SEEDS_PER_BATCH = 20000; // Batch full -> new texture; keep older seeds
const MIN_SEED_RADIUS_PX = 1.5; // Min. grown core radius = CSS pixels
const TRACK_SILENCE_RATIO = 0.01; // Silence threshold = upper RMS × ratio
const GROWTH_MIN = 8; // seeds/s at low volume, tempo 1x
const GROWTH_MAX = 35; // seeds/s at high volume, tempo 1x
const BEAT_THRESHOLD = 0.3; // minimum normalized onset strength
const BEAT_MIN_GAP = 0.12; // seconds between accepted beats

// Audio smoothing
let audioSmoothingSeconds = 1.0; // Slider -> smoothing; 0 = immediate

// Angle source
const ANGLE_AUDIO_SOURCE = 'perceptualSpread'; // Default source -> buttons override
const EXTRA_LOW_PERCENTILE = 0.05;
const EXTRA_HIGH_PERCENTILE = 0.95;
const GOLDEN_ANGLE_DEG = 137.508; // rounded golden angle in degrees
const ANGLE_SLIDER_MIN = 90;
const ANGLE_SLIDER_MAX = GOLDEN_ANGLE_DEG;
let baseAngle = 90; // Initial value -> slider overrides
let angleRange = GOLDEN_ANGLE_DEG - baseAngle;

// Live motion
const FLOW_SPEED = 0.15; // outward motion; lower = slower
let seedSpeed = 2; // Slider -> visual tempo; audio speed = fixed

// Normalization: calibrated track ranges + percentiles
const LOUDNESS_LOW_PERCENTILE = 0.03; // lower calibrated RMS limit
const LOUDNESS_HIGH_PERCENTILE = 0.97; // upper calibrated RMS limit
let loudnessMin = 0;
let loudnessMax = 1; // Calibration -> playback range
const BRIGHTNESS_LOW_PERCENTILE = 0.1; // Smoothed values -> trim bottom 10%
const BRIGHTNESS_HIGH_PERCENTILE = 0.9; // Smoothed values -> trim top 10%
let brightnessMinHz = 0;
let brightnessMaxHz = 1; // Calibration -> playback range
let calibratedTrackBuffer = null; // Decoded buffer = analysis + playback
let calibratedTrackRanges = null;
let trackAnalysisRunning = false;
const NOISE_MAX = 0.5; // Stored noise = flatness / reference
const ONSET_MAX = 1.0; // onset strength reference
const ONSET_THRESHOLD = 0.01; // ignore small spectrum changes

// Render resolution
const MAX_RENDER_WIDTH = 1920; // maximum render width in pixels
const AUTO_MIN = 1; // 1 = keep full target resolution
const SLOW_FRAME_MS = 24; // Slower frame -> lower resolution
const FAST_FRAME_MS = 18; // Faster frame -> restore resolution

// Analysis window
const BUFFER_SIZE = 1024; // Samples/window = power of two


// ============================================================
// 2. ANGLE CONTROLS
// ============================================================
function angleControl(frame) { // Source -> 0..1; 0 = baseAngle; 1 = golden angle
  return getAngleSourceValue(selectedAngleSource, frame);
}

const ANGLE_SOURCES = [ // MFCC labels = 1-based; indices = 0-based
  { key: 'perceptualSpread', label: 'Perceptual Spread' },
  { key: 'sharpness', label: 'Perceptual Sharpness' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'onset', label: 'Beat / Onset' },
  ...[[1, 'Log level'], [3, 'Broad shape'], [8, 'Detail'], [13, 'Fine detail']].map(([number, description]) => ({
    key: 'mfcc:' + (number - 1), label: 'MFCC ' + number + ' · ' + description,
  })),
];
const EXTRA_SCALAR_KEYS = ['perceptualSpread', 'sharpness'];
const AUDIO_FEATURE_EXTRACTORS = [ // Calibration features = live features
  'rms', 'spectralCentroid', 'spectralFlatness', 'amplitudeSpectrum',
  'perceptualSpread', 'perceptualSharpness', 'mfcc',
];
let selectedAngleSource = ANGLE_AUDIO_SOURCE;

function getAngleSourceValue(key, frame = measured) {
  if (['brightness', 'onset'].includes(key)) return clamp01(frame[key]);
  if (key.startsWith('mfcc:')) return normalizedAudioFeatures.mfcc[Number(key.split(':')[1])];
  return normalizedAudioFeatures[key] ?? 0;
}

function selectAngleSource(key) {
  if (!ANGLE_SOURCES.some(source => source.key === key)) return;
  selectedAngleSource = key;
  currentAngleValue = clamp01(angleControl(measured));
  angleMax = currentAngleValue; // discard the previous source peak
  for (const button of angleSourceButtons.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.source === key));
  }
  updateAudioDisplay();
}

let currentAngleValue = 0;


// ============================================================
// 3. SEED STORAGE -> GPU DATA TEXTURE
// ============================================================
const PIXELS_PER_SEED = 3; // Seed = 3 RGBA texels -> fetchData()
const VALUES_PER_SEED = PIXELS_PER_SEED * 4;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = Math.ceil((SEEDS_PER_BATCH * PIXELS_PER_SEED) / TEXTURE_WIDTH);
const seedBatches = [];

let seedCount = 0;
let seedTurns = 0; // accumulated angle in turns, 0..1
let flow = 0; // radial growth lag -> u_flow in seed.vert

function addSeed(loudness, brightness, noise, angleValue, mfcc) { // Sound + angle -> seed; full batch -> new batch
  const slot = seedCount % SEEDS_PER_BATCH;
  if (slot === 0) {
    seedBatches.push({
      data: new Float32Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4),
      texture: createSeedTexture(gl, TEXTURE_WIDTH, TEXTURE_HEIGHT),
      count: 0,
      uploadedCount: 0,
    });
  }
  const batch = seedBatches[seedBatches.length - 1];
  const extraDegrees = angleValue * angleRange;
  const stepDegrees = baseAngle + extraDegrees;
  seedTurns = (seedTurns + stepDegrees / 360) % 1; // Stored angle = fixed; controls -> new seeds
  batch.data.set( // Texel 2 = turns, MFCC 2..4
    [loudness, brightness, noise, now(), seedTurns, // Texel 1 = loudness, brightness, noise, birth
     mfcc[1], mfcc[2], mfcc[3], mfcc[4], angleValue, 0, 0], // Texel 3 = MFCC 5, source, 0, 0
    slot * VALUES_PER_SEED
  );
  batch.count++;
  seedCount++;
  flow += 1;
}

function clearSeeds() {
  for (const batch of seedBatches) gl.deleteTexture(batch.texture);
  seedBatches.length = 0;
  seedCount = 0;
  seedTurns = 0;
  flow = 0;
  currentAngleValue = 0;
}


// ============================================================
// 4. AUDIO ANALYSIS
// ============================================================
let audioContext = null; // Track -> Meyda -> normalized features -> seeds + uniforms
let analyzer = null; // active Meyda analyzer
let stopPlayback = null; // stop and disconnect the current track
let isPlaying = false;
let playbackGeneration = 0; // cancel stale async playback starts

let smoothedBrightnessHz = 0; // Raw -> smooth -> normalize; live + calibration
let smoothedLoudnessRms = 0;

const measured = { loudness: 0, // Latest audio values = normalized
                   brightness: 0,
                   noise: 0, 
                   onset: 0 
                  };

const smoothedExtraFeatures = { // Smoothed raw features -> normalization input
  perceptualSpread: 0, sharpness: 0,
  mfcc: new Float32Array(13),
};
const normalizedAudioFeatures = {
  perceptualSpread: 0, sharpness: 0,
  mfcc: new Float32Array(13),
};
let extraFeatureRanges = null;

function extraFeatureValues(features) {
  return {
    perceptualSpread: features.perceptualSpread,
    sharpness: features.perceptualSharpness,
    mfcc: features.mfcc,
  };
}

function normalizeExtraFeature(value, range) {
  return clamp01((value - range.min) / Math.max(range.max - range.min, 0.000001));
}

function updateNormalizedExtraFeatures(features, frameMs) {
  const raw = extraFeatureValues(features);
  for (const key of EXTRA_SCALAR_KEYS) {
    smoothedExtraFeatures[key] = smoothAudio(smoothedExtraFeatures[key], raw[key], frameMs);
    const range = extraFeatureRanges[key];
    normalizedAudioFeatures[key] = normalizeExtraFeature(smoothedExtraFeatures[key], range);
  }
  for (let i = 0; i < smoothedExtraFeatures.mfcc.length; i++) {
    smoothedExtraFeatures.mfcc[i] = smoothAudio(smoothedExtraFeatures.mfcc[i], raw.mfcc?.[i], frameMs);
    const range = extraFeatureRanges.mfcc[i];
    normalizedAudioFeatures.mfcc[i] = normalizeExtraFeature(smoothedExtraFeatures.mfcc[i], range);
  }
}

function resetNormalizedExtraFeatures() {
  for (const state of [smoothedExtraFeatures, normalizedAudioFeatures]) {
    for (const key of Object.keys(state)) {
      if (ArrayBuffer.isView(state[key])) state[key].fill(0);
      else state[key] = 0;
    }
  }
}

function extraFeatureRange(values) {
  values.sort((a, b) => a - b);
  const min = percentile(values, EXTRA_LOW_PERCENTILE);
  const max = Math.max(percentile(values, EXTRA_HIGH_PERCENTILE), min + 0.000001);
  return { min, max };
}

const live = { loudness: 0 }; // Live loudness -> deformation + haze

let slowSource = 0.5;
let waveTime = 0;

function updateWaveMotion(frameMs) { // Live source -> waves; stored source -> shape + color
  const dt = Math.min(frameMs / 1000, 0.1);
  const target = isPlaying ? currentAngleValue : 0.5;
  slowSource = smoothAudio(slowSource, target, dt * 1000);
  waveTime += dt * (0.8 + 0.4 * slowSource);
}


// Rhythm + seed growth state
let audioTime = 0;
let lastBeatTime = -Infinity;
const beatRings = [];
let onsetWasHigh = false;
let growthRate = GROWTH_MIN;
let hasSound = false;
let seedCredit = 0; // save fractional seeds between frames
let angleMax = 0;

function resetRhythm() {
  audioTime = 0;
  lastBeatTime = -Infinity;
  beatRings.length = 0;
  onsetWasHigh = false;
  growthRate = GROWTH_MIN;
  hasSound = false;
  seedCredit = 0;
  angleMax = 0;
  previousSpectrum = null;
  fluxAverage = 0;
}

function silenceThreshold() { // Silence threshold = calibrated upper RMS × ratio
  return Math.max(0.000001, loudnessMax * TRACK_SILENCE_RATIO);
}

function updateRhythm(onset, rms, frameMs) { // Onsets -> 4 rings max; loudness -> growth rate
  audioTime += frameMs / 1000;
  hasSound = rms >= silenceThreshold();

  if (hasSound && onset >= BEAT_THRESHOLD && !onsetWasHigh) { // Threshold crossing + min. gap -> beat
    if (audioTime - lastBeatTime >= BEAT_MIN_GAP) {
      lastBeatTime = audioTime;
      beatRings.push({ time: now(), strength: onset });
      if (beatRings.length > 4) beatRings.shift();
    }
    onsetWasHigh = true;
  }
  if (!hasSound || onset < BEAT_THRESHOLD * 0.5) onsetWasHigh = false;

  const targetRate = GROWTH_MIN + (GROWTH_MAX - GROWTH_MIN) * measured.loudness; // Smoothed loudness -> growth rate; tempo -> growSeeds()
  growthRate = smoothAudio(growthRate, targetRate, frameMs);
}

function growSeeds(frameMs) { // Frame -> seed credit -> addSeed()
  if (!hasSound || !isPlaying) {
    seedCredit = 0;
    angleMax = currentAngleValue;
    return;
  }
  seedCredit += growthRate * seedSpeed * Math.min(frameMs, 100) / 1000;
  while (seedCredit >= 1) {
    addSeed(measured.loudness, measured.brightness, measured.noise,
            angleMax, normalizedAudioFeatures.mfcc);
    angleMax = currentAngleValue;
    seedCredit -= 1;
  }
}

function onAudioFrame(features) { // Meyda -> smooth -> normalize -> angle + rhythm + UI
  const rms = features.rms || 0; // Missing raw feature -> 0
  const centroidHz = ((features.spectralCentroid || 0) * audioContext.sampleRate) / BUFFER_SIZE;
  const flatness = features.spectralFlatness || 0;

  const frameMs = BUFFER_SIZE / audioContext.sampleRate * 1000; // Raw -> smooth -> calibrated range -> 0..1
  smoothedLoudnessRms = smoothAudio(smoothedLoudnessRms, rms, frameMs);
  measured.loudness = clamp01((smoothedLoudnessRms - loudnessMin) / (loudnessMax - loudnessMin));

  smoothedBrightnessHz = smoothAudio(smoothedBrightnessHz, centroidHz, frameMs);
  measured.brightness = clamp01(
    (smoothedBrightnessHz - brightnessMinHz) / (brightnessMaxHz - brightnessMinHz)
  );

  measured.noise = smoothAudio(measured.noise, clamp01(flatness / NOISE_MAX), frameMs);
  const onset = measureOnset(features.amplitudeSpectrum, rms); // Raw onset -> beat detection
  measured.onset = smoothAudio(measured.onset, onset, frameMs); // Smoothed onset -> angle + appearance
  updateNormalizedExtraFeatures(features, frameMs);
  currentAngleValue = clamp01(angleControl(measured)); // Peak source -> next seed angle
  angleMax = Math.max(angleMax, currentAngleValue);
  updateRhythm(onset, rms, frameMs);
  if (!hasSound) angleMax = currentAngleValue;
  updateAudioDisplay();
}


let previousSpectrum = null; // Onset = positive spectral flux - baseline
let fluxAverage = 0;

function measureOnset(spectrum, rms) {
  if (!spectrum || rms < silenceThreshold()) { // Silence -> reset onset history
    previousSpectrum = null;
    return 0;
  }
  let flux = 0; // sum of positive spectrum changes
  let total = 0; // total spectrum amplitude
  for (let i = 0; i < spectrum.length; i++) {
    const rise = spectrum[i] - (previousSpectrum ? previousSpectrum[i] : 0);
    if (rise > 0) flux += rise;
    total += spectrum[i];
  }
  previousSpectrum = Float32Array.from(spectrum); // copy for the next analysis window
  flux /= total + 1e-6; // normalize by total amplitude

  const onset = flux - fluxAverage - ONSET_THRESHOLD;
  fluxAverage += (flux - fluxAverage) * 0.1; // moving baseline for onset detection
  return clamp01(onset / ONSET_MAX);
}


// ============================================================
// 5. AUDIO INPUT
// ============================================================
function startAnalysis(source) { // Track -> Web Audio -> Meyda callback
  analyzer = Meyda.createMeydaAnalyzer({ // source + features + callback
  
    audioContext: audioContext,  
    source: source,
    bufferSize: BUFFER_SIZE,

    featureExtractors: AUDIO_FEATURE_EXTRACTORS,
    
    numberOfMFCCCoefficients: 13,
    callback: onAudioFrame,
  });
  analyzer.start();
}

async function startCalibratedTrack() { // Playback buffer = calibration buffer
  if (!calibratedTrackBuffer || !calibratedTrackRanges) return;
  stop();
  const generation = playbackGeneration;
  setAudioRanges(calibratedTrackRanges.min, calibratedTrackRanges.max, calibratedTrackRanges.loudness.min, calibratedTrackRanges.loudness.max, calibratedTrackRanges.extra);
  clearSeeds();
  await audioContext.resume();
  if (generation !== playbackGeneration) return;

  const source = audioContext.createBufferSource();
  let playbackStarted = false;
  source.buffer = calibratedTrackBuffer;
  source.connect(audioContext.destination); // track playback through speakers

  stopPlayback = () => {
    source.onended = null;
    if (playbackStarted) source.stop();
    source.disconnect();
  };
  source.onended = () => {
    if (generation === playbackGeneration) stop();
  };
  try {
    startAnalysis(source);
    isPlaying = true;
    source.start();
    playbackStarted = true;
  } catch (err) {
    stop();
    throw err;
  }
}

// ============================================================
// 6. TRACK CALIBRATION
// ============================================================
function setAudioRanges(minHz, maxHz, minRms, maxRms, extraRanges) { // Calibrated ranges -> playback normalization (0..1)
  extraFeatureRanges = extraRanges;
  resetNormalizedExtraFeatures();
  loudnessMin = minRms;
  loudnessMax = maxRms;
  brightnessMinHz = minHz;
  brightnessMaxHz = maxHz;
  smoothedBrightnessHz = 0;
  smoothedLoudnessRms = 0;
  measured.brightness = 0;
  measured.loudness = live.loudness = 0;
  resetRhythm();
  currentAngleValue = 0;
  updateAudioDisplay();
}

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

async function analyzeTrackBuffer(buffer, progress = () => {}) { // Live settings = channel 0 + window size + sample rate
  const samples = buffer.getChannelData(0);
  const extractor = Object.assign({}, Meyda, { bufferSize: BUFFER_SIZE, sampleRate: buffer.sampleRate });
  const values = [];
  const rmsValues = [];
  let smoothedHz = 0;
  let smoothedRms = 0;
  const extraValues = { ...Object.fromEntries(EXTRA_SCALAR_KEYS.map(key => [key, []])),
    mfcc: Array.from({ length: 13 }, () => []) };
  const extraSmoothed = { perceptualSpread: 0, sharpness: 0,
    mfcc: new Float32Array(13) };
  const frameMs = BUFFER_SIZE / buffer.sampleRate * 1000;
  const frame = new Float32Array(BUFFER_SIZE);
  const count = Math.ceil(samples.length / BUFFER_SIZE);
  for (let i = 0; i < count; i++) {
    frame.fill(0);
    frame.set(samples.subarray(i * BUFFER_SIZE, (i + 1) * BUFFER_SIZE));
    const features = extractor.extract(AUDIO_FEATURE_EXTRACTORS, frame);
    const hz = features.spectralCentroid * buffer.sampleRate / BUFFER_SIZE;
    smoothedHz = smoothAudio(smoothedHz, hz, frameMs); // Include silence; invalid centroid -> 0 Hz
    values.push(smoothedHz);
    smoothedRms = smoothAudio(smoothedRms, features.rms, frameMs);
    rmsValues.push(smoothedRms);
    const extraRaw = extraFeatureValues(features);
    for (const key of EXTRA_SCALAR_KEYS) {
      extraSmoothed[key] = smoothAudio(extraSmoothed[key], extraRaw[key], frameMs);
      extraValues[key].push(extraSmoothed[key]);
    }
    for (let j = 0; j < extraSmoothed.mfcc.length; j++) {
      extraSmoothed.mfcc[j] = smoothAudio(extraSmoothed.mfcc[j], extraRaw.mfcc?.[j], frameMs);
      extraValues.mfcc[j].push(extraSmoothed.mfcc[j]);
    }
    if (i % 256 === 0) {
      progress(Math.round(i / count * 100));
      await new Promise(resolve => setTimeout(resolve, 0)); // Yield -> responsive UI
    }
  }
  if (!values.length) throw new Error('The audio file contains no samples.');
  values.sort((a, b) => a - b);
  let min = percentile(values, BRIGHTNESS_LOW_PERCENTILE);
  let max = percentile(values, BRIGHTNESS_HIGH_PERCENTILE);
  if (max - min < 50) { // Near-constant signal -> min. 50 Hz span
    const center = (min + max) / 2;
    min = Math.max(0, center - 25);
    max = min + 50;
  }
  rmsValues.sort((a, b) => a - b);
  let minRms = percentile(rmsValues, LOUDNESS_LOW_PERCENTILE);
  let maxRms = percentile(rmsValues, LOUDNESS_HIGH_PERCENTILE);
  if (maxRms - minRms < 0.005) { // Quiet/constant track -> min. RMS span
    const center = (minRms + maxRms) / 2;
    minRms = Math.max(0, center - 0.0025);
    maxRms = minRms + 0.005;
  }
  const extra = {
    ...Object.fromEntries(EXTRA_SCALAR_KEYS.map(key => [key, extraFeatureRange(extraValues[key])])),
    mfcc: extraValues.mfcc.map(extraFeatureRange),
  };
  return { min, max, extra,
    loudness: { min: minRms, max: maxRms } };

}

async function calibrateTrack(file) { // Decode -> calibrate -> enable playback
  if (trackAnalysisRunning) return;
  trackAnalysisRunning = true;
  stop();
  analyzeTrackButton.disabled = calibratedPlayButton.disabled = true;
  trackAnalysisInput.disabled = true;
  smoothingSlider.disabled = true; // Calibration -> lock smoothing
  try {
    document.getElementById('error').textContent = '';
    analyzeTrackButton.textContent = 'Loading audio…';
    audioContext = audioContext || new AudioContext();
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const result = await analyzeTrackBuffer(buffer, percent => {
      analyzeTrackButton.textContent = 'Analyzing: ' + percent + ' %';
    });
    calibratedTrackBuffer = buffer;
    calibratedTrackRanges = result;
    setAudioRanges(result.min, result.max, result.loudness.min, result.loudness.max, result.extra);
    trackTitle.textContent = file.name.replace(/\.[^.]+$/, '') || file.name;
  } catch (err) {
    showError('Audio analysis failed: ' + err.message);
  } finally {
    analyzeTrackButton.textContent = 'Analyze track';
    trackAnalysisRunning = false;
    analyzeTrackButton.disabled = trackAnalysisInput.disabled = false;
    smoothingSlider.disabled = false;
    calibratedPlayButton.disabled = !calibratedTrackBuffer;
    trackAnalysisInput.value = ''; // Reset -> same file selectable
  }
}

function stop() { // Stop -> reset live state; keep seeds
  playbackGeneration++;
  if (analyzer) {
    analyzer.stop();
    analyzer._m.source.disconnect(analyzer._m.spn); // Meyda.stop() = callbacks only -> disconnect processor
    analyzer._m.spn.disconnect();
    analyzer._m.spn.onaudioprocess = null;
  }
  if (stopPlayback) stopPlayback();
  analyzer = null;
  stopPlayback = null;
  isPlaying = false;
  smoothedBrightnessHz = 0;
  smoothedLoudnessRms = 0;
  measured.loudness = measured.brightness = measured.noise = measured.onset = 0;
  resetNormalizedExtraFeatures();
  currentAngleValue = 0;
  resetRhythm();
  updateAudioDisplay();
}


// ============================================================
// UI FEEDBACK
// ============================================================
const angleSourceButtons = document.getElementById('angle-source-buttons'); // Selected source -> normalized meter
const angleInputValue = document.getElementById('angle-input-value');
const angleInputMeter = document.getElementById('angle-input-meter');

function updateAudioDisplay() {
  const value = getAngleSourceValue(selectedAngleSource);
  angleInputValue.textContent = value.toFixed(3);
  angleInputMeter.value = value;
}

// ============================================================
// 7. RENDERING
// ============================================================
const canvas = document.getElementById('canvas'); // setup() -> draw() -> renderScene()
let gl = null;
let seedShader = null;
let postShader = null;
let renderTarget = null; // seed image -> post.frag as u_image


async function setup() {
  gl = initWebGL(canvas);
  if (!gl) return;

  let seedVert, seedFrag, postFrag;
  try {
    [seedVert, seedFrag, postFrag] = await Promise.all([
      loadText('shader/seed.vert'),
      loadText('shader/seed.frag'),
      loadText('shader/post.frag'),
    ]);
  } catch (err) {
    showError('Unable to load shaders. Open the page using a local server: ' + err.message);
    return;
  }
    
  seedShader = createShader(gl, seedVert, seedFrag, 'seed.vert', 'seed.frag'); // Programs = seeds + postprocessing
  postShader = createShader(gl, FULLSCREEN_VERTEX_SHADER, postFrag, 'Fullscreen shader', 'post.frag');
  if (!seedShader || !postShader) return; // stop on shader errors

  renderTarget = createRenderTarget(gl);
  requestAnimationFrame(draw);
}

async function loadText(file) {
  const response = await fetch(file, { cache: 'no-store' }); // load current shader source
  if (!response.ok) throw new Error(file);
  return response.text();
}

let lastFrameTime = null;

function draw(timestamp) { // Animation callback; timestamp = ms
  const frameMs = lastFrameTime === null ? 1000 / 60 : timestamp - lastFrameTime; // Frame duration -> stable growth + smoothing
  lastFrameTime = timestamp;
  adaptQuality(frameMs);

  updateWaveMotion(frameMs);

  for (const key in live) {
    live[key] = smoothAudio(live[key], measured[key], frameMs); // measured loudness -> live shader uniform
  }

  growSeeds(frameMs);

  flow *= Math.pow(1 - FLOW_SPEED, seedSpeed * frameMs / (1000 / 60)); // Smooth rank changes -> outward seed motion

  resizeCanvas(gl, targetPixelRatio() * autoScale); // device resolution x quality scale


  renderScene();
  requestAnimationFrame(draw);
}

function renderScene() { // Seeds -> textures; live state -> uniforms; 2 passes
  const width = canvas.width;
  const height = canvas.height;
  const time = now();
  const target = renderTarget;
  for (const batch of seedBatches) { // Changed batches -> u_seeds
    if (batch.count === batch.uploadedCount) continue;
    const firstRow = Math.floor(batch.uploadedCount * PIXELS_PER_SEED / TEXTURE_WIDTH);
    const usedRows = Math.ceil(batch.count * PIXELS_PER_SEED / TEXTURE_WIDTH);
    updateSeedTexture(gl, batch.texture, batch.data, TEXTURE_WIDTH, firstRow, usedRows - firstRow);
    batch.uploadedCount = batch.count;
  }

  resizeRenderTarget(gl, target, width, height);
  const minSeedSize = Math.max(
    MIN_SEED_RADIUS_PX / Math.max(canvas.clientHeight, 1),
    1 / Math.max(height, 1)
  );
  // JS -> GLSL: resolution + seed animation time
  setVec2(seedShader, 'u_resolution', width, height);
  setVec2(postShader, 'u_resolution', width, height);
  setFloat(seedShader, 'u_time', time);
  setInt(seedShader, 'u_seedCount', seedCount);
  setFloat(seedShader, 'u_minSeedSize', minSeedSize);
  setInt(seedShader, 'u_texWidth', TEXTURE_WIDTH);
  setFloat(seedShader, 'u_flow', flow);
  setFloat(postShader, 'u_loudness', live.loudness);
  setFloat(seedShader, 'u_loudness', live.loudness);
  setFloat(seedShader, 'u_slowSource', slowSource); // Slow source -> radial waves
  setFloat(seedShader, 'u_waveTime', waveTime);
  for (let i = 0; i < 4; i++) {
    const ring = beatRings[i];
    setVec2(seedShader, 'u_rings[' + i + ']', ring?.time ?? 0, ring?.strength ?? 0);
  }

  if (seedBatches.length === 0) drawSeeds(seedShader, target, null, 0); // Seeds -> renderTarget -> canvas
  for (let i = 0; i < seedBatches.length; i++) {
    const batch = seedBatches[i];
    setInt(seedShader, 'u_seedOffset', i * SEEDS_PER_BATCH);
    drawSeeds(seedShader, target, batch.texture, batch.count, i === 0);
  }
  drawPost(postShader, target);
}

function smoothAudio(previous, current, frameMs) { // Shared smoothing = calibration + playback + growth + uniforms
  const target = Number.isFinite(current) ? current : 0;
  if (audioSmoothingSeconds <= 0) return target;
  const factor = 1 - Math.exp(-Math.max(frameMs, 0) / (audioSmoothingSeconds * 1000));
  return previous + (target - previous) * factor;
}


// ============================================================
// 8. RENDER QUALITY
// ============================================================
let autoScale = 1; // 1 = full resolution; AUTO_MIN = lower limit
let avgFrameMs = 1000 / 60; // smoothed frame time
let slowMs = 0; // time continuously above the slow threshold
let fastMs = 0; // time continuously below the fast threshold
let warmupMs = 2000; // ignore startup frames

function targetPixelRatio() { // Pixel ratio -> capped render width
  return Math.min(window.devicePixelRatio || 1,
                  MAX_RENDER_WIDTH / Math.max(canvas.clientWidth, 1));
}

function adaptQuality(frameMs) {
  if (frameMs > 250) return; // ignore long pauses
  if (warmupMs > 0) {
    warmupMs -= frameMs;
    return;
  }

  avgFrameMs += (frameMs - avgFrameMs) * 0.05;

  if (avgFrameMs > SLOW_FRAME_MS) {
    slowMs += frameMs;
    fastMs = 0;
  } else if (avgFrameMs < FAST_FRAME_MS) {
    fastMs += frameMs;
    slowMs = 0;
  } else {
    slowMs = 0;
    fastMs = 0;
  }

  if (slowMs > 1000 && autoScale > AUTO_MIN) {
    autoScale = Math.max(autoScale * 0.9, AUTO_MIN);
    avgFrameMs = (SLOW_FRAME_MS + FAST_FRAME_MS) / 2; // restart frame-time sampling
    slowMs = 0;
  }

  if (fastMs > 1000 && autoScale < 1) {
    autoScale = Math.min(autoScale * 1.1, 1);
    fastMs = 0;
  }
}


// ============================================================
// 9. UI CONTROLS
// ============================================================
const analyzeTrackButton = document.getElementById('btn-analyze-track');
const calibratedPlayButton = document.getElementById('btn-play-calibrated');
const trackAnalysisInput = document.getElementById('input-analyze-track');
const trackTitle = document.getElementById('track-title');
analyzeTrackButton.addEventListener('click', () => trackAnalysisInput.click()); // File picker -> calibration
trackAnalysisInput.addEventListener('change', () => {
  const file = trackAnalysisInput.files[0];
  if (file) calibrateTrack(file);
});
calibratedPlayButton.addEventListener('click', () => {
  startCalibratedTrack().catch(err => showError('Unable to play audio: ' + err.message));
});
const sourceButtons = document.createElement('div'); // Angle sources -> single grid
sourceButtons.className = 'angle-source-group';
for (const source of ANGLE_SOURCES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.source = source.key;
  button.setAttribute('aria-pressed', String(source.key === selectedAngleSource));
  button.textContent = source.label;
  button.addEventListener('click', () => selectAngleSource(source.key));
  sourceButtons.appendChild(button);
}
angleSourceButtons.appendChild(sourceButtons);
const angleSlider = document.getElementById('slider-angle'); // baseAngle + angleRange = golden angle
const angleSettingsValue = document.getElementById('angle-settings-value');
angleSlider.value = baseAngle;

function onAngleChange() {
  baseAngle = Math.max(ANGLE_SLIDER_MIN, Math.min(ANGLE_SLIDER_MAX, Number(angleSlider.value)));
  angleRange = GOLDEN_ANGLE_DEG - baseAngle;
  angleSettingsValue.textContent = baseAngle === GOLDEN_ANGLE_DEG ? 'φ · 137.508°' : baseAngle.toFixed(3) + '°';
  currentAngleValue = clamp01(angleControl(measured));
  angleMax = currentAngleValue;
}
angleSlider.addEventListener('input', onAngleChange);
onAngleChange();

const smoothingSlider = document.getElementById('slider-smoothing');
const smoothingSettingsValue = document.getElementById('smoothing-settings-value');
smoothingSlider.value = audioSmoothingSeconds;

function onSmoothingChange() {
  audioSmoothingSeconds = Math.max(0, Math.min(2, Number(smoothingSlider.value)));
  smoothingSettingsValue.textContent = audioSmoothingSeconds.toFixed(2) + ' s';
}
smoothingSlider.addEventListener('input', onSmoothingChange);
onSmoothingChange();

const tempoSlider = document.getElementById('slider-tempo');
const tempoSettingsValue = document.getElementById('tempo-settings-value');
tempoSlider.value = seedSpeed;

function onTempoChange() {
  seedSpeed = Math.max(1, Math.min(3, Number(tempoSlider.value)));
  tempoSettingsValue.textContent = seedSpeed.toFixed(1) + '×';
}
tempoSlider.addEventListener('input', onTempoChange);
onTempoChange();

// ============================================================
// HELPERS
// ============================================================
function now() {
  return performance.now() / 1000; // seconds since page load
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x)); // limit to 0..1
}

setup(); // load shaders + start the render loop
