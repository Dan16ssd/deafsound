// Microphone capture → 16 kHz mono Float32 chunks. Nothing is recorded to disk
// or sent anywhere; chunks go straight into an in-memory ring buffer.

export const SAMPLE_RATE = 16000;
// Small chunks so a new sound reaches the detector quickly (latency budget).
export const CHUNK_SECONDS = 0.02;

export class RingBuffer {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.size = size;
    this.pos = 0;     // next write index
    this.total = 0;   // samples ever written
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.pos] = chunk[i];
      this.pos = (this.pos + 1) % this.size;
    }
    this.total += chunk.length;
  }

  // Samples [fromTotal, fromTotal + n) in absolute stream positions.
  slice(fromTotal, n) {
    const out = new Float32Array(n);
    const oldest = this.total - Math.min(this.total, this.size);
    for (let i = 0; i < n; i++) {
      const abs = fromTotal + i;
      if (abs < oldest || abs >= this.total) continue;
      const back = this.total - abs;
      out[i] = this.buf[(this.pos - back + this.size) % this.size];
    }
    return out;
  }

  latest(n) {
    return this.slice(this.total - n, n);
  }
}

// Linear-interpolation resampler that keeps phase across chunks. Only used if
// the browser refuses a 16 kHz AudioContext.
class Resampler {
  constructor(from, to) {
    this.step = from / to;
    this.t = 0;
    this.prev = 0;
  }

  process(input) {
    const out = [];
    while (this.t < input.length) {
      const i = Math.floor(this.t);
      const frac = this.t - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * frac);
      this.t += this.step;
    }
    this.t -= input.length;
    this.prev = input[input.length - 1];
    return Float32Array.from(out);
  }
}

export class MicStream {
  constructor(onChunk) {
    this.onChunk = onChunk; // (Float32Array @16k, receivedAtMs) => void
    this.ctx = null;
    this.stream = null;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  async start() {
    // Browser DSP is tuned for voice calls and would erase exactly the
    // environmental sounds we want to hear — turn it all off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await this.ctx.resume();

    const rate = this.ctx.sampleRate;
    const resampler = rate === SAMPLE_RATE ? null : new Resampler(rate, SAMPLE_RATE);

    await this.ctx.audioWorklet.addModule('js/capture-worklet.js');
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'capture', {
      processorOptions: { chunkSize: Math.round(rate * CHUNK_SECONDS) },
    });
    node.port.onmessage = (e) => {
      const chunk = resampler ? resampler.process(e.data) : e.data;
      this.onChunk(chunk, performance.now());
    };

    // Keep the node pulled by the graph without making any sound.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(this.ctx.destination);

    return { contextRate: rate };
  }

  async stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
  }
}

export function rms(samples, start = 0, end = samples.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}
