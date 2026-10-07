import { describe, it, expect, vi } from 'vitest';
import { createGa4Sync } from '../src/sync/ga4.js';

const row = (...dims) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: [{ value: '1' }] });

describe('sync GA4', () => {
  it('pide transacciones con primer contacto y guarda las filas', async () => {
    const ga4 = { runReportAll: vi.fn().mockResolvedValue([row('59461', '20261005', 'Paid Social', 'facebook', 'cpc', 'Email')]) };
    const ga4Repo = { upsertTransactions: vi.fn().mockResolvedValue(1) };
    const n = await createGa4Sync({ ga4, ga4Repo }).syncRange('2026-10-01', '2026-10-05');
    expect(n).toBe(1);
    const body = ga4.runReportAll.mock.calls[0][0];
    expect(body.dateRanges).toEqual([{ startDate: '2026-10-01', endDate: '2026-10-05' }]);
    expect(body.dimensions.map((d) => d.name)).toEqual(['transactionId', 'date', 'firstUserDefaultChannelGroup', 'firstUserSource', 'firstUserMedium', 'sessionDefaultChannelGroup']);
    expect(ga4Repo.upsertTransactions).toHaveBeenCalledWith([
      { transactionId: '59461', date: '20261005', firstGroup: 'Paid Social', firstSource: 'facebook', firstMedium: 'cpc', sessionGroup: 'Email' },
    ]);
  });

  it('backfill recorre meses hacia atrás y reporta progreso', async () => {
    const ga4 = { runReportAll: vi.fn().mockResolvedValue([]) };
    const ga4Repo = { upsertTransactions: vi.fn().mockResolvedValue(2) };
    const done = [];
    const n = await createGa4Sync({ ga4, ga4Repo }).backfill({ today: '2026-10-07', months: 3, onMonthDone: (m) => done.push(m) });
    expect(n).toBe(6);
    expect(ga4.runReportAll.mock.calls.map((c) => c[0].dateRanges[0])).toEqual([
      { startDate: '2026-10-01', endDate: '2026-10-07' },
      { startDate: '2026-09-01', endDate: '2026-09-30' },
      { startDate: '2026-08-01', endDate: '2026-08-31' },
    ]);
    expect(done).toEqual(['2026-10', '2026-09', '2026-08']);
  });
});
