import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { createAgentMetrics } from '../src/repo/agentMetrics.js';
import { createRecommendationsRepo } from '../src/repo/recommendations.js';
import { createOutcomeMeter } from '../src/agent/outcomes.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const row = (id, level, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null,
  has_attribution_params: false, objective: null, daily_budget: null, is_cbo: false, created_time: null, learning_status: null, status_updated_at: null, ...extra,
});
const spend = (ad, adset, camp, date, s) => ({ ad_id: ad, adset_id: adset, campaign_id: camp, date, spend: s, impressions: 1, clicks: 1, meta_purchases: 0, meta_purchase_value: 0 });

let db; let recs; let meter;
beforeAll(async () => {
  db = await createTestDb();
  const meta = createMetaRepo(db);
  await meta.upsertAds([
    row('2000001', 'campaign', { campaign_id: '2000001', objective: 'OUTCOME_SALES' }),
    row('3000001', 'adset', { parent_id: '2000001', campaign_id: '2000001' }),
    row('1000001', 'ad', { parent_id: '3000001', campaign_id: '2000001' }),
  ]);
  await meta.upsertSpend([spend('1000001', '3000001', '2000001', '2026-09-25', 500), spend('1000001', '3000001', '2000001', '2026-10-01', 1000)]);
  const orders = createOrdersRepo(db);
  for (const o of [
    { id: 1, at: '2026-10-01T15:00:00+0000', total: 4000 },
    { id: 2, at: '2026-10-04T15:00:00+0000', total: 2000 },
  ]) {
    const m = mapOrder({ id: o.id, number: o.id, status: 'open', payment_status: 'paid', created_at: o.at, total: String(o.total), products: [],
      customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=1000001', utm_parameters: {} } });
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  recs = createRecommendationsRepo(db);
  const metrics = createAgentMetrics({ db, reports: createReportsRepo(db) });
  meter = createOutcomeMeter({ db, recs, metrics, now: () => new Date('2026-10-06T12:00:00Z') });
});
afterAll(() => db.close());

const executed = async (rec, executedAt) => {
  const id = await recs.create({ title: 't', reasoning: 'r', confidence: 'alta', ...rec });
  await recs.transition(id, ['pending'], 'executed', { executed_at: executedAt });
  return id;
};

describe('outcomeMeter', () => {
  it('pausa de anuncio se mide sobre su campaña a 3 y 7 días', async () => {
    const id = await executed({ type: 'pause', level: 'ad', object_id: '1000001' }, '2026-09-28T15:00:00Z');
    const n = await meter.measure();
    expect(n).toBe(1);
    const r = await recs.get(id);
    expect(r.outcome.d3).toMatchObject({ before: { spend: 500, sales: 0 }, after: { spend: 1000, sales: 1, revenue: 4000 }, verdict: 'mejoro' });
    expect(r.outcome.d7).toMatchObject({ after: { spend: 1000, sales: 2, revenue: 6000 }, verdict: 'mejoro' });
    expect(r.verdict).toBe('mejoro');
  });
  it('lo ejecutado hace poco todavía no se mide', async () => {
    const id = await executed({ type: 'budget', level: 'campaign', object_id: '2000001' }, '2026-10-04T15:00:00Z');
    await meter.measure();
    expect((await recs.get(id)).outcome).toBeNull();
  });
  it('sin gasto antes → neutral con nota', async () => {
    const id = await executed({ type: 'budget', level: 'campaign', object_id: '9999999' }, '2026-09-20T15:00:00Z');
    await meter.measure();
    expect((await recs.get(id)).outcome.d7).toMatchObject({ verdict: 'neutral', nota: 'sin datos suficientes' });
  });
});
