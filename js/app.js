import { MicStream, RingBuffer, rms, SAMPLE_RATE } from './audio.js';
import { loadYamnet, WINDOW } from './yamnet.js';
import { TIERS, GROUPS, PERSONAL_ICON } from './labels.js';
import { LevelTrend, APPROACH } from './approach.js';
import { BackgroundPool, HEAD, headProb, withHead, addHardNegative } from './head.js';
import { SceneModel, SCENES, sceneOverrides } from './scene.js';
import { NoveltyDetector, NOVEL_ALERT } from './novelty.js';
import { estimatePitch, PitchTrend } from './pitch.js';
import { Flash, Band, bandLevel } from './outputs.js';
import { loadTimeline, saveTimeline, addRecord, summarize } from './timeline.js';
import { Spectrogram, bandLevels, cellColor } from './viz.js';
import { demoScenario, DEMO_SECONDS } from './demo.js';
import { CrossingController } from './crossing.js';
import { HeadingMap, compassHeading, levelOf, turn, closeness, norm360 } from './finder.js';
import { GUARDIAN, guardianFilter, NightSession } from './guardian.js';
import { assessRisk, vibrationFor, Snooze } from './risk.js';
import { Persistence, yamnetCandidates, rankCandidates, topClasses, Cooldown, defaultThreshold, suggestThreshold } from './detector.js';
import {
  PersonalMatcher, clipVector, consistency, buildSound,
  listSounds, putSound, deleteSound,
  CLIPS_PER_SOUND, CLIP_SAMPLES, CLIP_PREROLL,
} from './library.js';
import { narrate } from './narrate.js';

// Latency budget (spec: sound → vibration ≤ 200 ms). YAMNet already detects a
// horn with ~50 ms of it in the window, so the budget is spent waiting for the
// next analysis. Steady state: analyze every 100 ms. When a sudden loud sound
// starts, analyze every 40 ms for the next 600 ms. If inference is slower than
// the hop on a weak phone, windows are skipped rather than queued.
const HOP = Math.round(SAMPLE_RATE * 0.1);
const HOP_BURST = Math.round(SAMPLE_RATE * 0.04);
const BURST_MS = 600;
const ONSET_RATIO = 2.5;       // chunk loudness vs. running noise floor
const ONSET_MIN_RMS = 0.004;
const ONSET_LEAD = Math.round(SAMPLE_RATE * 0.04);
const HOLD_MS = 4000;                       // how long an alert stays on screen
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
const APPROACH_LO = 'ກຳລັງເຂົ້າມາໃກ້'; // "getting closer"
const FULLSCREEN_TIERS = new Set(['danger', 'caution']);
const $ = (id) => document.getElementById(id);

// ── persisted settings & metrics (localStorage, this device only) ───────────

const DEFAULT_SETTINGS = {
  sensitivity: 1,
  showInfo: true,
  vibrateInfo: false,
  notify: false,
  flash: false,
  guideSeen: false,
  thresholds: {},   // field-tuned overrides: { [groupId]: threshold }
  narration: { enabled: false, endpoint: 'https://api.anthropic.com/v1/messages', apiKey: '', model: 'claude-opus-5' },
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ? { ...fallback, ...v, ...(fallback.narration && { narration: { ...fallback.narration, ...v.narration } }) } : structuredClone(fallback);
  } catch { return structuredClone(fallback); }
}
const settings = load('deafsound.settings', DEFAULT_SETTINGS);
const saveSettings = () => localStorage.setItem('deafsound.settings', JSON.stringify(settings));

const EMPTY_METRICS = { alerts: {}, latencyMs: [], inferMs: [], registrations: [] };
let metrics = load('deafsound.metrics', EMPTY_METRICS);
const saveMetrics = () => localStorage.setItem('deafsound.metrics', JSON.stringify(metrics));
const pushCapped = (arr, v, n = 200) => { arr.push(Math.round(v)); if (arr.length > n) arr.shift(); };

// ── runtime state ───────────────────────────────────────────────────────────

const ring = new RingBuffer(SAMPLE_RATE * 4);
const matcher = new PersonalMatcher();
matcher.verify = (sound, e) => headProb(sound.head, e);
const cooldown = new Cooldown();
const persistence = new Persistence();
const log = [];                 // recent events, in memory only
let yamnetPromise = null;
let yam = null;
let mic = null;
let busy = false;
let lastInferTotal = 0;
let lastChunkAt = 0;
let pendingCapture = null;
let wakeLock = null;
let shown = null;               // event currently on screen
let holdTimer = null;

// ── startup ─────────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

function updateNetPill() {
  const pill = $('pill-net');
  pill.textContent = navigator.onLine ? 'ອອນລາຍ' : 'ອອບລາຍ';
  pill.classList.toggle('on', navigator.onLine);
}
addEventListener('online', updateNetPill);
addEventListener('offline', updateNetPill);
updateNetPill();

function setState(text, on = false) {
  $('pill-state').textContent = text;
  $('pill-state').classList.toggle('on', on);
}

// ── listening ───────────────────────────────────────────────────────────────

function getYamnet() {
  yamnetPromise ??= loadYamnet({ tf: window.tf }).then((m) => {
    yam = m;
    console.log(`[DeafSound] YAMNet ready on ${m.backend}`);
    return m;
  }).catch((err) => {
    yamnetPromise = null; // allow retry on next Start
    throw err;
  });
  return yamnetPromise;
}

async function start() {
  if (mic) return;
  const btn = $('btn-start');
  btn.disabled = true;
  setState('ກຳລັງໂຫຼດ…');
  showIdle('ກຳລັງໂຫຼດໂມເດວ…', 'Loading on-device model');
  try {
    await getYamnet();
    mic = new MicStream((chunk, t) => { if (!demoActive) onChunk(chunk, t); });
    const { contextRate } = await mic.start();
    console.log(`[DeafSound] mic running, context ${contextRate} Hz`);
    await acquireWakeLock();
    setState('ກຳລັງຟັງ', true);
    showIdle();
    btn.textContent = 'ຢຸດຟັງ';
    btn.classList.add('stop');
  } catch (err) {
    console.error(err);
    mic = null;
    setState('ຢຸດ');
    const denied = err.name === 'NotAllowedError';
    showIdle(denied ? 'ບໍ່ໄດ້ຮັບອະນຸຍາດໃຊ້ໄມໂຄຣໂຟນ' : 'ເລີ່ມບໍ່ໄດ້', `${err.name}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function stop() {
  await mic?.stop();
  mic = null;
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
  updateScreenWarn();
  setState('ຢຸດ');
  $('btn-start').textContent = 'ເລີ່ມຟັງ';
  $('btn-start').classList.remove('stop');
  $('meter-bar').style.width = '0';
  showIdle('ກົດ “ເລີ່ມຟັງ”', 'Tap Start to listen');
}

// A web app can't listen reliably once the screen turns off, so keep it on and
// tell the user whenever we can't.
async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => {
      wakeLock = null;
      updateScreenWarn();
      if (mic && document.visibilityState === 'visible') acquireWakeLock();
    });
  } catch {
    wakeLock = null;
  }
  updateScreenWarn();
}

function updateScreenWarn() {
  const unsupported = !('wakeLock' in navigator);
  $('screen-warn').hidden = !mic || (!!wakeLock && !wakeLock.released);
  $('screen-warn-detail').textContent = unsupported
    ? "This browser can't keep the screen on. Set a long screen timeout in phone settings."
    : 'Screen may turn off and listening can stop. Tap the page to keep it on.';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mic) acquireWakeLock();
});
document.addEventListener('click', () => {
  if (mic && !wakeLock) acquireWakeLock();
});

const trend = new LevelTrend();
const bgPool = new BackgroundPool();
const snooze = new Snooze();
const scene = new SceneModel();
const pitchTrend = new PitchTrend();
const flash = new Flash();
const band = new Band();
const timeline = loadTimeline();
const PASSED_LO = 'ຜ່ານໄປແລ້ວ'; // "has passed"
const passedAt = new Map();
const novelty = new NoveltyDetector();
let lastScene = null;
let lastLevel = 0;
let poolTick = 0;
const approachAlerted = new Map(); // key → time of last escalation
let noiseFloor = 0;
let burstUntil = 0;

function onChunk(chunk, receivedAt) {
  ring.push(chunk);
  lastChunkAt = receivedAt;
  const level = rms(chunk);
  $('meter-bar').style.width = `${Math.min(100, level * 400)}%`;
  if (mode === 'finder') finderSample(level);

  // Onset detection: a chunk much louder than the recent floor starts a burst
  // of faster analysis. The floor follows quiet quickly and loud slowly.
  if (level > ONSET_MIN_RMS && level > noiseFloor * ONSET_RATIO) {
    // First analysis lands ONSET_LEAD after the onset (enough sound in the
    // window for YAMNet), instead of wherever the regular schedule falls.
    if (receivedAt >= burstUntil) lastInferTotal = Math.min(lastInferTotal, ring.total - HOP_BURST + ONSET_LEAD);
    burstUntil = receivedAt + BURST_MS;
  }
  noiseFloor = noiseFloor === 0 ? level : noiseFloor + (level - noiseFloor) * (level < noiseFloor ? 0.2 : 0.01);
  const hop = receivedAt < burstUntil ? HOP_BURST : HOP;

  if (pendingCapture && ring.total >= pendingCapture.end) {
    const { start, resolve } = pendingCapture;
    pendingCapture = null;
    resolve(ring.slice(start, CLIP_SAMPLES));
  }

  if (!busy && yam && ring.total >= WINDOW && ring.total - lastInferTotal >= hop) infer();
}

async function infer() {
  busy = true;
  lastInferTotal = ring.total;
  const arrivedAt = lastChunkAt;
  try {
    const win = ring.latest(WINDOW);
    const liveRms = rms(win);
    trend.push(Date.now(), liveRms);
    lastLevel = liveRms;
    pitchTrend.push(Date.now(), estimatePitch(win));
    const t0 = performance.now();
    const { scores, embedding } = await yam.classify(win);
    const inferMs = performance.now() - t0;

    scene.update(scores, Date.now());
    onAnalysis(scores, liveRms);
    const sceneNow = scene.current();
    if (sceneNow !== lastScene) { lastScene = sceneNow; renderScene(sceneNow); }
    let cands = yamnetCandidates(scores, sensitivity(), sceneOverrides(sceneNow, GROUPS, defaultThreshold, settings.thresholds));
    if (!settings.showInfo) cands = cands.filter((c) => c.tier !== 'info');
    cands = persistence.filter(cands, Date.now());

    if (matcher.sounds.length) {
      const { results } = matcher.match(embedding, liveRms);
      for (const r of results) {
        if (r.hit) cands.push({ key: `personal:${r.sound.id}`, source: 'personal', emb: embedding, icon: PERSONAL_ICON, tier: r.sound.tier, lo: r.sound.name, en: r.sound.en ?? r.sound.name, confidence: r.sim });
      }
      updateLiveSims(results);
    }

    // Unknown-but-loud sounds: nothing above caution matched, yet it is unlike the recent background.
    const known = cands.some((c) => c.tier !== 'info');
    const nv = novelty.check({ embedding, pool: bgPool.items, rms: liveRms, noiseFloor, known, now: Date.now() });
    if (nv.fire) cands.push({ ...NOVEL_ALERT, confidence: Math.min(1, nv.novelty) });

    // Feed the background pool from ordinary moments (~2/s); then train heads
    // for personal sounds that don't have one yet.
    if (!known && !nv.fire && liveRms > 0.002 && ++poolTick % 5 === 0) {
      bgPool.add(embedding);
      if (bgPool.items.length === HEAD.minNegatives) trainMissingHeads();
    }

    handleCandidates(rankCandidates(cands), arrivedAt);
    pushCapped(metrics.inferMs, inferMs);
    logTop(scores, inferMs);
    updateDebug(scores, inferMs, liveRms);
  } catch (err) {
    console.error('[DeafSound] inference failed', err);
  } finally {
    busy = false;
  }
}

function renderScene(id) {
  const sc = SCENES[id];
  $('scene').textContent = sc ? `${sc.icon} ${sc.lo} · ${sc.en}` : id === 'mixed' ? 'ສຽງປະສົມ · Mixed surroundings' : 'ງຽບ · Quiet surroundings';
}

function handleCandidates(cands, arrivedAt) {
  const now = Date.now();
  cands = cands.filter((c) => !snooze.isSnoozed(c.key, now));
  cands = modeFilter(cands);
  if (cands.length === 0) return;

  // Same sound still going → keep it on screen.
  if (shown && cands.some((c) => c.key === shown.key)) extendHold();

  // A moving source that keeps getting louder is coming toward the user:
  // escalate once (stronger buzz, "getting closer" text) even inside cooldown.
  const mover = cands.find((c) => GROUP_BY_ID.get(c.group)?.moving && c.tier !== 'info');
  const pitch = pitchTrend.state();
  if (mover && pitch === 'falling' && trend.state() !== 'approaching' && now - (passedAt.get(mover.key) ?? 0) > APPROACH.realertMs) {
    // Pitch dropping while the level stops climbing: it just went past.
    passedAt.set(mover.key, now);
    const ev = { ...mover, passed: true, t: now, id: `${now}-${mover.key}-passed` };
    log.push(ev);
    navigator.vibrate?.([150]);
    showAlert(ev);
    record(ev);
    return;
  }
  if (mover && pitch !== 'falling' && trend.state() === 'approaching' && now - (approachAlerted.get(mover.key) ?? 0) > APPROACH.realertMs) {
    approachAlerted.set(mover.key, now);
    const risk = assessRisk({ tier: mover.tier, confidence: mover.confidence, approaching: true, level: lastLevel });
    const ev = { ...mover, approach: true, risk, t: now, id: `${now}-${mover.key}-approach` };
    log.push(ev);
    const pattern = risk.level === 'critical' ? vibrationFor(mover.tier, risk) : APPROACH.vibrate;
    navigator.vibrate?.(pattern);
    external(pattern, mover.tier, risk);
    showAlert(ev);
    record(ev);
    return;
  }

  const fresh = cands.filter((c) => cooldown.ready(c.key, c.tier, now));
  if (fresh.length === 0) return;

  for (const c of fresh) {
    const ev = { ...c, risk: assessRisk({ tier: c.tier, confidence: c.confidence, level: lastLevel }), t: now, id: `${now}-${c.key}` };
    log.push(ev);
    const m = (metrics.alerts[c.key] ??= { label: c.lo, tier: c.tier, count: 0, wrong: 0 });
    m.count++;
  }
  if (log.length > 300) log.splice(0, log.length - 300);

  const top = log[log.length - fresh.length]; // fresh is ranked, first pushed = top
  const outranked = shown && TIERS[shown.tier].rank > TIERS[top.tier].rank;
  if (!outranked) {
    const shouldVibrate = top.tier !== 'info' || settings.vibrateInfo;
    if (shouldVibrate) {
      const pattern = vibrationFor(top.tier, top.risk);
      navigator.vibrate?.(pattern);
      external(pattern, top.tier, top.risk);
      pushCapped(metrics.latencyMs, performance.now() - arrivedAt);
    }
    showAlert(top);
    if (document.hidden && settings.notify && top.tier !== 'info') notify(top);
    console.log(`[DeafSound] ALERT ${top.tier} ${top.en} ${(top.confidence * 100).toFixed(0)}%`);
  }

  for (const ev of log.slice(-fresh.length)) { record(ev); onAlertInMode(ev); }
  saveMetrics();
}

// Flash / band outputs (settings-gated) and the persistent timeline.
function external(pattern, tier, risk) {
  if (settings.flash) flash.play(pattern);
  band.alert(bandLevel(tier, risk));
}

function record(ev) {
  addRecord(timeline, ev);
  saveTimeline(timeline);
  renderEvents();
  renderToday();
}

// ── alert display ───────────────────────────────────────────────────────────

function restartFlash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

const lo = (ev) => (ev.approach ? `${ev.lo} · ${APPROACH_LO}` : ev.passed ? `${ev.lo} · ${PASSED_LO}` : ev.lo);
const metaOf = (ev, meta) => (ev.approach ? `↗ Getting closer · ${meta}` : ev.passed ? `↘ Passed you · ${meta}` : meta);

function showAlert(ev) {
  shown = ev;
  const icon = ev.icon ?? TIERS[ev.tier].icon;
  const tierLabel = `${ev.risk?.level === 'critical' ? '‼ ' : ''}${TIERS[ev.tier].lo}${ev.source === 'personal' ? ' · ສຽງຂອງຂ້ອຍ' : ''}`;
  const meta = `${ev.en} · ${Math.round(ev.confidence * 100)}%`;
  const canMarkWrong = ev.source !== 'test';

  const card = $('alert');
  card.className = `alert tier-${ev.tier}`;
  restartFlash(card);
  $('alert-icon').textContent = icon;
  $('alert-tier').textContent = tierLabel;
  $('alert-text').textContent = lo(ev);
  $('alert-meta').textContent = metaOf(ev, meta);
  $('btn-wrong').hidden = !canMarkWrong;
  const canSnooze = ev.source !== 'test' && ev.tier !== 'danger';
  $('btn-snooze').hidden = !canSnooze;
  $('ov-snooze').hidden = !canSnooze;

  // Danger and caution take over the whole screen; info stays in the card so
  // everyday sounds like speech don't keep covering the app.
  const overlay = $('overlay');
  if (FULLSCREEN_TIERS.has(ev.tier)) {
    overlay.className = `overlay tier-${ev.tier}`;
    $('ov-tier').textContent = `${TIERS[ev.tier].icon} ${tierLabel}`;
    $('ov-icon').textContent = icon;
    $('ov-text').textContent = lo(ev);
    $('ov-meta').textContent = metaOf(ev, meta);
    $('ov-wrong').hidden = !canMarkWrong;
    overlay.hidden = false;
    restartFlash(overlay);
    // Move focus only if the user isn't typing somewhere else.
    const active = document.activeElement;
    if (!active || active === document.body || overlay.contains(active) || active.tagName === 'BUTTON') $('ov-close').focus({ preventScroll: true });
  } else {
    overlay.hidden = true;
  }
  extendHold();
}

function extendHold() {
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => showIdle(), HOLD_MS);
}

function showIdle(text, meta) {
  shown = null;
  clearTimeout(holdTimer);
  $('overlay').hidden = true;
  $('alert').className = 'alert tier-idle';
  $('alert-icon').textContent = '';
  $('alert-tier').textContent = '';
  $('alert-text').textContent = text ?? (mic ? 'ກຳລັງຟັງ…' : 'ກົດ “ເລີ່ມຟັງ”');
  $('alert-meta').textContent = meta ?? (mic ? 'ບໍ່ມີສຽງທີ່ຕ້ອງລະວັງ · Listening' : 'Tap Start to listen');
  $('btn-wrong').hidden = true;
  $('btn-snooze').hidden = true;
}

function markWrong() {
  if (!shown) return;
  const m = metrics.alerts[shown.key];
  if (m) {
    m.wrong++;
    (m.wrongConf ??= []).push(Math.round(shown.confidence * 100) / 100);
    if (m.wrongConf.length > 50) m.wrongConf.shift();
  }
  const ev = log.find((e) => e.id === shown.id);
  if (ev) {
    ev.wrong = true;
    const rec = timeline.find((r) => r.t === ev.t && r.key === ev.key);
    if (rec) { rec.wrong = true; saveTimeline(timeline); renderToday(); }
  }
  if (shown.source === 'personal' && shown.emb) learnFromWrong(shown);
  saveMetrics();
  renderEvents();
  showIdle();
}

$('btn-wrong').addEventListener('click', markWrong);
$('ov-wrong').addEventListener('click', markWrong);
$('ov-close').addEventListener('click', () => showIdle());
function snoozeShown() {
  if (shown && snooze.snooze(shown.key, shown.tier, Date.now())) showIdle('ປິດສຽງນີ້ 10 ນາທີ', 'Snoozed for 10 minutes');
}
$('btn-snooze').addEventListener('click', snoozeShown);
$('ov-snooze').addEventListener('click', snoozeShown);

// ── verifier head (second model) ────────────────────────────────────────────

const otherCentroids = (id) => matcher.sounds.filter((x) => x.id !== id).map((x) => x.centroid);

async function trainMissingHeads() {
  for (const s of matcher.sounds) {
    if (s.head) continue;
    await putSound(withHead(stored(s), bgPool.items, otherCentroids(s.id)));
  }
  matcher.setSounds(await listSounds());
}

async function learnFromWrong(ev) {
  const id = ev.key.slice('personal:'.length);
  const s = matcher.sounds.find((x) => x.id === id);
  if (!s) return;
  await putSound(addHardNegative(stored(s), ev.emb, bgPool.items, otherCentroids(id)));
  matcher.setSounds(await listSounds());
}

// matcher.sounds carry a derived `vec`; strip it before saving.
function stored({ vec, ...rest }) { return rest; }

async function notify(ev) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.ready;
  reg?.showNotification(ev.lo, {
    body: `${TIERS[ev.tier].lo} · ${ev.en}`,
    tag: ev.key,
    renotify: true,
    vibrate: TIERS[ev.tier].vibrate,
    icon: 'icon.svg',
  });
}

// ── recent events ───────────────────────────────────────────────────────────

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} ວິນາທີກ່ອນ` : `${Math.round(s / 60)} ນາທີກ່ອນ`;
}

function renderEvents() {
  const ol = $('events');
  ol.replaceChildren(...log.slice(-20).reverse().map((e) => {
    const li = document.createElement('li');
    li.className = `tier-${e.tier}`;
    const left = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = e.lo + (e.wrong ? ' ✕' : '');
    left.append(lbl);
    if (e.source === 'personal') {
      const tag = document.createElement('span');
      tag.className = 'tag-personal';
      tag.textContent = 'ສຽງຂອງຂ້ອຍ';
      left.append(tag);
    }
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${Math.round(e.confidence * 100)}% · ${ago(e.t)}`;
    li.append(left, when);
    return li;
  }));
}
setInterval(() => { if (log.length && !document.hidden) renderEvents(); }, 5000);

// ── narration (on tap only) ─────────────────────────────────────────────────

$('btn-narrate').addEventListener('click', async () => {
  const btn = $('btn-narrate');
  btn.disabled = true;
  $('narration').hidden = false;
  $('narration-text').textContent = '…';
  $('narration-meta').textContent = '';
  const res = await narrate(log.filter((e) => !e.wrong), settings.narration);
  $('narration-text').textContent = res.text;
  $('narration-meta').textContent = res.source === 'llm'
    ? `AI · ${res.model ?? settings.narration.model}`
    : `ສະຫຼຸບໃນເຄື່ອງ · local summary${res.note ? ` (${res.note})` : ''}`;
  if (res.detail) console.warn('[DeafSound] narration error', res.detail);
  btn.disabled = false;
});

// ── debug panel ─────────────────────────────────────────────────────────────

let lastLog = 0;
function logTop(scores, inferMs) {
  if (performance.now() - lastLog < 1000) return;
  lastLog = performance.now();
  const top = topClasses(scores, yam.classNames, 3).map((c) => `${c.name} ${c.score.toFixed(2)}`).join(' | ');
  console.log(`[DeafSound] ${inferMs.toFixed(0)} ms · ${top}`);
}

let lastDebug = 0;
function updateDebug(scores, inferMs, liveRms) {
  if (!$('debug').open || performance.now() - lastDebug < 250) return;
  lastDebug = performance.now();
  $('debug-stats').textContent = `backend ${yam.backend} · infer ${inferMs.toFixed(0)} ms · rms ${liveRms.toFixed(4)}`;
  $('debug-top').replaceChildren(...topClasses(scores, yam.classNames, 5).map((c) => {
    const li = document.createElement('li');
    li.textContent = `${c.score.toFixed(2)}  ${c.name}`;
    return li;
  }));
}

// ── personal library ────────────────────────────────────────────────────────

const reg = { clips: [], firstTap: 0, busy: false };
const simEls = new Map();

function regStatus(text) { $('reg-status').textContent = text; }

function renderRegDots() {
  [...$('reg-dots').children].forEach((d, i) => {
    d.className = i < reg.clips.length ? 'done' : (reg.busy && i === reg.clips.length ? 'busy' : '');
  });
  const n = reg.clips.length;
  $('btn-record').textContent = n < CLIPS_PER_SOUND ? `ອັດສຽງ ຄັ້ງທີ ${n + 1}` : 'ຄົບ 3 ຄັ້ງແລ້ວ';
  $('btn-record').disabled = reg.busy || n >= CLIPS_PER_SOUND;
  $('btn-save').disabled = n < CLIPS_PER_SOUND || reg.busy;
}

function resetReg() {
  reg.clips = [];
  reg.firstTap = 0;
  reg.busy = false;
  regStatus('ກົດປຸ່ມ ແລ້ວເຮັດສຽງນັ້ນ 3 ຄັ້ງ');
  renderRegDots();
}

function captureClip() {
  return new Promise((resolve) => {
    const startAt = Math.max(0, ring.total - CLIP_PREROLL);
    pendingCapture = { start: startAt, end: startAt + CLIP_SAMPLES, resolve };
  });
}

$('btn-record').addEventListener('click', async () => {
  if (reg.busy || reg.clips.length >= CLIPS_PER_SOUND) return;
  reg.busy = true;
  renderRegDots();
  if (!mic) await start();
  if (!mic) { reg.busy = false; renderRegDots(); regStatus('ເປີດໄມໂຄຣໂຟນບໍ່ໄດ້'); return; }
  if (!reg.firstTap) reg.firstTap = performance.now();

  regStatus('🔴 ເຮັດສຽງດຽວນີ້! (2 ວິນາທີ)');
  const clip = await captureClip();
  regStatus('ກຳລັງວິເຄາະ…');
  const frames = await yam.run(clip);
  const { vector } = clipVector(clip, frames);
  reg.busy = false;

  if (!vector) {
    regStatus('ສຽງເບົາເກີນໄປ — ເຂົ້າໃກ້ ແລ້ວລອງໃໝ່');
  } else {
    reg.clips.push(vector);
    if (reg.clips.length < CLIPS_PER_SOUND) {
      regStatus(`ດີ ✓ ອີກ ${CLIPS_PER_SOUND - reg.clips.length} ຄັ້ງ`);
    } else {
      const c = consistency(reg.clips);
      regStatus(c >= 0.85 ? `ດີຫຼາຍ ✓ ສຽງຄືກັນ (${c.toFixed(2)}) — ໃສ່ຊື່ ແລ້ວບັນທຶກ`
        : c >= 0.75 ? `ພໍໃຊ້ໄດ້ (${c.toFixed(2)}) — ໃສ່ຊື່ ແລ້ວບັນທຶກ`
          : `ສຽງບໍ່ຄືກັນປານໃດ (${c.toFixed(2)}) — ແນະນຳໃຫ້ເລີ່ມໃໝ່`);
    }
  }
  renderRegDots();
});

$('btn-reg-reset').addEventListener('click', resetReg);

$('btn-save').addEventListener('click', async () => {
  const name = $('reg-name').value.trim();
  if (!name) { regStatus('ໃສ່ຊື່ສຽງກ່ອນ'); $('reg-name').focus(); return; }
  const tier = document.querySelector('#reg-tier input:checked').value;
  const registerMs = Math.round(performance.now() - reg.firstTap);
  const sound = withHead(buildSound({ name, tier, clipVecs: reg.clips, registerMs }), bgPool.items, otherCentroids(null));
  await putSound(sound);
  metrics.registrations.push({ name, tier, registerMs, pairMin: sound.pairMin, threshold: sound.threshold, at: Date.now() });
  saveMetrics();
  $('reg-name').value = '';
  resetReg();
  regStatus(`ບັນທຶກແລ້ວ ✓ ໃຊ້ເວລາ ${(registerMs / 1000).toFixed(1)} ວິນາທີ`);
  await refreshSounds();
});

async function refreshSounds() {
  const sounds = await listSounds();
  sounds.sort((a, b) => b.createdAt - a.createdAt);
  matcher.setSounds(sounds);
  simEls.clear();
  $('sounds').replaceChildren(...sounds.map(renderSound));
  if (sounds.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'ຍັງບໍ່ມີ. ບັນທຶກສຽງກະດິ່ງປະຕູ, ສຽງເອີ້ນຊື່, ຫຼື ສຽງແກລົດທີ່ທ່ານຮູ້ຈັກ.';
    $('sounds').append(li);
  }
  await renderPack(); // an added or deleted pack sound changes what's offered
}

function renderSound(s) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="head"><span class="name"></span><span class="sim">—</span></div>
    <div class="muted meta"></div>
    <div class="actions">
      <span class="muted">ເກນ</span>
      <input type="range" min="0.6" max="0.98" step="0.01" aria-label="Match threshold">
      <b class="thr"></b>
      <button class="del">ລຶບ</button>
    </div>`;
  li.querySelector('.name').textContent = s.name;
  li.querySelector('.meta').textContent = s.packId
    ? `${TIERS[s.tier].lo} · ຊຸດສຳເລັດຮູບ · ${s.en ?? ''}`
    : `${TIERS[s.tier].lo} · ຄວາມຄືກັນ ${s.pairMin} · ${(s.registerMs / 1000).toFixed(1)} ວິ`;
  const slider = li.querySelector('input');
  const thr = li.querySelector('.thr');
  slider.value = s.threshold;
  thr.textContent = s.threshold.toFixed(2);
  slider.addEventListener('input', () => { thr.textContent = Number(slider.value).toFixed(2); });
  slider.addEventListener('change', async () => {
    s.threshold = Number(slider.value);
    await putSound(s);
    matcher.setSounds(await listSounds());
  });
  const del = li.querySelector('.del');
  del.addEventListener('click', async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = '1';
      del.textContent = 'ກົດອີກຄັ້ງເພື່ອລຶບ';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'ລຶບ'; }, 3000);
      return;
    }
    await deleteSound(s.id);
    await refreshSounds();
  });
  simEls.set(s.id, li.querySelector('.sim'));
  return li;
}

function updateLiveSims(results) {
  if ($('view-library').hidden) return;
  for (const r of results) {
    const el = simEls.get(r.sound.id);
    if (!el) continue;
    el.textContent = r.sim.toFixed(2);
    el.classList.toggle('hit', r.hit);
  }
}

// ── settings ────────────────────────────────────────────────────────────────

function bindSettings() {
  const sens = $('set-sens');
  sens.value = settings.sensitivity;
  $('sens-val').textContent = `×${settings.sensitivity.toFixed(1)}`;
  sens.addEventListener('input', () => {
    settings.sensitivity = Number(sens.value);
    $('sens-val').textContent = `×${settings.sensitivity.toFixed(1)}`;
    saveSettings();
  });

  const checkbox = (id, get, set) => {
    $(id).checked = get();
    $(id).addEventListener('change', () => { set($(id).checked); saveSettings(); });
  };
  checkbox('set-info', () => settings.showInfo, (v) => { settings.showInfo = v; });
  checkbox('set-vib-info', () => settings.vibrateInfo, (v) => { settings.vibrateInfo = v; });
  checkbox('set-llm', () => settings.narration.enabled, (v) => { settings.narration.enabled = v; });
  checkbox('set-flash', () => settings.flash, async (v) => {
    settings.flash = v && (await flash.enable());
    $('set-flash').checked = settings.flash;
    if (!v) flash.disable();
    saveSettings();
  });
  if (band.supported) {
    $('btn-band').hidden = false;
    $('btn-band').addEventListener('click', async () => {
      const ok = await band.connect();
      $('btn-band').textContent = ok ? 'ເຊື່ອມຕໍ່ແລ້ວ ✓ Band connected' : 'ເຊື່ອມຕໍ່ບໍ່ໄດ້ · Could not connect';
    });
  }
  checkbox('set-notify', () => settings.notify, async (v) => {
    settings.notify = v;
    if (v && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  });

  const text = (id, key) => {
    $(id).value = settings.narration[key];
    $(id).addEventListener('change', () => { settings.narration[key] = $(id).value.trim(); saveSettings(); });
  };
  text('set-endpoint', 'endpoint');
  text('set-key', 'apiKey');
  text('set-model', 'model');

  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => {
    const tier = b.dataset.test;
    navigator.vibrate?.(TIERS[tier].vibrate);
    showAlert({ key: `test:${tier}`, source: 'test', tier, lo: `ທົດສອບ ${TIERS[tier].lo}`, en: `Test · ${TIERS[tier].en}`, confidence: 1 });
  }));

  $('btn-guide').addEventListener('click', () => openGuide());

  $('btn-copy-thr').addEventListener('click', async () => {
    const btn = $('btn-copy-thr');
    try { await navigator.clipboard.writeText(JSON.stringify(settings.thresholds, null, 2)); btn.textContent = 'Copied ✓'; }
    catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy overrides JSON'; }, 2000);
  });
  $('btn-reset-thr').addEventListener('click', () => {
    settings.thresholds = {};
    saveSettings();
    renderThresholds();
  });

  $('btn-copy-metrics').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(metrics, null, 2)); $('btn-copy-metrics').textContent = 'Copied ✓'; }
    catch { $('btn-copy-metrics').textContent = 'Copy failed'; }
    setTimeout(() => { $('btn-copy-metrics').textContent = 'Copy JSON'; }, 2000);
  });
  $('btn-reset-metrics').addEventListener('click', () => {
    metrics = structuredClone(EMPTY_METRICS);
    saveMetrics();
    renderMetrics();
  });
}

function pct(arr, p) {
  if (!arr.length) return '—';
  const s = [...arr].sort((a, b) => a - b);
  return `${s[Math.min(s.length - 1, Math.floor(p * s.length))]} ms`;
}

function renderMetrics() {
  const lines = [
    `sound → vibrate   p50 ${pct(metrics.latencyMs, 0.5)}   p95 ${pct(metrics.latencyMs, 0.95)}   (n=${metrics.latencyMs.length})`,
    `inference         p50 ${pct(metrics.inferMs, 0.5)}   p95 ${pct(metrics.inferMs, 0.95)}`,
    '',
    'registrations:',
    ...metrics.registrations.map((r) => `  ${r.name}: ${(r.registerMs / 1000).toFixed(1)} s, consistency ${r.pairMin}`),
    '',
    'alerts (count / marked wrong):',
    ...Object.entries(metrics.alerts)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, m]) => {
        const fp = m.count ? `  (${Math.round((100 * m.wrong) / m.count)}% FP)` : '';
        const group = GROUPS.find((g) => `yamnet:${g.id}` === k);
        const current = group && (settings.thresholds[group.id] ?? defaultThreshold(group));
        const s = group && suggestThreshold(m.wrongConf, current);
        return `  ${m.label}  ${m.count} / ${m.wrong}${fp}${s ? `  → suggest threshold ${s}` : ''}   [${k}]`;
      }),
  ];
  $('metrics').textContent = lines.join('\n');
}

// ── field threshold tuning ──────────────────────────────────────────────────

function renderThresholds() {
  $('thresholds').replaceChildren(...GROUPS.map((g) => {
    const li = document.createElement('li');
    const def = defaultThreshold(g);
    const override = settings.thresholds[g.id];
    const current = override ?? def;
    li.className = override !== undefined ? 't-changed' : '';
    li.innerHTML = `
      <div class="t-head"><span class="t-name"></span><small class="t-tier"></small></div>
      <div class="t-row">
        <input type="range" min="0.10" max="0.95" step="0.01">
        <span class="t-val"></span>
      </div>`;
    li.querySelector('.t-name').textContent = `${g.icon} ${g.lo}`;
    li.querySelector('.t-tier').textContent = `${g.en} · ${TIERS[g.tier].en} · default ${def.toFixed(2)}`;
    const slider = li.querySelector('input');
    slider.setAttribute('aria-label', `${g.en} threshold`);
    const val = li.querySelector('.t-val');
    slider.value = current;
    val.textContent = current.toFixed(2);

    const apply = (v) => {
      if (Math.abs(v - def) < 0.005) delete settings.thresholds[g.id];
      else settings.thresholds[g.id] = Math.round(v * 100) / 100;
      saveSettings();
      renderThresholds();
    };
    slider.addEventListener('input', () => { val.textContent = Number(slider.value).toFixed(2); });
    slider.addEventListener('change', () => apply(Number(slider.value)));

    const suggestion = suggestThreshold(metrics.alerts[`yamnet:${g.id}`]?.wrongConf, current);
    if (suggestion) {
      const btn = document.createElement('button');
      btn.className = 't-suggest';
      btn.textContent = `Suggested ${suggestion.toFixed(2)} (from false alarms) · apply`;
      btn.addEventListener('click', () => apply(suggestion));
      li.querySelector('.t-row').append(btn);
    }
    return li;
  }));
}

// ── Lao starter pack ────────────────────────────────────────────────────────

let pack = [];

async function loadPack() {
  try {
    const res = await fetch('packs/lao-starter.json');
    pack = res.ok ? ((await res.json()).sounds ?? []) : [];
  } catch {
    pack = [];
  }
  await renderPack();
}

async function renderPack() {
  const added = new Set((await listSounds()).map((s) => s.packId).filter(Boolean));
  const available = pack.filter((p) => !added.has(p.id));
  $('pack').hidden = available.length === 0;
  $('pack-list').replaceChildren(...available.map((p) => {
    const li = document.createElement('li');
    li.innerHTML = '<div class="head"><span class="name"></span><button class="add">ເພີ່ມ</button></div><div class="muted meta"></div>';
    li.querySelector('.name').textContent = `${PERSONAL_ICON} ${p.name}`;
    li.querySelector('.meta').textContent = `${p.en} · ${TIERS[p.tier].lo}`;
    li.querySelector('.add').addEventListener('click', async () => {
      await putSound({
        ...p,
        id: crypto.randomUUID?.() ?? String(Date.now()),
        packId: p.id,
        registerMs: 0,
        createdAt: Date.now(),
      });
      await refreshSounds();
    });
    return li;
  }));
}

// ── first-run visual guide ──────────────────────────────────────────────────

const GUIDE_STEPS = [
  { pic: '📱👂', text: 'ໂທລະສັບຈະຟັງສຽງອ້ອມຂ້າງແທນທ່ານ' },
  { pic: '🔴🟡⚪', text: 'ສີ ແລະ ການສັ່ນບອກວ່າສຽງນັ້ນອັນຕະລາຍປານໃດ', feel: true },
  { pic: '⭐🔔', text: 'ບັນທຶກສຽງຂອງທ່ານເອງ ເຊັ່ນ ກະດິ່ງປະຕູ ຫຼື ສຽງເອີ້ນຊື່' },
  { pic: '🔆🔒', text: 'ເປີດໜ້າຈໍໄວ້ຂະນະຟັງ · ສຽງບໍ່ເຄີຍອອກຈາກໂທລະສັບ' },
];
let guideStep = 0;

function openGuide() {
  guideStep = 0;
  $('guide').hidden = false;
  renderGuide();
  $('guide-next').focus({ preventScroll: true });
}

function closeGuide() {
  $('guide').hidden = true;
  settings.guideSeen = true;
  saveSettings();
}

function renderGuide() {
  const step = GUIDE_STEPS[guideStep];
  $('guide-pic').textContent = step.pic;
  $('guide-text').textContent = step.text;
  $('guide-dots').replaceChildren(...GUIDE_STEPS.map((_, i) => {
    const d = document.createElement('i');
    if (i <= guideStep) d.className = 'on';
    return d;
  }));
  $('guide-extra').replaceChildren(...(step.feel ? ['danger', 'caution', 'info'].map((tier) => {
    const b = document.createElement('button');
    b.className = `btn tier-${tier}`;
    b.textContent = `${TIERS[tier].icon} ${TIERS[tier].lo} · ສຳຜັດການສັ່ນ`;
    b.addEventListener('click', () => navigator.vibrate?.(TIERS[tier].vibrate));
    return b;
  }) : []));
  const last = guideStep === GUIDE_STEPS.length - 1;
  $('guide-next').textContent = last ? 'ເລີ່ມໃຊ້ ✓' : 'ຕໍ່ໄປ →';
  $('guide-skip').hidden = last;
}

$('guide-next').addEventListener('click', () => {
  if (guideStep === GUIDE_STEPS.length - 1) closeGuide();
  else { guideStep++; renderGuide(); }
});
$('guide-skip').addEventListener('click', closeGuide);

// ── tabs ────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  for (const v of ['listen', 'library', 'settings']) $(`view-${v}`).hidden = v !== b.dataset.view;
  if (b.dataset.view === 'settings') { renderMetrics(); renderThresholds(); }
  scrollTo(0, 0);
}));

$('btn-start').addEventListener('click', () => (mic ? stop() : start()));

bindSettings();
resetReg();
refreshSounds().then(loadPack);
if (!settings.guideSeen) openGuide();
// Load the model in the background so "Start" is instant.
getYamnet().catch((err) => console.error('[DeafSound] model load failed', err));


// ── "someone calls my name" preset ──────────────────────────────────────────

$('btn-preset-name').addEventListener('click', () => {
  $('reg-name').value = 'ມີຄົນເອີ້ນຊື່ຂ້ອຍ';
  document.querySelector('#reg-tier input[value="caution"]').checked = true;
  regStatus('ໃຫ້ຄົນຕ່າງກັນເອີ້ນຊື່ທ່ານ 3 ຄັ້ງ (ໃກ້ໆ ແລະ ດັງປົກກະຕິ) ແລ້ວກົດອັດສຽງ');
  $('reg-name').focus();
});

// ── today summary ───────────────────────────────────────────────────────────

function renderToday() {
  const s = summarize(timeline);
  const body = $('today-body');
  if (s.total === 0) { body.textContent = 'ມື້ນີ້ຍັງບໍ່ມີສຽງເຕືອນ · No alerts yet today'; return; }
  const top = s.top.map((g) => `${g.icon ?? ''} ${g.lo} ×${g.count}`).join('  ·  ');
  body.textContent = `ທັງໝົດ ${s.total} · ອັນຕະລາຍ ${s.danger} · ລະວັງ ${s.caution} · ຂໍ້ມູນ ${s.info}`
    + (s.critical ? ` · ‼ ${s.critical}` : '') + (s.approaching ? ` · ↗ ${s.approaching}` : '') + `\n${top}`;
  body.style.whiteSpace = 'pre-line';
}
renderToday();


// ── sound picture + demo ────────────────────────────────────────────────────

let demoActive = false;
const spec = new Spectrogram($('viz'));
let lastViz = 0;

function drawViz(now) {
  requestAnimationFrame(drawViz);
  if (now - lastViz < 50 || ring.total < 512 || document.hidden) return; // ~20 columns/s
  lastViz = now;
  spec.setTier(shown?.tier);
  spec.push(bandLevels(ring.latest(512)));
}
requestAnimationFrame(drawViz);

async function runDemo() {
  if (demoActive) return;
  const btn = $('btn-demo');
  btn.disabled = true;
  try { await getYamnet(); } catch { btn.disabled = false; showIdle('ໂຫຼດໂມເດວບໍ່ໄດ້', 'Could not load the model'); return; }
  demoActive = true;
  trend.reset(); pitchTrend.reset();
  noiseFloor = 0;
  const sig = demoScenario();
  const CH = 320;
  const t0 = performance.now();
  let fed = 0;
  btn.textContent = '⏺ ກຳລັງສາທິດ… Demo running';
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const due = Math.min(sig.length, Math.floor(((performance.now() - t0) / 1000) * SAMPLE_RATE / CH) * CH);
      while (fed < due) { onChunk(sig.subarray(fed, fed + CH), performance.now()); fed += CH; }
      if (fed >= sig.length) { clearInterval(timer); resolve(); }
    }, 20);
  });
  demoActive = false;
  trend.reset(); pitchTrend.reset();
  noiseFloor = 0;
  btn.disabled = false;
  btn.innerHTML = '▶ ທົດລອງ: ລົດແກເຂົ້າມາໃກ້ ແລ້ວຜ່ານໄປ <small>Demo: a horn approaches, then passes</small>';
}
$('btn-demo').addEventListener('click', runDemo);


// ── special modes ───────────────────────────────────────────────────────────

const crossing = new CrossingController();
const finder = new HeadingMap();
const MOVING_CLASSES = GROUPS.filter((g) => g.moving).flatMap((g) => g.classes);
let mode = null;
let heading = null;
let lastHeadingAt = 0;
let night = null;
let guardianEv = null;
let guardianRepeats = 0;
let guardianNext = 0;
let modeTimers = [];
let crossState = 'clear';

const sensitivity = () => settings.sensitivity * (mode === 'guardian' ? GUARDIAN.sensitivity : 1);

// Called on every analysis.
let finderTarget = null;   // the group being searched for, or null = any sound
let finderGate = 1;

function onAnalysis(scores, liveRms) {
  if (mode === 'finder') {
    // Aim at the sound that last alerted (within a minute); only its loudness counts.
    const recent = [...log].reverse().find((e) => e.t > Date.now() - 60000 && e.tier !== 'info' && GROUP_BY_ID.get(e.group));
    finderTarget = recent ? GROUP_BY_ID.get(recent.group) : null;
    let conf = 0;
    if (finderTarget) for (const c of finderTarget.classes) if (scores[c] > conf) conf = scores[c];
    finderGate = finderTarget ? Math.min(1, conf / 0.3) : 1;
    return;
  }
  if (mode !== 'crossing') return;
  let movingConf = 0;
  for (const c of MOVING_CLASSES) if (scores[c] > movingConf) movingConf = scores[c];
  crossing.update(Date.now(), {
    movingConf, rms: liveRms,
    approaching: trend.state() === 'approaching',
    passed: pitchTrend.state() === 'falling',
  });
}

// Crossing handles vehicles itself; the night guardian only watches night sounds.
function modeFilter(cands) {
  if (mode === 'crossing') return cands.filter((c) => !GROUP_BY_ID.get(c.group)?.moving);
  if (mode === 'guardian') return guardianFilter(cands);
  return cands;
}

function onAlertInMode(ev) {
  if (mode !== 'guardian' || ev.tier === 'info') return;
  night?.record(ev);
  guardianEv = ev;
  guardianRepeats = 0;
  guardianNext = Date.now() + GUARDIAN.repeatMs;
  $('mode-sub').textContent = `${night.events.length} ການແຈ້ງເຕືອນ · alerts`;
}

const MODE_INFO = {
  crossing: {
    icon: '🚸', title: 'ຂ້າມຖະໜົນ · Crossing',
    note: 'ຊ່ວຍເສີມເທົ່ານັ້ນ — ຫຼຽວຊ້າຍຂວາສະເໝີ. ງຽບ ≠ ປອດໄພ.\nAssistive only: always look both ways. Quiet does not mean safe.',
  },
  finder: {
    icon: '🧭', title: 'ຫາທິດທາງສຽງ · Find the sound',
    note: '1) ໃຫ້ສຽງດັງຢູ່  2) ຖືໂທລະສັບ ແລ້ວຫັນຕົວຊ້າໆ ໃຫ້ຄົບຮອບ  3) ຍ່າງຕາມລູກສອນ\n1) Keep the sound playing  2) Hold the phone and turn slowly all the way round  3) Follow the arrow. Approximate.',
  },
  guardian: {
    icon: '🌙', title: 'ເຝົ້າກາງຄືນ · Night guardian',
    note: 'ເສຍບສາຍສາກ ແລະ ວາງໂທລະສັບໄວ້ໃກ້ໆ. ຕ້ອງເປີດໜ້າຈໍຄ້າງໄວ້.\nPlug in the charger and keep the phone close. The screen must stay on.',
  },
};

const CROSS_TEXT = {
  clear: ['✅', 'ບໍ່ໄດ້ຍິນລົດ', 'No vehicle heard'],
  near: ['👂', 'ມີສຽງລົດ', 'Vehicle sound nearby'],
  close: ['⚠️', 'ລົດກຳລັງໃກ້', 'A vehicle is getting close'],
  back: ['⛔', 'ຖອຍຫຼັງ!', 'Step back!'],
};

async function enterMode(name) {
  if (mode) return;
  if (!mic) await start();
  if (!mic) return;
  mode = name;
  const info = MODE_INFO[name];
  const el = $('mode');
  el.className = `mode mode-${name}`;
  el.hidden = false;
  $('mode-title').textContent = info.title;
  $('mode-icon').textContent = info.icon;
  $('mode-note').textContent = info.note;
  $('mode-note').style.whiteSpace = 'pre-line';
  $('mode-sub').textContent = '';
  $('mode-compass').hidden = name !== 'finder';
  $('mode-icon').hidden = name === 'finder';
  $('mode-rescan').hidden = true;
  $('mode-exit').focus({ preventScroll: true });

  if (name === 'crossing') {
    crossing.reset(); crossState = 'clear';
    setCross('clear');
    modeTimers.push(setInterval(crossingTick, 50));
  } else if (name === 'finder') {
    heading = null; finderReset();
    $('mode-status').textContent = 'ກຳລັງເລີ່ມ… Starting';
    await startCompass();
    modeTimers.push(setInterval(finderTick, 100));
    requestAnimationFrame(drawCompass);
  } else if (name === 'guardian') {
    night = new NightSession(Date.now());
    guardianEv = null;
    clockTick();
    modeTimers.push(setInterval(clockTick, 1000), setInterval(guardianRepeat, 1000));
  }
}

function leaveMode() {
  modeTimers.forEach(clearInterval);
  modeTimers = [];
  stopCompass();
  flash.cancel();
  navigator.vibrate?.(0);
  guardianEv = null;
  mode = null;
  $('mode').hidden = true;
}

// Guardian shows a morning summary first; a second tap closes it.
function exitMode() {
  if (mode === 'guardian' && night && !$('mode').classList.contains('summary')) {
    const s = night.summary(Date.now());
    modeTimers.forEach(clearInterval); modeTimers = [];
    guardianEv = null;
    $('mode').classList.add('summary');
    $('mode-icon').textContent = '☀️';
    const h = Math.floor(s.durationMs / 3600000), m = Math.round((s.durationMs % 3600000) / 60000);
    $('mode-status').textContent = s.count ? `ມີ ${s.count} ການແຈ້ງເຕືອນ` : 'ຄືນນີ້ງຽບສະຫງົບ';
    $('mode-sub').textContent = `${h} ຊມ ${m} ນທ · ${s.count ? s.top.map((g) => `${g.icon ?? ''} ${g.lo} ×${g.count}`).join('  ·  ') : 'No alerts overnight'}`;
    $('mode-note').textContent = '';
    return;
  }
  $('mode').classList.remove('summary');
  night = null;
  leaveMode();
}

// ── crossing ────────────────────────────────────────────────────────────────

function setCross(state) {
  const [icon, lo, en] = CROSS_TEXT[state];
  $('mode-icon').textContent = icon;
  $('mode-status').textContent = lo;
  $('mode-sub').textContent = en;
  $('mode').dataset.state = state;
}

function crossingTick() {
  const now = Date.now();
  const plan = crossing.plan(now);
  if (plan.state !== crossState) {
    crossState = plan.state;
    setCross(plan.state);
  }
  const beat = crossing.due(now);
  if (beat) {
    navigator.vibrate?.(beat);
    if (settings.flash && plan.state !== 'near') flash.play(beat);
    band.alert(plan.state === 'back' ? 2 : plan.state === 'close' ? 1 : 0);
  }
}

// ── find the sound ──────────────────────────────────────────────────────────

// Both orientation events can fire. The relative one has an arbitrary zero, so once the
// absolute (compass) one is seen it wins and the relative one is ignored; mixing them makes
// the heading jump.
let absoluteSeen = false;
function onOrientation(e) {
  if (e.type === 'deviceorientationabsolute') absoluteSeen = true;
  else if (absoluteSeen) return;
  const h = e.webkitCompassHeading ?? (e.alpha == null ? null : compassHeading(e.alpha, e.beta ?? 0, e.gamma ?? 0));
  if (h == null || Number.isNaN(h)) return;
  heading = norm360(h);
  lastHeadingAt = performance.now();
}

async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch { /* permission denied → fall through to the "no compass" note */ }
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientation, true);
}

function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  window.removeEventListener('deviceorientation', onOrientation, true);
}

function finderSample(level) {
  if (heading === null || performance.now() - lastHeadingAt > 1000) return;
  // Target known: its loudness weighted by how sure the classifier is it is playing now.
  // Unknown: loudness above the room's noise floor, so steady noise cancels out.
  const lvl = finderTarget ? levelOf(level) * finderGate : Math.max(0, levelOf(level) - levelOf(noiseFloor * 1.2));
  const ok = finder.add(heading, lvl, performance.now());
  if (!ok) tooFastAt = performance.now();
  if (lvl > 0.04) heardAt = performance.now();
}

// Three clear steps: 1 scan (turn all the way round, a ring fills), 2 result (one locked arrow),
// 3 unclear (say so plainly and offer a rescan). Hot/cold is only a haptic tick, never text.
let finderPhase = 'scan';
let lastGood = null;       // last confident answer, kept briefly so the arrow doesn't flicker
let lastGoodAt = 0;
let tooFastAt = 0;
let heardAt = 0;
let nextTick = 0;
const SCAN_BINS = 30;      // of 36 bins (≈ 300°) before an answer is given

function finderReset() {
  finder.reset();
  finderPhase = 'scan'; lastGood = null; tooFastAt = 0; heardAt = 0;
  $('mode-rescan').hidden = true;
}

function finderTick() {
  const status = $('mode-status'), sub = $('mode-sub');
  if (heading === null || performance.now() - lastHeadingAt > 1500) {
    status.textContent = 'ບໍ່ພົບເຂັມທິດ';
    sub.textContent = 'No compass sensor on this device, so this mode cannot work here.';
    return;
  }
  const now = performance.now();
  const cover = finder.coverage();

  if (finderPhase === 'scan') {
    if (cover >= SCAN_BINS) {
      const best = finder.best();
      if (best?.heading != null) { finderPhase = 'result'; lastGood = best; lastGoodAt = now; }
      else { finderPhase = 'unclear'; }
    } else {
      $('mode-rescan').hidden = true;
      if (now - tooFastAt < 1200) { status.textContent = '🐢 ຊ້າລົງ'; sub.textContent = 'Slower: turn gently'; }
      else if (now - heardAt > 3000 && cover > 3) { status.textContent = '🔇 ບໍ່ໄດ້ຍິນສຽງ'; sub.textContent = 'No sound heard. Keep the sound playing, then turn.'; }
      else { status.textContent = '🔄 ຫັນຕົວຊ້າໆ ໃຫ້ຄົບຮອບ'; sub.textContent = `Turn slowly all the way round · ${Math.round((cover / 36) * 100)}%`; }
      return;
    }
  }

  if (finderPhase === 'result') {
    const best = finder.best();
    if (best?.heading != null) { lastGood = best; lastGoodAt = now; }
    else if (now - lastGoodAt > 6000) { finderPhase = 'unclear'; }
    if (finderPhase === 'result') {
      $('mode-rescan').hidden = false;
      status.textContent = '👉 ສຽງຢູ່ທາງນີ້';
      sub.textContent = `Follow the arrow · ±${Math.round(lastGood.width / 2)}° · ${finderTarget ? finderTarget.en : 'any sound'}`;
      const c = closeness(heading, lastGood.heading);
      if (c > 0.7 && now >= nextTick) { navigator.vibrate?.([c > 0.9 ? 90 : 30]); nextTick = now + 650 - 450 * c; }
      return;
    }
  }

  // unclear
  $('mode-rescan').hidden = false;
  status.textContent = '🌫️ ຍັງບໍ່ຊັດເຈນ';
  sub.textContent = 'Could not tell. Move closer to the sound or reduce other noise, then scan again.';
}

function drawCompass() {
  if (mode !== 'finder') return;
  requestAnimationFrame(drawCompass);
  const cv = $('mode-compass'), g = cv.getContext('2d');
  const W = cv.width, cx = W / 2, cy = W / 2, n = finder.cfg.bins;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#5b9bff';
  g.clearRect(0, 0, W, W);
  const h = heading ?? 0;
  const ang = (deg) => ((deg - h - 90) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {                        // the ring: fills as the user turns
    g.beginPath();
    g.arc(cx, cy, W * 0.46, ang(i * 360 / n), ang((i + 1) * 360 / n));
    g.arc(cx, cy, W * 0.38, ang((i + 1) * 360 / n), ang(i * 360 / n), true);
    g.closePath();
    g.fillStyle = finder.solid(i) ? accent : 'rgba(128,128,128,0.22)';
    g.globalAlpha = finderPhase === 'scan' ? 1 : 0.35;
    g.fill();
  }
  g.globalAlpha = 1;
  if (finderPhase === 'result' && lastGood) {
    const rel = (turn(h, lastGood.heading) * Math.PI) / 180;
    const half = ((lastGood.width / 2) * Math.PI) / 180;
    g.beginPath();                                     // the zone the sound probably comes from
    g.moveTo(cx, cy);
    g.arc(cx, cy, W * 0.46, rel - Math.PI / 2 - half, rel - Math.PI / 2 + half);
    g.closePath();
    g.fillStyle = 'rgba(255, 196, 77, 0.38)';
    g.fill();
    g.save();
    g.translate(cx, cy);
    g.rotate(rel);
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(0, -W * 0.34); g.lineTo(W * 0.13, W * 0.06); g.lineTo(0, -W * 0.02); g.lineTo(-W * 0.13, W * 0.06);
    g.closePath(); g.fill();
    g.restore();
  }
  g.fillStyle = css.getPropertyValue('--text').trim() || '#fff';   // "phone points here" marker
  g.beginPath(); g.moveTo(cx, 4); g.lineTo(cx - 9, 22); g.lineTo(cx + 9, 22); g.closePath(); g.fill();
}

// ── night guardian ──────────────────────────────────────────────────────────

function clockTick() {
  if (mode !== 'guardian' || $('mode').classList.contains('summary')) return;
  const d = new Date();
  $('mode-status').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!night.events.length) $('mode-sub').textContent = 'ກຳລັງເຝົ້າ… Guarding';
}

// Keep buzzing (and re-showing the alert) until the user taps Got it.
function guardianRepeat() {
  const now = Date.now();
  if (mode !== 'guardian' || !guardianEv || now < guardianNext) return;
  guardianNext = now + GUARDIAN.repeatMs;
  if (++guardianRepeats > GUARDIAN.maxRepeats) { guardianEv = null; return; }
  navigator.vibrate?.(GUARDIAN.pattern);
  flash.play(GUARDIAN.pattern);
  band.alert(2);
  showAlert(guardianEv);
}

$('ov-close').addEventListener('click', () => { guardianEv = null; flash.cancel(); });
document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => enterMode(b.dataset.mode)));
$('mode-exit').addEventListener('click', exitMode);
$('mode-rescan').addEventListener('click', finderReset);
