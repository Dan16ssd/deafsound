// On-tap narration. The ONLY networked code in the app.
// Sends recent events as text — {class, confidence, timestamp} — never audio,
// never embeddings. If disabled, offline, or failing, falls back to a local
// summary built from the label map so the button always does something.

import { TIERS } from './labels.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const WINDOW_MS = 60_000;
const MAX_EVENTS = 15;

export const SYSTEM_PROMPT = `You write one short sentence in Lao for a deaf or hard-of-hearing person in Laos, usually outdoors on a street without sidewalks.

The input is a JSON list of sound events their phone detected on-device in the last minute. Each event has an English class name, a Lao label, a severity tier (danger, caution, info), a confidence from 0 to 1, and how many seconds ago it happened. Some classes are the user's own registered sounds (source "personal"), such as their doorbell or someone calling their name.

Describe what is probably happening around them right now, most urgent and most recent first. The reader relies on this to decide whether to look around, so:
- Use simple everyday Lao, at most about 20 words.
- Mention only sounds in the input. Do not invent places, people, directions, or causes the events don't support.
- If a danger-tier event happened in the last 10 seconds, begin with ລະວັງ.
- If confidence is below 0.5, hedge with ອາດຈະ.
- Reply with only the Lao sentence: no translation, quotation marks, or explanation.`;

export function recentEvents(log, now = Date.now()) {
  let events = log.filter((e) => now - e.t <= WINDOW_MS);
  if (events.length === 0) events = log.slice(-5);
  return events.slice(-MAX_EVENTS);
}

export function toPayload(events, now = Date.now()) {
  return events.map((e) => ({
    class: e.en,
    label_lo: e.lo,
    source: e.source,
    tier: e.tier,
    confidence: Math.round(e.confidence * 100) / 100,
    seconds_ago: Math.round((now - e.t) / 1000),
    timestamp: new Date(e.t).toISOString(),
  }));
}

// Offline fallback: no generation, just the most urgent recent labels.
export function localSummary(events, now = Date.now()) {
  if (events.length === 0) return 'ຍັງບໍ່ມີສຽງທີ່ກວດພົບ';
  const byKey = new Map();
  for (const e of events) {
    const prev = byKey.get(e.key);
    if (!prev || e.t > prev.t) byKey.set(e.key, e);
  }
  const top = [...byKey.values()]
    .sort((a, b) => TIERS[b.tier].rank - TIERS[a.tier].rank || b.t - a.t)
    .slice(0, 3)
    .map((e) => `${e.lo} (${Math.round((now - e.t) / 1000)} ວິນາທີກ່ອນ)`);
  return `ຫຼ້າສຸດ: ${top.join(', ')}`;
}

export async function narrate(log, cfg) {
  const now = Date.now();
  const events = recentEvents(log, now);
  const local = localSummary(events, now);

  if (!cfg.enabled) return { text: local, source: 'local' };
  if (!navigator.onLine) return { text: local, source: 'local', note: 'offline' };
  if (events.length === 0) return { text: local, source: 'local' };

  const direct = cfg.endpoint.startsWith(ANTHROPIC_URL);
  if (direct && !cfg.apiKey) return { text: local, source: 'local', note: 'no-key' };

  const headers = { 'content-type': 'application/json' };
  if (direct) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const body = {
    model: cfg.model || 'claude-opus-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: JSON.stringify({ events: toPayload(events, now) }) }],
  };
  if (direct) body.fallbacks = 'default';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { text: local, source: 'local', note: `http-${res.status}`, detail };
    }
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') return { text: local, source: 'local', note: 'refusal' };
    const text = (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return { text: local, source: 'local', note: 'empty' };
    return { text, source: 'llm', model: msg.model };
  } catch (err) {
    return { text: local, source: 'local', note: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
