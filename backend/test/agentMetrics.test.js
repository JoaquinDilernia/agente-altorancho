import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { createAgentMetrics, withRatios } from '../src/repo/agentMetrics.js';
import { buildDataset } from '../src/agent/dataset.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const row = (id, level, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null,
  has_attribution_params: false, objective: null, daily_budget: null, is_cbo: false, created_time: '2026-09-01T00:00:00Z',
  learning_status: null, status_updated_at: null, ...extra,
});
const spend = (ad, adset, camp, date, s, extra = {}) => ({
  ad_id: ad, adset_id: adset, campaign_id: camp, date, spend: s, impressions: 1000, clicks: 20, meta_purchases: 0, meta_purchase_value: 0, ...extra,
});
const order = (id, at, total, landing) => ({
  id, number: id, status: 'open', payment_status: 'paid', created_at: at, total: String(total), products: [],
  customer_visit: { landing_page: landing, utm_parameters: {} },
});
const metaAd = (ad) => `https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=${ad}`;

let db; let metrics;
beforeAll(async () => {
  db = await createTestDb();
  const meta = createMetaRepo(db);
  await meta.upsertAds([
    row('2000001', 'campaign', { campaign_id: '2000001', objective: 'OUTCOME_SALES', is_cbo: true, daily_budget: 50000 }),
    row('2000009', 'campaign', { campaign_id: '2000009', objective: 'OUTCOME_ENGAGEMENT', is_cbo: true, daily_budget: 10000 }),
    row('2000002', 'campaign', { campaign_id: '2000002', objective: 'OUTCOME_SALES', is_cbo: false }),
    row('3000001', 'adset', { parent_id: '2000001', campaign_id: '2000001' }),
    row('3000002', 'adset', { parent_id: '2000002', campaign_id: '2000002', daily_budget: 20000, learning_status: 'LEARNING' }),
    row('1000001', 'ad', { parent_id: '3000001', campaign_id: '2000001' }),
    row('1000002', 'ad', { parent_id: '3000002', campaign_id: '2000002', created_time: '2026-10-04T12:00:00Z' }),
    row('1000009', 'ad', { parent_id: '3000009', campaign_id: '2000009' }),
  ]);
  await meta.upsertSpend([
    spend('1000001', '3000001', '2000001', '2026-10-01', 1000, { meta_purchases: 3, meta_purchase_value: 9000 }),
    spend('1000001', '3000001', '2000001', '2026-09-25', 500),
    spend('1000002', '3000002', '2000002', '2026-10-02', 300),
    spend('1000009', '3000009', '2000009', '2026-10-02', 700),
  ]);
  const orders = createOrdersRepo(db);
  for (const o of [
    order(1, '2026-10-01T15:00:00+0000', 4000, metaAd('1000001')),
    order(2, '2026-10-02T15:00:00+0000', 2000, 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=campaign 2000001'),
  ]) {
    const m = mapOrder(o);
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  metrics = createAgentMetrics({ db, reports: createReportsRepo(db) });
});
afterAll(() => db.close());

const W7 = { from: '2026-09-29', to: '2026-10-05' };

describe('agentMetrics', () => {
  it('byLevel devuelve métricas crudas por objeto', async () => {
    const m = await metrics.byLevel({ level: 'campaign', ...W7 });
    expect(m.get('2000001')).toMatchObject({ spend: 1000, sales: 2, revenue: 6000, metaPurchases: 3, impressions: 1000, clicks: 20 });
    expect(m.get('2000009')).toMatchObject({ spend: 700, sales: 0 });
  });
  it('coverageByCampaign: proporción de ventas atribuidas al anuncio', async () => {
    expect((await metrics.coverageByCampaign(W7)).get('2000001')).toBe(0.5);
  });
  it('objectWindow y salesWindow excluyen campañas que no son de ventas', async () => {
    expect(await metrics.objectWindow({ level: 'ad', id: '1000001', ...W7 })).toEqual({ spend: 1000, sales: 1, revenue: 4000 });
    expect(await metrics.salesWindow(W7)).toEqual({ spend: 1300, sales: 2, revenue: 6000 });
  });
  it('baseline calcula ROAS y costo por venta', async () => {
    expect(await metrics.baseline(W7)).toEqual({ spend: 1300, sales: 2, revenue: 6000, roas: 6000 / 1300, cpa: 650 });
  });
  it('withRatios no divide por cero', () => {
    expect(withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 0, clicks: 0, metaPurchases: 0, metaValue: 0 }))
      .toMatchObject({ roas: null, cpa: null, ctr: null });
  });
});

describe('buildDataset', () => {
  it('arma objetos con ventanas, dueño del presupuesto, edad, aprendizaje y cobertura', async () => {
    const ds = await buildDataset({ db, metrics, today: '2026-10-06' });
    expect(ds.windows).toEqual({
      w7: { from: '2026-09-29', to: '2026-10-05' }, wp: { from: '2026-09-22', to: '2026-09-28' }, w30: { from: '2026-09-06', to: '2026-10-05' },
    });
    const byId = Object.fromEntries(ds.objects.map((o) => [o.id, o]));
    expect(byId['2000001']).toMatchObject({ level: 'campaign', isSales: true, budgetOwner: { id: '2000001', level: 'campaign', daily: 50000 }, coverage: 0.5 });
    expect(byId['2000001'].m7).toMatchObject({ spend: 1000, sales: 2, roas: 6 });
    expect(byId['2000001'].mPrev).toMatchObject({ spend: 500, sales: 0 });
    expect(byId['3000001'].budgetOwner).toBeNull(); // su campaña es CBO
    expect(byId['3000002']).toMatchObject({ budgetOwner: { id: '3000002', level: 'adset', daily: 20000 }, learning: true });
    expect(byId['1000002']).toMatchObject({ learning: true, ageDays: 1, budgetOwner: null });
    expect(byId['1000009'].isSales).toBe(false);
    expect(ds.baseline).toMatchObject({ spend: 1800, sales: 2 }); // w30 incluye el gasto del 25/09
  });
});
