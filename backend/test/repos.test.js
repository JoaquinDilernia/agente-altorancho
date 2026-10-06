import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const baseTn = {
  id: 1001, number: 500, status: 'open', payment_status: 'pending', created_at: '2026-10-05T15:00:00+0000',
  total: '1000.00', products: [{ product_id: 1, variant_id: 11, sku: 'A', name: 'Lámpara', quantity: 1, price: '1000' }],
  customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=Camp Uno', utm_parameters: {} },
};
const prepare = (tn) => { const m = mapOrder(tn); return { ...m, attribution: attribute(m.visit) }; };

let db; let orders; let meta; let runs;
beforeEach(async () => {
  db = await createTestDb();
  orders = createOrdersRepo(db);
  meta = createMetaRepo(db);
  runs = createSyncRunsRepo(db);
});
afterEach(() => db.close());

describe('ordersRepo.upsert', () => {
  it('re-sincronizar la misma orden no duplica items y actualiza estado', async () => {
    await orders.upsert(prepare(baseTn));
    await orders.upsert(prepare({ ...baseTn, payment_status: 'paid' }));
    await orders.upsert(prepare({ ...baseTn, payment_status: 'paid', cancelled_at: '2026-10-06T10:00:00+0000' }));
    const { rows: o } = await db.query('SELECT payment_status, cancelled_at IS NOT NULL AS cancelled FROM orders');
    const { rows: it } = await db.query('SELECT count(*)::int AS n FROM order_items');
    expect(o).toEqual([{ payment_status: 'paid', cancelled: true }]);
    expect(it[0].n).toBe(1);
  });
  it('campaña por nombre sin catálogo queda sin id y se resuelve cuando llega el catálogo', async () => {
    await orders.upsert(prepare(baseTn));
    let { rows } = await db.query('SELECT campaign_id FROM order_attribution');
    expect(rows[0].campaign_id).toBeNull();
    await meta.upsertAds([{ id: '900', level: 'campaign', name: 'camp uno', status: 'ACTIVE', parent_id: null, campaign_id: '900', thumbnail_url: null, url_tags: null, has_attribution_params: false }]);
    await orders.resolveMetaIds();
    ({ rows } = await db.query('SELECT campaign_id FROM order_attribution'));
    expect(rows[0].campaign_id).toBe('900');
  });
  it('anuncio conocido completa conjunto y campaña al guardar', async () => {
    const tn = { ...baseTn, customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=777777', utm_parameters: {} } };
    await meta.upsertAds([{ id: '777777', level: 'ad', name: 'Ad2', status: 'ACTIVE', parent_id: '555', campaign_id: '900', thumbnail_url: null, url_tags: null, has_attribution_params: true }]);
    await orders.upsert(prepare(tn));
    const { rows } = await db.query('SELECT ad_id, adset_id, campaign_id, confidence FROM order_attribution');
    expect(rows[0]).toEqual({ ad_id: '777777', adset_id: '555', campaign_id: '900', confidence: 'ad' });
  });
  it('anuncio fuera del catálogo (borrado) toma conjunto y campaña de las filas de gasto', async () => {
    await meta.upsertSpend([{ ad_id: '888888', date: '2026-10-01', campaign_id: '900', adset_id: '555', spend: 1, impressions: 0, clicks: 0, meta_purchases: 0, meta_purchase_value: 0 }]);
    const tn = { ...baseTn, customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=888888', utm_parameters: {} } };
    await orders.upsert(prepare(tn));
    const { rows } = await db.query('SELECT adset_id, campaign_id FROM order_attribution');
    expect(rows[0]).toEqual({ adset_id: '555', campaign_id: '900' });
  });
  it('listForReattribution pagina por id y setAttribution reemplaza', async () => {
    await orders.upsert(prepare(baseTn));
    await orders.upsert(prepare({ ...baseTn, id: 1002, number: 501 }));
    const page = await orders.listForReattribution('0', 1);
    expect(page.map((r) => r.id)).toEqual(['1001']);
    expect((await orders.listForReattribution('1001', 10)).map((r) => r.id)).toEqual(['1002']);
    await orders.setAttribution('1001', { ...attribute({ landingUrl: null, visitLandingPage: null, visitUtm: null }) });
    const { rows } = await db.query("SELECT channel FROM order_attribution WHERE order_id = 1001");
    expect(rows[0].channel).toBe('unknown');
  });
});

describe('metaRepo', () => {
  it('upsertSpend deduplica por (ad_id, date) y actualiza', async () => {
    const row = { ad_id: '1', date: '2026-10-01', campaign_id: 'c', adset_id: 's', spend: 10, impressions: 100, clicks: 5, meta_purchases: 1, meta_purchase_value: 50 };
    await meta.upsertSpend([row, { ...row, spend: 12 }]);
    await meta.upsertSpend([{ ...row, spend: 15 }]);
    const { rows } = await db.query('SELECT spend::float8 AS spend, date::text AS date FROM meta_spend_daily');
    expect(rows).toEqual([{ spend: 15, date: '2026-10-01' }]);
  });
  it('listAdsMissingParams y markAdTags', async () => {
    await meta.upsertAds([
      { id: 'c1', level: 'campaign', name: 'Camp', status: 'ACTIVE', parent_id: null, campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
      { id: 'a1', level: 'ad', name: 'Ad 1', status: 'ACTIVE', parent_id: 's1', campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
      { id: 'a2', level: 'ad', name: 'Ad 2', status: 'PAUSED', parent_id: 's1', campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
    ]);
    expect(await meta.listAdsMissingParams()).toEqual([{ id: 'a1', name: 'Ad 1', status: 'ACTIVE', campaign_name: 'Camp' }]);
    await meta.markAdTags('a1', 'utm_content={{ad.id}}');
    expect(await meta.listAdsMissingParams()).toEqual([]);
  });
});

describe('syncRunsRepo', () => {
  it('start/progress/finish y lastCursor', async () => {
    const id = await runs.start('tn_backfill');
    await runs.progress(id, { rows: 10, cursor: { month: '2026-01' } });
    await runs.finish(id, { status: 'error', rows: 10, error: 'boom' });
    expect(await runs.lastCursor('tn_backfill')).toEqual({ month: '2026-01' });
    expect(await runs.lastCursor('meta_spend')).toBeNull();
    const latest = await runs.latestBySource();
    expect(latest[0]).toMatchObject({ source: 'tn_backfill', status: 'error', rows: 10, error: 'boom' });
    expect((await runs.recentErrors(5))[0]).toMatchObject({ source: 'tn_backfill', error: 'boom' });
  });
  it('markStaleRunning cierra corridas colgadas por reinicio', async () => {
    await runs.start('meta_spend');
    await runs.markStaleRunning();
    expect((await runs.latestBySource())[0].status).toBe('error');
  });
});
