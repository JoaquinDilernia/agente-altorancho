import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createTestDb } from './helpers/testDb.js';
import { mapGa4Channel } from '../src/engine/ga4Channel.js';
import { createGa4Client } from '../src/services/ga4.js';
import { createGa4Repo } from '../src/repo/ga4.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

describe('mapGa4Channel', () => {
  it('traduce los grupos de canales de GA4 a los nuestros', () => {
    expect(mapGa4Channel('Paid Social', 'facebook', 'cpc')).toBe('meta');
    expect(mapGa4Channel('Paid Social', 'ig', 'paid')).toBe('meta');
    expect(mapGa4Channel('Paid Social', 'tiktok', 'cpc')).toBe('other');
    expect(mapGa4Channel('Paid Search', 'google', 'cpc')).toBe('google');
    expect(mapGa4Channel('Cross-network', 'google', 'cpc')).toBe('google');
    expect(mapGa4Channel('Paid Shopping', 'google', 'cpc')).toBe('google');
    expect(mapGa4Channel('Email', 'perfit', 'email')).toBe('email');
    expect(mapGa4Channel('Organic Social', 'instagram.com', 'referral')).toBe('social_organic');
    expect(mapGa4Channel('Organic Search', 'google', 'organic')).toBe('organic');
    expect(mapGa4Channel('Direct', '(direct)', '(none)')).toBe('organic');
    expect(mapGa4Channel('Referral', 'chatgpt.com', 'referral')).toBe('organic');
    expect(mapGa4Channel('Unassigned', '(not set)', '(not set)')).toBeNull();
    expect(mapGa4Channel(undefined, undefined, undefined)).toBeNull();
  });
});

describe('cliente GA4', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: 'panel-ga4@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  it('pide token con JWT firmado y pagina runReport', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'T', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ rowCount: 3, rows: [{ dimensionValues: [{ value: 'a' }] }, { dimensionValues: [{ value: 'b' }] }] }))
      .mockResolvedValueOnce(json({ rowCount: 3, rows: [{ dimensionValues: [{ value: 'c' }] }] }));
    const ga4 = createGa4Client({ serviceAccountJson: sa, propertyId: '338242054', fetchFn, pageSize: 2 });
    const rows = await ga4.runReportAll({ dimensions: [{ name: 'transactionId' }], metrics: [{ name: 'transactions' }], dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-30' }] });
    expect(rows.map((r) => r.dimensionValues[0].value)).toEqual(['a', 'b', 'c']);
    const [tokenUrl, tokenOpts] = fetchFn.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(tokenOpts.body).get('assertion');
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'panel-ga4@p.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/analytics.readonly' });
    const [reportUrl, reportOpts] = fetchFn.mock.calls[1];
    expect(reportUrl).toBe('https://analyticsdata.googleapis.com/v1beta/properties/338242054:runReport');
    expect(reportOpts.headers.Authorization).toBe('Bearer T');
    expect(JSON.parse(fetchFn.mock.calls[2][1].body)).toMatchObject({ offset: 2, limit: 2 });
  });

  it('error de la API → excepción con el mensaje de Google', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'T', expires_in: 3600 }))
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => '{"error":{"message":"User does not have sufficient permissions"}}' });
    const ga4 = createGa4Client({ serviceAccountJson: sa, propertyId: '1', fetchFn });
    await expect(ga4.runReportAll({ dimensions: [], metrics: [], dateRanges: [] })).rejects.toThrow(/403.*permissions/);
  });
});

describe('ga4Repo + pedidos', () => {
  let db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(() => db.close());

  it('guarda primer contacto por transacción y lo muestra en los pedidos (por número de orden)', async () => {
    const orders = createOrdersRepo(db);
    const m = mapOrder({ id: 2087839852, number: 59461, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: '1000', products: [],
      customer_visit: { landing_page: 'https://altorancho.com/?utm_source=perfit&utm_medium=email', utm_parameters: {} } });
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
    const repo = createGa4Repo(db);
    const n = await repo.upsertTransactions([
      { transactionId: '59461', firstGroup: 'Paid Social', firstSource: 'facebook', firstMedium: 'cpc', sessionGroup: 'Email', date: '20261005' },
      { transactionId: '(not set)', firstGroup: 'Direct', firstSource: '(direct)', firstMedium: '(none)', sessionGroup: 'Direct', date: '20261005' },
    ]);
    expect(n).toBe(1); // "(not set)" se descarta
    const reports = createReportsRepo(db);
    const { items } = await reports.listOrders({ from: '2026-10-05', to: '2026-10-05' });
    expect(items[0]).toMatchObject({ channel: 'email', first_channel: 'meta' });
    expect(await reports.orderDetail(String(2087839852))).toMatchObject({ first_channel: 'meta', first_source: 'facebook', first_medium: 'cpc' });
  });
});
