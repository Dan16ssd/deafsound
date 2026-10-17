# ສຽງເຕືອນ · DeafSound

**A phone app that tells deaf and hard-of-hearing people about important sounds around them.**
When it hears something, it shows **big Lao words** on the screen and **vibrates** the phone.
It never talks and never needs the internet.

Built for people in Laos. It runs in the Chrome browser on an Android phone. There is nothing to install from an app store.

---

## What it does

When the phone hears a sound that matters, it shows a coloured screen and vibrates in a pattern you can feel:

| Level | Colour | Vibration | Examples |
|---|---|---|---|
| **Danger** (ອັນຕະລາຍ) | Red | One long buzz | Car horn, siren, motorbike close by, fire alarm, scream, crash |
| **Careful** (ລະວັງ) | Amber | Three short buzzes | Someone calling, dog barking, doorbell, knock, phone ringing, reversing truck |
| **Info** (ຂໍ້ມູນ) | Grey | Two soft taps (off by default) | Talking, temple drum, rain, music |

You choose which sounds you want to hear about, and you can tap **ບໍ່ຖືກຕ້ອງ ✕ (Wrong)** when the app gets it wrong so it can do better.

### Extra things you can do

- **Teach it your own sounds.** Record your doorbell, or someone calling your name, three times. The app will tell you when it hears it again.
- **🚸 Crossing mode.** Before crossing a street, tap it. The phone gives a heartbeat-like buzz that gets faster and stronger when a vehicle is getting close, and a long buzz with a red screen that means *step back*. If it says "no vehicle heard", that does **not** mean it is safe. Always look both ways.
- **🌙 Night guard.** Plug the phone in and leave it near your bed. It watches only for important sounds (smoke alarm, baby crying, glass breaking, knocking) and keeps buzzing and flashing until you tap "Got it". In the morning it shows what happened.
- **"Getting closer" and "passed you".** For vehicles, the alert tells you if a sound is coming toward you or has gone past.
- **Try it without any sound.** The **Demo** button plays a pretend horn that comes closer and passes, so you can see everything working.
- **Flash and wristband.** The camera light can blink with the alert, and a Bluetooth vibrating band can buzz your wrist (this needs a band that supports it).
- **See the sound.** An optional moving picture of what the phone is hearing.
- **Plain or fancy look.** A high-contrast style (easier to read in bright sun, and lighter on slow phones) or a soft "glass" style. The app picks for you, and you can change it in Settings.

---

## Your privacy

- **Sound never leaves your phone.** The app listens, decides and alerts all on the phone itself.
- It works with no internet once it has been opened one time.
- There is one **optional** feature that uses the internet: the "What happened?" button can write a short sentence about recent alerts. It only sends a few words (like "horn, 3 seconds ago"), never any audio. It is off unless you turn it on.

---

## How to try it

Open the app in Chrome on an Android phone and tap **ເລີ່ມຟັງ (Start)**. Allow the microphone when asked.
Keep the screen on while it is listening, because a web page cannot listen once the phone screen locks.

Live version: https://dan16ssd.github.io/deafsound/

To run it on your own computer, see **For developers** below.

---

## What works, and what does not (please read)

This is an early version. It has **not** yet been tested by deaf users on real phones.

- **It can make mistakes.** It may miss a sound, or alert for a sound that is not there. The app is a helper, never a replacement for looking around. **Do not rely on it for your safety.**
- **It needs the screen on.** It cannot listen while the phone is locked.
- **A small number of Lao words** in the app have not yet been checked by native Lao readers. They are listed in [docs/lao-review.md](docs/lao-review.md).
- **Some sounds common in Laos** (tuk-tuk, songthaew, vendor calls) are not built in yet. You can record them yourself, and the team plans to add a ready-made set.
- **Direction is not shown reliably.** A phone has one microphone, so it cannot truly tell where a sound comes from. A "Find sound" mode exists, but it is only a rough guess and can point the wrong way.
- Things not yet tried on real hardware: the vibration patterns, the Bluetooth band, the compass, and the long Night guard alarm.

---

## Help us make it better

- **Native Lao readers:** please check [docs/lao-review.md](docs/lao-review.md). Every word the app shows is listed there with its English meaning.
- **Deaf and hard-of-hearing people:** the most useful thing is to try it, tell us what was confusing, and tell us which sounds matter in your daily life.
- **Sound recordings:** short recordings of local sounds (tuk-tuk, temple drum, vendor calls) help us build the ready-made set. Only share recordings you have the right to share.

---

## For developers

The technical details (how detection works, file map, tuning, tests, deployment) are in **[docs/technical.md](docs/technical.md)**.

Quick start:

```sh
node serve.mjs 8000        # start the app at http://localhost:8000
npm install && npm test    # run the tests
```

The app is a plain static website (no build step). To use the microphone on a phone, serve it over HTTPS or use USB port forwarding; the steps are in the technical notes.
