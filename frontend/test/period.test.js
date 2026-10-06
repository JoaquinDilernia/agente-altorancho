// frontend/test/period.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { artToday, presetRange, periodQuery, loadPeriod, savePeriod, resolvePeriod } from '../src/lib/period.js';

describe('resolvePeriod', () => {
  it('un preset se recalcula con la fecha actual (la PWA puede quedar abierta de un día para otro)', () => {
    const viejo = { preset: 'today', from: '2026-10-04', to: '2026-10-04' };
    expect(resolvePeriod(viejo, new Date('2026-10-06T15:00:00Z'))).toEqual({ preset: 'today', from: '2026-10-06', to: '2026-10-06' });
  });
  it('custom se respeta', () => {
    const p = { preset: 'custom', from: '2026-08-01', to: '2026-08-31' };
    expect(resolvePeriod(p, new Date('2026-10-06T15:00:00Z'))).toBe(p);
  });
});

const NOW = new Date('2026-10-06T02:00:00Z'); // 23:00 del 05 en Argentina

describe('period', () => {
  beforeEach(() => localStorage.clear());
  it('hoy en ART', () => {
    expect(artToday(NOW)).toBe('2026-10-05');
  });
  it('presets', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-10-04', to: '2026-10-04' });
    expect(presetRange('7d', NOW)).toEqual({ from: '2026-09-29', to: '2026-10-05' });
    expect(presetRange('30d', NOW)).toEqual({ from: '2026-09-06', to: '2026-10-05' });
    expect(presetRange('month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(presetRange('custom', NOW)).toBeNull();
  });
  it('periodQuery', () => {
    expect(periodQuery({ from: '2026-10-01', to: '2026-10-05' })).toBe('from=2026-10-01&to=2026-10-05');
  });
  it('load/save: un preset se recalcula al cargar, custom conserva fechas, default 7 días', () => {
    expect(loadPeriod(NOW)).toEqual({ preset: '7d', from: '2026-09-29', to: '2026-10-05' });
    savePeriod({ preset: 'today', from: '2020-01-01', to: '2020-01-01' });
    expect(loadPeriod(NOW)).toEqual({ preset: 'today', from: '2026-10-05', to: '2026-10-05' });
    savePeriod({ preset: 'custom', from: '2026-08-01', to: '2026-08-31' });
    expect(loadPeriod(NOW)).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-31' });
  });
});
