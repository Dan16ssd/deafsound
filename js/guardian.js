// Night guardian: the phone on the charger watches for the sounds that matter
// at night and keeps buzzing until someone acknowledges. Pure helpers.

import { TIERS } from './labels.js';

// Groups watched at night (plus the user's own sounds and unusual loud sounds).
export const GUARDIAN_GROUPS = new Set([
  'fire_alarm', 'alarm', 'siren', 'explosion', 'scream', 'crash',
  'baby', 'crying', 'dog', 'knock', 'door', 'doorbell', 'phone',
]);
// Quiet-tier sounds that matter at night are raised to at least caution.
const RAISE = new Set(['door', 'dog', 'crying']);

export const GUARDIAN = {
  sensitivity: 1.3,      // multiplies the user's sensitivity while guarding
  repeatMs: 4000,        // re-buzz until acknowledged
  maxRepeats: 30,        // ~2 minutes, then stop (battery / neighbours)
  pattern: [800, 150, 800, 150, 1200],
};

export function guardianFilter(cands) {
  return cands
    .filter((c) => c.source === 'personal' || c.source === 'novelty' || GUARDIAN_GROUPS.has(c.group))
    .map((c) => (RAISE.has(c.group) && TIERS[c.tier].rank < TIERS.caution.rank ? { ...c, tier: 'caution' } : c));
}

export class NightSession {
  constructor(now) { this.start = now; this.events = []; }

  record(ev) { this.events.push({ t: ev.t, key: ev.key, lo: ev.lo, en: ev.en, mark: ev.mark, hue: ev.hue, tier: ev.tier }); }

  summary(now) {
    const by = new Map();
    for (const e of this.events) {
      const g = by.get(e.key) ?? { lo: e.lo, en: e.en, mark: e.mark, hue: e.hue, tier: e.tier, count: 0, last: e.t };
      g.count++; g.last = e.t;
      by.set(e.key, g);
    }
    return {
      durationMs: now - this.start,
      count: this.events.length,
      top: [...by.values()].sort((a, b) => b.count - a.count).slice(0, 6),
      first: this.events[0]?.t ?? null,
      last: this.events[this.events.length - 1]?.t ?? null,
    };
  }
}
