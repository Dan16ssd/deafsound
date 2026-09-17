// Personal sound library: record 3 clips → average YAMNet embeddings → store
// as a named vector in IndexedDB. Matching is cosine similarity. No training.
// Vectors never leave the device.

import { rms } from './audio.js';
import { WINDOW, FRAME_HOP } from './yamnet.js';

export const CLIPS_PER_SOUND = 3;
export const CLIP_SAMPLES = 32000;      // 2.0 s
export const CLIP_PREROLL = 4000;       // include 0.25 s before the tap
export const MIN_CLIP_RMS = 0.004;      // below this the clip is basically silence
const BG_MARGIN = 0.03;                 // live frame must look more like the target than like background
const MIN_LIVE_RMS = 0.003;

// ── vector math ─────────────────────────────────────────────────────────────

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Both inputs must already be normalized.
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function meanNormalized(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return normalize(out);
}

// ── registration ────────────────────────────────────────────────────────────

// frames: output of yamnet.run(clip). Picks the loud frames (where the target
// sound actually is) and averages their embeddings.
export function clipVector(clip, frames) {
  const loudness = frames.map((_, f) => {
    const start = Math.min(f * FRAME_HOP, Math.max(0, clip.length - WINDOW));
    return rms(clip, start, Math.min(clip.length, start + WINDOW));
  });
  const peak = Math.max(...loudness);
  if (peak < MIN_CLIP_RMS) return { vector: null, peak };
  const chosen = frames.filter((_, f) => loudness[f] >= 0.6 * peak).map((fr) => normalize(fr.embedding));
  return { vector: meanNormalized(chosen), peak };
}

export function consistency(clipVecs) {
  let min = 1;
  for (let i = 0; i < clipVecs.length; i++)
    for (let j = i + 1; j < clipVecs.length; j++)
      min = Math.min(min, dot(clipVecs[i], clipVecs[j]));
  return min;
}

export function buildSound({ name, tier, clipVecs, registerMs }) {
  const pairMin = consistency(clipVecs);
  const centroid = meanNormalized(clipVecs);
  // Threshold just under how similar the user's own recordings were to each
  // other, clamped to a sane range. User can adjust it later.
  const threshold = Math.min(0.93, Math.max(0.72, pairMin - 0.04));
  return {
    id: (crypto.randomUUID?.() ?? String(Date.now())),
    name,
    tier,
    centroid: Array.from(centroid),
    threshold: Math.round(threshold * 100) / 100,
    pairMin: Math.round(pairMin * 1000) / 1000,
    registerMs,
    createdAt: Date.now(),
  };
}

// ── live matching ───────────────────────────────────────────────────────────

export class PersonalMatcher {
  constructor() {
    this.sounds = [];
    this.bg = null;
  }

  setSounds(list) {
    this.sounds = list.map((s) => ({ ...s, vec: normalize(Float32Array.from(s.centroid)) }));
  }

  // Returns every stored sound with its similarity; `hit` marks matches.
  match(embedding, liveRms) {
    const e = normalize(embedding);
    const bgSim = this.bg ? dot(e, this.bg) : 0;
    const results = this.sounds.map((s) => {
      const sim = dot(e, s.vec);
      const hit = liveRms >= MIN_LIVE_RMS && sim >= s.threshold && sim - bgSim >= BG_MARGIN;
      return { sound: s, sim, hit };
    });
    // Slow running average of ambient sound (~20 s), frozen during matches so
    // a repeated target doesn't become "background".
    if (!results.some((r) => r.hit)) {
      if (!this.bg) this.bg = e;
      else {
        const a = 0.0125;
        const next = new Float32Array(e.length);
        for (let i = 0; i < e.length; i++) next[i] = (1 - a) * this.bg[i] + a * e[i];
        this.bg = normalize(next);
      }
    }
    return { results, bgSim };
  }
}

// ── IndexedDB ───────────────────────────────────────────────────────────────

const DB_NAME = 'deafsound';
const STORE = 'sounds';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const listSounds = () => tx('readonly', (s) => s.getAll()).then((l) => l ?? []);
export const putSound = (sound) => tx('readwrite', (s) => s.put(sound));
export const deleteSound = (id) => tx('readwrite', (s) => s.delete(id));
