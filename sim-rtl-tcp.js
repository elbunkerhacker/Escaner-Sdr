// rtl_tcp simulado: habla el mismo protocolo que rtl_tcp.exe y genera I/Q
// sintético con emisoras FM, banda aérea, PMR446, ISM 433, ADS-B, etc.
// Sirve para probar la web sin tener el dongle conectado.
//
//   node sim-rtl-tcp.js [puerto]      (por defecto 1234)

import net from 'node:net';
import { fileURLToPath } from 'node:url';

const MHz = 1e6;
// type: 'wfm' (FM ancha), 'nfm' (FM estrecha), 'am' (portadora + AM), 'burst' (ráfagas cortas)
// level: amplitud relativa a fondo de escala; duty/period: intermitencia
const SIGNALS = [
  { f: 88.5 * MHz, level: 0.10, type: 'wfm', dev: 75e3 },
  { f: 91.2 * MHz, level: 0.25, type: 'wfm', dev: 75e3 },
  { f: 94.6 * MHz, level: 0.05, type: 'wfm', dev: 75e3 },
  { f: 97.3 * MHz, level: 0.30, type: 'wfm', dev: 75e3 },
  { f: 100.4 * MHz, level: 0.15, type: 'wfm', dev: 75e3 },
  { f: 102.8 * MHz, level: 0.03, type: 'wfm', dev: 75e3 },
  { f: 105.9 * MHz, level: 0.20, type: 'wfm', dev: 75e3 },
  { f: 118.1 * MHz, level: 0.05, type: 'am', period: 9, duty: 0.4 },
  { f: 121.5 * MHz, level: 0.02, type: 'am', period: 20, duty: 0.2, phase: 0.5 },
  { f: 124.35 * MHz, level: 0.08, type: 'am', period: 7, duty: 0.5, phase: 0.3 },
  { f: 127.8 * MHz, level: 0.04, type: 'am', period: 13, duty: 0.35, phase: 0.7 },
  { f: 137.62 * MHz, level: 0.01, type: 'nfm', dev: 17e3 },
  { f: 145.5 * MHz, level: 0.06, type: 'nfm', dev: 5e3, period: 15, duty: 0.3 },
  { f: 433.92 * MHz, level: 0.12, type: 'burst', period: 4, duty: 0.08 },
  { f: 446.00625 * MHz, level: 0.07, type: 'nfm', dev: 2.5e3, period: 11, duty: 0.35 },
  { f: 446.09375 * MHz, level: 0.04, type: 'nfm', dev: 2.5e3, period: 17, duty: 0.25, phase: 0.6 },
  { f: 935.2 * MHz, level: 0.06, type: 'wfm', dev: 70e3 },
  { f: 942.6 * MHz, level: 0.09, type: 'wfm', dev: 70e3 },
  { f: 951.0 * MHz, level: 0.05, type: 'wfm', dev: 70e3 },
  { f: 1090 * MHz, level: 0.15, type: 'burst', period: 0.7, duty: 0.15 },
].map((s) => ({ phase: 0, ph: 0, mph: 0, ...s, rnd: Math.random() * 1e3 }));

function isOn(s, t) {
  if (!s.period) return true;
  return ((t / s.period + (s.phase || 0)) % 1) < s.duty;
}

export function startSim(port = 1234) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      console.log('[sim] cliente conectado');
      sock.setNoDelay(true);
      let center = 100 * MHz;
      let rate = 2.048e6;
      let gainDb = 30;
      let autoGain = true;
      let pending = Buffer.alloc(0);

      const hdr = Buffer.alloc(12);
      hdr.write('RTL0', 0, 'ascii');
      hdr.writeUInt32BE(5, 4); // R820T
      hdr.writeUInt32BE(29, 8);
      sock.write(hdr);

      sock.on('data', (d) => {
        pending = Buffer.concat([pending, d]);
        while (pending.length >= 5) {
          const cmd = pending[0];
          const v = pending.readInt32BE(1);
          pending = pending.subarray(5);
          if (cmd === 0x01) center = v >>> 0;
          else if (cmd === 0x02) rate = v;
          else if (cmd === 0x03) autoGain = v === 0;
          else if (cmd === 0x04) gainDb = v / 10;
        }
      });

      let last = performance.now();
      let tSamples = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        const n = Math.min(Math.floor(((now - last) / 1000) * rate), rate * 0.1) | 0;
        last = now;
        if (n <= 0) return;
        if (sock.writableLength > 512 * 1024) { tSamples += n; return; } // cliente lento: se pierde

        const g = Math.pow(10, ((autoGain ? 30 : gainDb) - 30) / 20);
        const noise = 0.012 * g + 0.004; // ruido del tuner + ruido de cuantización
        const tNow = tSamples / rate;
        const active = SIGNALS.filter((s) => Math.abs(s.f - center) < rate / 2 && isOn(s, tNow));
        const out = Buffer.allocUnsafe(n * 2);
        const dc = 0.01;
        for (let i = 0; i < n; i++) {
          let I = dc + noise * (Math.random() + Math.random() + Math.random() - 1.5) * 2;
          let Q = dc + noise * (Math.random() + Math.random() + Math.random() - 1.5) * 2;
          for (const s of active) {
            const off = s.f - center;
            let inst = off;
            let amp = s.level * g;
            if (s.type === 'wfm' || s.type === 'nfm') {
              // modulación por suma de dos tonos "de audio"
              s.mph += (2 * Math.PI * 1.3e3) / rate;
              inst += s.dev * (0.6 * Math.sin(s.mph) + 0.4 * Math.sin(s.mph * 0.37 + s.rnd));
            } else if (s.type === 'am') {
              s.mph += (2 * Math.PI * 900) / rate;
              amp *= 0.7 + 0.3 * Math.sin(s.mph);
            } else if (s.type === 'burst') {
              s.mph += (2 * Math.PI * 50e3) / rate;
              inst += Math.sign(Math.sin(s.mph)) * 40e3; // FSK simple
            }
            s.ph += (2 * Math.PI * inst) / rate;
            if (s.ph > 1e6) s.ph %= 2 * Math.PI;
            I += amp * Math.cos(s.ph);
            Q += amp * Math.sin(s.ph);
          }
          out[2 * i] = Math.max(0, Math.min(255, Math.round(127.4 + I * 128)));
          out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.4 + Q * 128)));
        }
        tSamples += n;
        sock.write(out);
      }, 20);

      sock.on('close', () => { clearInterval(timer); console.log('[sim] cliente desconectado'); });
      sock.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1', () => {
      console.log(`[sim] rtl_tcp simulado escuchando en 127.0.0.1:${port}`);
      resolve(srv);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startSim(Number(process.argv[2] || 1234));
}
