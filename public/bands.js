// Plan de bandas (orientado a España / UE). min/max en MHz.
// preset: aparece en el desplegable de bandas.
window.BANDS = [
  { name: 'CB 27 MHz', min: 26.965, max: 27.405, color: '#f59e0b', preset: true },
  { name: 'Radioaficionados 6 m', min: 50, max: 52, color: '#a78bfa' },
  { name: 'FM radiodifusión', min: 87.5, max: 108, color: '#22d3ee', preset: true },
  { name: 'Radionavegación aérea (VOR/ILS)', min: 108, max: 117.975, color: '#64748b' },
  { name: 'Banda aérea (AM)', min: 118, max: 137, color: '#38bdf8', preset: true },
  { name: 'Satélites meteo (NOAA/Meteor)', min: 137, max: 138, color: '#f472b6', preset: true },
  { name: 'Radioaficionados 2 m', min: 144, max: 146, color: '#a78bfa', preset: true },
  { name: 'Marina VHF', min: 156, max: 162.025, color: '#2dd4bf', preset: true },
  { name: 'DAB+ (radio digital)', min: 174, max: 240, color: '#818cf8', preset: true },
  { name: 'TETRA (emergencias)', min: 380, max: 400, color: '#f87171' },
  { name: 'Radioaficionados 70 cm', min: 430, max: 440, color: '#a78bfa', preset: true },
  { name: 'ISM 433 (mandos, sensores)', min: 433.05, max: 434.79, color: '#facc15', preset: true },
  { name: 'PMR446 (walkies)', min: 446.0, max: 446.2, color: '#4ade80', preset: true },
  { name: 'TDT (TV digital)', min: 470, max: 694, color: '#94a3b8', preset: true },
  { name: 'LTE 800 bajada', min: 791, max: 821, color: '#fb923c' },
  { name: 'LTE 800 subida', min: 832, max: 862, color: '#fb923c' },
  { name: 'ISM 868 (LoRa, alarmas)', min: 863, max: 870, color: '#facc15', preset: true },
  { name: 'GSM-900 subida', min: 880, max: 915, color: '#fb923c' },
  { name: 'GSM-900 bajada', min: 925, max: 960, color: '#fb923c', preset: true },
  { name: 'ADS-B (aviones)', min: 1089, max: 1091, color: '#e879f9', preset: true },
  { name: 'Radioaficionados 23 cm', min: 1240, max: 1300, color: '#a78bfa' },
  { name: 'Inmarsat', min: 1525, max: 1559, color: '#f472b6' },
  { name: 'GPS L1', min: 1574.4, max: 1576.4, color: '#e879f9' },
];

// Bandas personalizadas del usuario (las rellena app.js desde el servidor)
window.CUSTOM_BANDS = [];
window.allBands = () => window.CUSTOM_BANDS.concat(window.BANDS);

// La banda más estrecha que contiene la frecuencia (p. ej. ISM 433 antes que 70 cm).
// Las personalizadas tienen prioridad.
window.bandFor = function (mhz) {
  for (const b of window.CUSTOM_BANDS) if (mhz >= b.min && mhz <= b.max) return b;
  let best = null;
  for (const b of window.BANDS) {
    if (mhz >= b.min && mhz <= b.max && (!best || b.max - b.min < best.max - best.min)) best = b;
  }
  return best;
};
