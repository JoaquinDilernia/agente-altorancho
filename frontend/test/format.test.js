// frontend/test/format.test.js
import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtRoas, fmtPct, fmtRelative, shortName, fmtNumber, fmtDate } from '../src/lib/format.js';

describe('format', () => {
  it('plata en ARS sin decimales', () => {
    expect(fmtMoney(40497.12)).toMatch(/^\$\s?40\.497$/);
    expect(fmtMoney(null)).toBe('—');
  });
  it('roas, porcentajes y números', () => {
    expect(fmtRoas(6.73)).toBe('6,7x');
    expect(fmtRoas(null)).toBe('—');
    expect(fmtPct(1, 3)).toBe('33%');
    expect(fmtPct(1, 0)).toBe('0%');
    expect(fmtNumber(54463)).toBe('54.463');
  });
  it('tiempo relativo', () => {
    const now = new Date('2026-10-06T15:00:00Z');
    expect(fmtRelative('2026-10-06T14:59:40Z', now)).toBe('recién');
    expect(fmtRelative('2026-10-06T14:48:00Z', now)).toBe('hace 12 min');
    expect(fmtRelative('2026-10-06T12:00:00Z', now)).toBe('hace 3 h');
    expect(fmtRelative('2026-10-04T12:00:00Z', now)).toBe('04/10 09:00');
  });
  it('nombre corto y fecha', () => {
    expect(shortName('Mariana Francia')).toBe('Mariana F.');
    expect(shortName('Julieta')).toBe('Julieta');
    expect(shortName(null)).toBe('Sin nombre');
    expect(fmtDate('2026-09-29')).toBe('29/09');
  });
});
