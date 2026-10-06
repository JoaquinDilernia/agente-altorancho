import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaSync } from '../src/sync/meta.js';
import { URL_TAGS_TEMPLATE } from '../src/engine/urlTags.js';

let db; let metaRepo; let ordersRepo;
beforeEach(async () => { db = await createTestDb(); metaRepo = createMetaRepo(db); ordersRepo = createOrdersRepo(db); });
afterEach(() => db.close());

const fakeMeta = () => ({
  listCampaigns: vi.fn().mockResolvedValue([{ id: 'C1', name: 'altorancho_dpa', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '6000000', created_time: '2026-09-01T10:00:00-0300', updated_time: '2026-09-02T10:00:00-0300' }]),
  listAdsets: vi.fn().mockResolvedValue([{ id: 'S1', name: 'Conjunto', effective_status: 'ACTIVE', campaign_id: 'C1', created_time: '2026-09-01T10:05:00-0300', updated_time: '2026-09-03T10:00:00-0300', learning_stage_info: { status: 'LEARNING' } }]),
  listAds: vi.fn().mockResolvedValue([
    { id: 'A1', name: 'Con params', effective_status: 'ACTIVE', adset_id: 'S1', campaign_id: 'C1', creative: { id: 'CR1', thumbnail_url: 'https://t/1.jpg', url_tags: URL_TAGS_TEMPLATE } },
    { id: 'A2', name: 'Sin params', effective_status: 'PAUSED', adset_id: 'S1', campaign_id: 'C1' },
  ]),
  getDailyAdInsights: vi.fn().mockResolvedValue([{ ad_id: 'A1', adset_id: 'S1', campaign_id: 'C1', date_start: '2026-10-05', spend: '100' }]),
  getDailyAdInsightsAsync: vi.fn().mockResolvedValue([{ ad_id: 'A1', adset_id: 'S1', campaign_id: 'C1', date_start: '2026-09-01', spend: '50' }]),
});

describe('metaSync', () => {
  it('syncCatalog guarda campañas, conjuntos y anuncios con flag de parámetros', async () => {
    const n = await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    expect(n).toBe(4);
    const { rows } = await db.query('SELECT id, level, parent_id, campaign_id, has_attribution_params, thumbnail_url FROM meta_ads ORDER BY id');
    expect(rows).toEqual([
      { id: 'A1', level: 'ad', parent_id: 'S1', campaign_id: 'C1', has_attribution_params: true, thumbnail_url: 'https://t/1.jpg' },
      { id: 'A2', level: 'ad', parent_id: 'S1', campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
      { id: 'C1', level: 'campaign', parent_id: null, campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
      { id: 'S1', level: 'adset', parent_id: 'C1', campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
    ]);
  });
  it('syncCatalog resuelve atribuciones pendientes por nombre de campaña', async () => {
    const resolve = vi.spyOn(ordersRepo, 'resolveMetaIds');
    await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    expect(resolve).toHaveBeenCalledWith();
  });
  it('syncSpend guarda filas diarias', async () => {
    const meta = fakeMeta();
    expect(await createMetaSync({ meta, metaRepo, ordersRepo }).syncSpend('2026-10-05', '2026-10-06')).toBe(1);
    expect(meta.getDailyAdInsights).toHaveBeenCalledWith('2026-10-05', '2026-10-06');
    const { rows } = await db.query('SELECT ad_id, date::text AS date, spend::float8 AS spend FROM meta_spend_daily');
    expect(rows).toEqual([{ ad_id: 'A1', date: '2026-10-05', spend: 100 }]);
  });
  it('backfillSpend recorre meses con el reporte asincrónico', async () => {
    const meta = fakeMeta();
    const onMonthDone = vi.fn();
    await createMetaSync({ meta, metaRepo, ordersRepo }).backfillSpend({ days: 40, now: new Date('2026-10-06T15:00:00Z'), onMonthDone });
    expect(meta.getDailyAdInsightsAsync.mock.calls).toEqual([
      ['2026-08-27', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-06'],
    ]);
    expect(onMonthDone).toHaveBeenCalledTimes(3);
  });
  it('syncCatalog guarda objetivo, presupuesto en pesos, CBO y aprendizaje', async () => {
    await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    const { rows } = await db.query(
      `SELECT id, objective, daily_budget::float8 AS daily_budget, is_cbo, learning_status, created_time IS NOT NULL AS has_created
         FROM meta_ads WHERE id IN ('C1','S1') ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'C1', objective: 'OUTCOME_SALES', daily_budget: 60000, is_cbo: true, learning_status: null, has_created: true },
      { id: 'S1', objective: null, daily_budget: null, is_cbo: false, learning_status: 'LEARNING', has_created: true },
    ]);
  });
});
