# DeafSound · technical notes

For developers. The plain-language overview is in the main [README](../README.md).

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

### Getting closer

For sources that can travel (horn, siren, motorbike, passing vehicle, train, reversing, nearby vehicle) the app tracks the
loudness trend over the last 2.5 s (`js/approach.js`). If it climbs steadily (≥ 5 dB total, ≥ 3 dB/s) the alert is repeated
once, even inside the cooldown, with a stronger 3-part buzz and "ກຳລັງເຂົ້າມາໃກ້ · Getting closer" added to the text. It tells
a deaf pedestrian which vehicle is heading toward them, which direction-free detection can't. It re-alerts at most every 8 s per sound.
It is a loudness heuristic, not distance measurement: a source that simply gets louder (an engine revving in place) can trigger it too.

### Second model: verifier head, risk fusion, snooze

- **Verifier head** (`js/head.js`): each personal sound gets a small logistic-regression model over the 1024-d YAMNet embedding,
  trained on-device in ~100 ms from its 3 clips (augmented with jitter and background mixes) against the app's own recent
  background sounds and the user's other sounds. A cosine match must also pass the head (p ≥ 0.5). When the user taps **Wrong** on a
  personal alert, that embedding becomes a weighted hard negative and the head retrains, so false alarms teach it.
  The head only knows the background it has heard, so it refines near-misses; the cosine match still handles far-off sounds.
  Starter-pack sounds get a head once ~12 background samples exist. Nothing leaves the phone.
- **Risk fusion** (`js/risk.js`): tier + confidence + "getting closer" + loudness → urgency score. At *critical* (e.g. a loud, confident
  horn that is approaching) the phone uses a longer 4-part buzz and the alert is marked ‼.
- **Snooze**: caution/info alerts get a 10-minute snooze button (for a known repetitive sound). Danger-tier sounds can never be snoozed.

### Third and fourth models: scene context and novelty

- **Scene context** (`js/scene.js`): YAMNet class scores are averaged over ~20 s into a place guess (street, home, crowd/market,
  temple, nature, or quiet/mixed), shown as a chip on the Listen tab. Each scene nudges *non-danger* thresholds: "vehicle nearby"
  and traffic get less twitchy on a street, doorbell/knock/phone more sensitive at home, temple drums and chanting quieter at a temple.
  **Danger thresholds are never changed**, and a threshold you tuned yourself always wins.
- **Novelty detector** (`js/novelty.js`): the app remembers its own recent background sounds. A loud sound (≥ 2.5× the noise floor)
  that is unlike anything in that memory, and that no label or personal sound explains, raises a caution
  "ມີສຽງດັງທີ່ບໍ່ຄຸ້ນເຄີຍ · Unusual loud sound". This covers sounds the label map doesn't know. The trigger level adapts to the
  background spread on that phone, it needs ~40 background samples (about 20 s) before arming, and it holds 15 s per event; if the
  unusual sound continues it soon becomes "familiar" and stops alerting.

### Doppler, flash/band output, name preset, daily summary

- **Doppler** (`js/pitch.js`): the dominant tone (200–1600 Hz, autocorrelation) of a horn/siren is tracked. A pitch fall of ≥ 3 % while
  the level is no longer climbing means the vehicle just passed: the alert says "ຜ່ານໄປແລ້ວ · Passed you" with one short buzz, and the
  "getting closer" escalation is suppressed while the pitch is falling.
- **Flash** (Settings): flashes the camera torch in the alert's vibration pattern, for a phone in a bag or on a table. Needs camera
  permission; off by default.
- **Vibrating band** (Settings, Chrome Android): connects over Web Bluetooth to any band exposing the standard *Immediate Alert* service
  (0x1802): mild for caution, high for danger or critical risk. Untested on real hardware.
- **"Someone calls my name"** (My sounds): one-tap preset (caution tier, guidance to record different people calling) for the existing
  personal-sound matcher + verifier head. It matches the sound of a call, not words.
- **Today** (Listen tab): persistent on-device summary of today's alerts (counts per tier, critical/approaching, top sounds). Alerts you
  marked Wrong are excluded; nothing leaves the phone.

Not built from the plan: a second pretrained ensemble model (needs a model download and a latency check), stereo direction
(device-dependent) and live Lao captions (needs a team decision because audio would leave the phone).

### Sound picture and demo mode

- **Sound picture** (`js/viz.js`): a live scrolling spectrogram on the Listen tab (48 log-spaced bands, 100 Hz–6 kHz). Dark when quiet,
  and it takes on the colour of the current alert tier (blue → amber → red) as sound gets louder, so a deaf user can *see* what the
  phone hears.
- **Demo** (`js/demo.js`, button on the Listen tab): a synthetic 9 s scene (street noise, then a horn that approaches, then passes with a
  Doppler drop) is fed through the real pipeline with no mic or speaker. It shows detection, the "getting closer" escalation, the
  "passed you" cue, the risk level, the spectrogram, vibration, flash and band. The mic is ignored while it runs.

### Special modes (Listen tab)

- **🚸 Crossing** (`js/crossing.js`): a haptic heartbeat for crossing a street. A vehicle-class confidence, loudness and the
  "getting closer" / Doppler cues combine into a proximity value; the phone beats slowly when a vehicle is first heard and faster and
  stronger as it nears, then gives a long "step back" pattern and a red screen. Green means *no vehicle sound heard*, **not** safe:
  the screen says to look both ways. Vehicle alerts are handled by this mode while it is on.
- **🧭 Find the sound** (`js/finder.js`): a hot/cold compass. A phone has one mic, so it cannot hear direction; the user turns slowly
  while the app records loudness per compass heading (10° bins, 60 s half-life) and an arrow plus a yellow zone point at the loudest
  heading; the phone ticks faster when it faces it. To keep it as accurate as a single mic allows: the heading comes from the full
  orientation angles (right at any tilt) and only the compass event is used once it fires; readings taken while turning faster than
  80°/s are dropped; only the sound that last alerted counts (its loudness × the classifier's confidence), or, with no target, loudness
  above the room's noise floor; bins need 3 samples; a near-flat map is reported as "from everywhere" instead of guessing.
  Expect **±10–45°**, worse with echoes, and it needs 1–2 slow laps. True accuracy needs two microphones (time-difference-of-arrival),
  which phones do not expose to a web page reliably. It says so when there is no compass sensor.
- **🌙 Night guardian** (`js/guardian.js`): for the phone on a charger. Only night-relevant sounds count (fire/smoke alarm, siren, glass,
  scream, baby/crying, knock/door/doorbell, dog, phone, plus the user's own sounds and unusual loud sounds), sensitivity ×1.3, and a
  strong buzz + flash repeats every 4 s (up to ~2 min) until **Got it**. The screen is a dim clock; leaving shows a morning summary of what
  happened overnight. The screen must stay on, since a web app cannot listen with the screen locked.

### Glass look

`styles.css` ends with a liquid-glass layer over a four-light gradient mesh (coral, violet, mint, blue), applied selectively: glass on the top bar, tab bar, live alert, full-screen alerts/modes and
the mode tiles, with luminous gradient edges over a three-light gradient mesh. Dense content (lists, settings, forms) sits on calmer,
mostly opaque panels so text keeps contrast. Blue #1856FF is the interactive accent; Start is green, Stop red, and each mode tile has its own tint (green / orange / violet). Plus Jakarta Sans (self-hosted in `fonts/`, Latin only) leads the font
stack and Lao falls through to the Noto Sans Lao stack. Hover only applies on pointer devices; focus-visible, active and disabled states
are explicit. It falls back to solid surfaces without `backdrop-filter`, and under `prefers-contrast: more` or
`prefers-reduced-transparency`. Alert tiers keep their AA text colours (≥ 5.2:1).

### Start button and high-contrast style

- **Start is always in reach:** the Start / "What happened?" row is pinned above the tab bar on the Listen tab. The spectrogram, scene chip,
  today summary and debug now live in a collapsed **More** section (the spectrogram only draws while it is open).
- **High-contrast style** (Settings → Display: Auto / High contrast / Glass): plain solid colours, pure black or white text, thick
  2–6 px borders, no blur or gradients. **Auto** picks it on slower phones (≤ 4 CPU cores or ≤ 2 GB RAM) and when the system asks for more
  contrast or less transparency; Glass can always be chosen by hand. Text/background pairs are ≥ 6:1 (alert tiers 8.6–11.7:1).

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
