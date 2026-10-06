import { describe, it, expect } from 'vitest';
import { artDate, addDays, artDayStart, monthRanges, isYmd } from '../src/engine/dates.js';

describe('dates ART', () => {
  it('01:30 UTC del día D es el día D-1 en Argentina', () => {
    expect(artDate(new Date('2026-10-06T01:30:00Z'))).toBe('2026-10-05');
    expect(artDate(new Date('2026-10-06T03:00:00Z'))).toBe('2026-10-06');
  });
  it('addDays cruza meses y años', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('artDayStart', () => {
    expect(artDayStart('2026-10-06')).toBe('2026-10-06T00:00:00-03:00');
  });
  it('monthRanges recorta extremos', () => {
    expect(monthRanges('2026-08-15', '2026-10-06')).toEqual([
      { since: '2026-08-15', until: '2026-08-31' },
      { since: '2026-09-01', until: '2026-09-30' },
      { since: '2026-10-01', until: '2026-10-06' },
    ]);
  });
  it('isYmd', () => {
    expect(isYmd('2026-10-06')).toBe(true);
    expect(isYmd('2026-13-01')).toBe(false);
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('06/10/2026')).toBe(false);
    expect(isYmd(undefined)).toBe(false);
  });
});
