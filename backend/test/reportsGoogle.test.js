import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createGoogleRepo } from '../src/repo/google.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

let db; let reports;
const DAY = { from: '2026-10-05', to: '2026-10-05' };
beforeAll(async () => {
  db = await createTestDb();
  const google = createGoogleRepo(db);
  await google.upsertCampaigns([{ id: '111111', name: 'Search Marca', status: 'ENABLED', channel_type: 'SEARCH' }, { id: '222222', name: 'PMax', status: 'ENABLED', channel_type: 'PERFORMANCE_MAX' }]);
  await google.upsertSpend([
    { campaign_id: '111111', date: '2026-10-05', spend: 1000, impressions: 1, clicks: 1, conversions: 4, conversions_value: 9000 },
    { campaign_id: '222222', date: '2026-10-05', spend: 500, impressions: 1, clicks: 1, conversions: 1, conversions_value: 1000 },
  ]);
  const orders = createOrdersRepo(db);
  const seed = [
    [1, 'https://altorancho.com/?gad_source=1&gad_campaignid=111111&gclid=x', 3000],
    [2, 'https://altorancho.com/?gad_source=1&gad_campaignid=333333&gclid=y', 2000], // campaña sin gasto cargado
    [3, 'https://altorancho.com/?gclid=z', 700], // Google sin campaña
  ];
  for (const [id, landing, total] of seed) {
    const m = mapOrder({ id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: String(total), products: [], customer_visit: { landing_page: landing, utm_parameters: {} } });
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  reports = createReportsRepo(db);
});
afterAll(() => db.close());

describe('reportes con Google', () => {
  it('summary incluye el bloque de Google', async () => {
    const s = await reports.summary(DAY);
    expect(s.google).toEqual({
      spend: 1500, orders: 3, revenue: 5700, roas: 3.8, costPerSale: 500,
      reported: { conversions: 5, value: 10000, roas: 10000 / 1500 }, coverage: { campaign: 2, none: 1 },
    });
  });
  it('ranking de Google por campaña: gasto sin ventas y ventas sin gasto aparecen', async () => {
    const r = await reports.adsRanking({ ...DAY, platform: 'google' });
    expect(r).toMatchObject({ level: 'campaign', platform: 'google', unidentified: { orders: 1, revenue: 700 } });
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId['111111']).toMatchObject({ name: 'Search Marca', spend: 1000, sales: 1, revenue: 3000, roas: 3, metaPurchases: 4 });
    expect(byId['222222']).toMatchObject({ spend: 500, sales: 0, noSales: true });
    expect(byId['333333']).toMatchObject({ spend: 0, sales: 1, roas: null, costPerSale: null });
  });
  it('órdenes muestran el nombre de la campaña de Google', async () => {
    const { items } = await reports.listOrders({ ...DAY, channel: 'google' });
    expect(items.find((o) => o.id === '1').campaign_name).toBe('Search Marca');
    expect((await reports.orderDetail('1')).campaign_name).toBe('Search Marca');
  });
});
