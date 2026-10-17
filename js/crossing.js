// Street-crossing mode: turns "how close is the vehicle" into a haptic
// heartbeat that speeds up and strengthens as it nears, and a clear
// "step back" cue. Assistive only: silence never means it is safe to cross.
// Pure functions + a time-injected controller. No DOM, no network.

export const CROSSING = {
  quietRms: 0.01,     // level mapping: 0.01 rms → 0, 0.2 rms → 1
  loudRms: 0.2,
  gateLo: 0.12,       // vehicle-class confidence below this → no vehicle
  gateHi: 0.4,        // …and at/above this → fully trusted
  nearAt: 0.15,
  closeAt: 0.55,
  backAt: 0.85,
  slowMs: 1400,       // heartbeat interval when just noticed
  fastMs: 260,        // …and when very close
  pulseMin: 40,
  pulseMax: 220,
  backPattern: [500, 100, 500, 100, 500],
  staleMs: 1500,      // no analysis for this long → treat as clear
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// → 0..1 "how worried should I be about a vehicle right now".
export function proximity({ movingConf = 0, rms = 0, approaching = false, passed = false }, c = CROSSING) {
  const gate = clamp01((movingConf - c.gateLo) / (c.gateHi - c.gateLo));
  if (gate === 0) return 0;
  const db = 20 * Math.log10(Math.max(rms, 1e-6) / c.quietRms);
  const level = clamp01(db / (20 * Math.log10(c.loudRms / c.quietRms)));
  let p = 0.15 + 0.55 * level + (approaching ? 0.3 : 0);
  if (passed) p *= 0.5;
  return clamp01(p * gate);
}

// → { state: 'clear'|'near'|'close'|'back', intervalMs, pattern }
export function heartbeatPlan(prox, c = CROSSING) {
  if (prox < c.nearAt) return { state: 'clear', intervalMs: null, pattern: null };
  if (prox >= c.backAt) return { state: 'back', intervalMs: 1100, pattern: c.backPattern };
  const k = ((prox - c.nearAt) / (c.backAt - c.nearAt)) ** 1.5;
  return {
    state: prox >= c.closeAt ? 'close' : 'near',
    intervalMs: Math.round(c.slowMs + (c.fastMs - c.slowMs) * k),
    pattern: [Math.round(c.pulseMin + (c.pulseMax - c.pulseMin) * k)],
  };
}

export class CrossingController {
  constructor(cfg = CROSSING) { this.cfg = cfg; this.reset(); }

  reset() { this.prox = 0; this.lastUpdate = -Infinity; this.nextBeat = 0; }

  // Attack fast, release slowly, so a passing gap in the sound doesn't drop the alarm.
  update(t, input) {
    const p = proximity(input, this.cfg);
    this.prox = p > this.prox ? p : this.prox + (p - this.prox) * 0.25;
    this.lastUpdate = t;
  }

  plan(t) {
    return t - this.lastUpdate > this.cfg.staleMs ? heartbeatPlan(0, this.cfg) : heartbeatPlan(this.prox, this.cfg);
  }

  // Returns the vibration pattern if a beat is due now, else null.
  due(t) {
    const plan = this.plan(t);
    if (!plan.pattern) { this.nextBeat = 0; return null; }
    if (t < this.nextBeat) return null;
    this.nextBeat = t + plan.intervalMs;
    return plan.pattern;
  }
}
