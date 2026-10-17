// Third model: a scene context classifier. It pools YAMNet class scores over
// ~20 s into a place guess (street, home, crowd, temple, nature, quiet) and
// nudges *non-danger* thresholds to match: fewer constant "vehicle nearby"
// alerts on a busy street, more sensitivity to doorbells/knocks at home.
// Danger thresholds are never raised. Pure functions, no DOM, no network.

export const SCENES = {
  street: {
    lo: 'ຖະໜົນ', en: 'Street', icon: '🛣️',
    classes: [294, 300, 301, 302, 308, 310, 320, 321, 347, 315],
    scale: { vehicle: 1.25, traffic: 1.2, motorbike: 1, engine_idle: 1.2 },
  },
  home: {
    lo: 'ໃນເຮືອນ', en: 'Home / indoors', icon: '🏠',
    classes: [348, 351, 353, 364, 349, 350, 383, 384, 385],
    scale: { doorbell: 0.85, knock: 0.85, phone: 0.9 },
  },
  crowd: {
    lo: 'ບ່ອນມີຄົນຫຼາຍ', en: 'Crowd / market', icon: '👥',
    classes: [0, 1, 64, 65, 13, 314],
    scale: { shout: 1.15, speech: 1.1, crowd: 1.15 },
  },
  temple: {
    lo: 'ວັດ', en: 'Temple', icon: '🛕',
    classes: [159, 163, 172, 195, 196, 200, 27, 28],
    scale: { temple_drum: 1.3, bell: 1.3, chant: 1.3 },
  },
  nature: {
    lo: 'ທຳມະຊາດ', en: 'Outdoors / nature', icon: '🌳',
    classes: [283, 284, 285, 94, 96, 76, 78, 280, 281],
    scale: { rain: 1.2, rooster: 1.2 },
  },
};

export const SCENE_CFG = {
  tau: 20000,        // ms time constant of the running average
  minScore: 0.12,    // below this no scene is believed ("quiet")
  margin: 1.3,       // winner must beat the runner-up by this factor
  maxScale: 1.4,
};

const DANGER_SAFE = true; // scaling is applied to non-danger groups only (see sceneOverrides)

export class SceneModel {
  constructor(cfg = SCENE_CFG) {
    this.cfg = cfg;
    this.score = Object.fromEntries(Object.keys(SCENES).map((k) => [k, 0]));
    this.t = null;
  }

  // scores: YAMNet 521 class scores; t: ms timestamp.
  update(scores, t) {
    const dt = this.t === null ? this.cfg.tau : Math.max(0, t - this.t);
    this.t = t;
    const a = 1 - Math.exp(-dt / this.cfg.tau);
    for (const [id, sc] of Object.entries(SCENES)) {
      let m = 0;
      for (const c of sc.classes) if (scores[c] > m) m = scores[c];
      this.score[id] += a * (m - this.score[id]);
    }
  }

  // → scene id, or 'quiet' when nothing is convincing.
  current() {
    const ranked = Object.entries(this.score).sort((a, b) => b[1] - a[1]);
    const [id, top] = ranked[0];
    if (top < this.cfg.minScore) return 'quiet';
    if (ranked[1][1] > 0 && top < ranked[1][1] * this.cfg.margin) return 'mixed';
    return id;
  }
}

// Per-group threshold overrides for the scene, layered under the user's own
// field-tuned overrides. `groups` = labels.GROUPS. Danger groups are skipped.
export function sceneOverrides(scene, groups, defaultThreshold, userOverrides = {}) {
  const scale = SCENES[scene]?.scale;
  if (!scale) return userOverrides;
  const out = { ...userOverrides };
  for (const g of groups) {
    const k = scale[g.id];
    if (!k || (DANGER_SAFE && g.tier === 'danger') || userOverrides[g.id] !== undefined) continue;
    out[g.id] = Math.min(0.9, Math.max(0.1, defaultThreshold(g) * Math.min(SCENE_CFG.maxScale, k)));
  }
  return out;
}
