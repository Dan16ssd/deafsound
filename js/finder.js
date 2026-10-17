// "Find the sound": a hot/cold compass. A phone microphone can't tell
// direction, but the user can: turn slowly while the app records loudness per
// compass heading; the loudest heading is where the sound probably is.
// Approximate by nature. Pure functions, no DOM, no network.

export const FINDER = {
  bins: 36,           // 10° each
  halfLifeMs: 60000,  // old readings fade (time-based), so a moving source is followed but a slow lap is not forgotten
  decay: 0.9995,      // per-sample fade when no timestamps are given
  smooth: 0.35,       // per-bin update rate
  minCoverage: 12,    // bins seen before an answer is given (120° of turning)
  minContrast: 0.15,  // peak must beat the average by this much
  maxRate: 80,        // °/s: readings taken while turning faster than this are blurred, so they are skipped
  minSamples: 3,      // per bin, before it counts
  maxWidth: 250,      // °: a lobe wider than this means "from everywhere", not a direction
};

export const norm360 = (a) => ((a % 360) + 360) % 360;
// Signed shortest turn from `from` to `to`, in (−180, 180].
export const turn = (from, to) => { const d = norm360(to - from); return d > 180 ? d - 360 : d; };

// Compass heading the phone points at, from the W3C orientation angles (alpha/beta/gamma),
// valid at any tilt. Flat on a table it is the top edge; held upright it is the back of the
// phone; in between, whichever has the larger horizontal part. (Reading `alpha` alone is only
// right when the phone lies perfectly flat.)
export function compassHeading(alpha, beta, gamma) {
  const r = Math.PI / 180;
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha * r), Math.sin(alpha * r), Math.cos(beta * r), Math.sin(beta * r), Math.cos(gamma * r), Math.sin(gamma * r)];
  const toEarth = ([x, y, z]) => {
    [x, z] = [cg * x + sg * z, -sg * x + cg * z];       // Ry(gamma)
    [y, z] = [cb * y - sb * z, sb * y + cb * z];        // Rx(beta)
    [x, y] = [ca * x - sa * y, sa * x + ca * y];        // Rz(alpha)
    return [x, y, z];
  };
  const top = toEarth([0, 1, 0]);
  const back = toEarth([0, 0, -1]);
  const v = Math.hypot(top[0], top[1]) >= Math.hypot(back[0], back[1]) ? top : back;
  return norm360((Math.atan2(v[0], v[1]) * 180) / Math.PI);
}

// rms → 0..1 (−60 dBFS → 0, −10 dBFS → 1)
export const levelOf = (rms) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 50));

export class HeadingMap {
  constructor(cfg = FINDER) {
    this.cfg = cfg;
    this.v = new Float32Array(cfg.bins);
    this.seen = new Uint8Array(cfg.bins);
    this.n = new Uint16Array(cfg.bins);
    this.lastH = null;
    this.lastT = null;
  }

  reset() { this.v.fill(0); this.seen.fill(0); this.n.fill(0); this.lastH = this.lastT = null; }

  binOf(heading) { return Math.floor(norm360(heading) / (360 / this.cfg.bins)) % this.cfg.bins; }

  // t (ms) is optional; with it, samples taken while turning too fast are dropped.
  add(heading, level, t = null) {
    const { decay, smooth, maxRate, halfLifeMs } = this.cfg;
    let fade = decay;
    if (t !== null && this.lastT !== null && t > this.lastT) {
      const dt = t - this.lastT;
      fade = 0.5 ** (dt / halfLifeMs);
      const rate = (Math.abs(turn(this.lastH, heading)) / dt) * 1000;
      this.lastH = heading; this.lastT = t;
      if (rate > maxRate) { this.fadeAll(fade); return false; }
    } else if (t !== null) { this.lastH = heading; this.lastT = t; }
    this.fadeAll(fade);
    const b = this.binOf(heading);
    this.v[b] = this.seen[b] ? this.v[b] + smooth * (level - this.v[b]) : level;
    this.seen[b] = 1;
    this.n[b]++;
    return true;
  }

  fadeAll(f) { for (let i = 0; i < this.v.length; i++) this.v[i] *= f; }

  // Bins backed by enough samples to trust.
  solid(i) { return this.seen[i] && this.n[i] >= this.cfg.minSamples; }

  coverage() { let c = 0; for (let i = 0; i < this.cfg.bins; i++) if (this.solid(i)) c++; return c; }

  // → { heading, confidence } or null until the user has turned enough.
  best() {
    const n = this.cfg.bins;
    if (this.coverage() < this.cfg.minCoverage) return null;
    // 3-bin moving average over seen bins, so one noisy bin can't win.
    const avg = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (const d of [-1, 0, 1]) { const j = (i + d + n) % n; if (this.solid(j)) { s += this.v[j]; c++; } }
      avg[i] = c ? s / c : 0;
    }
    let bi = 0;
    for (let i = 1; i < n; i++) if (avg[i] > avg[bi]) bi = i;
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (this.solid(i)) { sum += avg[i]; cnt++; }
    const mean = sum / cnt;
    const confidence = avg[bi] > 0 ? Math.min(1, Math.max(0, (avg[bi] - mean) / avg[bi] / 0.5)) : 0;
    if (avg[bi] - mean < this.cfg.minContrast * avg[bi]) return { heading: null, confidence: 0, width: 360 };

    // Circular weighted centroid around the peak (±2 bins) for sub-bin accuracy.
    let x = 0, y = 0;
    for (let d = -2; d <= 2; d++) {
      const j = (bi + d + n) % n;
      if (!this.solid(j)) continue;
      const a = ((j + 0.5) * 2 * Math.PI) / n;
      x += avg[j] * Math.sin(a); y += avg[j] * Math.cos(a);
    }
    // Width of the lobe: contiguous bins around the peak above the half-way line between the
    // average and the peak. A smooth mic pattern makes this wide even when the peak is right,
    // so it is shown to the user as a zone, and only a near-flat map is rejected.
    const cut = mean + 0.5 * (avg[bi] - mean);
    let lo = 0, hi = 0;
    while (lo < n && avg[(bi - lo - 1 + n) % n] >= cut) lo++;
    while (hi < n && avg[(bi + hi + 1) % n] >= cut) hi++;
    const width = Math.min(360, (lo + hi + 1) * (360 / n));
    if (width > this.cfg.maxWidth) return { heading: null, confidence: 0, width };
    return { heading: norm360((Math.atan2(x, y) * 180) / Math.PI), confidence: confidence * (1 - width / 360), width };
  }
}

// How well the phone points at the sound: 1 = dead ahead, 0 = ≥ 90° away.
export const closeness = (current, target) => (target == null ? 0 : Math.max(0, 1 - Math.abs(turn(current, target)) / 90));
export const hotCold = (c) => (c > 0.85 ? 'hot' : c > 0.6 ? 'warm' : c > 0.3 ? 'cool' : 'cold');
