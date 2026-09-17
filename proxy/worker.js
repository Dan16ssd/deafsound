// Optional Cloudflare Worker that keeps the Anthropic API key off the phone.
// Deploy:  npx wrangler deploy proxy/worker.js --name deafsound-narrate
//          npx wrangler secret put ANTHROPIC_API_KEY
// Then set the app's Settings → Endpoint to the worker URL and leave API key empty.
//
// It ignores the client's prompt, rebuilds the request from whitelisted event
// fields only, pins the model and caps output — so the endpoint can't be used
// as a general-purpose Claude proxy.

import { SYSTEM_PROMPT } from '../js/narrate.js';

const ALLOWED_ORIGINS = ['*']; // replace with your deployed app origin
const MODEL = 'claude-opus-5';

const cors = (origin) => ({
  'access-control-allow-origin': ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ''),
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') ?? '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors(origin) });

    let body;
    try { body = await request.json(); } catch { return new Response('bad json', { status: 400, headers: cors(origin) }); }

    let events;
    try { events = JSON.parse(body?.messages?.[0]?.content).events; } catch { /* handled below */ }
    if (!Array.isArray(events) || events.length === 0 || events.length > 15) {
      return new Response('bad request', { status: 400, headers: cors(origin) });
    }
    const str = (v) => String(v ?? '').slice(0, 60);
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const clean = events.map((e) => ({
      class: str(e.class), label_lo: str(e.label_lo), source: str(e.source), tier: str(e.tier),
      confidence: num(e.confidence), seconds_ago: num(e.seconds_ago), timestamp: str(e.timestamp),
    }));

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low' },
        fallbacks: 'default',
        messages: [{ role: 'user', content: JSON.stringify({ events: clean }) }],
      }),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors(origin), 'content-type': 'application/json' },
    });
  },
};
