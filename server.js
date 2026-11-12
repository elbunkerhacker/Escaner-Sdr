// Puente RTL-SDR (rtl_tcp) → WebSocket con barrido de frecuencias y FFT.
//
//   node server.js                 conecta a rtl_tcp en 127.0.0.1:1234
//   node server.js --sim           arranca además un rtl_tcp simulado (sin hardware)
//   node server.js --rtl 192.168.1.50:1234 --port 8080
//
// La web se sirve en http://localhost:8080

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Demodulator, LISTEN_RATE, AUDIO_RATE } from './dsp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SIM = args.includes('--sim');
const DATA_DIR = path.resolve(argVal('--data', path.join(__dirname, 'data')));
const HTTP_PORT = Number(argVal('--port', process.env.PORT || 8080));
const [RTL_HOST, RTL_PORT] = (() => {
  const v = argVal('--rtl', process.env.RTL_TCP || '127.0.0.1:1234');
  const [h, p] = v.split(':');
  return [h || '127.0.0.1', Number(p || 1234)];
})();

// ---------------------------------------------------------------- utilidades
const TUNERS = ['desconocido', 'E4000', 'FC0012', 'FC0013', 'FC2580', 'R820T', 'R828D'];
const TUNER_RANGE = {
  // [minHz, maxHz] aproximados por tuner
  E4000: [52e6, 2200e6],
  FC0012: [22e6, 948.6e6],
  FC0013: [22e6, 1100e6],
  FC2580: [146e6, 924e6],
  R820T: [24e6, 1766e6],
  R828D: [24e6, 1766e6],
};
const R820T_GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9,
  25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6];
const EMPTY = Buffer.alloc(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- cliente rtl_tcp
class RtlTcp {
  constructor(host, port, onStatus) {
    this.host = host;
    this.port = port;
    this.onStatus = onStatus;
    this.sock = null;
    this.connected = false;
    this.header = null;
    this.carry = EMPTY;
    this.reader = null;
    this.waiters = [];
    this.streaming = false;
    this.queue = [];
    this.queueLen = 0;
    this._connect();
  }

  _connect() {
    this.header = null;
    this.carry = EMPTY;
    this.queue = [];
    this.queueLen = 0;
    const sock = net.createConnection({ host: this.host, port: this.port });
    sock.setNoDelay(true);
    this.sock = sock;
    sock.on('data', (c) => this._onData(c));
    sock.on('error', () => {});
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.header = null;
      if (this.reader) {
        this.reader.reject(new Error('rtl_tcp desconectado'));
        this.reader = null;
      }
      if (was) this.onStatus();
      setTimeout(() => this._connect(), 2000);
    });
  }

  _onData(chunk) {
    let data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = EMPTY;

    if (!this.header) {
      if (data.length < 12) { this.carry = Buffer.from(data); return; }
      const magic = data.toString('ascii', 0, 4);
      if (magic !== 'RTL0') {
        console.error('Cabecera rtl_tcp inválida:', magic);
        this.sock.destroy();
        return;
      }
      const tunerType = data.readUInt32BE(4);
      const gainCount = data.readUInt32BE(8);
      this.header = { tuner: TUNERS[tunerType] || `tipo ${tunerType}`, gainCount };
      this.connected = true;
      console.log(`rtl_tcp conectado (${this.host}:${this.port}) — tuner ${this.header.tuner}`);
      this.waiters.splice(0).forEach((w) => w());
      this.onStatus();
      data = data.subarray(12);
    }

    while (data.length && this.reader) {
      const r = this.reader;
      const take = Math.min(r.need - r.got, data.length);
      data.copy(r.buf, r.got, 0, take);
      r.got += take;
      data = data.subarray(take);
      if (r.got === r.need) {
        this.reader = null;
        r.resolve(r.buf);
      }
    }
    if (!data.length) return;
    if (this.streaming) {
      // Escucha: no se puede perder nada (el audio se cortaría). Se encola.
      this.queue.push(Buffer.from(data));
      this.queueLen += data.length;
      while (this.queueLen > 8 * 1024 * 1024) { // >1.7 s de retraso: tiramos lo más viejo
        const b = this.queue.shift();
        this.queueLen -= b.length;
        if (b.length % 2) this.queue[0] = this.queue[0].subarray(1), this.queueLen--;
      }
      return;
    }
    // Lo que nadie pide se descarta (así rtl_tcp nunca acumula retraso),
    // pero conservamos la alineación I/Q.
    if (data.length % 2) this.carry = Buffer.from(data.subarray(data.length - 1));
  }

  /** Modo continuo: los datos sin lector se guardan en cola en vez de descartarse. */
  setStreaming(on) {
    this.streaming = on;
    this.flush();
  }

  /** Descarta lo encolado conservando la alineación I/Q. */
  flush() {
    if (this.queueLen % 2) {
      const last = this.queue[this.queue.length - 1];
      this.carry = Buffer.concat([last.subarray(last.length - 1), this.carry]);
    }
    this.queue = [];
    this.queueLen = 0;
  }

  waitConnected() {
    if (this.connected) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  read(n) {
    if (!this.connected) return Promise.reject(new Error('rtl_tcp no conectado'));
    const r = { need: n, got: 0, buf: Buffer.allocUnsafe(n) };
    while (this.queueLen && r.got < n) {
      const b = this.queue[0];
      const take = Math.min(n - r.got, b.length);
      b.copy(r.buf, r.got, 0, take);
      r.got += take;
      this.queueLen -= take;
      if (take === b.length) this.queue.shift(); else this.queue[0] = b.subarray(take);
    }
    if (r.got === n) return Promise.resolve(r.buf);
    return new Promise((resolve, reject) => {
      this.reader = Object.assign(r, { resolve, reject });
    });
  }

  cmd(code, value) {
    if (!this.connected) return;
    const b = Buffer.alloc(5);
    b.writeUInt8(code, 0);
    b.writeInt32BE(value | 0, 1);
    this.sock.write(b);
  }

  setFreq(hz) { this.cmd(0x01, Math.round(hz)); }
  setSampleRate(sps) { this.cmd(0x02, Math.round(sps)); }
  setGainMode(manual) { this.cmd(0x03, manual ? 1 : 0); }
  setGain(tenthsDb) { this.cmd(0x04, Math.round(tenthsDb)); }
  setPpm(ppm) { this.cmd(0x05, Math.round(ppm)); }
  setAgc(on) { this.cmd(0x08, on ? 1 : 0); }
  setBiasTee(on) { this.cmd(0x0e, on ? 1 : 0); }
}

// ---------------------------------------------------------------- FFT
const fftCache = new Map();
function fftTables(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  // Ventana Blackman-Harris (poca fuga espectral: bueno para detectar señales débiles)
  const win = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    win[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    wsum += win[i];
  }
  // Normalizado para que un tono a fondo de escala marque 0 dBFS
  const t = { rev, cos, sin, win, norm: wsum * wsum, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, t);
  return t;
}

function fftInPlace(re, im, t) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const tw = k * step;
        const c = t.cos[tw], s = t.sin[tw];
        const a = start + k, b = a + half;
        const xr = re[b] * c - im[b] * s;
        const xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Devuelve la potencia media en dBFS por bin, ya con fftshift (bin 0 = -fs/2). */
function powerSpectrum(buf, n, avg) {
  const t = fftTables(n);
  const acc = new Float64Array(n);
  for (let a = 0; a < avg; a++) {
    const off = a * n * 2;
    for (let i = 0; i < n; i++) {
      t.re[i] = ((buf[off + 2 * i] - 127.4) / 128) * t.win[i];
      t.im[i] = ((buf[off + 2 * i + 1] - 127.4) / 128) * t.win[i];
    }
    fftInPlace(t.re, t.im, t);
    for (let i = 0; i < n; i++) acc[i] += t.re[i] * t.re[i] + t.im[i] * t.im[i];
  }
  const out = new Float32Array(n);
  const norm = avg * t.norm;
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    const p = acc[(i + half) % n] / norm;
    out[i] = 10 * Math.log10(p + 1e-20);
  }
  // Quitar el pico de DC (artefacto típico del RTL2832U en el centro)
  const l = out[half - 3], r = out[half + 3];
  for (let k = -2; k <= 2; k++) out[half + k] = l + ((r - l) * (k + 3)) / 6;
  return out;
}

// ---------------------------------------------------------------- estado
const DEFAULTS = {
  startHz: 88e6,
  stopHz: 108e6,
  sampleRate: 2.4e6,
  fftSize: 1024,
  avg: 16,
  gain: 40.2, // 'auto' o dB (el AGC del R820T tiende a saturar: mejor manual)
  ppm: 0,
  settleMs: 80,
  crop: 0.75, // fracción útil del ancho de banda (los bordes tienen caída del filtro)
  biasTee: false,
};
let cfg = { ...DEFAULTS };
let cfgVersion = 0;
let running = false;
let sweepId = 0;
let lastSweepMs = 0;
// Bandas personalizadas del usuario (persisten en data/bandas.json)
const BANDS_FILE = path.join(DATA_DIR, 'bandas.json');
let customBands = (() => {
  try { return JSON.parse(fs.readFileSync(BANDS_FILE, 'utf8')); } catch { return []; }
})();
function saveCustomBands() {
  fs.mkdirSync(path.dirname(BANDS_FILE), { recursive: true });
  fs.writeFileSync(BANDS_FILE, JSON.stringify(customBands, null, 2));
}
function sanitizeBand(b) {
  const name = String(b?.name ?? '').trim().slice(0, 40);
  const min = Number(b?.min), max = Number(b?.max);
  if (!name || !(min >= 0) || !(max > min) || max > 3000) return null;
  return {
    name,
    min: +min.toFixed(6),
    max: +max.toFixed(6),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#f97316',
    mode: ['wfm', 'nfm', 'am'].includes(b.mode) ? b.mode : '',
  };
}

// Frecuencias guardadas por el usuario (memorias), en data/frecuencias.json:
// { id, name, freqHz, mode: 'wfm'|'nfm'|'am', bw, note }
const FREQS_FILE = path.join(DATA_DIR, 'frecuencias.json');
let freqs = (() => {
  try { return JSON.parse(fs.readFileSync(FREQS_FILE, 'utf8')); } catch { return []; }
})();
function saveFreqs() {
  fs.mkdirSync(path.dirname(FREQS_FILE), { recursive: true });
  fs.writeFileSync(FREQS_FILE, JSON.stringify(freqs, null, 2));
}
function upsertFreq(x) {
  const name = String(x?.name ?? '').trim().slice(0, 40);
  const freqHz = Math.round(Number(x?.freqHz));
  if (!name || !(freqHz > 0 && freqHz < 3e9)) return;
  const f = {
    id: typeof x.id === 'string' && /^[a-z0-9]{6,20}$/i.test(x.id) ? x.id : Math.random().toString(36).slice(2, 12),
    name,
    freqHz,
    mode: ['wfm', 'nfm', 'am'].includes(x.mode) ? x.mode : 'nfm',
    bw: Math.min(50e3, Math.max(3e3, Number(x.bw) || 12500)),
    note: String(x.note ?? '').trim().slice(0, 80),
    scan: x.scan !== false, // incluida en «Escanear mis frecuencias»
  };
  freqs = freqs.filter((o) => o.id !== f.id);
  freqs.push(f);
  freqs.sort((a, b) => a.freqHz - b.freqHz);
  saveFreqs();
}

// Etiquetas de señales (persisten en data/etiquetas.json). Cada una:
// { f: Hz, tol: Hz (semiancho para reconocer la señal), name, color }
const TAGS_FILE = path.join(DATA_DIR, 'etiquetas.json');
let tags = (() => {
  try { return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')); } catch { return []; }
})();
function saveTags() {
  fs.mkdirSync(path.dirname(TAGS_FILE), { recursive: true });
  fs.writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2));
}
function setTag(m) {
  const f = Number(m.f);
  if (!(f > 0 && f < 3e9)) return;
  const tol = Math.min(100e3, Math.max(2e3, Number(m.tol) || 5e3));
  const name = String(m.name ?? '').trim().slice(0, 32);
  // Sustituye la etiqueta que ya hubiera en esa señal
  tags = tags.filter((t) => Math.abs(t.f - f) > Math.max(t.tol, tol));
  if (name) {
    tags.push({ f: Math.round(f), tol: Math.round(tol), name, color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#e879f9' });
    tags.sort((a, b) => a.f - b.f);
  }
  saveTags();
}

let listen = null; // { freqHz, mode: 'wfm'|'nfm'|'am', bw, squelch }
let listenVer = 0;
let listenCenter = null;

const clients = new Set();
function broadcast(obj) {
  const msg = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

function statusMsg() {
  const tuner = rtl.header?.tuner;
  return {
    type: 'status',
    rtl: { connected: rtl.connected, host: RTL_HOST, port: RTL_PORT, tuner, range: TUNER_RANGE[tuner] || null },
    gains: R820T_GAINS,
    running,
    cfg,
    sim: SIM,
    lastSweepMs,
    listen: listen && { ...listen, centerHz: listenCenter },
    audioRate: AUDIO_RATE,
    customBands,
    tags,
    freqs,
    memScan,
    memState,
  };
}

function sanitize(input) {
  const c = { ...cfg };
  const num = (v, min, max, def) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
  };
  if ('startHz' in input) c.startHz = num(input.startHz, 0, 3e9, c.startHz);
  if ('stopHz' in input) c.stopHz = num(input.stopHz, 0, 3e9, c.stopHz);
  if (c.stopHz <= c.startHz) c.stopHz = c.startHz + 10e3;
  if ('sampleRate' in input) {
    const sr = Number(input.sampleRate);
    // Rangos válidos del RTL2832U
    c.sampleRate = (sr >= 225001 && sr <= 300000) || (sr >= 900001 && sr <= 3.2e6) ? sr : c.sampleRate;
  }
  if ('fftSize' in input) {
    const f = Number(input.fftSize);
    c.fftSize = [128, 256, 512, 1024, 2048, 4096, 8192].includes(f) ? f : c.fftSize;
  }
  if ('avg' in input) c.avg = Math.round(num(input.avg, 1, 256, c.avg));
  if ('gain' in input) c.gain = input.gain === 'auto' ? 'auto' : num(input.gain, 0, 50, 20);
  if ('ppm' in input) c.ppm = Math.round(num(input.ppm, -200, 200, 0));
  if ('settleMs' in input) c.settleMs = Math.round(num(input.settleMs, 0, 2000, c.settleMs));
  if ('crop' in input) c.crop = num(input.crop, 0.3, 1, c.crop);
  if ('biasTee' in input) c.biasTee = !!input.biasTee;
  return c;
}

function makePlan(c) {
  const n = c.fftSize;
  const binHz = c.sampleRate / n;
  let keep = Math.max(2, Math.floor((n * c.crop) / 2) * 2); // bins útiles por salto (par)
  const usable = keep * binHz;
  const span = c.stopHz - c.startHz;
  const segments = [];
  if (span <= usable) {
    // Cabe en una sola captura: centramos y recortamos al rango pedido
    const center = (c.startHz + c.stopHz) / 2;
    const first = Math.max(0, Math.floor(n / 2 - span / 2 / binHz));
    const count = Math.min(n - first, Math.ceil(span / binHz));
    segments.push({ center, first, count });
  } else {
    const steps = Math.ceil(span / usable);
    for (let k = 0; k < steps; k++) {
      const lo = c.startHz + k * usable;
      const center = lo + usable / 2;
      const count = Math.min(keep, Math.ceil((c.stopHz - lo) / binHz));
      segments.push({ center, first: n / 2 - keep / 2, count });
    }
  }
  return { binHz, segments, n };
}

async function applyHardware(c, prev) {
  if (!prev || prev.sampleRate !== c.sampleRate) rtl.setSampleRate(c.sampleRate);
  if (!prev || prev.gain !== c.gain) {
    if (c.gain === 'auto') {
      rtl.setGainMode(false);
    } else {
      rtl.setGainMode(true);
      rtl.setGain(c.gain * 10);
    }
  }
  if (!prev || prev.ppm !== c.ppm) rtl.setPpm(c.ppm);
  if (!prev || prev.biasTee !== c.biasTee) rtl.setBiasTee(c.biasTee);
  await sleep(30);
}

// Mensajes binarios: byte 0 = tipo.
//   1 = espectro: [u8 1, ×7][f64 sweepId][f64 firstHz][f64 binHz] + float32[] dB
//   2 = audio:    [u8 2, ×3][f32 nivel dBFS] + float32[] a 48 kHz
function sendSegment(id, firstHz, binHz, slice) {
  const out = Buffer.alloc(32 + slice.length * 4);
  out.writeUInt8(1, 0);
  out.writeDoubleLE(id, 8);
  out.writeDoubleLE(firstHz, 16);
  out.writeDoubleLE(binHz, 24);
  Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).copy(out, 32);
  broadcast(out);
}
function sendAudio(audio, levelDb) {
  const out = Buffer.alloc(8 + audio.length * 4);
  out.writeUInt8(2, 0);
  out.writeFloatLE(levelDb, 4);
  Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).copy(out, 8);
  broadcast(out);
}

// ---------------------------------------------------------------- escucha
const LISTEN_OFFSET = 250e3; // se sintoniza desplazado para que el pico de DC no caiga en la señal
const LISTEN_BLOCK = 120000; // muestras por bloque (50 ms a 2.4 MS/s)

async function listenSession() {
  const fs = LISTEN_RATE;
  const demod = new Demodulator();
  let center = null, ver = -1, cv = -1, block = 0;
  rtl.setSampleRate(fs);
  rtl.setStreaming(true);
  console.log('Escucha iniciada');
  try {
    while (listen && !memScan && rtl.connected) {
      if (cv !== cfgVersion) {
        cv = cfgVersion;
        const c = cfg;
        if (c.gain === 'auto') rtl.setGainMode(false); else { rtl.setGainMode(true); rtl.setGain(c.gain * 10); }
        rtl.setPpm(c.ppm);
        rtl.setBiasTee(c.biasTee);
      }
      if (ver !== listenVer) {
        ver = listenVer;
        const L = listen;
        // Si la nueva frecuencia cae dentro de lo que ya capturamos, basta con mover el NCO
        if (center === null || Math.abs(L.freqHz - center) > fs * 0.4) {
          center = L.freqHz + LISTEN_OFFSET;
          rtl.setFreq(center);
          await sleep(cfg.settleMs);
          rtl.flush();
          await rtl.read(Math.round(fs * 0.02) * 2); // 20 ms más por si quedan muestras viejas en camino
          rtl.flush();
        }
        demod.configure({ mode: L.mode, bw: L.bw, offsetHz: L.freqHz - center, squelch: L.squelch });
        listenCenter = center;
        broadcast(statusMsg());
      }
      const buf = await rtl.read(LISTEN_BLOCK * 2);
      const { audio, levelDb } = demod.process(buf);
      sendAudio(audio, levelDb);

      // Espectro alrededor de la frecuencia escuchada (~10 por segundo)
      if (block++ % 2 === 0) {
        const n = cfg.fftSize, avg = Math.min(cfg.avg, Math.floor(LISTEN_BLOCK / n));
        const db = powerSpectrum(buf, n, avg);
        const binHz = fs / n;
        const keep = Math.max(2, Math.floor((n * cfg.crop) / 2) * 2);
        const first = n / 2 - keep / 2;
        const firstHz = center + (first - n / 2) * binHz;
        const id = ++sweepId;
        broadcast({ type: 'sweepStart', id, startHz: firstHz, stopHz: firstHz + keep * binHz, binHz, segments: 1 });
        sendSegment(id, firstHz, binHz, db.subarray(first, first + keep));
        broadcast({ type: 'sweepEnd', id, ms: 50 });
      }
      // Si el proceso se retrasa más de 1 s, saltamos al presente
      if (rtl.queueLen > fs * 2) rtl.flush();
    }
  } catch (e) {
    console.warn('Escucha interrumpida:', e.message);
    await sleep(300);
  } finally {
    rtl.setStreaming(false);
    listenCenter = null;
    console.log('Escucha detenida');
  }
}

// ---------------------------------------------------------------- escaneo de mis frecuencias
// Salta entre las frecuencias guardadas marcadas (scan: true). Si en una hay señal
// (SNR ≥ umbral), se queda: primero «confirmando» y, si dura holdMs, «escuchando».
// Cuando lleva hangMs en silencio, sigue saltando por la siguiente.
let memScan = null; // { thrDb, holdMs, hangMs, mute }
let memSkip = false;
let memState = null; // lo que se muestra en la web

function setMemState(s) {
  memState = s;
  broadcast({ type: 'memState', state: s });
}

/** SNR (dB) de un canal dentro de un espectro centrado en center; null si no cae dentro. */
function channelSnr(db, center, ch, binHz) {
  const n = db.length;
  const bw = ch.mode === 'wfm' ? 150e3 : ch.bw;
  const off = ch.freqHz - center;
  if (Math.abs(off) + bw / 2 > LISTEN_RATE * 0.4) return null;
  // Ruido: percentil 30 de la parte útil de la captura
  const lo = Math.floor(n * 0.1), hi = Math.ceil(n * 0.9);
  const sorted = Array.from(db.subarray(lo, hi)).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.3)];
  const b0 = Math.max(0, Math.floor((off - bw / 2) / binHz + n / 2));
  const b1 = Math.min(n - 1, Math.ceil((off + bw / 2) / binHz + n / 2));
  let peak = -Infinity;
  for (let i = b0; i <= b1; i++) if (db[i] > peak) peak = db[i];
  return peak - floor;
}

async function memScanSession() {
  const fs = LISTEN_RATE;
  const n = 1024, binHz = fs / n;
  const demod = new Demodulator();
  const lockout = new Map(); // id → hasta cuándo se ignora (botón Saltar)
  let center = null, idx = 0, cur = null, phase = 'scan', t0 = 0, lastSeen = 0, cv = -1, block = 0, lastMsg = 0;
  rtl.setSampleRate(fs);
  rtl.setStreaming(true);
  console.log('Escaneo de mis frecuencias iniciado');
  const nextAfter = (chans, ch) => {
    const i = chans.findIndex((c) => c.id === ch.id);
    return i < 0 ? 0 : i + 1;
  };
  try {
    while (memScan && rtl.connected) {
      if (cv !== cfgVersion) {
        cv = cfgVersion;
        const c = cfg;
        if (c.gain === 'auto') rtl.setGainMode(false); else { rtl.setGainMode(true); rtl.setGain(c.gain * 10); }
        rtl.setPpm(c.ppm);
        rtl.setBiasTee(c.biasTee);
      }
      const now0 = Date.now();
      const chans = freqs.filter((f) => f.scan !== false && !(lockout.get(f.id) > now0));
      const { thrDb, holdMs, hangMs, mute } = memScan;

      if (phase === 'scan') {
        if (!chans.length) {
          setMemState({ phase: 'idle' });
          await sleep(400);
          continue;
        }
        idx %= chans.length;
        const target = chans[idx];
        // Si todas caen en la misma captura no hace falta resintonizar
        const covers = center !== null && channelSnr(new Float32Array(n), center, target, binHz) !== null;
        if (!covers) {
          center = target.freqHz + LISTEN_OFFSET;
          rtl.setFreq(center);
          await sleep(cfg.settleMs);
          rtl.flush();
          await rtl.read(16384);
        } else {
          rtl.flush(); // descartar lo acumulado: queremos muestras de ahora
        }
        const buf = await rtl.read(n * 2 * 24);
        const db = powerSpectrum(buf, n, 24);
        // Todas las frecuencias marcadas que caen en esta captura se miran a la vez
        let best = null, covered = 0;
        for (const ch of chans) {
          const snr = channelSnr(db, center, ch, binHz);
          if (snr === null) continue;
          if (chans.indexOf(ch) >= idx) covered = Math.max(covered, chans.indexOf(ch));
          if (snr >= thrDb && (!best || snr > best.snr)) best = { ch, snr };
        }
        setMemState({ phase: 'scan', id: target.id, name: target.name, freqHz: target.freqHz });
        if (best) {
          cur = best.ch;
          phase = 'qualify';
          t0 = lastSeen = Date.now();
          demod.configure({ mode: cur.mode, bw: cur.bw, offsetHz: cur.freqHz - center, squelch: -200 });
          listenCenter = center;
          console.log(`Señal en ${cur.name} (${(cur.freqHz / 1e6).toFixed(4)} MHz), SNR ${best.snr.toFixed(1)} dB`);
        } else {
          idx = Math.max(idx, covered) + 1;
        }
        continue;
      }

      // Fijado en un canal: confirmando o escuchando
      if (memSkip) {
        memSkip = false;
        lockout.set(cur.id, Date.now() + 30000); // se ignora 30 s
        phase = 'scan';
        idx = nextAfter(chans, cur);
        sendAudio(new Float32Array(0), -200);
        continue;
      }
      const buf = await rtl.read(LISTEN_BLOCK * 2);
      const { audio, levelDb } = demod.process(buf);
      const db = powerSpectrum(buf, n, 24);
      const snr = channelSnr(db, center, cur, binHz) ?? -99;
      const now = Date.now();
      if (snr >= (phase === 'qualify' ? thrDb : thrDb - 3)) lastSeen = now; // 3 dB de histéresis
      const quietMs = now - lastSeen;

      if (phase === 'qualify') {
        if (quietMs > 400) { // era corta: seguimos saltando
          phase = 'scan';
          idx = nextAfter(chans, cur);
          sendAudio(new Float32Array(0), -200);
          continue;
        }
        if (now - t0 >= holdMs) phase = 'listen';
      } else if (quietMs > hangMs) { // terminó la transmisión
        console.log(`Fin de señal en ${cur.name}`);
        phase = 'scan';
        idx = nextAfter(chans, cur);
        sendAudio(new Float32Array(0), -200);
        continue;
      }
      if (phase === 'qualify' && mute) audio.fill(0);
      sendAudio(audio, levelDb);

      if (now - lastMsg > 250) {
        lastMsg = now;
        setMemState({ phase, id: cur.id, name: cur.name, freqHz: cur.freqHz, mode: cur.mode,
          snr: +snr.toFixed(1), elapsedMs: now - t0, quietMs, holdMs, hangMs });
      }
      // Espectro de la zona (~10 por segundo)
      if (block++ % 2 === 0) {
        const keep = Math.max(2, Math.floor((n * cfg.crop) / 2) * 2);
        const first = n / 2 - keep / 2;
        const firstHz = center + (first - n / 2) * binHz;
        const id = ++sweepId;
        broadcast({ type: 'sweepStart', id, startHz: firstHz, stopHz: firstHz + keep * binHz, binHz, segments: 1 });
        sendSegment(id, firstHz, binHz, db.subarray(first, first + keep));
        broadcast({ type: 'sweepEnd', id, ms: 50 });
      }
      if (rtl.queueLen > fs * 2) rtl.flush();
    }
  } catch (e) {
    console.warn('Escaneo de frecuencias interrumpido:', e.message);
    await sleep(300);
  } finally {
    rtl.setStreaming(false);
    listenCenter = null;
    setMemState(null);
    console.log('Escaneo de mis frecuencias detenido');
  }
}

async function sweepLoop() {
  let applied = null;
  let tunedHz = null, tunedCfg = null;
  while (true) {
    if (memScan) {
      if (!rtl.connected) { await rtl.waitConnected(); continue; }
      await memScanSession();
      applied = null; tunedHz = null;
      continue;
    }
    if (listen) {
      if (!rtl.connected) { await rtl.waitConnected(); continue; }
      await listenSession();
      applied = null; tunedHz = null; // al volver hay que reconfigurar el barrido
      continue;
    }
    if (!running) { await sleep(100); continue; }
    if (!rtl.connected) { applied = null; tunedHz = null; await rtl.waitConnected(); continue; }
    try {
      const c = cfg;
      const ver = cfgVersion;
      if (applied !== c) { await applyHardware(c, applied); applied = c; }
      const plan = makePlan(c);
      const id = ++sweepId;
      const t0 = Date.now();
      broadcast({
        type: 'sweepStart', id, startHz: c.startHz, stopHz: c.stopHz, binHz: plan.binHz,
        segments: plan.segments.length,
      });
      for (const seg of plan.segments) {
        if (!running || ver !== cfgVersion || listen || memScan) break;
        // Con un solo salto (modo monitor) no se resintoniza: espectro continuo y rápido
        if (seg.center !== tunedHz || applied !== tunedCfg) {
          tunedHz = seg.center;
          tunedCfg = applied;
          rtl.setFreq(seg.center);
          if (c.settleMs) await sleep(c.settleMs);
          await rtl.read(16384);
        }
        // Tras resintonizar quedan muestras de la frecuencia anterior en los búferes
        // de rtl_tcp/USB/TCP. Durante el tiempo de asentamiento se descarta todo lo que
        // llega (por tiempo, no por bytes: así también se vacía cualquier retraso
        // acumulado) y después un bloque más por seguridad.
        const buf = await rtl.read(plan.n * 2 * c.avg);
        const db = powerSpectrum(buf, plan.n, c.avg);
        const slice = db.subarray(seg.first, seg.first + seg.count);
        const firstHz = seg.center + (seg.first - plan.n / 2) * plan.binHz;
        sendSegment(id, firstHz, plan.binHz, slice);
        if (listen) break;
      }
      if (ver === cfgVersion && running && !listen && !memScan) {
        lastSweepMs = Date.now() - t0;
        broadcast({ type: 'sweepEnd', id, ms: lastSweepMs });
        // En modo monitor, como mucho ~30 actualizaciones por segundo
        if (plan.segments.length === 1) await sleep(Math.max(0, 33 - lastSweepMs));
      }
    } catch (e) {
      tunedHz = null;
      console.warn('Barrido interrumpido:', e.message);
      await sleep(300);
    }
  }
}

// ---------------------------------------------------------------- HTTP + WS
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(statusMsg()));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'config') {
      cfg = sanitize(m.cfg || {});
      cfgVersion++;
      if (m.start) running = true;
    } else if (m.type === 'start') {
      running = true;
    } else if (m.type === 'stop') {
      running = false;
    } else if (m.type === 'listen') {
      const f = Number(m.freqHz);
      if (!(f > 0 && f < 3e9)) return;
      const mode = ['wfm', 'nfm', 'am'].includes(m.mode) ? m.mode : 'wfm';
      const bw = Math.min(50e3, Math.max(3e3, Number(m.bw) || 12500));
      const squelch = Number.isFinite(Number(m.squelch)) ? Number(m.squelch) : -200;
      listen = { freqHz: Math.round(f), mode, bw, squelch };
      listenVer++;
      memScan = null; // escuchar a mano para el escaneo de frecuencias
    } else if (m.type === 'listenStop') {
      listen = null;
    } else if (m.type === 'memScan') {
      const num = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
      memScan = {
        thrDb: num(m.thrDb, 3, 40, 10),
        holdMs: num(m.holdMs, 0, 30000, 2000),
        hangMs: num(m.hangMs, 0, 60000, 2000),
        mute: !!m.mute,
      };
      listen = null;
    } else if (m.type === 'memScanStop') {
      memScan = null;
    } else if (m.type === 'memSkip') {
      memSkip = true;
    } else if (m.type === 'saveBand') {
      const b = sanitizeBand(m.band);
      if (!b) return;
      customBands = customBands.filter((x) => x.name.toLowerCase() !== b.name.toLowerCase());
      customBands.push(b);
      customBands.sort((a, c) => a.min - c.min);
      saveCustomBands();
    } else if (m.type === 'deleteBand') {
      customBands = customBands.filter((x) => x.name !== m.name);
      saveCustomBands();
    } else if (m.type === 'setTag') {
      setTag(m); // nombre vacío = quitar etiqueta
    } else if (m.type === 'saveFreq') {
      upsertFreq(m.freq);
    } else if (m.type === 'deleteFreq') {
      if (typeof m.id !== 'string') return;
      freqs = freqs.filter((o) => o.id !== m.id);
      saveFreqs();
    }
    broadcast(statusMsg());
  });
});

// ---------------------------------------------------------------- arranque
if (SIM) {
  const { startSim } = await import('./sim-rtl-tcp.js');
  await startSim(RTL_PORT);
}
const rtl = new RtlTcp(RTL_HOST, RTL_PORT, () => broadcast(statusMsg()));
server.listen(HTTP_PORT, () => {
  console.log(`Escáner del Búnker Hacker en http://localhost:${HTTP_PORT}`);
  console.log(`Buscando rtl_tcp en ${RTL_HOST}:${RTL_PORT}${SIM ? ' (simulado)' : ''}…`);
});
setInterval(() => broadcast(statusMsg()), 3000);
sweepLoop();
