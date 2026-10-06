const TZ = 'America/Argentina/Buenos_Aires';
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const number = new Intl.NumberFormat('es-AR');

const empty = (n) => n === null || n === undefined;
export const fmtMoney = (n) => (empty(n) ? '—' : money.format(n));
export const fmtNumber = (n) => (empty(n) ? '—' : number.format(n));
export const fmtRoas = (n) => (empty(n) ? '—' : `${n.toFixed(1).replace('.', ',')}x`);
export const fmtPct = (part, total) => (total ? `${Math.round((part * 100) / total)}%` : '0%');
export const fmtDate = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : '—');

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const pad = (v) => String(v).padStart(2, '0'); // algunos ICU ignoran 2-digit en es-AR
  return `${pad(parts.day)}/${pad(parts.month)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function fmtRelative(iso, now = new Date()) {
  if (!iso) return '—';
  const minutes = (now.getTime() - new Date(iso).getTime()) / 60000;
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${Math.floor(minutes)} min`;
  if (minutes < 24 * 60) return `hace ${Math.floor(minutes / 60)} h`;
  return fmtDateTime(iso);
}

export function shortName(name) {
  if (!name || !name.trim()) return 'Sin nombre';
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}
