// Demodulador FM ancha / FM estrecha / AM para muestras I/Q de 8 bits del RTL-SDR.
//
// Cadena (fs de entrada = 2.4 MS/s):
//   uint8 I/Q ─▶ mezclador (NCO) ─▶ FIR ↓5 (480 k) ─▶ FIR ↓2 (240 k)
//     WFM: discriminador ─▶ de-énfasis 50 µs ─▶ FIR 15 kHz ↓5 ─▶ audio 48 kHz
//     NFM/AM: FIR ↓5 (48 k) ─▶ filtro de canal ─▶ discriminador / envolvente ─▶ audio 48 kHz

export const AUDIO_RATE = 48000;
export const LISTEN_RATE = 2.4e6;

/** FIR paso bajo por ventana (Blackman). cutoff en Hz. */
function lowpass(taps, cutoff, fs) {
  const h = new Float32Array(taps);
  const fc = cutoff / fs;
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/** FIR decimador (complejo o real) que conserva el estado entre bloques. */
class Decimator {
  constructor(h, D, complex = true) {
    this.h = h;
    this.D = D;
    this.complex = complex;
    this.L = h.length;
    this.hr = new Float32Array(this.L - 1);
    this.hi = new Float32Array(this.L - 1);
    this.phase = 0;
  }
  process(re, im) {
    const { h, D, L } = this;
    const N = re.length;
    const xr = new Float32Array(L - 1 + N);
    xr.set(this.hr); xr.set(re, L - 1);
    let xi = null;
    if (this.complex) { xi = new Float32Array(L - 1 + N); xi.set(this.hi); xi.set(im, L - 1); }
    const outN = Math.max(0, Math.ceil((N - this.phase) / D));
    const or = new Float32Array(outN);
    const oi = this.complex ? new Float32Array(outN) : null;
    let k = this.phase, o = 0;
    for (; k < N; k += D, o++) {
      let sr = 0, si = 0;
      const base = k + L - 1;
      if (this.complex) {
        for (let j = 0; j < L; j++) { sr += h[j] * xr[base - j]; si += h[j] * xi[base - j]; }
        oi[o] = si;
      } else {
        for (let j = 0; j < L; j++) sr += h[j] * xr[base - j];
      }
      or[o] = sr;
    }
    this.phase = k - N;
    this.hr = xr.slice(N);
    if (this.complex) this.hi = xi.slice(N);
    return [or, oi];
  }
}

export class Demodulator {
  constructor() {
    this.fs = LISTEN_RATE;
    this.d1 = new Decimator(lowpass(32, 110e3, 2.4e6), 5); // → 480 k
    this.d2 = new Decimator(lowpass(48, 100e3, 480e3), 2); // → 240 k
    this.d3 = new Decimator(lowpass(32, 18e3, 240e3), 5); // → 48 k (NFM/AM)
    this.audioWfm = new Decimator(lowpass(48, 15e3, 240e3), 5, false); // audio WFM → 48 k
    this.ncoR = 1; this.ncoI = 0;
    this.configure({ mode: 'wfm', bw: 12500, offsetHz: 0, squelch: -200 });
  }

  configure({ mode, bw, offsetHz, squelch }) {
    if (mode !== this.mode || bw !== this.bw) {
      this.mode = mode;
      this.bw = bw;
      this.chan = new Decimator(lowpass(81, bw / 2, AUDIO_RATE), 1);
      this.prevR = 1; this.prevI = 0;
      this.deemph = 0; this.dc = 0; this.env = 0.01;
    }
    this.squelch = squelch;
    // El NCO desplaza la señal de offsetHz a 0 Hz
    const w = (-2 * Math.PI * offsetHz) / this.fs;
    this.stepR = Math.cos(w); this.stepI = Math.sin(w);
  }

  /** Procesa un bloque de I/Q uint8 → { audio: Float32Array a 48 kHz, levelDb } */
  process(buf) {
    const n = buf.length >> 1;
    const re = new Float32Array(n), im = new Float32Array(n);
    let pr = this.ncoR, pi = this.ncoI;
    const sr = this.stepR, si = this.stepI;
    for (let i = 0; i < n; i++) {
      const x = (buf[2 * i] - 127.4) / 128, y = (buf[2 * i + 1] - 127.4) / 128;
      re[i] = x * pr - y * pi;
      im[i] = x * pi + y * pr;
      const t = pr * sr - pi * si;
      pi = pr * si + pi * sr;
      pr = t;
    }
    const mag = Math.hypot(pr, pi); // renormalizar el fasor
    this.ncoR = pr / mag; this.ncoI = pi / mag;

    let [r1, i1] = this.d1.process(re, im);
    [r1, i1] = this.d2.process(r1, i1); // 240 k complejo

    let audio, level;
    if (this.mode === 'wfm') {
      level = power(r1, i1);
      const fs1 = 240e3;
      const k = fs1 / (2 * Math.PI * 75e3);
      const alpha = 1 - Math.exp(-1 / (fs1 * 50e-6));
      const dem = new Float32Array(r1.length);
      let pR = this.prevR, pI = this.prevI, de = this.deemph;
      for (let i = 0; i < r1.length; i++) {
        const a = r1[i], b = i1[i];
        const ph = Math.atan2(b * pR - a * pI, a * pR + b * pI);
        pR = a; pI = b;
        de += alpha * (ph * k - de);
        dem[i] = de;
      }
      this.prevR = pR; this.prevI = pI; this.deemph = de;
      [audio] = this.audioWfm.process(dem, null);
      for (let i = 0; i < audio.length; i++) audio[i] *= 0.8;
    } else {
      let [r2, i2] = this.d3.process(r1, i1);
      [r2, i2] = this.chan.process(r2, i2); // canal a 48 k
      level = power(r2, i2);
      audio = new Float32Array(r2.length);
      if (this.mode === 'nfm') {
        const k = AUDIO_RATE / (2 * Math.PI * Math.max(2000, this.bw * 0.3));
        let pR = this.prevR, pI = this.prevI, dc = this.dc;
        for (let i = 0; i < r2.length; i++) {
          const a = r2[i], b = i2[i];
          const v = Math.atan2(b * pR - a * pI, a * pR + b * pI) * k;
          pR = a; pI = b;
          dc += 0.0005 * (v - dc); // quita el desplazamiento por error de sintonía
          audio[i] = (v - dc) * 0.7;
        }
        this.prevR = pR; this.prevI = pI; this.dc = dc;
      } else { // AM con control automático de ganancia
        let env = this.env, dc = this.dc;
        for (let i = 0; i < r2.length; i++) {
          const m = Math.hypot(r2[i], i2[i]);
          dc += 0.0008 * (m - dc); // portadora
          env += 0.0002 * (Math.abs(m - dc) - env);
          audio[i] = ((m - dc) / Math.max(env * 4, 1e-4)) * 0.5;
        }
        this.env = env; this.dc = dc;
      }
    }

    const levelDb = 10 * Math.log10(level + 1e-20);
    if (levelDb < this.squelch) audio.fill(0);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.max(-1, Math.min(1, audio[i]));
    return { audio, levelDb };
  }
}

function power(re, im) {
  let s = 0;
  for (let i = 0; i < re.length; i++) s += re[i] * re[i] + im[i] * im[i];
  return re.length ? s / re.length : 0;
}
