import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createOrderSync } from '../src/sync/orders.js';

const order = (id, extra = {}) => ({
  id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-09-10T15:00:00+0000', total: '100',
  products: [], customer_visit: { landing_page: 'https://altorancho.com/', utm_parameters: {} }, ...extra,
});
const page = (start, n) => Array.from({ length: n }, (_, i) => order(start + i));

let db; let ordersRepo;
beforeEach(async () => { db = await createTestDb(); ordersRepo = createOrdersRepo(db); });
afterEach(() => db.close());
const count = async () => (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;

describe('orderSync', () => {
  it('syncOrder trae la orden completa y la guarda con atribución', async () => {
    const tn = { getOrder: vi.fn().mockResolvedValue(order(5, { customer_visit: { landing_page: 'https://altorancho.com/?gclid=x', utm_parameters: {} } })) };
    await createOrderSync({ tn, ordersRepo }).syncOrder(5);
    const { rows } = await db.query('SELECT channel FROM order_attribution WHERE order_id = 5');
    expect(rows[0].channel).toBe('google');
  });
  it('syncUpdatedSince pagina hasta una página incompleta', async () => {
    const listOrders = vi.fn()
      .mockResolvedValueOnce(page(1, 200))
      .mockResolvedValueOnce(page(201, 3));
    const rows = await createOrderSync({ tn: { listOrders }, ordersRepo }).syncUpdatedSince('2026-10-06T10:00:00Z');
    expect(rows).toBe(203);
    expect(await count()).toBe(203);
    expect(listOrders.mock.calls.map((c) => c[0])).toEqual([
      { updatedMin: '2026-10-06T10:00:00Z', page: 1 }, { updatedMin: '2026-10-06T10:00:00Z', page: 2 },
    ]);
  });
  it('backfill recorre meses, informa cada mes y retoma después de resumeAfter', async () => {
    const listOrders = vi.fn().mockImplementation(async ({ createdMin }) => (createdMin.startsWith('2026-08') ? [order(1)] : [order(2)]));
    const onMonthDone = vi.fn();
    const sync = createOrderSync({ tn: { listOrders }, ordersRepo });
    await sync.backfill({ from: '2026-07-01', to: '2026-09-15', resumeAfter: '2026-07', onMonthDone });
    expect(listOrders.mock.calls.map((c) => [c[0].createdMin, c[0].createdMax])).toEqual([
      ['2026-08-01T00:00:00-03:00', '2026-09-01T00:00:00-03:00'],
      ['2026-09-01T00:00:00-03:00', '2026-09-16T00:00:00-03:00'],
    ]);
    expect(onMonthDone.mock.calls.map((c) => c[0])).toEqual(['2026-08', '2026-09']);
    expect(await count()).toBe(2);
  });
  it('una orden rota no frena el resto y al final informa el id', async () => {
    const listOrders = vi.fn().mockResolvedValueOnce([order(1), { id: 2, number: 2 }, order(3)]);
    const sync = createOrderSync({ tn: { listOrders }, ordersRepo, log: { error: () => {} } });
    await expect(sync.syncUpdatedSince('2026-10-06T10:00:00Z')).rejects.toThrow(/1 órdenes fallaron.*2/);
    expect(await count()).toBe(2);
  });
});
