// "Getting closer" detection: a vehicle sound whose loudness keeps rising is
// coming toward the user, which is when a deaf pedestrian most needs to know.
// Pure functions, no DOM, no network. Level is tracked in dB so the rise is
// independent of how loud the phone's mic is.

export const APPROACH = {
  windowMs: 2500,     // history kept
  minSpanMs: 1000,    // need at least this much history to judge
  minRiseDb: 5,       // total rise across the window
  minSlopeDbPerS: 3,  // and a steady climb, not one spike
  minLevel: 0.004,    // ignore near-silence (rms)
  vibrate: [400, 100, 400, 100, 900], // stronger than the plain danger buzz
  realertMs: 8000,    // at most one escalation per sound per this long
};

const toDb = (rms) => 20 * Math.log10(Math.max(rms, 1e-6));

export class LevelTrend {
  constructor(cfg = APPROACH) {
    this.cfg = cfg;
    this.pts = [];
  }

  push(t, rms) {
    this.pts.push({ t, rms, db: toDb(rms) });
    const cut = t - this.cfg.windowMs;
    while (this.pts.length && this.pts[0].t < cut) this.pts.shift();
  }

  reset() { this.pts = []; }

  // 'approaching' | 'receding' | 'steady'
  state() {
    const p = this.pts;
    const { minSpanMs, minRiseDb, minSlopeDbPerS, minLevel } = this.cfg;
    if (p.length < 4 || p[p.length - 1].t - p[0].t < minSpanMs) return 'steady';
    if (p[p.length - 1].rms < minLevel && p[0].rms < minLevel) return 'steady';

    // Least-squares slope in dB/s.
    const n = p.length;
    const mt = p.reduce((s, x) => s + x.t, 0) / n;
    const md = p.reduce((s, x) => s + x.db, 0) / n;
    let num = 0, den = 0;
    for (const x of p) { num += (x.t - mt) * (x.db - md); den += (x.t - mt) ** 2; }
    const slope = den ? (num / den) * 1000 : 0;

    // Compare the mean of the first and last thirds so one spike can't trigger it.
    const k = Math.max(1, Math.floor(n / 3));
    const head = p.slice(0, k).reduce((s, x) => s + x.db, 0) / k;
    const tail = p.slice(-k).reduce((s, x) => s + x.db, 0) / k;

    if (slope >= minSlopeDbPerS && tail - head >= minRiseDb && p[p.length - 1].rms >= minLevel) return 'approaching';
    if (slope <= -minSlopeDbPerS && head - tail >= minRiseDb) return 'receding';
    return 'steady';
  }
}
