// YAMNet on-device inference with TensorFlow.js. Model files are served from
// this app's own origin (model/) and cached by the service worker, so it
// loads and runs with no network.

export const WINDOW = 15600;     // 0.975 s @ 16 kHz → exactly one YAMNet frame
export const FRAME_HOP = 7680;   // 0.48 s, YAMNet's internal frame hop

export function parseClassMap(csvText) {
  return csvText.trim().split(/\r?\n/).slice(1).map((line) => {
    const m = line.match(/^(\d+),([^,]*),(.*)$/);
    return m ? m[3].replace(/^"|"$/g, '') : line;
  });
}

export async function loadYamnet({ tf, modelUrl = 'model/model.json', classMapUrl = 'model/yamnet_class_map.csv', ioHandler, classMapText }) {
  let backend = 'cpu';
  if (typeof document !== 'undefined') {
    for (const b of ['webgl', 'cpu']) {
      try {
        if (await tf.setBackend(b)) { backend = b; break; }
      } catch { /* try next */ }
    }
  } else {
    await tf.setBackend('cpu');
  }
  await tf.ready();

  const model = await tf.loadGraphModel(ioHandler ?? modelUrl);
  const classNames = parseClassMap(classMapText ?? await (await fetch(classMapUrl)).text());

  // Run arbitrary-length audio; returns one entry per YAMNet frame.
  async function run(waveform) {
    // Outputs are scores [N,521], embeddings [N,1024], spectrogram [M,64];
    // pick by shape rather than trusting output order.
    const [scoresT, embT] = tf.tidy(() => {
      const out = model.predict(tf.tensor1d(waveform));
      const byDim = (d) => out.find((t) => t.shape[1] === d);
      return [byDim(521), byDim(1024)];
    });
    // Synchronous readback on purpose: async data() on WebGL waits on the
    // browser's frame scheduler, which is throttled to ~1 s when the page is
    // hidden or the screen dims. dataSync() takes ~10–15 ms regardless.
    const scores = scoresT.dataSync();
    const emb = embT.dataSync();
    const frames = scoresT.shape[0];
    tf.dispose([scoresT, embT]);
    const result = [];
    for (let f = 0; f < frames; f++) {
      result.push({
        scores: scores.subarray(f * 521, (f + 1) * 521),
        embedding: emb.subarray(f * 1024, (f + 1) * 1024),
      });
    }
    return result;
  }

  // Warm up: the first WebGL call compiles shaders and can take seconds.
  await run(new Float32Array(WINDOW));

  return {
    backend,
    classNames,
    run,
    // Single 0.975 s window → { scores, embedding }
    async classify(window) {
      const frames = await run(window);
      return frames[frames.length - 1];
    },
  };
}
