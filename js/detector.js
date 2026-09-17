// Turns YAMNet scores + personal-library similarities into alert candidates.
// Pure functions, no DOM, no network.

import { TIERS, GROUPS } from './labels.js';

export function yamnetCandidates(scores, sensitivity = 1) {
  const out = [];
  for (const g of GROUPS) {
    let conf = 0;
    for (const c of g.classes) if (scores[c] > conf) conf = scores[c];
    const threshold = Math.min(0.95, (g.threshold ?? TIERS[g.tier].threshold) / sensitivity);
    if (conf >= threshold) {
      out.push({ key: `yamnet:${g.id}`, source: 'yamnet', tier: g.tier, lo: g.lo, en: g.en, confidence: conf });
    }
  }
  return out;
}

export function topClasses(scores, classNames, k = 5) {
  const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);
  return idx.map((i) => ({ index: i, name: classNames[i], score: scores[i] }));
}

// Highest tier first, then highest confidence. Personal sounds win ties
// because the user explicitly asked to be told about them.
export function rankCandidates(cands) {
  return cands.slice().sort((a, b) =>
    TIERS[b.tier].rank - TIERS[a.tier].rank
    || (b.source === 'personal') - (a.source === 'personal')
    || b.confidence - a.confidence);
}

export class Cooldown {
  constructor() {
    this.lastSeen = new Map();
    this.lastAlert = new Map();
  }

  // True if this key should vibrate now. A sound that keeps going extends its
  // cooldown (one alert per event), but still re-alerts every 3× cooldown so a
  // long-running horn or siren is never silently absorbed.
  ready(key, tier, now) {
    const cd = TIERS[tier].cooldownMs;
    const seen = this.lastSeen.get(key);
    const alerted = this.lastAlert.get(key);
    this.lastSeen.set(key, now);
    const ongoing = seen !== undefined && now - seen < cd;
    if (ongoing && now - alerted < 3 * cd) return false;
    this.lastAlert.set(key, now);
    return true;
  }
}
