// npm test — runs against the real bundled YAMNet model on the CPU backend.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { TIERS, GROUPS } from '../js/labels.js';
import { Persistence, yamnetCandidates, rankCandidates, Cooldown, defaultThreshold, suggestThreshold } from '../js/detector.js';
import { BackgroundPool, headProb, withHead, addHardNegative, HEAD } from '../js/head.js';
import { SceneModel, SCENES, sceneOverrides } from '../js/scene.js';
import { NoveltyDetector, NOVELTY } from '../js/novelty.js';
import { estimatePitch, PitchTrend } from '../js/pitch.js';
import { flashSchedule, bandLevel } from '../js/outputs.js';
import { toRecord, addRecord, summarize, TIMELINE_MAX } from '../js/timeline.js';
import { bandLevels, BAND_COUNT } from '../js/viz.js';
import { demoScenario, DEMO_SECONDS } from '../js/demo.js';
import { proximity, heartbeatPlan, CrossingController } from '../js/crossing.js';
import { HeadingMap, compassHeading, levelOf, turn, closeness, hotCold } from '../js/finder.js';
import { guardianFilter, NightSession, GUARDIAN_GROUPS } from '../js/guardian.js';
import { assessRisk, vibrationFor, Snooze, RISK } from '../js/risk.js';
import { LevelTrend } from '../js/approach.js';
import * as L from '../js/library.js';
import { rms, RingBuffer, CHUNK_SECONDS } from '../js/audio.js';
import { WINDOW } from '../js/yamnet.js';
import { toPayload, recentEvents, localSummary } from '../js/narrate.js';
import { sanitizeEvents } from '../proxy/worker.js';
import { loadNodeYamnet, readWav, writeWav } from '../tools/node-yamnet.mjs';
import { buildPack } from '../tools/build-pack.mjs';

const SR = 16000;
let yam;
before(async () => { yam = await loadNodeYamnet(); });

// ── synthetic sounds ────────────────────────────────────────────────────────
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
const noise = (n, amp) => { const a = new Float32Array(n); let b = 0; for (let i = 0; i < n; i++) { b = 0.97 * b + 0.03 * rnd(); a[i] = amp * (b * 4 + 0.3 * rnd()); } return a; };
const mix = (...xs) => { const o = new Float32Array(xs[0].length); for (const x of xs) for (let i = 0; i < o.length; i++) o[i] += x[i]; return o; };
function dingdong(n, at, amp, detune = 1) {
  const a = new Float32Array(n);
  for (const [t0, f] of [[at, 660 * detune], [at + 0.55 * SR, 523 * detune]]) {
    for (let i = 0; i < 0.5 * SR && t0 + i < n; i++) {
      const env = Math.exp((-i / SR) * 5);
      a[t0 + i] += amp * env * (Math.sin((2 * Math.PI * f * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 2.76 * f * i) / SR));
    }
  }
  return a;
}
function horn(n, amp) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let s = 0;
    for (let h = 1; h < 8; h++) s += Math.sin(2 * Math.PI * 420 * h * t) / h + Math.sin(2 * Math.PI * 500 * h * t) / h;
    a[i] = amp * 0.25 * Math.tanh(2 * s);
  }
  return a;
}

// ── label map & alert spec ──────────────────────────────────────────────────

test('label map: valid, unique classes, mark + Lao + English on every group', () => {
  const seen = new Set();
  for (const g of GROUPS) {
    assert.ok(TIERS[g.tier], `${g.id} tier`);
    assert.ok(g.mark && g.lo && g.en, `${g.id} mark/lo/en`);
    assert.match(g.lo, /[຀-໿]/, `${g.id} Lao text`);
    for (const c of g.classes) {
      assert.ok(c >= 0 && c < 521, `${g.id} class ${c}`);
      assert.ok(!seen.has(c), `class ${c} in two groups`);
      seen.add(c);
    }
  }
});

test('vibration patterns match the feature spec', () => {
  const on = (p) => p.filter((_, i) => i % 2 === 0);
  assert.deepEqual(on(TIERS.danger.vibrate).length, 1, 'danger: one continuous buzz');
  assert.ok(TIERS.danger.vibrate[0] >= 1000, 'danger: long');
  assert.equal(on(TIERS.caution.vibrate).length, 3, 'caution: 3 pulses');
  assert.ok(on(TIERS.caution.vibrate).every((d) => d <= 150), 'caution: short');
  assert.ok(TIERS.caution.vibrate.filter((_, i) => i % 2).every((d) => d <= 100), 'caution: fast');
  const info = on(TIERS.info.vibrate);
  assert.ok(info.length >= 1 && info.length <= 2 && info.every((d) => d <= 100), 'info: 1–2 gentle');
});

test('latency budget: ≤100 ms steady hop, ≤40 ms burst hop on onsets, ≤20 ms audio chunks', () => {
  const src = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const secs = (name) => Number(src.match(new RegExp(`const ${name} = Math\\.round\\(SAMPLE_RATE \\* ([\\d.]+)\\)`))[1]);
  assert.ok(secs('HOP') <= 0.1, 'steady hop');
  assert.ok(secs('HOP_BURST') <= 0.04, 'burst hop');
  assert.ok(CHUNK_SECONDS <= 0.02, 'chunk size');
});

// ── detection ───────────────────────────────────────────────────────────────

test('synthetic horn → danger alert with mark', async () => {
  const { scores } = await yam.classify(mix(horn(WINDOW, 0.4), noise(WINDOW, 0.02)));
  const top = rankCandidates(yamnetCandidates(scores))[0];
  assert.equal(top?.group, 'horn');
  assert.equal(top.tier, 'danger');
  assert.equal(top.mark, 'sharp');
});

test('field threshold override suppresses a group; suggestion raises above false alarms', async () => {
  const { scores } = await yam.classify(mix(horn(WINDOW, 0.4), noise(WINDOW, 0.02)));
  assert.ok(yamnetCandidates(scores, 1, { horn: 0.95 }).every((c) => c.group !== 'horn'));
  const horn_ = GROUPS.find((g) => g.id === 'horn');
  assert.equal(suggestThreshold([0.31, 0.42], defaultThreshold(horn_)), 0.45);
  assert.equal(suggestThreshold([0.1], 0.25), null, 'never suggests lowering');
  assert.equal(suggestThreshold([0.99], 0.25), 0.9, 'capped');
  assert.equal(suggestThreshold([], 0.25), null);
});

test('cooldown: one alert per ongoing sound, re-alerts after 3× cooldown, new event after a gap', () => {
  const cd = new Cooldown();
  const fired = [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 7600].map((t) => cd.ready('k', 'danger', t));
  assert.deepEqual(fired, [true, false, false, false, false, false, false, false, false, true]);
  const gap = new Cooldown();
  assert.deepEqual([0, 3000].map((t) => gap.ready('k', 'danger', t)), [true, true]);
});

// ── personal library ────────────────────────────────────────────────────────

async function registerDoorbell() {
  const clipVecs = [];
  for (let k = 0; k < 3; k++) {
    const clip = mix(dingdong(L.CLIP_SAMPLES, 3000 + k * 1500, 0.3 * (0.8 + 0.2 * k), 1 + 0.005 * k), noise(L.CLIP_SAMPLES, 0.015));
    clipVecs.push(L.clipVector(clip, await yam.run(clip)).vector);
  }
  return L.buildSound({ name: 'ກະດິ່ງ', tier: 'caution', clipVecs, registerMs: 0 });
}

test('personal library: matches its own sound, rejects others and silence', async () => {
  const sound = await registerDoorbell();
  assert.ok(sound.threshold >= 0.72 && sound.threshold <= 0.93);
  const quiet = noise(L.CLIP_SAMPLES, 0.0005);
  assert.equal(L.clipVector(quiet, await yam.run(quiet)).vector, null, 'near-silent clip rejected');

  const m = new L.PersonalMatcher();
  m.setSounds([sound]);
  for (let i = 0; i < 30; i++) { const w = noise(WINDOW, 0.02); m.match((await yam.classify(w)).embedding, rms(w)); }

  assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25, 0.997), noise(WINDOW, 0.02))), true, 'doorbell');
  assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25, 1.6), noise(WINDOW, 0.02))), false, 'different chime');
  assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25, 1.15), noise(WINDOW, 0.02))), false, 'similar chime');
  assert.equal(await anyHit(m, () => mix(horn(WINDOW, 0.4), noise(WINDOW, 0.02))), false, 'horn');
  assert.equal(await anyHit(m, () => noise(WINDOW, 0.02)), false, 'ambient');
});

// The app re-checks a sliding window every 100 ms, so a sound is seen at many
// offsets within the 0.975 s window. Match if any offset hits, like the app.
async function anyHit(matcher, makeWindow) {
  for (let at = 0; at <= 8000; at += 1600) {
    const w = makeWindow(at);
    if (matcher.match((await yam.classify(w)).embedding, rms(w)).results[0].hit) return true;
  }
  return false;
}

// ── starter pack tool ───────────────────────────────────────────────────────

test('readWav: 44.1 kHz stereo 16-bit → 16 kHz mono', () => {
  const src = new Float32Array(44100).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const stereo = Buffer.alloc(44 + src.length * 4);
  const mono16 = writeWav(src, 44100);
  mono16.copy(stereo, 0, 0, 44);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(44100 * 4, 28); stereo.writeUInt16LE(4, 32);
  stereo.writeUInt32LE(src.length * 4, 40); stereo.writeUInt32LE(36 + src.length * 4, 4);
  for (let i = 0; i < src.length; i++) {
    const v = Math.round(src[i] * 32767);
    stereo.writeInt16LE(v, 44 + i * 4); stereo.writeInt16LE(v, 46 + i * 4);
  }
  const out = readWav(stereo);
  assert.ok(Math.abs(out.length - 16000) <= 1);
  assert.ok(Math.abs(rms(out) - 0.5 / Math.SQRT2) < 0.01);
  assert.throws(() => readWav(Buffer.from('not a wav file at all.............')));
});

test('build-pack: builds matchable pack sounds and reports bad folders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deafsound-pack-'));
  try {
    const bell = path.join(dir, 'door-bell');
    fs.mkdirSync(bell);
    fs.writeFileSync(path.join(bell, 'meta.json'), JSON.stringify({ name: 'ກະດິ່ງ', en: 'Doorbell', tier: 'caution' }));
    for (let k = 0; k < 3; k++) {
      fs.writeFileSync(path.join(bell, `take${k}.wav`), writeWav(mix(dingdong(L.CLIP_SAMPLES, 2000 + k * 1000, 0.3), noise(L.CLIP_SAMPLES, 0.015))));
    }
    fs.mkdirSync(path.join(dir, 'no-meta'));
    const short = path.join(dir, 'too-few');
    fs.mkdirSync(short);
    fs.writeFileSync(path.join(short, 'meta.json'), JSON.stringify({ name: 'x', en: 'x', tier: 'info' }));
    fs.writeFileSync(path.join(short, 'a.wav'), writeWav(horn(L.CLIP_SAMPLES, 0.3)));

    const { sounds, problems } = await buildPack(dir, { yam, log: () => {} });
    assert.equal(sounds.length, 1);
    const [s] = sounds;
    assert.equal(s.id, 'door-bell');
    assert.equal(s.centroid.length, 1024);
    assert.ok(s.threshold >= 0.7);
    assert.ok(problems.some((p) => p.startsWith('no-meta/')));
    assert.ok(problems.some((p) => p.startsWith('too-few/')));

    const m = new L.PersonalMatcher();
    m.setSounds([s]);
    assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25), noise(WINDOW, 0.02))), true, 'pack doorbell');
    assert.equal(await anyHit(m, () => mix(horn(WINDOW, 0.4), noise(WINDOW, 0.02))), false, 'pack vs horn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped starter pack file is valid', () => {
  const pack = JSON.parse(fs.readFileSync(new URL('../packs/lao-starter.json', import.meta.url), 'utf8'));
  assert.equal(pack.version, 1);
  for (const s of pack.sounds) {
    assert.ok(s.id && s.name && s.en && TIERS[s.tier] && s.centroid?.length === 1024 && s.threshold > 0);
  }
});

// ── narration & proxy ───────────────────────────────────────────────────────

test('narration payload is text only; local summary works offline', () => {
  const now = Date.now();
  const log = [
    { key: 'yamnet:horn', en: 'Vehicle horn', lo: 'ມີສຽງແກລົດ', tier: 'danger', source: 'yamnet', confidence: 0.71, t: now - 4000, mark: 'sharp' },
    { key: 'yamnet:dog', en: 'Dog barking', lo: 'ມີໝາເຫົ່າ', tier: 'caution', source: 'yamnet', confidence: 0.44, t: now - 20000 },
  ];
  const payload = toPayload(recentEvents(log, now), now);
  assert.deepEqual(Object.keys(payload[0]).sort(), ['class', 'confidence', 'label_lo', 'seconds_ago', 'source', 'tier', 'timestamp']);
  assert.match(localSummary(log, now), /ມີສຽງແກລົດ/);
});

test('proxy sanitizer: clamps, trims, rejects bad shapes', () => {
  const body = (events) => ({ messages: [{ content: JSON.stringify({ events }) }] });
  const [e] = sanitizeEvents(body([{ class: 'x'.repeat(200), label_lo: 'ລົດ', source: 'personal', tier: 'caution', confidence: 7, seconds_ago: -5, extra: 1 }]));
  assert.equal(e.class.length, 60);
  assert.equal(e.confidence, 1);
  assert.equal(e.seconds_ago, 0);
  assert.equal(e.extra, undefined);
  assert.equal(sanitizeEvents(body([])), null);
  assert.equal(sanitizeEvents(body([{ source: 'yamnet', tier: 'hacker' }])), null);
  assert.equal(sanitizeEvents({}), null);
});

test('ring buffer keeps the newest samples', () => {
  const rb = new RingBuffer(10);
  rb.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.deepEqual(Array.from(rb.latest(4)), [9, 10, 11, 12]);
});

// ── dev server ──────────────────────────────────────────────────────────────

test('dev server serves only app files (case-insensitive) and survives bad URLs', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['serve.mjs', String(port)], { cwd: new URL('..', import.meta.url) });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const status = async (p) => (await fetch(base + p)).status;
    for (const p of ['/', '/js/app.js', '/JS/app.js', '/model/model.json', '/packs/lao-starter.json', '/sw.js']) assert.equal(await status(p), 200, p);
    for (const p of ['/package.json', '/serve.mjs', '/proxy/worker.js', '/PROXY/wrangler.toml', '/tests/run.mjs', '/tools/build-pack.mjs', '/node_modules/@tensorflow/tfjs/package.json', '/js/../package.json', '/CERTS/dev-key.pem', '/.git/config']) {
      assert.equal(await status(p), 404, p);
    }
    const raw = (p) => new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve('error'));
        req.end();
      });
    });
    assert.equal(await raw('/%'), 400);
    assert.equal(await raw('//'), 200);
    assert.equal(await status('/'), 200, 'still up');
  } finally {
    server.kill();
  }
});

// ── getting closer ──────────────────────────────────────────────────────────

test('approach: rising level → approaching, falling → receding, flat/spike → steady', () => {
  const run = (f) => { const tr = new LevelTrend(); for (let t = 0; t <= 2000; t += 100) tr.push(t, f(t)); return tr.state(); };
  assert.equal(run((t) => 0.01 * 10 ** (t / 2000)), 'approaching');   // +20 dB over 2 s
  assert.equal(run((t) => 0.2 * 10 ** (-t / 2000)), 'receding');
  assert.equal(run(() => 0.1), 'steady');
  assert.equal(run((t) => (t === 1000 ? 0.5 : 0.05)), 'steady');       // single spike
  assert.equal(run((t) => 0.0001 * 10 ** (t / 2000)), 'steady');       // near-silence ignored
  const short = new LevelTrend(); short.push(0, 0.01); short.push(200, 0.1); assert.equal(short.state(), 'steady');
});

test('approach: only travelling sources are flagged moving', () => {
  const moving = GROUPS.filter((g) => g.moving).map((g) => g.id);
  for (const id of ['horn', 'siren', 'motorbike', 'vehicle_pass', 'train']) assert.ok(moving.includes(id), id);
  for (const id of ['doorbell', 'speech', 'dog']) assert.ok(!moving.includes(id), id);
});

// ── verifier head (second model) ────────────────────────────────────────────

async function embed(w) { return L.normalize((await yam.classify(w)).embedding); }

test('head: learns doorbell vs background, then learns from a flagged false alarm', async () => {
  const sound = await registerDoorbell();
  assert.equal(sound.clips.length, 3);
  const pool = new BackgroundPool();
  for (let i = 0; i < 30; i++) pool.add(await embed(noise(WINDOW, 0.01 + 0.002 * i)));
  assert.equal(withHead(sound, pool.items.slice(0, HEAD.minNegatives - 1)).head, undefined, 'too little background → no head');

  const trained = withHead(sound, pool.items);
  assert.ok(trained.head, 'head trained');
  const bell = await embed(mix(dingdong(WINDOW, 1600, 0.25, 0.997), noise(WINDOW, 0.02)));
  const ambient = await embed(noise(WINDOW, 0.02));
  assert.ok(headProb(trained.head, bell) > 0.5, `doorbell p=${headProb(trained.head, bell)}`);
  assert.ok(headProb(trained.head, ambient) < 0.5, 'ambient');
  assert.equal(headProb(null, bell), 1, 'no head never vetoes');

  // A similar chime the user flags as wrong becomes a hard negative.
  const similar = await embed(mix(dingdong(WINDOW, 1600, 0.25, 1.15), noise(WINDOW, 0.02)));
  const before = headProb(trained.head, similar);
  const learned = addHardNegative(trained, similar, pool.items);
  const after = headProb(learned.head, similar);
  assert.ok(after < before || after < 0.5, `false alarm p ${before} → ${after}`);
  assert.ok(headProb(learned.head, bell) > 0.5, 'still hears the real doorbell');
  assert.equal(learned.hardNeg.length, 1);
});

test('head: matcher lets the head veto a cosine hit', async () => {
  const sound = await registerDoorbell();
  const m = new L.PersonalMatcher();
  m.setSounds([sound]);
  m.verify = () => 0.1;
  assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25, 0.997), noise(WINDOW, 0.02))), false, 'vetoed');
  m.verify = () => 0.9;
  assert.equal(await anyHit(m, (at) => mix(dingdong(WINDOW, at, 0.25, 0.997), noise(WINDOW, 0.02))), true, 'confirmed');
});

// ── risk fusion & snooze ────────────────────────────────────────────────────

test('risk: approaching + loud danger is critical; quiet info is low; vibration scales', () => {
  const calm = assessRisk({ tier: 'danger', confidence: 0.4, level: 0.01 });
  const close = assessRisk({ tier: 'danger', confidence: 0.9, approaching: true, level: 0.2 });
  assert.ok(close.score > calm.score);
  assert.equal(close.level, 'critical');
  assert.ok(close.reasons.includes('approaching'));
  assert.notEqual(calm.level, 'critical');
  assert.equal(assessRisk({ tier: 'info', confidence: 0.6, level: 0.01 }).level, 'low');
  assert.ok(assessRisk({ tier: 'caution', confidence: 1, approaching: true, level: 1 }).score <= 1);
  assert.deepEqual(vibrationFor('danger', close), RISK.vibrateCritical);
  assert.deepEqual(vibrationFor('danger', calm), TIERS.danger.vibrate);
  assert.deepEqual(vibrationFor('caution', { level: 'high' }), TIERS.caution.vibrate);
});

test('snooze: works for caution/info, expires, never for danger', () => {
  const s = new Snooze();
  assert.equal(s.snooze('yamnet:dog', 'caution', 1000, 5000), true);
  assert.equal(s.isSnoozed('yamnet:dog', 3000), true);
  assert.equal(s.isSnoozed('yamnet:dog', 6001), false, 'expired');
  assert.equal(s.snooze('yamnet:horn', 'danger', 0), false);
  assert.equal(s.isSnoozed('yamnet:horn', 1), false);
});

// ── scene context ───────────────────────────────────────────────────────────

const sceneScores = (o) => { const s = new Float32Array(521); for (const [c, v] of Object.entries(o)) s[c] = v; return s; };

test('scene: pooled class scores pick street / home / quiet, and danger thresholds never rise', () => {
  const m = new SceneModel();
  assert.equal(m.current(), 'quiet');
  for (let t = 0; t < 40000; t += 1000) m.update(sceneScores({ 300: 0.7, 321: 0.6 }), t);
  assert.equal(m.current(), 'street');
  const h = new SceneModel();
  for (let t = 0; t < 40000; t += 1000) h.update(sceneScores({ 348: 0.6, 364: 0.5 }), t);
  assert.equal(h.current(), 'home');
  const mixed = new SceneModel();
  for (let t = 0; t < 40000; t += 1000) mixed.update(sceneScores({ 300: 0.6, 348: 0.58 }), t);
  assert.equal(mixed.current(), 'mixed');
  // one passing sound doesn't flip the scene
  m.update(sceneScores({ 348: 0.9 }), 41000);
  assert.equal(m.current(), 'street');

  const street = sceneOverrides('street', GROUPS, defaultThreshold, { traffic: 0.5 });
  assert.ok(street.vehicle > defaultThreshold(GROUPS.find((g) => g.id === 'vehicle')), 'vehicle less twitchy on street');
  assert.equal(street.traffic, 0.5, 'user override wins');
  const home = sceneOverrides('home', GROUPS, defaultThreshold);
  assert.ok(home.doorbell < defaultThreshold(GROUPS.find((g) => g.id === 'doorbell')), 'doorbell more sensitive at home');
  for (const sc of Object.keys(SCENES)) {
    const o = sceneOverrides(sc, GROUPS, defaultThreshold);
    for (const g of GROUPS.filter((x) => x.tier === 'danger')) assert.equal(o[g.id], undefined, `${sc}/${g.id} untouched`);
  }
  assert.deepEqual(sceneOverrides('quiet', GROUPS, defaultThreshold, { a: 1 }), { a: 1 });
});

// ── novelty ─────────────────────────────────────────────────────────────────

test('novelty: fires on a loud unfamiliar sound, not on familiar background or quiet/known ones', async () => {
  const pool = new BackgroundPool();
  for (let i = 0; i < 60; i++) pool.add(await embed(noise(WINDOW, 0.01 + 0.0005 * i)));
  const d = new NoveltyDetector();
  const call = (e, extra = {}) => d.check({ embedding: e, pool: pool.items, rms: 0.1, noiseFloor: 0.01, known: false, now: 100000, ...extra });

  assert.equal(d.check({ embedding: await embed(horn(WINDOW, 0.4)), pool: pool.items.slice(0, 5), rms: 0.1, noiseFloor: 0.01, known: false, now: 0 }).armed, false, 'unarmed with a tiny pool');
  for (let i = 0; i < 20; i++) call(await embed(noise(WINDOW, 0.012)), { rms: 0.005 }); // learn the background spread

  const strange = await embed(mix(dingdong(WINDOW, 1600, 0.4, 1.3), horn(WINDOW, 0.3)));
  assert.equal(call(await embed(noise(WINDOW, 0.012))).fire, false, 'familiar background');
  assert.equal(call(strange, { rms: 0.005 }).fire, false, 'too quiet');
  assert.equal(call(strange, { known: true }).fire, false, 'already explained by a label');
  const r = call(strange);
  assert.equal(r.fire, true, `novelty ${r.novelty.toFixed(2)} vs ${d.threshold().toFixed(2)}`);
  assert.equal(call(strange, { now: 100000 + NOVELTY.holdMs - 1 }).fire, false, 'held');
  assert.equal(call(strange, { now: 100000 + NOVELTY.holdMs + 1 }).fire, true, 'after hold');
});

// ── doppler pitch ───────────────────────────────────────────────────────────

function tone(hz, n = 2048, amp = 0.3) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR); return a; }

test('pitch: estimates a horn tone, rejects noise and silence, tracks a falling Doppler pitch', () => {
  for (const hz of [250, 420, 500, 880, 1400]) {
    const p = estimatePitch(tone(hz));
    assert.ok(p && Math.abs(p.hz - hz) / hz < 0.01, `${hz} Hz → ${p?.hz}`);
  }
  assert.equal(estimatePitch(noise(2048, 0.2)), null, 'noise');
  assert.equal(estimatePitch(tone(440, 2048, 0.001)), null, 'silence');

  const run = (f0, f1) => { const tr = new PitchTrend(); for (let i = 0; i <= 10; i++) tr.push(i * 200, estimatePitch(tone(f0 + ((f1 - f0) * i) / 10))); return tr.state(); };
  assert.equal(run(520, 470), 'falling');   // passing: ≈ −10 %
  assert.equal(run(470, 520), 'rising');
  assert.equal(run(500, 502), 'steady');
  assert.equal(new PitchTrend().state(), 'steady');
});

// ── outputs ─────────────────────────────────────────────────────────────────

test('outputs: flash schedule follows the vibration pattern; band level by tier/risk', () => {
  assert.deepEqual(flashSchedule([120, 70, 120]), [
    { at: 0, on: true }, { at: 120, on: false }, { at: 190, on: true }, { at: 310, on: false },
  ]);
  assert.equal(bandLevel('danger'), 2);
  assert.equal(bandLevel('caution'), 1);
  assert.equal(bandLevel('caution', { level: 'critical' }), 2);
  assert.equal(bandLevel('info'), 0);
});

// ── timeline ────────────────────────────────────────────────────────────────

test('timeline: compact records, cap, daily summary ignores wrong alerts and other days', () => {
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const t0 = now.getTime();
  const ev = (o) => ({ t: t0, key: 'yamnet:horn', lo: 'ມີສຽງແກລົດ', en: 'Horn', mark: 'sharp', tier: 'danger', emb: new Float32Array(1024), ...o });
  const list = [];
  addRecord(list, ev({}));
  addRecord(list, ev({ approach: true, risk: { level: 'critical' } }));
  addRecord(list, ev({ key: 'yamnet:dog', lo: 'ໝາ', en: 'Dog', tier: 'caution' }));
  addRecord(list, ev({ wrong: true }));
  addRecord(list, ev({ t: t0 - 3 * 86400000 }));
  assert.ok(!('emb' in list[0]), 'no embeddings stored');
  const s = summarize(list, t0 - 3600000);
  assert.equal(s.total, 3);
  assert.equal(s.danger, 2); assert.equal(s.caution, 1);
  assert.equal(s.critical, 1); assert.equal(s.approaching, 1);
  assert.equal(s.top[0].count, 2);
  assert.equal(s.byHour[12], 3);
  for (let i = 0; i < TIMELINE_MAX + 20; i++) addRecord(list, ev({}));
  assert.equal(list.length, TIMELINE_MAX);
});

// ── sound picture & demo scenario ───────────────────────────────────────────

test('viz: band levels peak at the tone, and are quiet for silence', () => {
  const lv = bandLevels(tone(1000, 512));
  assert.equal(lv.length, BAND_COUNT);
  const peak = lv.indexOf(Math.max(...lv));
  const hz = 100 * (6000 / 100) ** (peak / (BAND_COUNT - 1));
  assert.ok(Math.abs(hz - 1000) / 1000 < 0.12, `peak at ${hz} Hz`);
  assert.ok(Math.max(...bandLevels(new Float32Array(512))) < 0.01);
  for (const v of lv) assert.ok(v >= 0 && v <= 1);
});

test('demo scenario: getting closer, then pitch falls = passed; and the real model calls it a horn', async () => {
  const sig = demoScenario();
  assert.equal(sig.length, DEMO_SECONDS * SR);
  const tr = new LevelTrend(), pt = new PitchTrend();
  const seen = { approaching: false, passed: false, approachAfterPass: false };
  for (let t = 0; t + 2048 <= sig.length; t += 1600) {
    const ms = (t / SR) * 1000;
    tr.push(ms, rms(sig.subarray(t, t + 2048)));
    pt.push(ms, estimatePitch(sig.subarray(t, t + 2048)));
    const approaching = tr.state() === 'approaching', falling = pt.state() === 'falling';
    if (approaching && !falling) seen.approaching = true;
    if (falling) seen.passed = true;
    if (seen.passed && approaching && !falling) seen.approachAfterPass = true;
  }
  assert.ok(seen.approaching, 'approach detected');
  assert.ok(seen.passed, 'pass detected');
  const win = sig.subarray(4.5 * SR, 4.5 * SR + WINDOW);
  const { scores } = await yam.classify(win);
  const cands = yamnetCandidates(scores, 1, {});
  assert.ok(cands.some((c) => c.tier === 'danger'), `danger candidates: ${cands.map((c) => c.group)}`);
});

// ── crossing mode ───────────────────────────────────────────────────────────

test('crossing: proximity grows with loudness and approach; heartbeat speeds up; far/passed is calm', () => {
  const far = proximity({ movingConf: 0.5, rms: 0.012 });
  const near = proximity({ movingConf: 0.6, rms: 0.08 });
  const onTop = proximity({ movingConf: 0.9, rms: 0.25, approaching: true });
  assert.ok(far < near && near < onTop, `${far} ${near} ${onTop}`);
  assert.equal(proximity({ movingConf: 0.05, rms: 0.3, approaching: true }), 0, 'no vehicle sound → nothing');
  assert.ok(proximity({ movingConf: 0.9, rms: 0.25, approaching: true, passed: true }) < onTop, 'passed reduces');

  assert.equal(heartbeatPlan(0.05).state, 'clear');
  const a = heartbeatPlan(0.25), b = heartbeatPlan(0.7);
  assert.ok(b.intervalMs < a.intervalMs && b.pattern[0] > a.pattern[0], 'faster and stronger');
  assert.equal(heartbeatPlan(0.9).state, 'back');
  assert.ok(heartbeatPlan(0.9).pattern.length > 1);
});

test('crossing: controller beats on schedule, releases slowly, and goes quiet when stale', () => {
  const c = new CrossingController();
  c.update(0, { movingConf: 0.9, rms: 0.2, approaching: true });
  assert.ok(c.due(0), 'first beat immediately');
  assert.equal(c.due(10), null, 'not again yet');
  c.update(1900, { movingConf: 0.9, rms: 0.2, approaching: true });
  assert.ok(c.due(2000), 'next beat');
  c.update(2100, { movingConf: 0, rms: 0.001 });   // vehicle sound drops out for a moment
  assert.ok(c.plan(2100).state !== 'clear', 'released slowly, not instantly');
  assert.equal(c.plan(2100 + 2000).state, 'clear', 'stale → clear');
  assert.equal(c.due(2100 + 2000), null);
});

// ── find the sound ──────────────────────────────────────────────────────────

test('finder: locates the loudest heading around the circle, including across 0°', () => {
  const sweep = (target) => {
    const m = new HeadingMap();
    for (let lap = 0; lap < 3; lap++) for (let h = 0; h < 360; h += 5) m.add(h, 0.15 + 0.8 * Math.max(0, Math.cos(((h - target) * Math.PI) / 180)) ** 2);
    return m.best();
  };
  for (const target of [90, 200, 355, 10]) {
    const b = sweep(target);
    assert.ok(Math.abs(turn(b.heading, target)) <= 12, `target ${target} → ${b.heading}`);
    assert.ok(b.confidence > 0.3);
  }
  const partial = new HeadingMap();
  for (let lap = 0; lap < 3; lap++) for (let h = 0; h < 60; h += 5) partial.add(h, 0.5);
  assert.equal(partial.best(), null, 'needs more turning');
  const flat = new HeadingMap();
  for (let lap = 0; lap < 3; lap++) for (let h = 0; h < 360; h += 5) flat.add(h, 0.5);
  assert.equal(flat.best().heading, null, 'uniform → no direction');
  assert.equal(turn(350, 10), 20); assert.equal(turn(10, 350), -20); assert.equal(hotCold(closeness(0, 5)), 'hot'); assert.equal(hotCold(closeness(0, 170)), 'cold');
  assert.ok(levelOf(0.3) > levelOf(0.01));
});

// ── night guardian ──────────────────────────────────────────────────────────

test('guardian: keeps night sounds, drops the rest, raises quiet-tier door/dog; summary counts', () => {
  const c = (group, tier, extra = {}) => ({ key: `yamnet:${group}`, group, tier, source: 'yamnet', lo: group, en: group, ...extra });
  const out = guardianFilter([c('fire_alarm', 'danger'), c('music', 'info'), c('door', 'info'), c('speech', 'info'),
    c('x', 'caution', { source: 'personal' }), c('novelty', 'caution', { source: 'novelty' })]);
  assert.deepEqual(out.map((x) => x.group), ['fire_alarm', 'door', 'x', 'novelty']);
  assert.equal(out.find((x) => x.group === 'door').tier, 'caution');
  for (const id of GUARDIAN_GROUPS) assert.ok(GROUPS.some((g) => g.id === id), `${id} is a real group`);
  const n = new NightSession(0);
  n.record({ t: 100, key: 'a', lo: 'A', tier: 'danger' }); n.record({ t: 200, key: 'a', lo: 'A', tier: 'danger' }); n.record({ t: 300, key: 'b', lo: 'B', tier: 'caution' });
  const s = n.summary(3600000);
  assert.equal(s.count, 3); assert.equal(s.top[0].count, 2); assert.equal(s.durationMs, 3600000);
  assert.equal(new NightSession(0).summary(1).first, null);
});

// ── persistence ─────────────────────────────────────────────────────────────

test('persistence: one-frame caution/info blips are dropped; danger and personal pass instantly', () => {
  const p = new Persistence(2, 700);
  const dog = { key: 'yamnet:dog', tier: 'caution', source: 'yamnet' };
  const horn = { key: 'yamnet:horn', tier: 'danger', source: 'yamnet' };
  const mine = { key: 'personal:1', tier: 'caution', source: 'personal' };
  assert.deepEqual(p.filter([dog, horn, mine], 0).map((c) => c.key), ['yamnet:horn', 'personal:1'], 'dog waits');
  assert.deepEqual(p.filter([], 100), [], 'gone → forgotten');
  assert.deepEqual(p.filter([dog], 200), [], 'blip again: still only one hit');
  assert.deepEqual(p.filter([dog], 300).map((c) => c.key), ['yamnet:dog'], 'second hit within the window');
  assert.deepEqual(p.filter([dog], 5000), [], 'old hits expire');
});

test('finder: tilt-safe heading, fast turns skipped, noisy/broad signals rejected, realistic mic recovers direction', () => {
  // flat phone: heading = 360 − alpha; upright phone facing the same way gives the same heading
  assert.ok(Math.abs(turn(compassHeading(90, 0, 0), 270)) < 1, `flat ${compassHeading(90, 0, 0)}`);
  assert.ok(Math.abs(turn(compassHeading(0, 90, 0), 0)) < 1, `upright ${compassHeading(0, 90, 0)}`);
  assert.ok(Math.abs(turn(compassHeading(0, 0, 0), 0)) < 1);

  // samples taken while spinning fast are discarded
  const fast = new HeadingMap();
  assert.equal(fast.add(0, 1, 0), true);
  assert.equal(fast.add(60, 1, 100), false, '600°/s is a blur');
  assert.equal(fast.add(63, 1, 300), true, '≈ 15°/s is fine');

  // 2 slow laps, a ~14 dB front/back phone mic, room noise and a weak wall echo → within ~45°
  let seed = 5; const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const trial = (target) => {
    const m = new HeadingMap();
    let t = 0;
    for (let lap = 0; lap < 2; lap++) for (let h = 0; h < 360; h += 2) {
      t += 140; // ≈ 14°/s
      const pattern = 0.6 + 0.4 * Math.cos(((h - target) * Math.PI) / 180);           // mic directivity
      const reflection = 0.06 * Math.cos(((h - (target + 150)) * Math.PI) / 180);       // a wall echo
      for (let k = 0; k < 6; k++) m.add(h, Math.max(0, 0.15 + 0.42 * (pattern + reflection) * (0.85 + 0.3 * r()) + 0.05 * r()), t + k * 20);
    }
    return m.best();
  };
  let worst = 0;
  for (const target of [20, 100, 185, 260, 340]) {
    const b = trial(target);
    worst = Math.max(worst, b.heading === null ? 360 : Math.abs(turn(b.heading, target)));
  }
  assert.ok(worst <= 45, `worst error ${worst}°`);   // honest bound: a loudness compass is ±10–45°, not precise
});
