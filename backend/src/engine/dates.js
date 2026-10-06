// Argentina es UTC-3 fijo (sin horario de verano).
const OFFSET_MS = 3 * 3600 * 1000;

export const artDate = (d = new Date()) => new Date(new Date(d).getTime() - OFFSET_MS).toISOString().slice(0, 10);

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const artDayStart = (ymd) => `${ymd}T00:00:00-03:00`;

export function monthRanges(fromYmd, toYmd) {
  const out = [];
  let cur = `${fromYmd.slice(0, 7)}-01`;
  while (cur <= toYmd) {
    const d = new Date(`${cur}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const next = d.toISOString().slice(0, 10);
    const until = addDays(next, -1);
    out.push({ since: cur < fromYmd ? fromYmd : cur, until: until > toYmd ? toYmd : until });
    cur = next;
  }
  return out;
}

export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
