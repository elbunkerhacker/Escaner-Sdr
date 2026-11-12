'use strict';
// Escáner del Búnker Hacker — cliente web
const $ = (id) => document.getElementById(id);
const MHz = 1e6;
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// ---------------------------------------------------------------- estado
const S = {
  ws: null,
  status: null,
  cfg: null,
  gains: [],
  running: false,
  firstStatus: true,
  sweep: null, // { id, startHz, stopHz, binHz, segTotal, segDone }
  geomKey: '',
  disp: null, // Float32Array con el último valor por bin
  peak: null, // retención de picos
  floorBins: null, // ruido estimado por bin
  floor: -80,
  scale: { min: -90, max: -10 },
  hoverX: null,
  drag: null,
  history: [],
  signals: store.get('sdr.signals', []),
  tags: [], // etiquetas guardadas en el servidor
  freqs: [], // mis frecuencias (memorias) guardadas en el servidor
  freqEditId: null,
  editingTag: false,
  lastTable: 0,
  lastSweepMs: 0,
  ui: Object.assign({ threshold: 10, autoScale: true, peakHold: true, showBands: true, dbMin: -90, dbMax: -10, sort: 'f' }, store.get('sdr.ui', {})),
};

// ---------------------------------------------------------------- utilidades
function fmtMHz(hz, span) {
  const d = span < 0.05 * MHz ? 5 : span < 2 * MHz ? 4 : span < 50 * MHz ? 3 : 2;
  return (hz / MHz).toFixed(d);
}
function fmtFreq(hz) {
  return (hz / MHz).toFixed(hz < 1e9 ? 4 : 3) + ' MHz';
}
function fmtBw(hz) {
  return hz >= 1e6 ? (hz / 1e6).toFixed(2) + ' MHz' : (hz / 1e3).toFixed(1) + ' kHz';
}
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 2) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(ts).toLocaleTimeString();
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function percentile(arr, q) {
  const v = Array.from(arr).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

// Paleta de la cascada (azul oscuro → cian → amarillo → rojo → blanco)
const LUT = (() => {
  const stops = [[0, [4, 7, 20]], [0.2, [10, 30, 90]], [0.4, [8, 120, 170]], [0.55, [34, 211, 238]],
    [0.7, [250, 204, 21]], [0.85, [239, 68, 68]], [1, [255, 245, 235]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const u = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return lut;
})();

// ---------------------------------------------------------------- WebSocket
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => setPill('wsPill', 'on', 'Servidor conectado');
  ws.onclose = () => {
    setPill('wsPill', 'off', 'Servidor desconectado');
    S.firstStatus = true;
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return onJson(JSON.parse(ev.data));
    const kind = new Uint8Array(ev.data, 0, 1)[0];
    if (kind === 1) onSegment(ev.data);
    else if (kind === 2) onAudio(ev.data);
  };
}
function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}
function setPill(id, cls, text) {
  const el = $(id);
  el.className = 'pill ' + cls;
  el.textContent = text;
}

function onJson(m) {
  if (m.type === 'status') onStatus(m);
  else if (m.type === 'sweepStart') onSweepStart(m);
  else if (m.type === 'sweepEnd') onSweepEnd(m);
  else if (m.type === 'memState') { S.memState = m.state; updateMemScanUi(); }
}

function onStatus(m) {
  S.status = m;
  S.gains = m.gains || [];
  S.running = m.running;
  const r = m.rtl;
  if (r.connected) setPill('rtlPill', m.sim ? 'sim' : 'on', `${m.sim ? 'Simulador' : 'RTL-SDR'} · ${r.tuner}`);
  else setPill('rtlPill', 'off', `Sin rtl_tcp (${r.host}:${r.port})`);
  $('gain').max = Math.max(0, S.gains.length - 1);
  const cb = m.customBands || [];
  if (JSON.stringify(cb) !== JSON.stringify(window.CUSTOM_BANDS)) {
    window.CUSTOM_BANDS = cb;
    buildPresetSelect();
    renderTable();
    requestDraw();
  }
  const fq = m.freqs || [];
  if (JSON.stringify(fq) !== JSON.stringify(S.freqs)) {
    S.freqs = fq;
    renderFreqs();
    renderTable();
    requestDraw();
  }
  const tg = m.tags || [];
  if (JSON.stringify(tg) !== JSON.stringify(S.tags)) {
    S.tags = tg;
    renderTable();
    requestDraw();
  }
  S.listen = m.listen || null;
  S.memScan = m.memScan || null;
  S.memState = m.memState || null;
  updateMemScanUi();
  S.audioRate = m.audioRate || 48000;
  updateListenUi();

  if (S.firstStatus) {
    S.firstStatus = false;
    const saved = store.get('sdr.cfg', null);
    if (saved && JSON.stringify(saved) !== JSON.stringify(m.cfg)) {
      S.cfg = saved;
      send({ type: 'config', cfg: saved });
    } else S.cfg = m.cfg;
    cfgToInputs();
  } else if (JSON.stringify(m.cfg) !== JSON.stringify(S.cfg)) {
    S.cfg = m.cfg;
    cfgToInputs();
  }
  updateRunBtn();
}

// ---------------------------------------------------------------- barridos
function onSweepStart(m) {
  const key = `${m.startHz}|${m.stopHz}|${m.binHz}`;
  const n = Math.max(1, Math.ceil((m.stopHz - m.startHz) / m.binHz));
  if (key !== S.geomKey) {
    S.geomKey = key;
    S.disp = new Float32Array(n).fill(NaN);
    S.peak = new Float32Array(n).fill(NaN);
    S.floorBins = null;
    clearWaterfall();
  }
  S.sweep = { id: m.id, startHz: m.startHz, stopHz: m.stopHz, binHz: m.binHz, segTotal: m.segments, segDone: 0, n };
}

function onSegment(buf) {
  const dv = new DataView(buf);
  const id = dv.getFloat64(8, true);
  const sw = S.sweep;
  if (!sw || id !== sw.id) return;
  const firstHz = dv.getFloat64(16, true);
  const db = new Float32Array(buf, 32);
  const i0 = Math.round((firstHz - sw.startHz) / sw.binHz);
  for (let k = 0; k < db.length; k++) {
    const i = i0 + k;
    if (i < 0 || i >= sw.n) continue;
    S.disp[i] = db[k];
    if (!(S.peak[i] >= db[k])) S.peak[i] = db[k];
  }
  sw.segDone++;
  $('progressBar').style.width = `${(100 * sw.segDone) / sw.segTotal}%`;
  requestDraw();
}

function onSweepEnd(m) {
  if (!S.sweep || m.id !== S.sweep.id) return;
  S.lastSweepMs = m.ms;
  const sw = S.sweep;
  const now0 = performance.now();
  const dt = S.lastEndT ? now0 - S.lastEndT : 0;
  S.lastEndT = now0;
  S.rate = S.rate ? S.rate * 0.9 + (dt ? 1000 / dt : 0) * 0.1 : (dt ? 1000 / dt : 0);
  $('sweepInfo').textContent = S.listen
    ? `🎧 ${fmtFreq(S.listen.freqHz)} · ${MODE_NAMES[S.listen.mode]}`
    : S.memScan && S.memState && S.memState.name
    ? `⟳ ${S.memState.name} · ${fmtFreq(S.memState.freqHz)}`
    : sw.segTotal === 1
    ? `monitor · ${S.rate.toFixed(0)} act/s`
    : `barrido ${m.ms < 1000 ? m.ms + ' ms' : (m.ms / 1000).toFixed(1) + ' s'} · ${sw.segTotal} saltos`;
  const dets = detect();
  mergeSignals(dets);
  autoScale();
  addWaterfallRow();
  const now = Date.now();
  if (now - S.lastTable > 500) { S.lastTable = now; renderTable(true); }
  requestDraw();
}

// ---------------------------------------------------------------- detección
function detect() {
  const d = S.disp, n = d.length, sw = S.sweep;
  // Ruido de fondo por bloques (percentil 25: robusto aunque haya muchas señales)
  const block = Math.max(128, Math.ceil(n / 48));
  const floors = new Float32Array(n);
  const blockFloors = [];
  for (let b = 0; b < n; b += block) {
    const f = percentile(d.subarray(b, Math.min(n, b + block)), 0.25);
    blockFloors.push(f);
    floors.fill(f, b, Math.min(n, b + block));
  }
  S.floorBins = floors;
  const g = percentile(Float32Array.from(blockFloors), 0.5);
  if (!Number.isNaN(g)) S.floor = g;

  const T = S.ui.threshold;
  const maxGap = Math.max(2, Math.round(12.5e3 / sw.binHz)); // huecos < 12.5 kHz no parten una señal
  const out = [];
  let runStart = -1, gap = 0;
  const close = (end) => {
    let pk = runStart, wsum = 0, fsum = 0;
    for (let i = runStart; i <= end; i++) {
      if (d[i] > d[pk]) pk = i;
      const p = Math.pow(10, d[i] / 10);
      wsum += p; fsum += p * i;
    }
    const ci = fsum / wsum;
    out.push({
      f: sw.startHz + (ci + 0.5) * sw.binHz,
      db: d[pk],
      snr: d[pk] - floors[pk],
      bw: (end - runStart + 1) * sw.binHz,
    });
  };
  for (let i = 0; i < n; i++) {
    const above = d[i] > floors[i] + T;
    if (above) {
      if (runStart < 0) runStart = i;
      gap = 0;
    } else if (runStart >= 0 && ++gap > maxGap) {
      close(i - gap);
      runStart = -1; gap = 0;
    }
  }
  if (runStart >= 0) close(n - 1 - gap);
  return out;
}

function mergeSignals(dets) {
  const sw = S.sweep, now = Date.now();
  // Histéresis: una señal sigue "activa" 2 s después de la última detección,
  // para que el parpadeo alrededor del umbral no cuente como apariciones nuevas.
  const HOLD = 2000;
  for (const s of S.signals) if (s.f >= sw.startHz && s.f <= sw.stopHz) s.live = now - s.last < HOLD;
  const margin = Math.max(3 * sw.binHz, 5e3);
  const overlaps = (a, b) => Math.abs(a.f - b.f) <= (a.bw + b.bw) / 2 + margin;
  for (const d of dets) {
    let m = null, best = Infinity;
    for (const s of S.signals) {
      const dist = Math.abs(s.f - d.f);
      if (overlaps(s, d) && dist < best) { m = s; best = dist; }
    }
    if (m) {
      m.f = d.f; m.bw = d.bw; m.db = d.db; m.snr = d.snr;
      m.maxDb = Math.max(m.maxDb, d.db);
      if (now - m.last >= HOLD) m.hits++;
      m.live = true; m.last = now;
    } else {
      S.signals.push({ f: d.f, bw: d.bw, db: d.db, snr: d.snr, maxDb: d.db, hits: 1, first: now, last: now, live: true });
    }
  }
  // Fusionar entradas que ahora se solapan (p. ej. una señal débil que antes salió partida)
  S.signals.sort((a, b) => a.f - b.f);
  for (let i = 1; i < S.signals.length; i++) {
    const a = S.signals[i - 1], b = S.signals[i];
    if (overlaps(a, b) && (a.live || b.live)) {
      const keep = a.live && (!b.live || a.bw >= b.bw) ? a : b, drop = keep === a ? b : a;
      keep.hits = Math.max(keep.hits, drop.hits);
      keep.maxDb = Math.max(keep.maxDb, drop.maxDb);
      keep.first = Math.min(keep.first, drop.first);
      S.signals.splice(S.signals.indexOf(drop), 1);
      i--;
    }
  }
  if (S.signals.length > 400) {
    S.signals.sort((a, b) => b.last - a.last);
    S.signals.length = 400;
  }
  store.set('sdr.signals', S.signals);
}

function autoScale() {
  if (!S.ui.autoScale) return;
  let max = -Infinity;
  const src = S.ui.peakHold ? S.peak : S.disp;
  for (let i = 0; i < src.length; i++) if (src[i] > max) max = src[i];
  if (!Number.isFinite(max)) return;
  const tMin = Math.floor((S.floor - 12) / 5) * 5;
  const tMax = Math.max(tMin + 30, Math.ceil((max + 6) / 5) * 5);
  S.scale.min += (tMin - S.scale.min) * 0.5;
  S.scale.max += (tMax - S.scale.max) * 0.5;
  $('dbMin').value = Math.round(S.scale.min);
  $('dbMax').value = Math.round(S.scale.max);
}

// ---------------------------------------------------------------- dibujo
const spec = $('spectrum'), wf = $('waterfall');
const sctx = spec.getContext('2d'), wctx = wf.getContext('2d');
const M = { l: 48, r: 12, t: 20, b: 24 }; // márgenes en px CSS
let dpr = window.devicePixelRatio || 1;
let drawPending = false;

function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawSpectrum(); });
}

function plotBox(canvas) {
  const W = canvas.width / dpr, H = canvas.height / dpr;
  return { W, H, x0: M.l, x1: W - M.r, pw: W - M.l - M.r };
}

/** Máximo por columna de píxel (para que ninguna señal estrecha desaparezca al reducir). */
function columns(arr, pw) {
  const sw = S.sweep;
  const cols = new Float32Array(pw).fill(NaN);
  if (!arr || !sw) return cols;
  const n = arr.length;
  for (let x = 0; x < pw; x++) {
    const i0 = Math.floor((x / pw) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / pw) * n));
    let m = NaN;
    for (let i = i0; i < i1 && i < n; i++) {
      const v = arr[i];
      if (!Number.isNaN(v) && !(m >= v)) m = v;
    }
    cols[x] = m;
  }
  return cols;
}

function drawSpectrum() {
  const ctx = sctx;
  const { W, H, x0, x1, pw } = plotBox(spec);
  const y0 = M.t, y1 = H - M.b, ph = y1 - y0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#060a12';
  ctx.fillRect(x0, y0, pw, ph);

  const sw = S.sweep;
  const lo = S.scale.min, hi = S.scale.max;
  const yOf = (db) => y0 + ph * (1 - (db - lo) / (hi - lo));

  // Rejilla dB
  ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const dStep = hi - lo > 60 ? 10 : 5;
  for (let v = Math.ceil(lo / dStep) * dStep; v <= hi; v += dStep) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = 'rgba(125,138,166,.13)';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = '#7d8aa6';
    ctx.fillText(String(v), x0 - 6, y);
  }
  ctx.save();
  ctx.translate(11, y0 + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('dBFS', 0, 0);
  ctx.restore();

  if (!sw) {
    ctx.fillStyle = '#7d8aa6'; ctx.textAlign = 'center';
    ctx.fillText(S.running ? 'Esperando datos…' : 'Pulsa «Escanear» para empezar', x0 + pw / 2, y0 + ph / 2);
    return;
  }
  const span = sw.stopHz - sw.startHz;
  const xOfF = (f) => x0 + ((f - sw.startHz) / span) * pw;

  // Rejilla de frecuencia
  const fStep = niceStep(span / Math.max(2, pw / 110));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = Math.ceil(sw.startHz / fStep) * fStep; f <= sw.stopHz; f += fStep) {
    const x = Math.round(xOfF(f)) + 0.5;
    ctx.strokeStyle = 'rgba(125,138,166,.13)';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillStyle = '#7d8aa6';
    const label = fmtMHz(f, fStep * 5);
    const half = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.min(x1 - half, Math.max(x0 + half, x)), y1 + 6);
  }

  // Bandas
  if (S.ui.showBands) {
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const b of window.allBands().slice().reverse()) { // las personalizadas, encima
      const bx0 = Math.max(x0, xOfF(b.min * MHz)), bx1 = Math.min(x1, xOfF(b.max * MHz));
      if (bx1 <= bx0) continue;
      ctx.fillStyle = b.color + '33';
      ctx.fillRect(bx0, 3, Math.max(1, bx1 - bx0), 13);
      ctx.fillStyle = b.color + '0d';
      ctx.fillRect(bx0, y0, Math.max(1, bx1 - bx0), ph);
    }
    // Nombres: primero las personalizadas; si un nombre pisaría otro ya escrito, se omite
    const used = [];
    for (const b of window.allBands()) {
      const bx0 = Math.max(x0, xOfF(b.min * MHz)), bx1 = Math.min(x1, xOfF(b.max * MHz));
      const w = ctx.measureText(b.name).width;
      if (bx1 <= bx0 || w + 8 >= bx1 - bx0) continue;
      let lx = bx0 + 4;
      for (const [a, z] of used) if (lx < z + 6 && lx + w > a - 6) lx = z + 10; // correr a la derecha
      if (lx + w + 4 > bx1) continue;
      used.push([lx, lx + w]);
      ctx.fillStyle = b.color; ctx.fillText(b.name, lx, 10);
    }
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip();

  // Retención de picos
  if (S.ui.peakHold) {
    const pk = columns(S.peak, Math.round(pw));
    traceLine(ctx, pk, x0, yOf, 'rgba(251,191,36,.55)', 1);
  }
  // Espectro actual con relleno
  const cur = columns(S.disp, Math.round(pw));
  const grad = ctx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, 'rgba(34,211,238,.35)');
  grad.addColorStop(1, 'rgba(34,211,238,.02)');
  ctx.beginPath();
  let started = false, lastX = x0;
  for (let x = 0; x < cur.length; x++) {
    if (Number.isNaN(cur[x])) continue;
    const px = x0 + x, py = yOf(cur[x]);
    if (!started) { ctx.moveTo(px, y1); ctx.lineTo(px, py); started = true; } else ctx.lineTo(px, py);
    lastX = px;
  }
  if (started) { ctx.lineTo(lastX, y1); ctx.closePath(); ctx.fillStyle = grad; ctx.fill(); }
  traceLine(ctx, cur, x0, yOf, '#22d3ee', 1.25);

  // Umbral de detección
  if (S.floorBins) {
    const fl = columns(S.floorBins, Math.round(pw));
    for (let i = 0; i < fl.length; i++) fl[i] += S.ui.threshold;
    ctx.setLineDash([4, 4]);
    traceLine(ctx, fl, x0, yOf, 'rgba(248,113,113,.6)', 1);
    ctx.setLineDash([]);
  }

  // Marcadores de señales activas
  ctx.fillStyle = '#4ade80';
  for (const s of S.signals) {
    if (!s.live || s.f < sw.startHz || s.f > sw.stopHz) continue;
    const x = xOfF(s.f), y = yOf(s.db) - 6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y - 7); ctx.lineTo(x + 4, y - 7); ctx.fill();
  }

  // Etiquetas (en filas escalonadas para que no se pisen)
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const rowEnd = [-Infinity, -Infinity, -Infinity];
  for (const t of S.tags) {
    if (t.f < sw.startHz || t.f > sw.stopHz) continue;
    const x = xOfF(t.f);
    const w = ctx.measureText(t.name).width + 10;
    let lx = Math.min(x1 - w - 2, Math.max(x0 + 2, x - w / 2));
    let row = rowEnd.findIndex((end) => lx > end + 4);
    if (row < 0) continue; // no cabe: se ve igual en la tabla y al pasar el ratón
    rowEnd[row] = lx + w;
    const ly = y0 + 10 + row * 18;
    ctx.strokeStyle = t.color + '88';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, ly + 8); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(6,10,18,.85)';
    ctx.beginPath(); ctx.roundRect(lx, ly - 8, w, 16, 8); ctx.fill();
    ctx.strokeStyle = t.color; ctx.stroke();
    ctx.fillStyle = t.color;
    ctx.fillText(t.name, lx + 5, ly + 0.5);
  }

  // Mis frecuencias: estrella sobre el eje
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const fr of S.freqs) {
    if (fr.freqHz < sw.startHz || fr.freqHz > sw.stopHz) continue;
    const x = xOfF(fr.freqHz);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('★', x, y1 - 8);
  }

  // Canal que se está escuchando
  const msL = S.memState && S.memState.phase !== 'scan' && S.memState.freqHz
    ? (() => { const f = S.freqs.find((x) => x.id === S.memState.id); return f && { freqHz: f.freqHz, mode: f.mode, bw: f.bw }; })()
    : null;
  const L = S.listen || msL || (S.ui.lsFreq ? { freqHz: S.ui.lsFreq * MHz, mode: S.ui.lsMode, bw: S.ui.lsBw, idle: true } : null);
  if (L && L.freqHz >= sw.startHz && L.freqHz <= sw.stopHz) {
    const bw = L.mode === 'wfm' ? 200e3 : L.bw;
    const xa = xOfF(L.freqHz - bw / 2), xb = xOfF(L.freqHz + bw / 2), xc = Math.round(xOfF(L.freqHz)) + 0.5;
    ctx.fillStyle = L.idle ? 'rgba(251,146,60,.06)' : 'rgba(251,146,60,.16)';
    ctx.fillRect(xa, y0, Math.max(1, xb - xa), ph);
    ctx.strokeStyle = L.idle ? 'rgba(251,146,60,.45)' : '#fb923c';
    ctx.setLineDash(L.idle ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(xc, y0); ctx.lineTo(xc, y1); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Selección de zoom
  if (S.drag && Math.abs(S.drag.x1 - S.drag.x0) > 2) {
    const a = Math.min(S.drag.x0, S.drag.x1), b = Math.max(S.drag.x0, S.drag.x1);
    ctx.fillStyle = 'rgba(34,211,238,.12)';
    ctx.fillRect(a, y0, b - a, ph);
    ctx.strokeStyle = 'rgba(34,211,238,.7)';
    ctx.strokeRect(a + 0.5, y0 + 0.5, b - a, ph - 1);
  }
  // Cursor
  if (S.hoverX != null && S.hoverX >= x0 && S.hoverX <= x1) {
    ctx.strokeStyle = 'rgba(219,228,243,.35)';
    ctx.beginPath(); ctx.moveTo(S.hoverX + 0.5, y0); ctx.lineTo(S.hoverX + 0.5, y1); ctx.stroke();
  }
  ctx.restore();
}

function traceLine(ctx, cols, x0, yOf, color, width) {
  ctx.beginPath();
  let pen = false;
  for (let x = 0; x < cols.length; x++) {
    if (Number.isNaN(cols[x])) { pen = false; continue; }
    const px = x0 + x + 0.5, py = yOf(cols[x]);
    if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
  }
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.lineWidth = 1;
}

// ---------------------------------------------------------------- cascada
function clearWaterfall() {
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.fillStyle = '#04070e';
  wctx.fillRect(0, 0, wf.width, wf.height);
}

function addWaterfallRow() {
  const Wd = wf.width, Hd = wf.height;
  const x0 = Math.round(M.l * dpr), pw = Math.round(Wd - (M.l + M.r) * dpr);
  if (pw <= 0) return;
  const ms = S.lastSweepMs;
  const rowH = Math.round((ms > 1500 ? 4 : ms > 300 ? 2 : 1) * dpr);
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.drawImage(wf, 0, 0, Wd, Hd - rowH, 0, rowH, Wd, Hd - rowH);
  const cols = columns(S.disp, pw);
  const img = wctx.createImageData(pw, rowH);
  const lo = S.scale.min, hi = S.scale.max;
  for (let x = 0; x < pw; x++) {
    const v = cols[x];
    const t = Number.isNaN(v) ? 0 : Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
    for (let r = 0; r < rowH; r++) {
      const o = (r * pw + x) * 4;
      img.data[o] = LUT[t * 3]; img.data[o + 1] = LUT[t * 3 + 1]; img.data[o + 2] = LUT[t * 3 + 2]; img.data[o + 3] = 255;
    }
  }
  wctx.putImageData(img, x0, 0);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  for (const c of [spec, wf]) {
    const r = c.parentElement.getBoundingClientRect();
    const w = Math.max(50, Math.round(r.width * dpr)), h = Math.max(50, Math.round(r.height * dpr));
    if (c.width === w && c.height === h) continue;
    if (c === wf && wf.width > 1) {
      const tmp = document.createElement('canvas');
      tmp.width = wf.width; tmp.height = wf.height;
      tmp.getContext('2d').drawImage(wf, 0, 0);
      c.width = w; c.height = h;
      clearWaterfall();
      wctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, w, tmp.height * (w / tmp.width));
    } else {
      c.width = w; c.height = h;
    }
  }
  requestDraw();
}
new ResizeObserver(resize).observe($('specWrap'));
new ResizeObserver(resize).observe($('wfWrap'));

// ---------------------------------------------------------------- ratón
function freqAt(px) {
  const sw = S.sweep;
  if (!sw) return null;
  const { x0, pw } = plotBox(spec);
  const t = (px - x0) / pw;
  if (t < 0 || t > 1) return null;
  return sw.startHz + t * (sw.stopHz - sw.startHz);
}

for (const c of [spec, wf]) {
  c.addEventListener('mousemove', (e) => {
    const x = e.offsetX;
    S.hoverX = x;
    if (S.drag) S.drag.x1 = x;
    const f = freqAt(x);
    const ro = $('readout');
    if (f == null) { ro.hidden = true; requestDraw(); return; }
    const sw = S.sweep;
    const i = Math.floor((f - sw.startHz) / sw.binHz);
    const v = S.disp[i];
    const band = window.bandFor(f / MHz);
    const tag = tagFor(f, 2 * sw.binHz);
    const fav = freqFor(f, Math.max(4 * sw.binHz, ((sw.stopHz - sw.startHz) / plotBox(spec).pw) * 6));
    ro.innerHTML = `${fmtFreq(f)}${Number.isNaN(v) || v === undefined ? '' : ` · ${v.toFixed(1)} dB`}` +
      `${fav ? `<br><b style="color:#fbbf24">★ ${esc(fav.name)}</b> <span class="muted">${fmtFreq(fav.freqHz)}</span>` : ''}` +
      `${tag ? `<br><b style="color:${tag.color}">🏷 ${esc(tag.name)}</b>` : ''}` +
      `${band ? `<br><span style="color:${band.color}">${esc(band.name)}</span>` : ''}`;
    ro.hidden = false;
    const wrap = $('specWrap').getBoundingClientRect();
    const left = Math.min(x + 12, wrap.width - ro.offsetWidth - 4);
    ro.style.left = `${left}px`;
    ro.style.top = c === spec ? `${Math.max(22, e.offsetY - 34)}px` : `${wrap.height - ro.offsetHeight - 28}px`;
    requestDraw();
  });
  c.addEventListener('mouseleave', () => { S.hoverX = null; S.drag = null; $('readout').hidden = true; requestDraw(); });
  c.addEventListener('mousedown', (e) => { if (e.button === 0) S.drag = { x0: e.offsetX, x1: e.offsetX }; });
  c.addEventListener('mouseup', () => {
    const d = S.drag;
    S.drag = null;
    if (!d || Math.abs(d.x1 - d.x0) < 6) {
      // Clic simple: sintonizar ahí (se ajusta a la señal detectada más cercana)
      const f = d && freqAt(d.x0);
      if (f != null) tuneTo(f);
      requestDraw();
      return;
    }
    const a = freqAt(Math.min(d.x0, d.x1)) ?? S.sweep.startHz;
    const b = freqAt(Math.max(d.x0, d.x1)) ?? S.sweep.stopHz;
    zoomTo(a, b);
  });
  c.addEventListener('dblclick', (e) => {
    const f = freqAt(e.offsetX);
    if (f == null) return;
    const span = (S.cfg.stopHz - S.cfg.startHz) / 4;
    zoomTo(f - span / 2, f + span / 2);
  });
}

function zoomTo(a, b) {
  const minSpan = 10e3;
  if (b - a < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
  S.history.push({ startHz: S.cfg.startHz, stopHz: S.cfg.stopHz });
  if (S.history.length > 30) S.history.shift();
  applyCfg({ startHz: Math.round(Math.max(0, a)), stopHz: Math.round(b) }, true);
}

// ---------------------------------------------------------------- controles
function cfgToInputs() {
  const c = S.cfg;
  if (!c) return;
  const setIf = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  setIf('startMHz', +(c.startHz / MHz).toFixed(6));
  setIf('stopMHz', +(c.stopHz / MHz).toFixed(6));
  setIf('sampleRate', String(c.sampleRate));
  setIf('fftSize', String(c.fftSize));
  setIf('avg', c.avg);
  setIf('settleMs', c.settleMs);
  setIf('ppm', c.ppm);
  setIf('crop', String(c.crop));
  $('biasTee').checked = !!c.biasTee;
  $('gainAuto').checked = c.gain === 'auto';
  $('gain').disabled = c.gain === 'auto';
  if (c.gain !== 'auto' && S.gains.length) {
    let bi = 0;
    S.gains.forEach((g, i) => { if (Math.abs(g - c.gain) < Math.abs(S.gains[bi] - c.gain)) bi = i; });
    $('gain').value = bi;
  }
  $('gainVal').textContent = c.gain === 'auto' ? 'auto' : `${Number(c.gain).toFixed(1)} dB`;
  syncPresetSelect();
  updateResInfo();
}

function updateResInfo() {
  const c = S.cfg;
  const bin = c.sampleRate / c.fftSize;
  const keep = Math.max(2, Math.floor((c.fftSize * c.crop) / 2) * 2);
  const usable = keep * bin;
  const steps = Math.max(1, Math.ceil((c.stopHz - c.startHz) / usable));
  const perStep = c.settleMs + (1000 * c.fftSize * c.avg) / c.sampleRate;
  const est = steps * perStep;
  $('resInfo').textContent = `${fmtBw(bin)}/bin · ${fmtBw(usable)}/salto · ${steps} salto${steps > 1 ? 's' : ''} · ≈${est < 1000 ? Math.round(est) + ' ms' : (est / 1000).toFixed(1) + ' s'}`;
}

function applyCfg(patch, start) {
  S.cfg = Object.assign({}, S.cfg, patch);
  store.set('sdr.cfg', S.cfg);
  cfgToInputs();
  send({ type: 'config', cfg: S.cfg, start: !!start || S.running });
}

function updateRunBtn() {
  const b = $('runBtn');
  b.textContent = S.running ? '■ Detener' : '▶ Escanear';
  b.classList.toggle('running', S.running);
  $('backBtn').disabled = !S.history.length;
}

/** Lee Inicio/Fin. Si uno queda al otro lado del otro, se mueve el contrario
 *  conservando el ancho actual (p. ej. Inicio 863 con Fin 98,5 → Fin 863 + ancho). */
function readRange(e) {
  let a = Math.round(parseFloat(String($('startMHz').value).replace(',', '.')) * MHz);
  let b = Math.round(parseFloat(String($('stopMHz').value).replace(',', '.')) * MHz);
  if (!(a >= 0) || !(b >= 0)) { cfgToInputs(); return; }
  if (b <= a) {
    const span = Math.max(10e3, S.cfg.stopHz - S.cfg.startHz);
    if (e && e.target === $('stopMHz')) a = Math.max(0, b - span);
    else b = a + span;
  }
  S.history.push({ startHz: S.cfg.startHz, stopHz: S.cfg.stopHz });
  applyCfg({ startHz: a, stopHz: b });
}

function initControls() {
  const sel = $('preset');
  buildPresetSelect();
  sel.addEventListener('change', () => {
    const r = presetRange(sel.value);
    if (!r) return;
    S.history.push({ startHz: S.cfg.startHz, stopHz: S.cfg.stopHz });
    applyCfg({ startHz: r[0], stopHz: r[1] }, true);
    // La frecuencia de escucha pasa al centro de la banda (redondeada a 1 kHz), con el
    // modo de la banda: el que tenga guardado si es propia, o el típico de esa banda.
    const center = Math.round((r[0] + r[1]) / 2 / 1e3) * 1e3;
    setListenParams(center, guessMode(center, 0));
    if (S.listen) sendListen(); // si ya estabas escuchando, se resintoniza
  });
  initBandForm();

  $('startMHz').addEventListener('change', readRange);
  $('stopMHz').addEventListener('change', readRange);
  $('runBtn').addEventListener('click', () => {
    if (S.listen || S.memScan) {
      send({ type: 'listenStop' }); send({ type: 'memScanStop' });
      send({ type: 'config', cfg: S.cfg, start: true });
    }
    else if (S.running) send({ type: 'stop' });
    else send({ type: 'config', cfg: S.cfg, start: true });
  });
  $('backBtn').addEventListener('click', () => {
    const h = S.history.pop();
    if (h) applyCfg(h);
    updateRunBtn();
  });

  for (const id of ['sampleRate', 'fftSize', 'avg', 'settleMs', 'ppm', 'crop']) {
    $(id).addEventListener('change', () => applyCfg({ [id]: Number($(id).value) }));
  }
  $('biasTee').addEventListener('change', () => applyCfg({ biasTee: $('biasTee').checked }));
  $('gainAuto').addEventListener('change', () => {
    applyCfg({ gain: $('gainAuto').checked ? 'auto' : S.gains[+$('gain').value] ?? 20 });
  });
  $('gain').addEventListener('input', () => { $('gainVal').textContent = `${(S.gains[+$('gain').value] ?? 0).toFixed(1)} dB`; });
  $('gain').addEventListener('change', () => applyCfg({ gain: S.gains[+$('gain').value] }));

  // Visualización
  const ui = S.ui;
  const saveUi = () => store.set('sdr.ui', ui);
  $('threshold').value = ui.threshold;
  $('thrVal').textContent = `${ui.threshold} dB`;
  $('threshold').addEventListener('input', () => {
    ui.threshold = +$('threshold').value; $('thrVal').textContent = `${ui.threshold} dB`; saveUi(); requestDraw();
  });
  for (const k of ['autoScale', 'peakHold', 'showBands']) {
    $(k).checked = ui[k];
    $(k).addEventListener('change', () => { ui[k] = $(k).checked; saveUi(); requestDraw(); });
  }
  $('dbMin').value = ui.dbMin; $('dbMax').value = ui.dbMax;
  S.scale = { min: ui.dbMin, max: ui.dbMax };
  for (const k of ['dbMin', 'dbMax']) {
    $(k).addEventListener('change', () => {
      ui.autoScale = false; $('autoScale').checked = false;
      ui[k] = +$(k).value;
      S.scale = { min: ui.dbMin, max: Math.max(ui.dbMin + 5, ui.dbMax) };
      saveUi(); requestDraw();
    });
  }
  $('resetPeak').addEventListener('click', () => { if (S.peak) S.peak.fill(NaN); requestDraw(); });

  // Señales
  $('sigSort').value = ui.sort;
  $('sigSort').addEventListener('change', () => { ui.sort = $('sigSort').value; saveUi(); renderTable(); });
  $('clearSig').addEventListener('click', () => { S.signals = []; store.set('sdr.signals', []); renderTable(); requestDraw(); });
  $('exportCsv').addEventListener('click', exportCsv);
  $('sigBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const s = S.signals[+tr.dataset.i];
    if (!s) return;
    if (e.target.closest('.tag-edit')) return; // editando: no hacer zoom
    if (e.target.closest('.fav-row')) {
      const ex = freqFor(s.f, s.bw);
      if (ex) openFreqForm(ex);
      else {
        const mode = guessMode(s.f, s.bw);
        openFreqForm({ freqHz: s.f, mode, bw: mode === 'am' ? 10000 : 12500, name: tagFor(s.f, s.bw)?.name || '' });
      }
      return;
    }
    if (e.target.closest('.tag-cell')) {
      editTag(e.target.closest('.tag-cell'), s);
      return;
    }
    if (e.target.closest('.ls-row')) {
      setListenParams(s.f, guessMode(s.f, s.bw));
      startListening();
      return;
    }
    if (e.target.closest('.del')) {
      S.signals.splice(+tr.dataset.i, 1);
      store.set('sdr.signals', S.signals);
      renderTable(); requestDraw();
      return;
    }
    const half = Math.max(s.bw * 3, 100e3);
    zoomTo(s.f - half, s.f + half);
  });
  setInterval(() => renderTable(true), 5000);
  // Con el ratón encima, la tabla no se reordena sola (para no clicar la fila equivocada)
  const tw = document.querySelector('.table-wrap');
  tw.addEventListener('mouseenter', () => { S.tableHover = true; });
  tw.addEventListener('mouseleave', () => { S.tableHover = false; renderTable(true); });
}

// ---------------------------------------------------------------- bandas (desplegable)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Rango [startHz, stopHz] de una opción del desplegable: 'all', 'c:N' (propia) o 'b:N' (plan). */
function presetRange(v) {
  if (v === 'all') return [24 * MHz, 1766 * MHz];
  const [k, i] = v.split(':');
  if (k === 'c') {
    const b = window.CUSTOM_BANDS[+i];
    return b && [Math.round(b.min * MHz), Math.round(b.max * MHz)]; // exacta, sin margen
  }
  if (k === 'b') {
    const b = window.BANDS[+i];
    if (!b) return null;
    const m = Math.max(0.05, (b.max - b.min) * 0.03);
    return [Math.round((b.min - m) * MHz), Math.round((b.max + m) * MHz)];
  }
  return null;
}

function buildPresetSelect() {
  const custom = window.CUSTOM_BANDS.map((b, i) =>
    `<option value="c:${i}">★ ${esc(b.name)} · ${b.min}–${b.max}</option>`).join('');
  const plan = window.BANDS.map((b, i) => b.preset ? `<option value="b:${i}">${esc(b.name)} · ${b.min}–${b.max}</option>` : '').join('');
  $('preset').innerHTML = '<option value="">— elegir banda —</option>' +
    (custom ? `<optgroup label="Mis bandas">${custom}</optgroup>` : '') +
    `<optgroup label="Plan de bandas"><option value="all">Todo el rango (24–1766 MHz)</option>${plan}</optgroup>`;
  syncPresetSelect();
}

/** Marca en el desplegable la banda que coincide con el rango actual (si la hay). */
function syncPresetSelect() {
  const sel = $('preset');
  let match = '';
  if (S.cfg) {
    for (const o of sel.options) {
      const r = o.value && presetRange(o.value);
      if (r && Math.abs(r[0] - S.cfg.startHz) < 1 && Math.abs(r[1] - S.cfg.stopHz) < 1) { match = o.value; break; }
    }
  }
  sel.value = match;
  $('delBandBtn').disabled = !match.startsWith('c:');
}

function initBandForm() {
  const form = $('bandForm');
  const open = () => {
    const a = S.cfg.startHz / MHz, b = S.cfg.stopHz / MHz;
    $('bfRange').textContent = `Rango actual: ${+a.toFixed(4)} – ${+b.toFixed(4)} MHz`;
    $('bfName').value = '';
    $('bfMode').value = S.listen ? S.listen.mode : '';
    form.hidden = false;
    $('bfName').focus();
  };
  const save = () => {
    const name = $('bfName').value.trim();
    if (!name) { $('bfName').focus(); return; }
    const exists = window.CUSTOM_BANDS.some((b) => b.name.toLowerCase() === name.toLowerCase());
    if (exists && !confirm(`Ya tienes una banda llamada «${name}». ¿Reemplazarla?`)) return;
    send({ type: 'saveBand', band: {
      name, min: S.cfg.startHz / MHz, max: S.cfg.stopHz / MHz, color: $('bfColor').value, mode: $('bfMode').value,
    } });
    form.hidden = true;
  };
  $('saveBandBtn').addEventListener('click', () => (form.hidden ? open() : (form.hidden = true)));
  $('bfCancel').addEventListener('click', () => { form.hidden = true; });
  $('bfOk').addEventListener('click', save);
  $('bfName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') form.hidden = true;
  });
  $('delBandBtn').addEventListener('click', () => {
    const v = $('preset').value;
    if (!v.startsWith('c:')) return;
    const b = window.CUSTOM_BANDS[+v.slice(2)];
    if (b && confirm(`¿Borrar la banda «${b.name}»?`)) send({ type: 'deleteBand', name: b.name });
  });
}

// ---------------------------------------------------------------- etiquetas
const TAG_COLORS = ['#e879f9', '#f97316', '#22d3ee', '#4ade80', '#facc15', '#f87171', '#a78bfa'];

/** Etiqueta de la señal en f (con ancho bw), o null. */
function tagFor(f, bw = 0) {
  let best = null;
  for (const t of S.tags) {
    const d = Math.abs(t.f - f);
    if (d <= Math.max(t.tol, bw / 2, 2e3) && (!best || d < Math.abs(best.f - f))) best = t;
  }
  return best;
}

/** Convierte la celda de etiqueta en un editor (Enter guarda, Esc cancela, vacío = quitar). */
function editTag(td, s) {
  if (td.querySelector('.tag-edit')) return;
  const cur = tagFor(s.f, s.bw);
  S.editingTag = true;
  td.innerHTML = `<div class="tag-edit">
    <input type="text" maxlength="32" placeholder="Nombre de la señal" value="${cur ? esc(cur.name) : ''}">
    <input type="color" value="${cur ? cur.color : TAG_COLORS[S.tags.length % TAG_COLORS.length]}" title="Color">
  </div>`;
  const [name, color] = td.querySelectorAll('input');
  name.focus();
  name.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    S.editingTag = false;
    if (save) {
      const n = name.value.trim();
      if (n || cur) send({ type: 'setTag', f: cur && !n ? cur.f : s.f, tol: Math.max(s.bw / 2, 3e3), name: n, color: color.value });
    }
    renderTable();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  // Guardar al salir del editor (pero no al pasar del texto al selector de color)
  td.addEventListener('focusout', (e) => {
    if (!td.contains(e.relatedTarget)) setTimeout(() => { if (!td.contains(document.activeElement)) finish(true); }, 150);
  });
  color.addEventListener('change', () => name.focus());
}

// ---------------------------------------------------------------- tabla
/** auto = refresco periódico (se omite si el ratón está sobre la tabla). */
function renderTable(auto = false) {
  if (S.editingTag) return; // no pisar el editor de etiquetas
  if (auto && S.tableHover) return;
  const idx = S.signals.map((s, i) => i);
  const k = S.ui.sort;
  const tagName = (s) => tagFor(s.f, s.bw)?.name;
  idx.sort((a, b) => {
    const A = S.signals[a], B = S.signals[b];
    if (k === 'tag') {
      const ta = tagName(A), tb = tagName(B);
      if (ta && tb) return ta.localeCompare(tb, 'es');
      if (ta || tb) return ta ? -1 : 1;
      return A.f - B.f;
    }
    return k === 'f' ? A.f - B.f : k === 'db' ? B.maxDb - A.maxDb : k === 'hits' ? B.hits - A.hits : B.last - A.last;
  });
  $('sigCount').textContent = S.signals.length;
  $('sigEmpty').hidden = S.signals.length > 0;
  $('sigBody').innerHTML = idx.map((i) => {
    const s = S.signals[i];
    const band = window.bandFor(s.f / MHz);
    const tuned = S.listen && Math.abs(S.listen.freqHz - s.f) < Math.max(s.bw / 2, 5e3);
    return `<tr data-i="${i}" title="Clic para hacer zoom" class="${tuned ? 'tuned' : ''}">
      <td><span class="dot ${s.live ? 'live' : ''}"></span></td>
      <td><button class="ls-row" title="Escuchar esta señal">🎧</button></td>
      <td>${(() => {
        const fv = freqFor(s.f, s.bw);
        return fv ? `<button class="fav-row saved" title="Guardada como «${esc(fv.name)}» (clic para editar)">★</button>`
          : '<button class="fav-row" title="Guardar en Mis frecuencias">☆</button>';
      })()}</td>
      <td class="num">${fmtFreq(s.f)}</td>
      <td class="tag-cell" title="Clic para poner o cambiar la etiqueta">${(() => {
        const t = tagFor(s.f, s.bw);
        return t ? `<span class="sig-tag" style="--c:${t.color}">${esc(t.name)}</span>` : '<span class="add-tag">＋ etiqueta</span>';
      })()}</td>
      <td class="num">${s.db.toFixed(1)} dB</td>
      <td class="num">${s.snr.toFixed(1)} dB</td>
      <td class="num">${fmtBw(s.bw)}</td>
      <td class="num">${s.hits}</td>
      <td>${ago(s.last)}</td>
      <td>${band ? `<span class="band-tag"><i style="background:${band.color}"></i>${esc(band.name)}</span>` : '<span class="muted">—</span>'}</td>
      <td><button class="del" title="Quitar">✕</button></td>
    </tr>`;
  }).join('');
}

function exportCsv() {
  const rows = [['frecuencia_mhz', 'etiqueta', 'nivel_db', 'nivel_max_db', 'snr_db', 'ancho_khz', 'veces', 'primera_vez', 'ultima_vez', 'banda']];
  for (const s of [...S.signals].sort((a, b) => a.f - b.f)) {
    const band = window.bandFor(s.f / MHz);
    rows.push([(s.f / MHz).toFixed(5), tagFor(s.f, s.bw)?.name ?? '', s.db.toFixed(1), s.maxDb.toFixed(1), s.snr.toFixed(1), (s.bw / 1e3).toFixed(1), s.hits,
      new Date(s.first).toISOString(), new Date(s.last).toISOString(), band ? band.name : '']);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `senales-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- escucha (audio)
const MODE_NAMES = { wfm: 'FM ancha', nfm: 'FM estrecha', am: 'AM' };
const A = { ctx: null, gain: null, t: 0 };

function guessMode(f, bw) {
  const band = window.bandFor(f / MHz);
  if (band && band.mode) return band.mode; // banda personalizada con modo elegido
  if (band && /FM radiodifusión/.test(band.name)) return 'wfm';
  if (band && /aérea|CB 27/.test(band.name)) return 'am';
  return bw > 80e3 ? 'wfm' : 'nfm';
}

function setListenParams(f, mode) {
  const ui = S.ui;
  ui.lsFreq = +(f / MHz).toFixed(5);
  if (mode) ui.lsMode = mode;
  store.set('sdr.ui', ui);
  $('lsFreq').value = ui.lsFreq;
  $('lsMode').value = ui.lsMode;
  $('lsBw').disabled = ui.lsMode === 'wfm';
  requestDraw();
}

/** Sintoniza en f: se pega al centro de una señal detectada si el clic cae dentro de ella. */
function tuneTo(f) {
  let best = null;
  for (const s of S.signals) {
    if (Math.abs(s.f - f) <= Math.max(s.bw / 2, 3e3) && (!best || Math.abs(s.f - f) < Math.abs(best.f - f))) best = s;
  }
  const mode = S.listen ? S.ui.lsMode : guessMode(best ? best.f : f, best ? best.bw : 0);
  let target = best ? best.f : f;
  if (!best) target = Math.round(target / (mode === 'wfm' ? 10e3 : 500)) * (mode === 'wfm' ? 10e3 : 500);
  setListenParams(target, mode);
  if (S.listen) sendListen();
}

function squelchValue() {
  const v = +S.ui.lsSquelch;
  return v <= -100 ? -200 : v;
}

function sendListen() {
  const ui = S.ui;
  send({ type: 'listen', freqHz: ui.lsFreq * MHz, mode: ui.lsMode, bw: +ui.lsBw, squelch: squelchValue() });
}

function ensureAudio() {
  if (!A.ctx) {
    A.ctx = new (window.AudioContext || window.webkitAudioContext)();
    A.gain = A.ctx.createGain();
    A.gain.connect(A.ctx.destination);
  }
  A.gain.gain.value = +S.ui.lsVol;
  if (A.ctx.state === 'suspended') A.ctx.resume();
  A.t = 0;
}

function startListening() {
  ensureAudio(); // debe ocurrir dentro del clic del usuario (política de autoplay)
  sendListen();
}

function onAudio(buf) {
  const level = new DataView(buf).getFloat32(4, true);
  showLevel(level);
  if (!A.ctx || A.ctx.state !== 'running' || !(S.listen || S.memScan)) return;
  const pcm = new Float32Array(buf, 8);
  if (!pcm.length) return;
  const b = A.ctx.createBuffer(1, pcm.length, S.audioRate);
  b.copyToChannel(pcm, 0);
  const src = A.ctx.createBufferSource();
  src.buffer = b;
  src.connect(A.gain);
  const now = A.ctx.currentTime;
  // Colchón de ~150 ms; si nos quedamos sin datos o acumulamos retraso, se recoloca
  if (A.t < now + 0.03 || A.t > now + 0.6) A.t = now + 0.15;
  src.start(A.t);
  A.t += b.duration;
}

function showLevel(db) {
  const pct = (v) => Math.max(0, Math.min(100, ((v + 100) / 100) * 100));
  $('lsLevel').style.width = `${pct(db)}%`;
  $('lsLevel').title = `${db.toFixed(1)} dBFS`;
}

function updateListenUi() {
  const on = !!S.listen;
  const b = $('listenBtn');
  const needsGesture = on && (!A.ctx || A.ctx.state !== 'running');
  b.textContent = !on ? '🎧 Escuchar' : needsGesture ? '🔈 Activar audio' : '■ Dejar de escuchar';
  b.classList.toggle('on', on);
  if (on && document.activeElement !== $('lsFreq')) {
    $('lsFreq').value = +(S.listen.freqHz / MHz).toFixed(5);
    $('lsMode').value = S.listen.mode;
    S.ui.lsFreq = +$('lsFreq').value; S.ui.lsMode = S.listen.mode;
    S.ui.lsBw = S.listen.bw; $('lsBw').value = String(S.listen.bw);
  }
  $('lsBw').disabled = $('lsMode').value === 'wfm';
  if (!on) showLevel(-200);
  renderFreqs();
  requestDraw();
}

// ---------------------------------------------------------------- mis frecuencias
const FREQ_MODE_SHORT = { wfm: 'FM-A', nfm: 'FM-E', am: 'AM' };

/** Frecuencia guardada en f (tolerancia en Hz), o null. */
function freqFor(f, bw = 0) {
  let best = null;
  for (const fr of S.freqs) {
    const d = Math.abs(fr.freqHz - f);
    if (d <= Math.max(bw / 2, 2e3) && (!best || d < Math.abs(best.freqHz - f))) best = fr;
  }
  return best;
}

function renderFreqs() {
  const list = $('freqList');
  if (!list) return;
  const q = ($('freqFilter').value || '').trim().toLowerCase();
  const items = S.freqs.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q) ||
    String(f.freqHz / MHz).includes(q));
  $('freqCount').textContent = S.freqs.length;
  $('freqFilter').hidden = S.freqs.length < 6;
  $('freqEmpty').hidden = S.freqs.length > 0;
  $('memScanBox').hidden = S.freqs.length === 0;
  const ms = S.memState;
  // Si la lista no ha cambiado, solo se actualizan las marcas (no se sustituyen
  // las filas: así un clic no se pierde mientras el escaneo va cambiando de frecuencia)
  const key = JSON.stringify(items.map((f) => [f.id, f.name, f.freqHz, f.mode, f.note, f.scan]));
  if (key === list.dataset.key) {
    for (const li of list.children) {
      const f = items.find((x) => x.id === li.dataset.id);
      const msHere = ms && ms.id === f.id;
      const on = (S.listen && Math.abs(S.listen.freqHz - f.freqHz) < 500) || (msHere && ms.phase !== 'scan');
      const scanning = msHere && ms.phase === 'scan';
      li.classList.toggle('on', !!on);
      li.classList.toggle('scanning', !!scanning);
      li.querySelector('.fi-name').textContent = `${on ? '🔊 ' : scanning ? '⟳ ' : ''}${f.name}`;
    }
    return;
  }
  list.dataset.key = key;
  list.innerHTML = items.map((f) => {
    const msHere = ms && ms.id === f.id;
    const on = (S.listen && Math.abs(S.listen.freqHz - f.freqHz) < 500) || (msHere && ms.phase !== 'scan');
    const scanning = msHere && ms.phase === 'scan';
    const sub = `${(f.freqHz / MHz).toFixed(f.freqHz < 1e9 ? 4 : 3)} · ${FREQ_MODE_SHORT[f.mode]}${f.note ? ' · ' + esc(f.note) : ''}`;
    return `<li class="freq-item ${on ? 'on' : ''} ${scanning ? 'scanning' : ''}" data-id="${esc(f.id)}" title="Clic para escuchar">
      <input type="checkbox" class="fi-scan" title="Incluir en «Escanear mis frecuencias»" ${f.scan !== false ? 'checked' : ''}>
      <div><div class="fi-name">${on ? '🔊 ' : scanning ? '⟳ ' : ''}${esc(f.name)}</div><div class="fi-sub">${sub}</div></div>
      <div class="fi-actions"><button class="fi-edit" title="Editar">✎</button><button class="fi-del" title="Borrar">✕</button></div>
    </li>`;
  }).join('');
}

/** Abre el formulario con los datos de f (si f.id existe, se edita esa frecuencia). */
function openFreqForm(f) {
  S.freqEditId = f.id || null;
  $('ffName').value = f.name || '';
  $('ffFreq').value = +(f.freqHz / MHz).toFixed(5);
  $('ffMode').value = f.mode || 'nfm';
  $('ffBw').value = String(f.bw || 12500);
  $('ffBw').disabled = $('ffMode').value === 'wfm';
  $('ffNote').value = f.note || '';
  $('ffOk').textContent = S.freqEditId ? 'Guardar cambios' : 'Guardar';
  $('freqForm').hidden = false;
  $('freqForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('ffName').focus();
}

function saveFreqForm() {
  const name = $('ffName').value.trim();
  const mhz = parseFloat(String($('ffFreq').value).replace(',', '.'));
  if (!name) { $('ffName').focus(); return; }
  if (!(mhz > 0)) { $('ffFreq').focus(); return; }
  const prev = S.freqs.find((x) => x.id === S.freqEditId);
  send({ type: 'saveFreq', freq: {
    id: S.freqEditId || undefined, name, freqHz: Math.round(mhz * MHz),
    mode: $('ffMode').value, bw: +$('ffBw').value, note: $('ffNote').value.trim(),
    scan: prev ? prev.scan !== false : true,
  } });
  $('freqForm').hidden = true;
  S.freqEditId = null;
}

function listenToFreq(f) {
  S.ui.lsBw = f.bw;
  $('lsBw').value = String(f.bw);
  setListenParams(f.freqHz, f.mode);
  if (S.listen) sendListen();
  else startListening(); // dentro del clic: permite arrancar el audio
}

function initFreqs() {
  $('saveFreqBtn').addEventListener('click', () => {
    const f = S.ui.lsFreq * MHz;
    const ex = freqFor(f);
    if (ex) return openFreqForm(ex);
    openFreqForm({ freqHz: f, mode: S.ui.lsMode, bw: S.ui.lsBw, name: tagFor(f)?.name || '' });
  });
  $('ffOk').addEventListener('click', saveFreqForm);
  $('ffCancel').addEventListener('click', () => { $('freqForm').hidden = true; S.freqEditId = null; });
  $('ffMode').addEventListener('change', () => { $('ffBw').disabled = $('ffMode').value === 'wfm'; });
  for (const id of ['ffName', 'ffFreq', 'ffNote']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveFreqForm();
      if (e.key === 'Escape') { $('freqForm').hidden = true; S.freqEditId = null; }
    });
  }
  $('freqFilter').addEventListener('input', renderFreqs);
  $('freqList').addEventListener('click', (e) => {
    const li = e.target.closest('.freq-item');
    const f = li && S.freqs.find((x) => x.id === li.dataset.id);
    if (!f) return;
    if (e.target.closest('.fi-scan')) {
      send({ type: 'saveFreq', freq: { ...f, scan: e.target.checked } });
      return;
    }
    if (e.target.closest('.fi-edit')) return openFreqForm(f);
    if (e.target.closest('.fi-del')) {
      if (confirm(`¿Borrar «${f.name}» (${fmtFreq(f.freqHz)}) de Mis frecuencias?`)) send({ type: 'deleteFreq', id: f.id });
      return;
    }
    listenToFreq(f);
  });
  renderFreqs();
  initMemScan();
}

// ---------------------------------------------------------------- escaneo de mis frecuencias
function memScanParams() {
  const sec = (id, def) => { const v = parseFloat(String($(id).value).replace(',', '.')); return v >= 0 ? v : def; };
  return { type: 'memScan', thrDb: S.ui.threshold, holdMs: sec('msHold', 2) * 1000, hangMs: sec('msHang', 2) * 1000, mute: $('msMute').checked };
}

function initMemScan() {
  const ui = S.ui;
  ui.msHold ??= 2; ui.msHang ??= 2; ui.msMute ??= false;
  $('msHold').value = ui.msHold; $('msHang').value = ui.msHang; $('msMute').checked = ui.msMute;
  const changed = () => {
    ui.msHold = +$('msHold').value; ui.msHang = +$('msHang').value; ui.msMute = $('msMute').checked;
    store.set('sdr.ui', ui);
    if (S.memScan) send(memScanParams()); // aplicar en marcha
  };
  for (const id of ['msHold', 'msHang', 'msMute']) $(id).addEventListener('change', changed);
  $('threshold').addEventListener('change', () => { if (S.memScan) send(memScanParams()); });
  $('msBtn').addEventListener('click', () => {
    if (S.memScan) return send({ type: 'memScanStop' });
    if (!S.freqs.some((f) => f.scan !== false)) { alert('Marca ☑ al menos una de tus frecuencias.'); return; }
    ensureAudio(); // dentro del clic: permite el audio
    send(memScanParams());
  });
  $('msSkip').addEventListener('click', () => send({ type: 'memSkip' }));
  const setAll = (on) => (e) => {
    e.preventDefault();
    for (const f of S.freqs) if ((f.scan !== false) !== on) send({ type: 'saveFreq', freq: { ...f, scan: on } });
  };
  $('msAll').addEventListener('click', setAll(true));
  $('msNone').addEventListener('click', setAll(false));
}

function updateMemScanUi() {
  const on = !!S.memScan;
  const b = $('msBtn');
  b.textContent = on ? '■ Parar escaneo' : '⟳ Escanear mis frecuencias';
  b.classList.toggle('on', on);
  const ms = S.memState;
  $('msSkip').disabled = !(on && ms && (ms.phase === 'qualify' || ms.phase === 'listen'));
  const st = $('msStatus');
  st.hidden = !on;
  if (on) {
    st.className = 'ms-status ' + (ms ? ms.phase : 'scan');
    if (!ms) st.textContent = 'Arrancando…';
    else if (ms.phase === 'idle') st.textContent = 'Ninguna frecuencia marcada ☑.';
    else if (ms.phase === 'scan') st.innerHTML = `⟳ Buscando… <b>${esc(ms.name)}</b> <span class="mono">${(ms.freqHz / MHz).toFixed(4)}</span>`;
    else if (ms.phase === 'qualify') {
      const p = Math.min(100, (100 * ms.elapsedMs) / Math.max(1, ms.holdMs));
      st.innerHTML = `◔ Señal en <b>${esc(ms.name)}</b> · confirmando ${(ms.elapsedMs / 1000).toFixed(1)} / ${(ms.holdMs / 1000).toFixed(1)} s` +
        `<div class="ms-bar"><div style="width:${p}%"></div></div>`;
    } else {
      const quiet = ms.quietMs > 300;
      const p = quiet ? Math.min(100, (100 * ms.quietMs) / Math.max(1, ms.hangMs)) : 0;
      st.innerHTML = `🔊 <b>${esc(ms.name)}</b> <span class="mono">${(ms.freqHz / MHz).toFixed(4)} · SNR ${ms.snr} dB</span><br>` +
        (quiet ? `en silencio ${(ms.quietMs / 1000).toFixed(1)} s — vuelve a escanear a los ${(ms.hangMs / 1000).toFixed(1)} s` +
          `<div class="ms-bar"><div style="width:${p}%"></div></div>` : `escuchando desde hace ${(ms.elapsedMs / 1000).toFixed(0)} s`);
    }
  }
  renderFreqs();
}

function initListen() {
  const ui = S.ui;
  ui.lsFreq ??= 97.3; ui.lsMode ??= 'wfm'; ui.lsBw ??= 12500; ui.lsVol ??= 0.8; ui.lsSquelch ??= -100;
  $('lsFreq').value = ui.lsFreq;
  $('lsMode').value = ui.lsMode;
  $('lsBw').value = String(ui.lsBw);
  $('lsVol').value = ui.lsVol;
  $('lsSquelch').value = ui.lsSquelch;
  const sq = () => {
    $('sqVal').textContent = ui.lsSquelch <= -100 ? 'apagado' : `${ui.lsSquelch} dBFS`;
    $('lsSqMark').style.left = `${ui.lsSquelch <= -100 ? 0 : ui.lsSquelch + 100}%`;
    $('lsSqMark').style.display = ui.lsSquelch <= -100 ? 'none' : '';
  };
  sq();
  const save = () => store.set('sdr.ui', ui);
  const changed = () => { save(); if (S.listen) sendListen(); requestDraw(); };

  $('lsFreq').addEventListener('change', () => { ui.lsFreq = +$('lsFreq').value; changed(); });
  $('lsMode').addEventListener('change', () => { ui.lsMode = $('lsMode').value; $('lsBw').disabled = ui.lsMode === 'wfm'; changed(); });
  $('lsBw').addEventListener('change', () => { ui.lsBw = +$('lsBw').value; changed(); });
  $('lsSquelch').addEventListener('input', () => { ui.lsSquelch = +$('lsSquelch').value; sq(); });
  $('lsSquelch').addEventListener('change', changed);
  $('lsVol').addEventListener('input', () => { ui.lsVol = +$('lsVol').value; if (A.gain) A.gain.gain.value = ui.lsVol; save(); });
  $('listenBtn').addEventListener('click', () => {
    if (S.listen && (!A.ctx || A.ctx.state !== 'running')) { ensureAudio(); updateListenUi(); return; }
    if (S.listen) send({ type: 'listenStop' });
    else startListening();
  });
}

// ---------------------------------------------------------------- arranque
initListen();
initFreqs();
initControls();
renderTable();
resize();
connect();
