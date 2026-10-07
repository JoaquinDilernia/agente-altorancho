import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { createIngestRouter } from '../src/routes/ingest.js';
import { createGoogleRepo } from '../src/repo/google.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { parseGooglePayload } from '../src/engine/googleIngest.js';

const payload = (o = {}) => ({
  campaigns: [{ id: '11472612872', name: 'Search Marca', status: 'ENABLED', channel_type: 'SEARCH' }],
  rows: [{ campaign_id: '11472612872', date: '2026-10-05', cost_micros: 1234567890, impressions: 1000, clicks: 50, conversions: 3.5, conversions_value: 210000 }],
  ...o,
});

describe('parseGooglePayload', () => {
  it('convierte micros a pesos con centavos', () => {
    expect(parseGooglePayload(payload()).spend[0]).toEqual({
      campaign_id: '11472612872', date: '2026-10-05', spend: 1234.57, impressions: 1000, clicks: 50, conversions: 3.5, conversions_value: 210000, purchases: 0, purchases_value: 0,
    });
  });
  it('acepta conversiones negativas (ajustes de Google) pero no costo negativo', () => {
    const r = parseGooglePayload(payload({ rows: [{ ...payload().rows[0], conversions: -1, conversions_value: -5000 }] })).spend[0];
    expect(r).toMatchObject({ conversions: -1, conversions_value: -5000 });
  });
  it('acepta entidades (grupos) con su campaña y compras opcionales por fila', () => {
    const p = parseGooglePayload(payload({
      entities: [{ id: '21694934859', campaign_id: '21694933125', type: 'asset_group' }],
      rows: [{ ...payload().rows[0], purchases: 2, purchases_value: 90000 }],
    }));
    expect(p.entities).toEqual([{ id: '21694934859', campaign_id: '21694933125', type: 'asset_group' }]);
    expect(p.spend[0]).toMatchObject({ purchases: 2, purchases_value: 90000 });
    expect(parseGooglePayload(payload()).spend[0]).toMatchObject({ purchases: 0, purchases_value: 0 });
    expect(parseGooglePayload(payload()).entities).toEqual([]);
  });
  it('rechaza ids, fechas o números inválidos', () => {
    expect(() => parseGooglePayload({})).toThrow(/payload/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], campaign_id: 'x' }] }))).toThrow(/campaign_id/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], date: '05/10/2026' }] }))).toThrow(/fecha/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], cost_micros: -1 }] }))).toThrow(/cost_micros/);
  });
});

describe('POST /ingest/google', () => {
  let db; let app;
  beforeEach(async () => {
    db = await createTestDb();
    app = createApp({ ingestRouter: createIngestRouter({ token: 'secreto', googleRepo: createGoogleRepo(db), syncRuns: createSyncRunsRepo(db) }) });
  });
  afterEach(() => db.close());
  const post = (body, token = 'secreto') => request(app).post('/ingest/google').set('x-ingest-token', token).send(body);

  it('sin token o token incorrecto → 401', async () => {
    expect((await request(app).post('/ingest/google').send(payload())).status).toBe(401);
    expect((await post(payload(), 'otro')).status).toBe(401);
  });
  it('los rechazos quedan registrados como error (sin el token) para verlos en Estado', async () => {
    await post(payload(), 'otro');
    await post({ rows: 'x' });
    const { rows } = await db.query(`SELECT status, error FROM sync_runs WHERE source = 'google_ingest' ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/token/) });
    expect(rows[0].error).not.toMatch(/otro/);
    expect(rows[1]).toMatchObject({ status: 'error', error: expect.stringMatching(/payload|rows/) });
  });
  it('payload inválido → 400 y no guarda nada', async () => {
    expect((await post({ rows: 'x' })).status).toBe(400);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM google_spend_daily');
    expect(rows[0].n).toBe(0);
  });
  it('guarda campañas y gasto; reenviar el mismo día actualiza sin duplicar', async () => {
    expect((await post(payload())).body).toEqual({ ok: true, rows: 1 });
    const again = payload({ rows: [{ ...payload().rows[0], cost_micros: 2000000000 }] });
    await post(again);
    const { rows } = await db.query('SELECT campaign_id, date::text AS date, spend::float8 AS spend FROM google_spend_daily');
    expect(rows).toEqual([{ campaign_id: '11472612872', date: '2026-10-05', spend: 2000 }]);
    const { rows: c } = await db.query('SELECT name, channel_type FROM google_campaigns');
    expect(c).toEqual([{ name: 'Search Marca', channel_type: 'SEARCH' }]);
    const { rows: runs } = await db.query("SELECT status, rows FROM sync_runs WHERE source = 'google_ingest' ORDER BY id");
    expect(runs).toEqual([{ status: 'ok', rows: 1 }, { status: 'ok', rows: 1 }]);
  });
  it('acepta payloads grandes (más de 100 KB)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ ...payload().rows[0], date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, campaign_id: String(1000000 + i) }));
    expect((await post(payload({ rows }))).status).toBe(200);
  });
  it('un error de la base devuelve 500 sin tirar el proceso', async () => {
    const broken = { start: async () => { throw new Error('db caída'); }, finish: async () => {} };
    const app2 = createApp({ ingestRouter: createIngestRouter({ token: 'secreto', googleRepo: createGoogleRepo(db), syncRuns: broken, log: { error: () => {} } }) });
    const res = await request(app2).post('/ingest/google').set('x-ingest-token', 'secreto').send(payload());
    expect(res.status).toBe(500);
  });
  it('las ventas atribuidas a un grupo pasan a su campaña', async () => {
    const { createOrdersRepo } = await import('../src/repo/orders.js');
    const { mapOrder } = await import('../src/engine/mapOrder.js');
    const { attribute } = await import('../src/engine/attribution.js');
    const m = mapOrder({ id: 1, number: 1, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: '1000', products: [],
      customer_visit: { landing_page: 'https://altorancho.com/?pf=mc&gad_campaignid=21694934859&gclid=x', utm_parameters: {} } });
    await createOrdersRepo(db).upsert({ ...m, attribution: attribute(m.visit) });
    await post(payload({ entities: [{ id: '21694934859', campaign_id: '11472612872', type: 'asset_group' }] }));
    const { rows } = await db.query('SELECT campaign_id FROM order_attribution WHERE order_id = 1');
    expect(rows[0].campaign_id).toBe('11472612872');
  });
});
