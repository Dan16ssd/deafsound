import { MicStream, RingBuffer, rms, SAMPLE_RATE } from './audio.js';
import { loadYamnet, WINDOW } from './yamnet.js';
import { TIERS, GROUPS, PERSONAL_ICON } from './labels.js';
import { yamnetCandidates, rankCandidates, topClasses, Cooldown, defaultThreshold, suggestThreshold } from './detector.js';
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
const FULLSCREEN_TIERS = new Set(['danger', 'caution']);
const $ = (id) => document.getElementById(id);

// ── persisted settings & metrics (localStorage, this device only) ───────────

const DEFAULT_SETTINGS = {
  sensitivity: 1,
  showInfo: true,
  vibrateInfo: false,
  notify: false,
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
const cooldown = new Cooldown();
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
    mic = new MicStream(onChunk);
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

let noiseFloor = 0;
let burstUntil = 0;

function onChunk(chunk, receivedAt) {
  ring.push(chunk);
  lastChunkAt = receivedAt;
  const level = rms(chunk);
  $('meter-bar').style.width = `${Math.min(100, level * 400)}%`;

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
    const t0 = performance.now();
    const { scores, embedding } = await yam.classify(win);
    const inferMs = performance.now() - t0;

    let cands = yamnetCandidates(scores, settings.sensitivity, settings.thresholds);
    if (!settings.showInfo) cands = cands.filter((c) => c.tier !== 'info');

    if (matcher.sounds.length) {
      const { results } = matcher.match(embedding, liveRms);
      for (const r of results) {
        if (r.hit) cands.push({ key: `personal:${r.sound.id}`, source: 'personal', icon: PERSONAL_ICON, tier: r.sound.tier, lo: r.sound.name, en: r.sound.en ?? r.sound.name, confidence: r.sim });
      }
      updateLiveSims(results);
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

function handleCandidates(cands, arrivedAt) {
  if (cands.length === 0) return;
  const now = Date.now();

  // Same sound still going → keep it on screen.
  if (shown && cands.some((c) => c.key === shown.key)) extendHold();

  const fresh = cands.filter((c) => cooldown.ready(c.key, c.tier, now));
  if (fresh.length === 0) return;

  for (const c of fresh) {
    const ev = { ...c, t: now, id: `${now}-${c.key}` };
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
      navigator.vibrate?.(TIERS[top.tier].vibrate);
      pushCapped(metrics.latencyMs, performance.now() - arrivedAt);
    }
    showAlert(top);
    if (document.hidden && settings.notify && top.tier !== 'info') notify(top);
    console.log(`[DeafSound] ALERT ${top.tier} ${top.en} ${(top.confidence * 100).toFixed(0)}%`);
  }

  renderEvents();
  saveMetrics();
}

// ── alert display ───────────────────────────────────────────────────────────

function restartFlash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function showAlert(ev) {
  shown = ev;
  const icon = ev.icon ?? TIERS[ev.tier].icon;
  const tierLabel = `${TIERS[ev.tier].lo}${ev.source === 'personal' ? ' · ສຽງຂອງຂ້ອຍ' : ''}`;
  const meta = `${ev.en} · ${Math.round(ev.confidence * 100)}%`;
  const canMarkWrong = ev.source !== 'test';

  const card = $('alert');
  card.className = `alert tier-${ev.tier}`;
  restartFlash(card);
  $('alert-icon').textContent = icon;
  $('alert-tier').textContent = tierLabel;
  $('alert-text').textContent = ev.lo;
  $('alert-meta').textContent = meta;
  $('btn-wrong').hidden = !canMarkWrong;

  // Danger and caution take over the whole screen; info stays in the card so
  // everyday sounds like speech don't keep covering the app.
  const overlay = $('overlay');
  if (FULLSCREEN_TIERS.has(ev.tier)) {
    overlay.className = `overlay tier-${ev.tier}`;
    $('ov-tier').textContent = `${TIERS[ev.tier].icon} ${tierLabel}`;
    $('ov-icon').textContent = icon;
    $('ov-text').textContent = ev.lo;
    $('ov-meta').textContent = meta;
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
  if (ev) ev.wrong = true;
  saveMetrics();
  renderEvents();
  showIdle();
}

$('btn-wrong').addEventListener('click', markWrong);
$('ov-wrong').addEventListener('click', markWrong);
$('ov-close').addEventListener('click', () => showIdle());

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
  const sound = buildSound({ name, tier, clipVecs: reg.clips, registerMs });
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
