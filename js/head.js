// Second model: a small logistic-regression "verifier" per personal sound,
// trained on-device over YAMNet embeddings. The cosine match proposes a hit;
// the head confirms or vetoes it. It learns from the user's own "Wrong" taps
// (hard negatives), so a personal sound gets more accurate with use.
// Pure functions, no DOM, no network; weights live in IndexedDB with the sound.

import { normalize, dot } from './library.js';

export const HEAD = {
  minNegatives: 12,   // don't train a head on too little background
  poolSize: 160,      // background embeddings kept in memory
  jitter: 0.012,      // per-dim noise when augmenting positives
  epochs: 150,
  lr: 1.5,
  l2: 1e-3,
  hardNegWeight: 3,   // per augmented copy of a user-flagged false alarm
  hardNegMax: 40,
  accept: 0.5,
};

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Small seeded PRNG so training is reproducible (and testable).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

// Each clip vector becomes `n` plausible variants: jittered, and blended with
// a little background, since a real doorbell never arrives on silence.
export function augment(vecs, bgPool, n = 10, seed = 7) {
  const r = rng(seed);
  const out = [];
  for (const v of vecs) {
    out.push(Float32Array.from(v));
    for (let k = 0; k < n; k++) {
      const bg = bgPool.length ? bgPool[Math.floor(r() * bgPool.length)] : null;
      const mixAmt = bg ? 0.05 + 0.2 * r() : 0;
      const x = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) x[i] = (1 - mixAmt) * v[i] + (bg ? mixAmt * bg[i] : 0) + HEAD.jitter * gauss(r);
      out.push(normalize(x));
    }
  }
  return out;
}

// positives / negatives: arrays of normalized embeddings. negatives may carry
// {vec, weight}; a bare vector has weight 1. Returns { w, b } or null.
export function trainHead(positives, negatives, opts = {}) {
  const negs = negatives.map((n) => (n.vec ? n : { vec: n, weight: 1 }));
  if (positives.length === 0 || negs.length < HEAD.minNegatives) return null;
  const { epochs, lr, l2 } = { ...HEAD, ...opts };
  const dim = positives[0].length;
  const w = new Float32Array(dim);
  let b = 0;

  // Class-balanced: positives and negatives each carry half of the total weight.
  const nw = negs.reduce((s, x) => s + x.weight, 0);
  const rows = [
    ...positives.map((x) => ({ x, y: 1, c: 0.5 / positives.length })),
    ...negs.map((n) => ({ x: n.vec, y: 0, c: (0.5 * n.weight) / nw })),
  ];
  const gw = new Float32Array(dim);
  for (let e = 0; e < epochs; e++) {
    gw.fill(0);
    let gb = 0;
    for (const { x, y, c } of rows) {
      const err = (sigmoid(dot(w, x) + b) - y) * c;
      for (let i = 0; i < dim; i++) gw[i] += err * x[i];
      gb += err;
    }
    // Embeddings are unit length, so scale the step to keep it stable.
    for (let i = 0; i < dim; i++) w[i] -= lr * 40 * (gw[i] + l2 * w[i]);
    b -= lr * 40 * gb;
  }
  return { w: Array.from(w), b };
}

export function headProb(head, embedding) {
  if (!head) return 1; // no head → don't veto
  let z = head.b;
  for (let i = 0; i < head.w.length; i++) z += head.w[i] * embedding[i];
  return sigmoid(z);
}

// Build/refresh a sound's head from its stored clips, the live background pool,
// the other registered sounds (they must not trigger this one) and any
// user-flagged false alarms. Returns a new sound record (does not mutate).
export function withHead(sound, bgPool, otherCentroids = []) {
  const clips = sound.clips ?? [sound.centroid];
  const pos = augment([...clips, sound.centroid].map((v) => normalize(Float32Array.from(v))), bgPool);
  const negs = [
    ...bgPool.map((vec) => ({ vec, weight: 1 })),
    ...otherCentroids.map((c) => ({ vec: normalize(Float32Array.from(c)), weight: 2 })),
    ...hardNegatives(sound.hardNeg ?? [], bgPool),
  ];
  const head = trainHead(pos, negs);
  return head ? { ...sound, head } : sound;
}

// Flagged false alarms are rare but precious: jitter them like positives and
// give them a fixed share of the negative mass so they aren't drowned out.
function hardNegatives(hardNeg, bgPool) {
  if (!hardNeg.length) return [];
  const vecs = augment(hardNeg.map((v) => normalize(Float32Array.from(v))), bgPool, 6, 23);
  return vecs.map((vec) => ({ vec, weight: HEAD.hardNegWeight }));
}

// The user said this alert was wrong → remember the embedding and retrain.
export function addHardNegative(sound, embedding, bgPool, otherCentroids = []) {
  const hardNeg = [...(sound.hardNeg ?? []), Array.from(normalize(embedding))].slice(-HEAD.hardNegMax);
  return withHead({ ...sound, hardNeg }, bgPool, otherCentroids);
}

// Keeps a bounded, spread-out sample of recent non-match embeddings.
export class BackgroundPool {
  constructor(size = HEAD.poolSize) { this.size = size; this.items = []; this.seen = 0; this.r = rng(11); }
  add(embedding) {
    const e = normalize(embedding);
    this.seen++;
    if (this.items.length < this.size) this.items.push(e);
    else { const j = Math.floor(this.r() * this.seen); if (j < this.size) this.items[j] = e; } // reservoir
  }
}
