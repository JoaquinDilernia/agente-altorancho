const OFFSET_MS = 3 * 3600 * 1000; // Argentina UTC-3 fijo
const KEY = 'ar_period';

export const artToday = (now = new Date()) => new Date(now.getTime() - OFFSET_MS).toISOString().slice(0, 10);

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const PRESETS = [
  { id: 'today', label: 'Hoy' },
  { id: 'yesterday', label: 'Ayer' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'month', label: 'Mes' },
  { id: 'custom', label: 'Elegir' },
];

export function presetRange(id, now = new Date()) {
  const t = artToday(now);
  switch (id) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case '7d': return { from: addDays(t, -6), to: t };
    case '30d': return { from: addDays(t, -29), to: t };
    case 'month': return { from: `${t.slice(0, 8)}01`, to: t };
    default: return null;
  }
}

export const periodQuery = ({ from, to }) => `from=${from}&to=${to}`;

export function loadPeriod(now = new Date()) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignorar */ }
  if (saved?.preset === 'custom' && saved.from && saved.to) return saved;
  const preset = saved?.preset && presetRange(saved.preset, now) ? saved.preset : '7d';
  return { preset, ...presetRange(preset, now) };
}

export function savePeriod(period) {
  try { localStorage.setItem(KEY, JSON.stringify(period)); } catch { /* ignorar */ }
}

// Los presets ("Hoy", "7 días"…) se recalculan con la fecha actual; "Elegir" conserva sus fechas.
export function resolvePeriod(period, now = new Date()) {
  if (period.preset === 'custom') return period;
  const range = presetRange(period.preset, now);
  return range ? { preset: period.preset, ...range } : period;
}
