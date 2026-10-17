// Fourth model: novelty detector for sounds the label map doesn't know.
// Keeps the app's own background embeddings; a loud sound that looks unlike
// anything heard recently, and that YAMNet didn't map to an alert, becomes an
// "unusual loud sound" caution. Distance = 1 - max cosine to the background
// pool; the trigger level adapts to this phone's own background spread.
// Pure functions, no DOM, no network.

import { normalize, dot } from './library.js';

export const NOVELTY = {
  minPool: 40,          // don't arm until the app knows its surroundings
  minRms: 0.02,         // and the sound must be clearly audible…
  loudRatio: 2.5,       // …and well above the noise floor
  sigmas: 4,            // novelty must exceed mean + this many σ of background
  floor: 0.25,          // and never below this absolute distance
  holdMs: 15000,        // one alert per unusual event
  ema: 0.02,
};

export const NOVEL_ALERT = {
  key: 'novelty:unusual', source: 'novelty', group: 'novelty', icon: '❓', tier: 'caution',
  lo: 'ມີສຽງດັງທີ່ບໍ່ຄຸ້ນເຄີຍ', en: 'Unusual loud sound',
};

export class NoveltyDetector {
  constructor(cfg = NOVELTY) {
    this.cfg = cfg;
    this.mean = 0.1;   // running stats of background novelty
    this.var = 0.002;
    this.last = -Infinity;
  }

  // Distance of an embedding to its nearest background neighbour (0 = seen before).
  novelty(embedding, pool) {
    const e = normalize(embedding);
    let best = -1;
    for (const p of pool) { const d = dot(e, p); if (d > best) best = d; }
    return best < 0 && pool.length === 0 ? 0 : 1 - best;
  }

  threshold() {
    return Math.max(this.cfg.floor, this.mean + this.cfg.sigmas * Math.sqrt(this.var));
  }

  // Call for every analysis. Returns { novelty, fire }. `known` = YAMNet or
  // personal already produced an alert-worthy candidate for this window.
  check({ embedding, pool, rms, noiseFloor, known, now }) {
    if (pool.length < this.cfg.minPool) return { novelty: 0, fire: false, armed: false };
    const nov = this.novelty(embedding, pool);
    const loud = rms >= this.cfg.minRms && rms > noiseFloor * this.cfg.loudRatio;
    const fire = loud && !known && nov > this.threshold() && now - this.last > this.cfg.holdMs;
    if (fire) this.last = now;
    // Learn the background spread only from ordinary moments.
    if (!loud) {
      const a = this.cfg.ema;
      const d = nov - this.mean;
      this.mean += a * d;
      this.var += a * (d * d - this.var);
    }
    return { novelty: nov, fire, armed: true };
  }
}
