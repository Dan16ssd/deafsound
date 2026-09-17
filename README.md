# ສຽງເຕືອນ · DeafSound

Environmental sound alerts for deaf and hard-of-hearing people in Laos. A web app for Chrome on Android.
Output is **big Lao text + vibration**. No speech, no STT/TTS/OCR.

**Audio never leaves the phone.** Detection, personal sounds and alerts all run offline. The only network call is
optional on-tap narration, which sends a few lines of text (`class, confidence, timestamp`), never audio.

## Run it

```sh
node serve.mjs 8000          # zero-dependency static server with correct MIME types
```

- **Desktop:** open http://localhost:8000
- **Android phone (USB):** enable USB debugging → on the PC open `chrome://inspect` → *Port forwarding* `8000 → localhost:8000`
  → open `http://localhost:8000` in Chrome on the phone. (The mic needs `localhost` or HTTPS.)
- **Deploy:** the folder is fully static. Drop it on any HTTPS host (GitHub Pages, Netlify, Cloudflare Pages).

Open it once while online. The service worker then caches the app, TensorFlow.js and the 16 MB YAMNet model,
so later launches work in airplane mode. "Add to Home screen" makes it installable.

## Architecture

```
mic (getUserMedia, browser DSP off) → AudioWorklet → 16 kHz ring buffer
  every 250 ms → YAMNet (tf.js WebGL, ~25–50 ms) on the last 0.975 s
    ├─ 521 class scores → label map (js/labels.js) → Lao phrase + tier
    └─ 1024-d embedding → cosine vs personal library (IndexedDB)
  → rank (danger > caution > info, personal wins ties) → cooldown
  → INSTANT: navigator.vibrate(pattern per tier) + full-width colored Lao text
  → ON TAP: last 60 s of events as JSON text → LLM → one Lao sentence
```

| File | Layer |
|---|---|
| `js/audio.js`, `js/capture-worklet.js` | Mic capture, resampling, ring buffer |
| `js/yamnet.js` | Model load + inference (model files served locally from `model/`) |
| `js/labels.js` | **Label map**: 40 groups over 88 YAMNet classes → Lao + tier + threshold |
| `js/detector.js` | Thresholds, ranking, cooldown |
| `js/library.js` | Personal sounds: 3 clips → averaged embedding → cosine matching, IndexedDB |
| `js/narrate.js` | The only networked code. Falls back to a local summary when off, offline or failing |
| `proxy/worker.js` | Optional Cloudflare Worker so the API key isn't on the phone |
| `sw.js` | Offline cache |

### Tiers

| Tier | Color | Vibration | Examples |
|---|---|---|---|
| ອັນຕະລາຍ danger | red | long ×4 | horn, siren, motorbike/revving, car passing, skid, train, fire alarm, scream, crash |
| ລະວັງ caution | amber | medium ×2 | shout/calling, dog, doorbell, knock, phone, whistle, reversing beeps, thunder |
| ຂໍ້ມູນ info | neutral | none (optional short) | speech, temple drum/gong, bell, chanting, music, rain, rooster, vendor jingle |

A sound that keeps going raises one alert, not a stream of them, but it re-alerts every ~7 s (danger) so a long horn is never absorbed.

### Personal library

1. Tap **ອັດສຽງ** and make the sound. It takes 2 s of audio (plus 0.25 s before the tap). Repeat 3 times.
2. For each clip, keep the loud YAMNet frames and average their embeddings. Then average the 3 clips.
3. The threshold is set automatically from how similar the 3 takes were (0.72–0.93). You can adjust it with the slider;
   the live similarity number next to each sound helps you tune it.
4. A match also has to look more like the target than like the slowly updated *background* embedding, and it can't be near-silent.
   This cuts false positives from steady ambient noise.

No gradient steps, no training. Lao-specific sounds that YAMNet lacks (tuk-tuk, songthaew, a particular vendor call,
the user's name being called) are handled here.

### Narration (optional)

Settings → enable, then either:
- **Direct:** paste an Anthropic API key (stored in this browser's localStorage only). Fine for a demo on your own phone.
- **Proxy:** deploy `proxy/worker.js` (`npx wrangler deploy proxy/worker.js`, then `npx wrangler secret put ANTHROPIC_API_KEY`),
  set Endpoint to the worker URL and leave the key empty. The worker ignores the client's prompt, rebuilds the request from
  whitelisted event fields, and pins the model, so it can't be abused as a general proxy.

Model: `claude-opus-5` at low effort, with server-side refusal fallbacks enabled. If narration is off, offline or errors out,
the button shows a local Lao summary of the most urgent recent events, so it always does something.

## Deliberate cuts (say this in the pitch)

- **No direction-of-arrival / beamforming.** Phones expose one processed mic stream to the browser. Direction is out of scope by design.
- No custom-trained model, no fine-tuning, no GPU server, no native app, no STT/TTS/OCR, no continuous network use.

## Measuring the success metrics

Settings → **ສະຖິຕິ / Metrics** (stored on-device, "Copy JSON" to export):
- **Latency:** p50/p95 from the newest audio chunk arriving to `vibrate()`. Add ≤250 ms hop plus however much of the sound
  YAMNet needs to hear.
- **Registration time** per personal sound, and consistency of its 3 takes.
- **False positives:** tap **ບໍ່ຖືກຕ້ອງ ✕** on a wrong alert. Per-class count / wrong / FP% is tracked.
- **Detection accuracy on Lao sounds:** open **Debug · YAMNet** on the Listen tab to see live top-5 classes. The console logs
  the top 3 once per second (`[DeafSound] …`).

## Verified during build

- Node + tf.js with the real model: a synthetic horn is detected as "Vehicle horn" at 0.92, which raises a danger alert.
  A registered synthetic doorbell matched at 0.90. A different chime scored 0.64 and ambient noise 0.41, so neither matched.
- Chrome (WebGL) with a synthetic stream through the real capture pipeline: inference 22–55 ms, chunk→vibrate 23–45 ms.
  3-clip registration saved with consistency 0.98. Doorbell replay fired the personal alert and a different chime did not.
  All 20 assets were cached for offline use.
- **Not yet verified:** a real phone mic, real street sounds, real vibration hardware, and a live narration call.

## Before field use

- **Have a native Lao reader review every string** in `js/labels.js` and `index.html` (Lao Association of the Deaf).
- Tune per-group thresholds in `js/labels.js` on real Vientiane recordings. Busy streets fire "vehicle" classes often.
- Keep the screen on (the app requests a wake lock). With the screen off, Android may throttle the tab. The optional
  "notify in background" setting uses system notifications with vibration as a fallback.
