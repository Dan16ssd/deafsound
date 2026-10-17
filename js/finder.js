// "Find the sound": a hot/cold compass. A phone microphone can't tell
// direction, but the user can: turn slowly while the app records loudness per
// compass heading; the loudest heading is where the sound probably is.
// Approximate by nature. Pure functions, no DOM, no network.

export const FINDER = {
  bins: 36,           // 10° each
  decay: 0.998,       // old readings fade, so a moving source is followed
  smooth: 0.35,       // per-bin update rate
  minCoverage: 12,    // bins seen before an answer is given (120° of turning)
  minContrast: 0.15,  // peak must beat the average by this much
};

export const norm360 = (a) => ((a % 360) + 360) % 360;
// Signed shortest turn from `from` to `to`, in (−180, 180].
export const turn = (from, to) => { const d = norm360(to - from); return d > 180 ? d - 360 : d; };

// rms → 0..1 (−60 dBFS → 0, −10 dBFS → 1)
export const levelOf = (rms) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 50));

export class HeadingMap {
  constructor(cfg = FINDER) {
    this.cfg = cfg;
    this.v = new Float32Array(cfg.bins);
    this.seen = new Uint8Array(cfg.bins);
  }

  reset() { this.v.fill(0); this.seen.fill(0); }

  binOf(heading) { return Math.floor(norm360(heading) / (360 / this.cfg.bins)) % this.cfg.bins; }

  add(heading, level) {
    const { decay, smooth } = this.cfg;
    for (let i = 0; i < this.v.length; i++) this.v[i] *= decay;
    const b = this.binOf(heading);
    this.v[b] = this.seen[b] ? this.v[b] + smooth * (level - this.v[b]) : level;
    this.seen[b] = 1;
  }

  coverage() { return this.seen.reduce((s, x) => s + x, 0); }

  // → { heading, confidence } or null until the user has turned enough.
  best() {
    const n = this.cfg.bins;
    if (this.coverage() < this.cfg.minCoverage) return null;
    // 3-bin moving average over seen bins, so one noisy bin can't win.
    const avg = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (const d of [-1, 0, 1]) { const j = (i + d + n) % n; if (this.seen[j]) { s += this.v[j]; c++; } }
      avg[i] = c ? s / c : 0;
    }
    let bi = 0;
    for (let i = 1; i < n; i++) if (avg[i] > avg[bi]) bi = i;
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (this.seen[i]) { sum += avg[i]; cnt++; }
    const mean = sum / cnt;
    const confidence = avg[bi] > 0 ? Math.min(1, Math.max(0, (avg[bi] - mean) / avg[bi] / 0.5)) : 0;
    if (avg[bi] - mean < this.cfg.minContrast * avg[bi]) return { heading: null, confidence: 0 };

    // Circular weighted centroid around the peak (±2 bins) for sub-bin accuracy.
    let x = 0, y = 0;
    for (let d = -2; d <= 2; d++) {
      const j = (bi + d + n) % n;
      if (!this.seen[j]) continue;
      const a = ((j + 0.5) * 2 * Math.PI) / n;
      x += avg[j] * Math.sin(a); y += avg[j] * Math.cos(a);
    }
    return { heading: norm360((Math.atan2(x, y) * 180) / Math.PI), confidence };
  }
}

// How well the phone points at the sound: 1 = dead ahead, 0 = ≥ 90° away.
export const closeness = (current, target) => (target == null ? 0 : Math.max(0, 1 - Math.abs(turn(current, target)) / 90));
export const hotCold = (c) => (c > 0.85 ? 'hot' : c > 0.6 ? 'warm' : c > 0.3 ? 'cool' : 'cold');
