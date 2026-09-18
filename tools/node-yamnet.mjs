// Loads the app's bundled YAMNet model in Node (CPU backend), for tools and tests.
import * as tf from '@tensorflow/tfjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYamnet } from '../js/yamnet.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = path.join(root, 'model');

export async function loadNodeYamnet() {
  const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
  const weights = Buffer.concat(manifest.weightsManifest[0].paths.map((p) => fs.readFileSync(path.join(modelDir, p))));
  const ioHandler = {
    load: async () => ({
      modelTopology: manifest.modelTopology,
      weightSpecs: manifest.weightsManifest[0].weights,
      weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
      format: manifest.format,
      userDefinedMetadata: manifest.userDefinedMetadata,
    }),
  };
  return loadYamnet({
    tf,
    ioHandler,
    classMapText: fs.readFileSync(path.join(modelDir, 'yamnet_class_map.csv'), 'utf8'),
  });
}

// Minimal WAV reader: PCM 16/24/32-bit or 32-bit float, any channel count and
// sample rate. Returns mono Float32Array at 16 kHz.
export function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
      if (fmt.format === 0xfffe) fmt.format = buffer.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = data.readFloatLE(o);
      else if (fmt.format === 1 && fmt.bits === 16) v = data.readInt16LE(o) / 32768;
      else if (fmt.format === 1 && fmt.bits === 24) v = data.readIntLE(o, 3) / 8388608;
      else if (fmt.format === 1 && fmt.bits === 32) v = data.readInt32LE(o) / 2147483648;
      else throw new Error(`unsupported WAV: format ${fmt.format}, ${fmt.bits}-bit`);
      sum += v;
    }
    mono[i] = sum / fmt.channels;
  }
  return resample(mono, fmt.rate, 16000);
}

function resample(input, from, to) {
  if (from === to) return input;
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const t = i * step;
    const j = Math.floor(t);
    const a = input[j];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * (t - j);
  }
  return out;
}

// 16 kHz mono 16-bit PCM WAV, used by tests to create fixtures.
export function writeWav(samples, rate = 16000) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
