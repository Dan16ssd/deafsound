// Doppler cue: a horn or siren drops in pitch as it passes you. Combined with
// the loudness trend (js/approach.js) this separates "coming at you" from
// "already went by". Pure functions, no DOM, no network.

import { SAMPLE_RATE } from './audio.js';

export const PITCH = {
  minHz: 200,
  maxHz: 1600,
  frame: 2048,          // samples analysed (~128 ms)
  minClarity: 0.6,      // normalized autocorrelation peak; below = not a clean tone
  minRms: 0.01,
  windowMs: 2500,
  minPoints: 5,
  minDropFrac: 0.03,    // ≥ 3 % fall = passing (a 30 m/s vehicle shifts ≈ ±9 %)
};

// → { hz, clarity } or null when there is no clean tone.
export function estimatePitch(samples, sr = SAMPLE_RATE) {
  const n = Math.min(PITCH.frame, samples.length);
  const x = samples.subarray(samples.length - n);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (Math.sqrt(e0 / n) < PITCH.minRms) return null;

  const minLag = Math.floor(sr / PITCH.maxHz);
  const maxLag = Math.min(Math.ceil(sr / PITCH.minHz), n >> 1);
  const r = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let c = 0, e1 = 0;
    for (let i = 0; i + lag < n; i++) { c += x[i] * x[i + lag]; e1 += x[i + lag] * x[i + lag]; }
    r[lag] = c / (Math.sqrt(e0 * e1) || 1);
  }
  // First strong local maximum (avoids picking a sub-octave multiple).
  let best = -1, bestV = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > bestV) { bestV = r[lag]; best = lag; }
  if (best < 0 || bestV < PITCH.minClarity) return null;
  for (let lag = minLag; lag < best; lag++) {
    if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > 0.9 * bestV) { best = lag; bestV = r[lag]; break; }
  }
  // Parabolic interpolation for sub-sample precision.
  const a = r[best - 1], b = r[best], c = r[best + 1];
  const d = a - 2 * b + c;
  const shift = d ? (0.5 * (a - c)) / d : 0;
  return { hz: sr / (best + shift), clarity: bestV };
}

export class PitchTrend {
  constructor(cfg = PITCH) { this.cfg = cfg; this.pts = []; }

  push(t, pitch) {
    if (pitch) this.pts.push({ t, hz: pitch.hz });
    const cut = t - this.cfg.windowMs;
    while (this.pts.length && this.pts[0].t < cut) this.pts.shift();
  }

  reset() { this.pts = []; }

  // 'falling' (passing / receding), 'rising' or 'steady'
  state() {
    const p = this.pts;
    if (p.length < this.cfg.minPoints) return 'steady';
    const k = Math.max(1, Math.floor(p.length / 3));
    const head = p.slice(0, k).reduce((s, x) => s + x.hz, 0) / k;
    const tail = p.slice(-k).reduce((s, x) => s + x.hz, 0) / k;
    const frac = (tail - head) / head;
    if (frac <= -this.cfg.minDropFrac) return 'falling';
    if (frac >= this.cfg.minDropFrac) return 'rising';
    return 'steady';
  }
}
