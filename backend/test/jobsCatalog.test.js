import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createJobCatalog } from '../src/jobsCatalog.js';
import { mapOrder } from '../src/engine/mapOrder.js';

const ctx = () => ({ progress: vi.fn().mockResolvedValue() });
const NOW = new Date('2026-10-06T15:00:00Z');

describe('jobCatalog', () => {
  it('tn-backfill retoma después del último mes hecho si no estaba completo', async () => {
    const orderSync = { backfill: vi.fn(async ({ onMonthDone }) => { await onMonthDone('2026-10', 5); return 5; }) };
    const syncRuns = { lastCursor: vi.fn().mockResolvedValue({ done: '2026-03', complete: false }) };
    const cat = createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns, now: () => NOW });
    const c = ctx();
    expect(await cat['tn-backfill'].fn(c)).toBe(5);
    expect(orderSync.backfill.mock.calls[0][0]).toMatchObject({ resumeAfter: '2026-03' });
    expect(c.progress).toHaveBeenLastCalledWith(5, { done: '2026-10', complete: true });
  });
  it('tn-backfill después de uno completo arranca de cero', async () => {
    const orderSync = { backfill: vi.fn().mockResolvedValue(0) };
    const syncRuns = { lastCursor: vi.fn().mockResolvedValue({ done: '2026-10', complete: true }) };
    await createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns, now: () => NOW })['tn-backfill'].fn(ctx());
    expect(orderSync.backfill.mock.calls[0][0]).toMatchObject({ resumeAfter: null });
  });
  it('tn-incremental pide lo actualizado en las últimas 2 horas', async () => {
    const orderSync = { syncUpdatedSince: vi.fn().mockResolvedValue(3) };
    await createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns: {}, now: () => NOW })['tn-incremental'].fn(ctx());
    expect(orderSync.syncUpdatedSince).toHaveBeenCalledWith('2026-10-06T13:00:00.000Z');
  });
  it('meta-spend sincroniza los últimos 7 días ART', async () => {
    const metaSync = { syncSpend: vi.fn().mockResolvedValue(10) };
    await createJobCatalog({ orderSync: {}, metaSync, ordersRepo: {}, syncRuns: {}, now: () => NOW })['meta-spend'].fn(ctx());
    expect(metaSync.syncSpend).toHaveBeenCalledWith('2026-09-29', '2026-10-06');
  });
  describe('reattribute (con DB)', () => {
    let db;
    beforeEach(async () => { db = await createTestDb(); });
    afterEach(() => db.close());
    it('recalcula la atribución de todas las órdenes desde lo guardado', async () => {
      const ordersRepo = createOrdersRepo(db);
      for (const id of [1, 2]) {
        const m = mapOrder({ id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: '1', products: [],
          customer_visit: { landing_page: 'https://altorancho.com/?gclid=x', utm_parameters: {} } });
        await ordersRepo.upsert({ ...m, attribution: { channel: 'organic', confidence: 'none', source_raw: {}, rules_version: 0 } });
      }
      const c = ctx();
      const n = await createJobCatalog({ orderSync: {}, metaSync: {}, ordersRepo, syncRuns: {}, now: () => NOW }).reattribute.fn(c);
      expect(n).toBe(2);
      const { rows } = await db.query('SELECT channel, rules_version FROM order_attribution ORDER BY order_id');
      expect(rows).toEqual([{ channel: 'google', rules_version: 1 }, { channel: 'google', rules_version: 1 }]);
    });
  });
});
