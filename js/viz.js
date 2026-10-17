// Live "sound picture": a scrolling spectrogram so a deaf user can SEE sound.
// Pure band analysis (Goertzel) + a small canvas painter. No network.

import { SAMPLE_RATE } from './audio.js';

export const BAND_COUNT = 48;
const F_MIN = 100;
const F_MAX = 6000;
export const BAND_FREQS = Array.from({ length: BAND_COUNT }, (_, i) => F_MIN * (F_MAX / F_MIN) ** (i / (BAND_COUNT - 1)));

// Energy of each band (0..1, log-scaled) in one short frame of samples.
export function bandLevels(samples, freqs = BAND_FREQS, sr = SAMPLE_RATE) {
  const n = samples.length;
  const out = new Float32Array(freqs.length);
  for (let b = 0; b < freqs.length; b++) {
    const w = 2 * Math.cos((2 * Math.PI * freqs[b]) / sr);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const s0 = samples[i] * hann + w * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - w * s1 * s2;
    const amp = Math.sqrt(Math.max(power, 0)) / n * 4;
    const db = 20 * Math.log10(amp + 1e-6);
    out[b] = Math.min(1, Math.max(0, (db + 70) / 55)); // −70 dB → 0, −15 dB → 1
  }
  return out;
}

// Colour of one cell: dark → tier colour as energy rises, white-hot at the peak.
const HUES = { idle: 215, info: 205, caution: 40, danger: 5 };
export function cellColor(v, tier = 'idle') {
  const hue = HUES[tier] ?? HUES.idle;
  const l = 8 + 62 * v ** 1.2;
  return `hsl(${hue} ${Math.round(40 + 55 * v)}% ${Math.round(l)}%)`;
}

export class Spectrogram {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.px = 3;                 // width of one time column
    this.tier = 'idle';
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, canvas.width, canvas.height);
  }

  setTier(tier) { this.tier = tier ?? 'idle'; }

  push(levels) {
    const { g, c, px } = this;
    g.drawImage(c, -px, 0);                                 // scroll left
    const h = c.height / levels.length;
    for (let b = 0; b < levels.length; b++) {
      g.fillStyle = cellColor(levels[b], this.tier);
      g.fillRect(c.width - px, c.height - (b + 1) * h, px, Math.ceil(h));
    }
  }
}
