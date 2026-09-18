// Turns YAMNet scores + personal-library similarities into alert candidates.
// Pure functions, no DOM, no network.

import { TIERS, GROUPS } from './labels.js';

// Built-in threshold for a group, before any field-tuned override.
export function defaultThreshold(group) {
  return group.threshold ?? TIERS[group.tier].threshold;
}

// overrides: { [groupId]: threshold } tuned in the field (Settings → Thresholds).
export function yamnetCandidates(scores, sensitivity = 1, overrides = {}) {
  const out = [];
  for (const g of GROUPS) {
    let conf = 0;
    for (const c of g.classes) if (scores[c] > conf) conf = scores[c];
    const threshold = Math.min(0.95, (overrides[g.id] ?? defaultThreshold(g)) / sensitivity);
    if (conf >= threshold) {
      out.push({ key: `yamnet:${g.id}`, source: 'yamnet', group: g.id, icon: g.icon, tier: g.tier, lo: g.lo, en: g.en, confidence: conf });
    }
  }
  return out;
}

// Field tuning aid: the lowest threshold that would have suppressed every
// alert marked wrong, capped so a group can't be tuned into silence.
export function suggestThreshold(wrongConfidences, current) {
  if (!wrongConfidences?.length) return null;
  const s = Math.min(0.9, Math.max(...wrongConfidences) + 0.03);
  return s > current ? Math.round(s * 100) / 100 : null;
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
