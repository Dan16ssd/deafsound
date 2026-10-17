// Risk fusion: combines what the models know into one urgency score so the
// alert can scale to the situation instead of treating every "danger" alike.
//   tier + confidence (YAMNet or personal head) + approaching + loudness
// Also: per-sound snooze, so a known repetitive sound can be silenced for a while.
// Pure functions, no DOM, no network.

import { TIERS } from './labels.js';

export const RISK = {
  critical: 0.8,                 // at/above → critical vibration + banner
  tierBase: { danger: 0.55, caution: 0.3, info: 0.05 },
  confWeight: 0.2,               // up to +0.20 for a confident detection
  approachBonus: 0.25,
  loudWeight: 0.15,              // up to +0.15 for a loud source (close / strong)
  loudRms: 0.15,                 // rms at which loudness bonus saturates
  snoozeMs: 10 * 60 * 1000,
  vibrateCritical: [600, 120, 600, 120, 600, 120, 1200],
};

// → { score 0..1, level: 'critical' | 'high' | 'normal' | 'low', reasons[] }
export function assessRisk({ tier, confidence = 0, approaching = false, level = 0 }) {
  const reasons = [];
  let score = RISK.tierBase[tier] ?? 0;
  score += RISK.confWeight * Math.min(1, Math.max(0, confidence));
  if (approaching) { score += RISK.approachBonus; reasons.push('approaching'); }
  const loud = Math.min(1, level / RISK.loudRms);
  score += RISK.loudWeight * loud;
  if (loud > 0.6) reasons.push('loud');
  if (confidence > 0.8) reasons.push('confident');
  score = Math.min(1, score);
  const lvl = score >= RISK.critical ? 'critical' : score >= 0.55 ? 'high' : score >= 0.3 ? 'normal' : 'low';
  return { score: Math.round(score * 100) / 100, level: lvl, reasons };
}

// Vibration for an assessed alert: the tier pattern normally, the long
// critical pattern when the situation is critical. Danger is never reduced.
export function vibrationFor(tier, risk) {
  return risk.level === 'critical' ? RISK.vibrateCritical : TIERS[tier].vibrate;
}

export class Snooze {
  constructor() { this.until = new Map(); }
  // Danger-tier sounds can't be snoozed: that would be unsafe.
  snooze(key, tier, now, ms = RISK.snoozeMs) {
    if (tier === 'danger') return false;
    this.until.set(key, now + ms);
    return true;
  }
  isSnoozed(key, now) {
    const t = this.until.get(key);
    if (t === undefined) return false;
    if (now >= t) { this.until.delete(key); return false; }
    return true;
  }
  clear(key) { this.until.delete(key); }
}
