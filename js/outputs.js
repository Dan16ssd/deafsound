// Extra alert outputs for when the phone is in a pocket or bag: camera-torch
// flash, and a vibrating band over Web Bluetooth (standard Immediate Alert
// service, which many fitness bands expose). Everything is best-effort and
// off by default. The pure helpers are testable; the browser parts are guarded.

// Vibration arrays alternate on/off/on…; turn one into timed flash segments.
export function flashSchedule(pattern) {
  let t = 0;
  const out = [];
  pattern.forEach((ms, i) => {
    if (i % 2 === 0) out.push({ at: t, on: true }, { at: t + ms, on: false });
    t += ms;
  });
  return out;
}

// Immediate Alert levels: 0 none, 1 mild, 2 high.
export const BAND = { service: 0x1802, characteristic: 0x2a06 };
export function bandLevel(tier, risk) {
  if (tier === 'danger' || risk?.level === 'critical') return 2;
  if (tier === 'caution') return 1;
  return 0;
}

export class Flash {
  constructor() { this.track = null; this.timers = []; }

  get supported() { return !!navigator.mediaDevices?.getUserMedia; }

  async enable() {
    if (this.track) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const track = stream.getVideoTracks()[0];
      if (!track?.getCapabilities?.().torch) { stream.getTracks().forEach((t) => t.stop()); return false; }
      this.track = track;
      return true;
    } catch { return false; }
  }

  disable() { this.cancel(); this.track?.stop(); this.track = null; }

  cancel() { this.timers.forEach(clearTimeout); this.timers = []; this.set(false); }

  set(on) { this.track?.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); }

  play(pattern) {
    if (!this.track) return;
    this.cancel();
    for (const s of flashSchedule(pattern)) this.timers.push(setTimeout(() => this.set(s.on), s.at));
  }
}

export class Band {
  constructor() { this.char = null; this.device = null; }

  get supported() { return !!navigator.bluetooth; }
  get connected() { return !!this.char; }

  async connect() {
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BAND.service] }] });
      this.device.addEventListener?.('gattserverdisconnected', () => { this.char = null; });
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(BAND.service);
      this.char = await svc.getCharacteristic(BAND.characteristic);
      return true;
    } catch { this.char = null; return false; }
  }

  async alert(level) {
    if (!this.char || !level) return;
    try {
      await this.char.writeValueWithoutResponse(Uint8Array.of(level));
      setTimeout(() => this.char?.writeValueWithoutResponse(Uint8Array.of(0)).catch(() => {}), level === 2 ? 1500 : 500);
    } catch { /* disconnected; the user can reconnect in Settings */ }
  }

  disconnect() { this.device?.gatt?.disconnect(); this.char = null; }
}
