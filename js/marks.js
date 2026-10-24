// The sound mark: the only iconography in the app.
//
// Every icon here is drawn in CSS — a core disc with arcs radiating from it —
// and animated. Nothing is an emoji and nothing is an image file. A horn is not
// a picture of a horn; it is a sharp burst. A baby is a slow soft swell. For a
// user who cannot hear the sound, the movement *is* the description, and it
// stays readable at a glance from arm's length, which a 16 px emoji does not.
//
// Motions (see .smark--* in styles.css):
//   pulse   hard, fast swell          danger: engines, crashes, thunder
//   sharp   short tight bursts        horns, sirens, alarms, bells, phones
//   expand  rings travelling outward  knocks, doors, voices, animals
//   soft    slow gentle swell         babies, speech, music, rain
//   bars    equaliser bars            live microphone / the user's own sounds
//   wave    scrolling waveform        idle, "listening for anything"
//   steady  no movement               resolved / all-clear states

const RING_MOTIONS = new Set(['pulse', 'sharp', 'expand', 'soft', 'steady']);
const BAR_COUNT = 7;

// How many <i> children a motion needs. The core disc and the first ring are
// pseudo-elements, so a bare <span class="smark smark--pulse"> already renders;
// the children only add the outer arcs.
function partsFor(motion) {
  if (motion === 'bars') return BAR_COUNT;
  if (motion === 'wave') return 0;
  return 2;
}

/**
 * Build a sound mark element.
 * @param {string} motion one of the motions listed above
 * @param {{hue?: string, size?: string, label?: string}} [opts]
 *   hue   — overrides the tier colour ('blue' | 'purple' | 'orange' | 'green' | 'teal')
 *   size  — any CSS length, e.g. '2rem'; defaults to 1em of the parent
 *   label — accessible name; without one the mark is hidden from assistive tech,
 *           which is usually right because the text beside it already says it
 */
export function soundMark(motion = 'expand', opts = {}) {
  const el = document.createElement('span');
  setMark(el, motion, opts);
  return el;
}

// An element the page already styles (#alert-icon, #mode-icon, …) keeps its own
// class; only the smark-* part is swapped, so turning a mark into another one
// never drops the layout rules attached to the slot it sits in.
function baseClass(el) {
  el.dataset.base ??= [...el.classList].filter((c) => !c.startsWith('smark')).join(' ');
  return el.dataset.base;
}

/**
 * Turn an existing element into (or back into) a sound mark.
 * `travel` animates the one thing the detector knows and the text can only
 * state: 'approach' swells the mark outward, 'recede' lets it fall away. For
 * someone who cannot hear the horn change pitch, that movement is the cue.
 */
export function setMark(el, motion = 'expand', { hue, size, label, travel } = {}) {
  const m = RING_MOTIONS.has(motion) || motion === 'bars' || motion === 'wave' ? motion : 'expand';
  const t = travel === 'approach' || travel === 'recede' ? ` smark--${travel}` : '';
  el.className = `${baseClass(el)} smark smark--${m}${t}`.trim();
  el.replaceChildren(...Array.from({ length: partsFor(m) }, () => document.createElement('i')));

  if (hue) el.dataset.hue = hue; else delete el.dataset.hue;
  if (size) el.style.setProperty('--smark-size', size); else el.style.removeProperty('--smark-size');

  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.removeAttribute('aria-hidden');
  } else {
    el.setAttribute('aria-hidden', 'true');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
  }
  return el;
}

/**
 * Fire the one-shot "this just happened" punch. Re-adding the class alone will
 * not restart a CSS animation, so the layout is flushed in between.
 */
export function hitMark(el) {
  el.classList.remove('hit');
  void el.offsetWidth;
  el.classList.add('hit');
}

/**
 * Drive a `bars` mark from the live microphone level, so the bars move with
 * the room instead of looping on a timer. Called once per audio chunk.
 */
export function setMarkLevel(el, level) {
  // The floor matters: a quiet room must still show a clearly moving
  // equaliser, because "the app is listening" is the thing the screen is
  // there to say. Only the amplitude above that floor is real signal.
  el.style.setProperty('--smark-gain', (0.55 + Math.min(1, level * 4) * 0.75).toFixed(3));
}

/** Clear a mark element back to nothing (idle card, dismissed overlay). */
export function clearMark(el) {
  el.className = `${baseClass(el)} smark smark--none`.trim();
  el.replaceChildren();
  delete el.dataset.hue;
}

/**
 * A mark followed by text, as one fragment — for the places that used to build
 * `${icon} ${name}` strings. Returns a DocumentFragment so the caller can keep
 * using textContent semantics for the name itself (names can be user-typed).
 */
export function markedText(motion, text, opts = {}) {
  const frag = document.createDocumentFragment();
  frag.append(soundMark(motion, opts), document.createTextNode(` ${text}`));
  return frag;
}
