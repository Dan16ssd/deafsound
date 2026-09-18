// Builds the Lao starter pack (packs/lao-starter.json) from the team's own
// recordings, using exactly the app's registration code, so a pack sound
// behaves like a sound the user recorded themselves. No model training.
//
// Usage:
//   npm install
//   node tools/build-pack.mjs <recordings-dir> [output.json]
//
// Layout (one folder per sound, 3+ WAV takes each, ~2 s, sound near the mic):
//   recordings/
//     tuk-tuk/
//       meta.json   {"name": "ລົດຕຸກຕຸກ", "en": "Tuk-tuk", "tier": "danger"}
//       take1.wav  take2.wav  take3.wav
//
// Only record sounds you have the right to use. Recordings stay local; only
// the averaged embedding vectors go into the pack.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadNodeYamnet, readWav } from './node-yamnet.mjs';
import { clipVector, buildSound, CLIPS_PER_SOUND } from '../js/library.js';
import { TIERS } from '../js/labels.js';

// Pack sounds were recorded on a different phone and in a different place than
// the user's, so matches score a little lower. Start slightly more permissive;
// users can tune the threshold in the app.
const CROSS_DEVICE_MARGIN = 0.05;
const MIN_PACK_THRESHOLD = 0.7;

export async function buildPack(recordingsDir, { yam, log = console.log } = {}) {
  yam ??= await loadNodeYamnet();
  const sounds = [];
  const problems = [];

  const dirs = fs.readdirSync(recordingsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const id of dirs) {
    const dir = path.join(recordingsDir, id);
    const where = `${id}/`;
    if (!/^[a-z0-9-]+$/.test(id)) { problems.push(`${where} folder name must be lowercase letters, digits, dashes`); continue; }

    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
    catch { problems.push(`${where} missing or invalid meta.json`); continue; }
    if (!meta.name || !meta.en || !TIERS[meta.tier]) { problems.push(`${where} meta.json needs name (Lao), en, tier (danger|caution|info)`); continue; }

    const wavs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
    const clipVecs = [];
    for (const file of wavs) {
      try {
        const clip = readWav(fs.readFileSync(path.join(dir, file)));
        const { vector, peak } = clipVector(clip, await yam.run(clip));
        if (vector) clipVecs.push(vector);
        else problems.push(`${where}${file} too quiet (peak rms ${peak.toFixed(4)}), skipped`);
      } catch (err) {
        problems.push(`${where}${file} ${err.message}`);
      }
    }
    if (clipVecs.length < CLIPS_PER_SOUND) {
      problems.push(`${where} needs at least ${CLIPS_PER_SOUND} usable takes, has ${clipVecs.length}`);
      continue;
    }

    const built = buildSound({ name: meta.name, tier: meta.tier, clipVecs, registerMs: 0 });
    const threshold = Math.max(MIN_PACK_THRESHOLD, Math.round((built.threshold - CROSS_DEVICE_MARGIN) * 100) / 100);
    sounds.push({
      id,
      name: meta.name,
      en: meta.en,
      tier: meta.tier,
      threshold,
      pairMin: built.pairMin,
      takes: clipVecs.length,
      centroid: built.centroid.map((v) => Math.round(v * 1e5) / 1e5),
    });
    log(`✓ ${id}: ${clipVecs.length} takes, consistency ${built.pairMin}, threshold ${threshold}`);
    if (built.pairMin < 0.75) problems.push(`${where} takes are not very consistent (${built.pairMin}); consider re-recording`);
  }
  return { sounds, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [recordingsDir, out = 'packs/lao-starter.json'] = process.argv.slice(2);
  if (!recordingsDir) {
    console.error('usage: node tools/build-pack.mjs <recordings-dir> [output.json]');
    process.exit(2);
  }
  const { sounds, problems } = await buildPack(recordingsDir);
  for (const p of problems) console.warn(`! ${p}`);
  fs.writeFileSync(out, JSON.stringify({
    version: 1,
    note: 'Built by tools/build-pack.mjs from the team\'s own recordings.',
    builtAt: new Date().toISOString(),
    sounds,
  }, null, 2) + '\n');
  console.log(`wrote ${sounds.length} sound(s) to ${out}`);
  console.log('Bump CACHE in sw.js so installed apps pick up the new pack.');
}
