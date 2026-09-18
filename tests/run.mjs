// npm test — runs against the real bundled YAMNet model on the CPU backend.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { TIERS, GROUPS } from '../js/labels.js';
import { yamnetCandidates, rankCandidates, Cooldown, defaultThreshold, suggestThreshold } from '../js/detector.js';
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

test('label map: valid, unique classes, icon + Lao + English on every group', () => {
  const seen = new Set();
  for (const g of GROUPS) {
    assert.ok(TIERS[g.tier], `${g.id} tier`);
    assert.ok(g.icon && g.lo && g.en, `${g.id} icon/lo/en`);
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

test('synthetic horn → danger alert with icon', async () => {
  const { scores } = await yam.classify(mix(horn(WINDOW, 0.4), noise(WINDOW, 0.02)));
  const top = rankCandidates(yamnetCandidates(scores))[0];
  assert.equal(top?.group, 'horn');
  assert.equal(top.tier, 'danger');
  assert.equal(top.icon, '📯');
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
    { key: 'yamnet:horn', en: 'Vehicle horn', lo: 'ມີສຽງແກລົດ', tier: 'danger', source: 'yamnet', confidence: 0.71, t: now - 4000, icon: '📯' },
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
