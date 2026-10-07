/* ---------------------------------------------------------------------------
   Heart rate from a fingertip on the camera (photoplethysmography).

   Each heartbeat pushes a little more blood into the fingertip, which then
   lets through a little less light, so the red channel of the camera dips
   once per beat. Everything here works on that one number per frame:

   Pulse.sample(imageData)  -> {value, finger}       one frame's reading
   Pulse.estimate(samples)  -> {bpm, quality, wave}   from [{t, v}] in ms

   No DOM in here, so it can be tested on its own.
--------------------------------------------------------------------------- */

(function (root) {
  'use strict';

  const RATE = 30;                 // Hz the samples are resampled to
  const MIN_BPM = 40;
  const MAX_BPM = 200;

  /* The mean colour of a frame, and whether a fingertip is on the lens. A lit
     fingertip fills the frame with red and very little green; a room, a face
     or a dark lens does not. The reading is red plus green: both dip with
     each beat, and under a bright flash red alone can sit at full and go
     flat. */
  function sample(image) {
    const d = image.data;
    let r = 0, g = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; n++; }
    r /= n; g /= n;
    return {value: r + g, finger: r > 50 && r > g * 1.8};
  }

  /* Uneven frame times onto an even grid, by straight-line interpolation. */
  function resample(samples) {
    const out = [];
    if (samples.length < 2) return out;
    const step = 1000 / RATE;
    let j = 0;
    for (let t = samples[0].t; t <= samples[samples.length - 1].t; t += step) {
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[j + 1];
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      out.push(a.v + (b.v - a.v) * k);
    }
    return out;
  }

  function movingAverage(x, width) {
    const half = Math.floor(width / 2);
    const out = new Array(x.length);
    let sum = 0, lo = 0, hi = -1;
    for (let i = 0; i < x.length; i++) {
      const want = Math.min(x.length - 1, i + half);
      while (hi < want) sum += x[++hi];
      const from = Math.max(0, i - half);
      while (lo < from) sum -= x[lo++];
      out[i] = sum / (hi - lo + 1);
    }
    return out;
  }

  /* Keep only what moves at heartbeat speed: take away the slow drift of the
     finger settling (anything slower than ~0.7 Hz), smooth away sensor
     flicker, and flip it so each beat is a peak rather than a dip. */
  function clean(raw) {
    const drift = movingAverage(raw, Math.round(RATE * 1.2));
    const pulse = raw.map((v, i) => drift[i] - v);
    return movingAverage(pulse, 3);
  }

  /* The beat is the delay at which the wave best matches itself. Quality is
     how well it matches there (0..1): a clean pulse is well above 0.5,
     a shaking finger or a covered-but-unlit lens is not. */
  function estimate(samples) {
    const raw = resample(samples);
    if (raw.length < RATE * 4) return {bpm: null, quality: 0, wave: []};
    const wave = clean(raw);

    const mean = wave.reduce((s, v) => s + v, 0) / wave.length;
    const x = wave.map((v) => v - mean);
    const energy = x.reduce((s, v) => s + v * v, 0);
    if (!energy) return {bpm: null, quality: 0, wave};

    const minLag = Math.floor(RATE * 60 / MAX_BPM);
    const maxLag = Math.ceil(RATE * 60 / MIN_BPM);
    const corr = [];
    for (let lag = 0; lag <= maxLag + 1 && lag < x.length; lag++) {
      let s = 0;
      for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
      // Shorter overlaps have fewer terms; scale them back up to compare fairly.
      corr[lag] = (s / energy) * (x.length / (x.length - lag));
    }

    // The first strong peak, not the tallest: two beats apart also matches
    // well, and picking it would halve the rate.
    let best = -1;
    let top = 0;
    for (let lag = minLag; lag <= maxLag && lag < corr.length - 1; lag++) {
      if (corr[lag] > top) top = corr[lag];
    }
    for (let lag = minLag; lag <= maxLag && lag < corr.length - 1; lag++) {
      const peak = corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1];
      if (peak && corr[lag] >= top * 0.85) { best = lag; break; }
    }
    if (best < 0) return {bpm: null, quality: 0, wave};

    // Between frames: fit a parabola through the peak and its neighbours.
    const a = corr[best - 1], b = corr[best], c = corr[best + 1];
    const shift = (a - 2 * b + c) ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    const bpm = 60 * RATE / (best + shift);

    return {bpm, quality: Math.max(0, Math.min(1, b)), wave};
  }

  const api = {sample, estimate, RATE, MIN_BPM, MAX_BPM};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pulse = api;
})(typeof window !== 'undefined' ? window : globalThis);
