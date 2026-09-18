# ສຽງເຕືອນ · DeafSound

Environmental sound alerts for deaf and hard-of-hearing people in Laos. A web app for Chrome on Android.
Output is **big Lao text + vibration**. No speech, no STT/TTS/OCR.

**Audio never leaves the phone.** Detection, personal sounds and alerts all run offline. The only network call is
optional on-tap narration, which sends a few lines of text (`class, confidence, timestamp`), never audio.

**Live demo:** https://dan16ssd.github.io/deafsound/ (open in Chrome on Android)

## Run it

```sh
node serve.mjs 8000                          # zero-dependency static server with correct MIME types
node serve.mjs --https --host 192.168.0.109  # HTTPS on your Wi-Fi so phones get a secure context (needs certs/)
npm install && npm test                      # test suite against the real model (Node, CPU)
```

- **Desktop:** open http://localhost:8000
- **Phone on the same Wi-Fi:** create a self-signed cert for your PC's IP in `certs/dev-cert.pem` + `certs/dev-key.pem`, e.g.
  `openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout certs/dev-key.pem -out certs/dev-cert.pem -subj "/CN=DeafSound" -addext "subjectAltName=IP:<your-ip>"`.
  Run the HTTPS command above, open `https://<your-ip>:8443` and accept the warning. The offline cache won't install with
  an untrusted cert; everything else works. The server only serves app files, and forwards `POST /narrate` to a local `wrangler dev`.
- **Android phone (USB):** enable USB debugging → on the PC open `chrome://inspect` → *Port forwarding* `8000 → localhost:8000`
  → open `http://localhost:8000` in Chrome on the phone. (The mic needs `localhost` or HTTPS.)
- **Deploy:** the app is fully static. Put it on any HTTPS host (GitHub Pages, Netlify, Cloudflare Pages).

Open it once while online. The service worker then caches the app, TensorFlow.js and the 16 MB YAMNet model,
so later launches work in airplane mode. "Add to Home screen" makes it installable. Bump `CACHE` in `sw.js` on every release.

## Architecture

```
mic (getUserMedia, browser DSP off) → AudioWorklet (20 ms chunks) → 16 kHz ring buffer
  every 100 ms, or every 40 ms for 0.6 s after a sudden loud onset
  → YAMNet (tf.js WebGL, ~25 ms) on the last 0.975 s
    ├─ 521 class scores → label map (js/labels.js) → Lao phrase + icon + tier (+ field-tuned thresholds)
    └─ 1024-d embedding → cosine vs personal library + starter pack sounds (IndexedDB)
  → rank (danger > caution > info, personal wins ties) → cooldown
  → INSTANT: navigator.vibrate(pattern per tier)
             + danger / caution: full-screen overlay (icon, Lao text, Got it / Wrong)
             + info: alert card only
  → ON TAP: last 60 s of events as JSON text → LLM → one Lao sentence
```

| File | Layer |
|---|---|
| `js/audio.js`, `js/capture-worklet.js` | Mic capture, resampling, ring buffer |
| `js/yamnet.js` | Model load + inference (model files served locally from `model/`) |
| `js/labels.js` | **Label map**: 40 groups over 88 YAMNet classes → Lao + icon + tier + threshold; vibration patterns |
| `js/detector.js` | Thresholds (with field overrides), ranking, cooldown, threshold suggestions |
| `js/library.js` | Personal sounds: 3 clips → averaged embedding → cosine matching, IndexedDB |
| `js/narrate.js` | The only networked code. Falls back to a local summary when off, offline or failing |
| `js/app.js` | UI, onset-driven analysis loop, full-screen alerts, guide, tuning, starter pack |
| `proxy/worker.js` | Optional Cloudflare Worker so the API key isn't on the phone |
| `sw.js` | Offline cache |
| `packs/lao-starter.json` | Ready-made Lao sounds, built by `tools/build-pack.mjs` (empty until the team records them) |
| `docs/lao-review.md` | Every Lao string with its English meaning, for native reviewers |
| `tests/run.mjs` | `npm test`: label map, vibration spec, latency budget, detection, matching, pack builder, proxy, dev server |

### Tiers

| Tier | Screen | Vibration | Examples |
|---|---|---|---|
| ອັນຕະລາຍ danger | red, full screen | one long continuous buzz (1.5 s) | horn, siren, motorbike/revving, car passing, skid, train, fire alarm, scream, crash |
| ລະວັງ caution | amber, full screen | 3 short fast pulses | shout/calling, dog, doorbell, knock, phone, whistle, reversing beeps, thunder |
| ຂໍ້ມູນ info | neutral, card only | 2 gentle taps (off by default) | speech, temple drum/gong, bell, chanting, music, rain, rooster, vendor jingle |

A sound that keeps going raises one alert, not a stream of them, but it re-alerts every ~7 s (danger) so a long horn is never absorbed.

Text/background colors meet WCAG 2.1 AA contrast (≥ 4.5:1) in light and dark themes. The first launch shows a 4-step
picture guide in Lao, including buttons to feel each vibration pattern; it can be reopened from Settings.

### Latency

YAMNet already recognizes a horn with ~50 ms of it in the window, so latency is mostly time spent waiting for the next
analysis. Audio arrives in 20 ms chunks. The app analyzes every 100 ms normally; when a chunk is much louder than the
recent noise floor, it schedules an analysis 40 ms later and keeps analyzing every 40 ms for 0.6 s. If a phone's
inference is slower than that, windows are skipped rather than queued, so alerts never fall behind.

### Screen-on listening

The app holds a screen wake lock while listening. If the lock is refused or lost, a banner tells the user to keep the
screen on, and tapping the page retries. A web app can't listen reliably with the screen locked; that would need a
native app, which is out of scope. The optional "notify in background" setting uses system notifications with vibration.

### Personal library

1. Tap **ອັດສຽງ** and make the sound. It takes 2 s of audio (plus 0.25 s before the tap). Repeat 3 times.
2. For each clip, keep the loud YAMNet frames and average their embeddings. Then average the 3 clips.
3. The threshold is set automatically from how similar the 3 takes were (0.72–0.93). You can adjust it with the slider;
   the live similarity number next to each sound helps you tune it.
4. A match also has to look more like the target than like the slowly updated *background* embedding, and it can't be near-silent.
   This cuts false positives from steady ambient noise.

No gradient steps, no training. Lao-specific sounds that YAMNet lacks (tuk-tuk, songthaew, a particular vendor call,
the user's name being called) are handled here.

Matching runs on overlapping windows every 100 ms, so what counts is the best score during a sound. In tests a
registered doorbell peaks at 0.96 against its 0.89 threshold, while the most similar other chime peaks at 0.84.

### Lao starter pack

Ready-made Lao sounds users can add in one tap (My sounds tab). Build the pack from your own recordings:

```
recordings/
  tuk-tuk/
    meta.json      {"name": "ລົດຕຸກຕຸກ", "en": "Tuk-tuk", "tier": "danger"}
    take1.wav  take2.wav  take3.wav      (3+ takes, ~2 s each, any sample rate)
```

```sh
npm run build-pack -- recordings     # writes packs/lao-starter.json and reports bad folders or takes
```

The tool uses the app's own registration code, so a pack sound behaves like one the user recorded. Only the averaged
vectors ship; the recordings stay with you. Pack thresholds start 0.05 lower to allow for a different phone.
Bump `CACHE` in `sw.js` after rebuilding. Only record sounds you have the right to use.

### Narration (optional)

Settings → enable, then either:
- **Direct:** paste an Anthropic API key (stored in this browser's localStorage only). Fine for a demo on your own phone.
- **Proxy (recommended):** `proxy/` is a Cloudflare Worker. From `proxy/`: `npx wrangler login`, `npx wrangler deploy`,
  `npx wrangler secret put ANTHROPIC_API_KEY`. Then set Endpoint to the worker URL and leave the key empty.
  It only accepts browsers from `ALLOWED_ORIGINS` (`wrangler.toml`), rate-limits each IP to 10 requests/min, ignores the
  client's prompt, rebuilds the request from whitelisted and clamped event fields, pins the model, and never echoes
  upstream errors. Origin checks don't stop forged scripts, so also **set a spend limit on the API key's workspace**.

Model: `claude-opus-5` at low effort, with server-side refusal fallbacks enabled. If narration is off, offline or errors out,
the button shows a local Lao summary of the most urgent recent events, so it always does something.

## Deliberate cuts (say this in the pitch)

- **No direction-of-arrival / beamforming.** Phones expose one processed mic stream to the browser. Direction is out of scope by design.
- No custom-trained model, no fine-tuning, no GPU server, no native app, no STT/TTS/OCR, no continuous network use.

## Measuring the success metrics

Settings → **ສະຖິຕິ / Metrics** (stored on-device, "Copy JSON" to export):
- **Latency:** p50/p95 from the newest audio chunk arriving to `vibrate()`. True sound-onset latency also includes the
  ≤ 40 ms onset wait and the ~50 ms of sound YAMNet needs to hear.
- **Registration time** per personal sound, and consistency of its 3 takes.
- **False positives:** tap **ບໍ່ຖືກຕ້ອງ ✕** on a wrong alert. Per-class count / wrong / FP% is tracked, plus the confidence
  of each wrong alert.
- **Field tuning:** Settings → **ປັບເກນການກວດ** has a threshold slider per sound group and suggests a value just above the
  false alarms' confidence, with one-tap apply. "Copy overrides JSON" exports the tuned values to paste into `js/labels.js`.
- **Detection accuracy on Lao sounds:** open **Debug · YAMNet** on the Listen tab to see live top-5 classes. The console logs
  the top 3 once per second (`[DeafSound] …`).

## Verified during build

- `npm test` (14 tests, real model on CPU): label map, spec vibration patterns, latency constants, horn → danger with icon,
  threshold overrides and suggestions, cooldown, personal matching (doorbell yes; other chimes, horn and ambient no),
  WAV reading, pack builder, proxy sanitizer, dev-server allowlist.
- Chrome (WebGL, desktop), synthetic horn fed through the real capture pipeline, 12 trials, **true sound onset →
  `vibrate()`**: median 186 ms, 90th percentile 218 ms, max 253 ms, 9 of 12 within 200 ms, no misses. Inference 21–32 ms.
  Before the onset burst and 20 ms chunks: median 238 ms, max 310 ms.
- Chrome: full-screen overlay (icon, Lao text, focus on "Got it"), first-run guide, screen-on warning when the wake lock is
  refused, false alarm → threshold suggestion → apply, starter pack add and remove.
- WCAG contrast computed for every text/background pair in both themes; three failures fixed.
- **Not yet verified:** a real phone mic and its capture latency, real street sounds, real vibration hardware, a live
  narration call, and a real starter pack (needs the team's recordings).

## Before field use

- **Have native Lao readers review `docs/lao-review.md`** (every alert label and interface string, with English meanings).
- Tune per-group thresholds on real Vientiane streets with Settings → ປັບເກນການກວດ, then copy the overrides into `js/labels.js`.
  Busy streets fire "vehicle" classes often.
- Record tuk-tuk, songthaew, temple drum and vendor calls, and build the starter pack.
- Keep the screen on while listening.
