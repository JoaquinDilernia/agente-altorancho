import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const CAMP = '2000001'; const ADSET = '3000001';
const metaAd = (adId) => `https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=${adId}`;
const tn = ({ id, at, total, payment = 'paid', cancelled = null, landing = 'https://altorancho.com/', item = 'Lámpara' }) => ({
  id, number: id, status: 'open', payment_status: payment, cancelled_at: cancelled, created_at: at, total: String(total),
  contact_name: `Cliente ${id}`, products: [{ product_id: 1, variant_id: 1, name: item, quantity: 1, price: String(total) }],
  customer_visit: { landing_page: landing, utm_parameters: {} },
});
const ad = (id, level, parent, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: parent, campaign_id: CAMP, thumbnail_url: null, url_tags: null, has_attribution_params: false, ...extra,
});
const spend = (adId, date, s, extra = {}) => ({
  ad_id: adId, date, campaign_id: CAMP, adset_id: ADSET, spend: s, impressions: 100, clicks: 10, meta_purchases: 0, meta_purchase_value: 0, ...extra,
});

let db; let reports;
beforeAll(async () => {
  db = await createTestDb();
  const orders = createOrdersRepo(db);
  const meta = createMetaRepo(db);
  reports = createReportsRepo(db);
  await meta.upsertAds([
    ad(CAMP, 'campaign', null), ad(ADSET, 'adset', CAMP),
    ad('1000001', 'ad', ADSET), ad('1000002', 'ad', ADSET), ad('1000003', 'ad', ADSET),
  ]);
  await meta.upsertSpend([
    spend('1000001', '2026-10-05', 400, { meta_purchases: 3, meta_purchase_value: 5000 }),
    spend('1000002', '2026-10-05', 600),
    spend('1000001', '2026-10-01', 100),
  ]);
  const seed = [
    tn({ id: 1, at: '2026-10-05T15:00:00+0000', total: 1000, landing: metaAd('1000001') }),
    tn({ id: 2, at: '2026-10-06T01:30:00+0000', total: 3000, landing: metaAd('1000001') }), // 22:30 ART del 05
    tn({ id: 3, at: '2026-10-06T04:00:00+0000', total: 500 }), // orgánica del 06
    tn({ id: 4, at: '2026-10-05T16:00:00+0000', total: 900, payment: 'pending', landing: metaAd('1000001') }),
    tn({ id: 5, at: '2026-10-05T17:00:00+0000', total: 800, cancelled: '2026-10-05T20:00:00+0000', landing: metaAd('1000001') }),
    tn({ id: 6, at: '2026-10-05T18:00:00+0000', total: 2000, landing: metaAd('1000003'), item: 'Silla Nórdica' }),
    tn({ id: 7, at: '2026-10-05T19:00:00+0000', total: 700, landing: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc' }), // Meta sin identificar
  ];
  for (const o of seed) {
    const m = mapOrder(o);
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
});
afterAll(() => db.close());

const DAY = { from: '2026-10-05', to: '2026-10-05' };

describe('summary', () => {
  it('cuenta solo ventas pagadas no canceladas del día ART', async () => {
    const s = await reports.summary(DAY);
    expect(s).toMatchObject({ orders: 4, revenue: 6700, avgTicket: 1675 });
    expect(s.channels).toEqual([{ channel: 'meta', orders: 4, revenue: 6700 }]);
  });
  it('métricas de Meta: real vs reportado y cobertura', async () => {
    const s = await reports.summary(DAY);
    expect(s.meta).toEqual({
      spend: 1000, orders: 4, revenue: 6700, roas: 6.7, costPerSale: 250,
      reported: { purchases: 3, value: 5000, roas: 5 },
    });
    expect(s.coverage).toEqual({ ad: 3, campaign: 0, none: 1 });
  });
  it('período sin gasto no divide por cero', async () => {
    const s = await reports.summary({ from: '2026-10-06', to: '2026-10-06' });
    expect(s).toMatchObject({ orders: 1, revenue: 500 });
    expect(s.meta).toMatchObject({ spend: 0, roas: null, costPerSale: null });
  });
});

describe('listOrders', () => {
  it('pagina con cursor, más nuevas primero, incluye todos los estados', async () => {
    const p1 = await reports.listOrders({ ...DAY, limit: 4 });
    expect(p1.items.map((o) => o.id)).toEqual(['2', '7', '6', '5']);
    expect(p1.items[3]).toMatchObject({ cancelled: true });
    const p2 = await reports.listOrders({ ...DAY, limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((o) => o.id)).toEqual(['4', '1']);
    expect(p2.nextCursor).toBeNull();
  });
  it('filtra por canal y trae nombres de anuncio/campaña', async () => {
    const r = await reports.listOrders({ ...DAY, channel: 'meta' });
    expect(r.items.find((o) => o.id === '1')).toMatchObject({ channel: 'meta', confidence: 'ad', ad_name: 'ad 1000001', campaign_name: `campaign ${CAMP}` });
    expect((await reports.listOrders({ from: '2026-10-06', to: '2026-10-06', channel: 'organic' })).items.map((o) => o.id)).toEqual(['3']);
  });
  it('búsqueda numérica ignora el período; texto busca cliente y producto', async () => {
    expect((await reports.listOrders({ from: '2020-01-01', to: '2020-01-01', q: '3' })).items.map((o) => o.id)).toEqual(['3']);
    expect((await reports.listOrders({ ...DAY, q: 'nórdica' })).items.map((o) => o.id)).toEqual(['6']);
    expect((await reports.listOrders({ ...DAY, q: 'cliente 7' })).items.map((o) => o.id)).toEqual(['7']);
  });
  it('cursor inválido → error 400', async () => {
    await expect(reports.listOrders({ ...DAY, cursor: 'basura' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('orderDetail', () => {
  it('trae items, origen y costo promedio de los 7 días que terminan el día de la orden', async () => {
    const d = await reports.orderDetail('1');
    expect(d).toMatchObject({ number: 1, channel: 'meta', ad_name: 'ad 1000001', adset_name: `adset ${ADSET}`, campaign_name: `campaign ${CAMP}` });
    expect(d.items).toHaveLength(1);
    expect(d.costEstimate).toEqual({ level: 'ad', from: '2026-09-29', to: '2026-10-05', spend: 500, sales: 2, costPerSale: 250 });
  });
  it('orgánica no tiene costo; inexistente → null', async () => {
    expect((await reports.orderDetail('3')).costEstimate).toBeNull();
    expect(await reports.orderDetail('999')).toBeNull();
  });
});

describe('adsRanking', () => {
  it('nivel anuncio: gasto sin ventas y ventas sin gasto aparecen, sin dividir por cero', async () => {
    const r = await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET });
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId['1000001']).toMatchObject({ spend: 400, sales: 2, revenue: 4000, costPerSale: 200, roas: 10, metaPurchases: 3, metaRoas: 12.5, noSales: false });
    expect(byId['1000002']).toMatchObject({ spend: 600, sales: 0, costPerSale: null, roas: 0, noSales: true });
    expect(byId['1000003']).toMatchObject({ spend: 0, sales: 1, revenue: 2000, costPerSale: null, roas: null, noSales: false });
    expect(r.unidentified).toBeNull();
  });
  it('orden por defecto gasto desc; cps pone primero los que no venden', async () => {
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET, sort: 'cps' })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET, sort: 'roas' })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
  });
  it('nivel campaña suma todo e informa ventas Meta sin campaña identificada', async () => {
    const r = await reports.adsRanking({ ...DAY, level: 'campaign' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: CAMP, spend: 1000, sales: 3, revenue: 6000 });
    expect(r.unidentified).toEqual({ orders: 1, revenue: 700 });
  });
});

describe('adDetail / estado', () => {
  it('adDetail trae métricas y órdenes del anuncio', async () => {
    const d = await reports.adDetail({ id: '1000001', ...DAY });
    expect(d.ad).toMatchObject({ id: '1000001', level: 'ad' });
    expect(d.metrics).toMatchObject({ spend: 400, sales: 2 });
    expect(d.orders.map((o) => o.id)).toEqual(['2', '1']);
    expect(await reports.adDetail({ id: 'nope', ...DAY })).toBeNull();
  });
  it('adDetail de un anuncio con gasto pero fuera del catálogo no da 404', async () => {
    await createMetaRepo(db).upsertSpend([spend('1000099', '2026-10-05', 50)]);
    const d = await reports.adDetail({ id: '1000099', ...DAY });
    expect(d.ad).toMatchObject({ id: '1000099', level: 'ad', name: null });
    expect(d.metrics).toMatchObject({ spend: 50, sales: 0 });
  });
  it('coverageWeekly agrupa por semana ART', async () => {
    expect(await reports.coverageWeekly({ now: new Date('2026-10-07T12:00:00Z') }))
      .toEqual([{ week: '2026-10-05', ad: 3, campaign: 0, none: 1 }]);
  });
  it('counts', async () => {
    expect(await reports.counts()).toEqual({ orders: 7, adsMissingParams: 3 });
  });
});

describe('mejoras de listado', () => {
  it('listOrders trae la cantidad total de productos', async () => {
    const { items } = await reports.listOrders({ ...DAY, q: '2' });
    expect(items[0]).toMatchObject({ id: '2', items_count: 1 });
  });
  it('campañas y conjuntos muestran la miniatura del anuncio que más gastó', async () => {
    await db.query("UPDATE meta_ads SET thumbnail_url = 'https://t/1.jpg' WHERE id = '1000001'");
    await db.query("UPDATE meta_ads SET thumbnail_url = 'https://t/2.jpg' WHERE id = '1000002'");
    const camp = await reports.adsRanking({ ...DAY, level: 'campaign' });
    expect(camp.rows[0].thumbnail_url).toBe('https://t/2.jpg'); // 1000002 gastó 600 vs 400
    const adset = await reports.adsRanking({ ...DAY, level: 'adset' });
    expect(adset.rows[0].thumbnail_url).toBe('https://t/2.jpg');
  });
});
