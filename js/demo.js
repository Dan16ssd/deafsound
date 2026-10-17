// Demo mode: a synthetic "vehicle horn coming at you, then passing" scene that
// is fed through the real pipeline (no mic, no speaker), so every feature can
// be shown anywhere: detection, getting closer, passed-you, risk, flash/band.

import { SAMPLE_RATE } from './audio.js';

export const DEMO_SECONDS = 9;

function lcg(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; }; }

// 0–1 s street noise; horn from 1 s, +24 dB louder over 4 s (approaching, pitch
// slightly high); passes at 5 s (pitch falls ≈ 9 %); fades out by 9 s.
export function demoScenario(sr = SAMPLE_RATE) {
  const n = DEMO_SECONDS * sr;
  const out = new Float32Array(n);
  const rnd = lcg(42);
  let ph1 = 0, ph2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    lp = 0.97 * lp + 0.03 * rnd();
    let s = 0.012 * (lp * 4 + 0.3 * rnd());
    if (t >= 1) {
      const rise = Math.min(1, (t - 1) / 4);
      const amp = t < 5 ? 0.02 * 10 ** (rise * 24 / 20) : 0.32 * Math.exp(-(t - 5) / 2.2);
      const k = t < 5 ? 1.045 : t < 5.6 ? 1.045 - (0.09 * (t - 5)) / 0.6 : 0.955; // Doppler step through the pass
      ph1 += (2 * Math.PI * 420 * k) / sr;
      ph2 += (2 * Math.PI * 500 * k) / sr;
      let h = 0;
      for (let m = 1; m < 7; m++) h += Math.sin(m * ph1) / m + Math.sin(m * ph2) / m;
      s += amp * 0.25 * Math.tanh(2 * h);
    }
    out[i] = s;
  }
  return out;
}
