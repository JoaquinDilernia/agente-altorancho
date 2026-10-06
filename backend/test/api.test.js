import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createApiRouter } from '../src/routes/api.js';
import { createAuthMiddleware } from '../src/routes/authMiddleware.js';

function setup(overrides = {}) {
  const deps = {
    reports: {
      summary: vi.fn().mockResolvedValue({ orders: 1 }),
      listOrders: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      orderDetail: vi.fn().mockResolvedValue(null),
      adsRanking: vi.fn().mockResolvedValue({ level: 'campaign', rows: [], unidentified: null }),
      adDetail: vi.fn().mockResolvedValue({ ad: { id: '1' } }),
      coverageWeekly: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ orders: 0, adsMissingParams: 0 }),
    },
    syncRuns: {
      latestBySource: vi.fn().mockResolvedValue([]),
      lastSuccessBySource: vi.fn().mockResolvedValue([]),
      recentErrors: vi.fn().mockResolvedValue([]),
    },
    metaRepo: { listAdsMissingParams: vi.fn().mockResolvedValue([{ id: '1' }]) },
    urlTagger: { apply: vi.fn().mockResolvedValue([{ adId: '123', status: 'applied' }]) },
    jobs: {
      run: vi.fn(async (_s, fn) => ({ ok: true, rows: await fn({ progress: async () => {} }) })),
      runInBackground: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(false),
    },
    jobCatalog: { 'tn-backfill': { source: 'tn_backfill', fn: vi.fn() } },
    ...overrides,
  };
  const app = createApp({ apiRouter: [createAuthMiddleware({ password: 'pw' }), createApiRouter(deps)] });
  const get = (url) => request(app).get(url).set('authorization', 'Bearer pw');
  const post = (url, body) => request(app).post(url).set('authorization', 'Bearer pw').send(body);
  return { app, deps, get, post };
}

describe('api', () => {
  it('sin contraseña → 401', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/summary?from=2026-10-01&to=2026-10-05')).status).toBe(401);
  });
  it('summary valida el período', async () => {
    const { get, deps } = setup();
    expect((await get('/api/summary?from=2026-10-05&to=2026-10-01')).status).toBe(400);
    expect((await get('/api/summary?from=ayer&to=2026-10-01')).status).toBe(400);
    expect((await get('/api/summary?from=2024-01-01&to=2026-10-01')).status).toBe(400); // > 366 días
    const ok = await get('/api/summary?from=2026-10-01&to=2026-10-05');
    expect(ok.status).toBe(200);
    expect(deps.reports.summary).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05' });
  });
  it('orders pasa filtros y valida canal', async () => {
    const { get, deps } = setup();
    await get('/api/orders?from=2026-10-01&to=2026-10-05&channel=meta&q=silla&cursor=abc');
    expect(deps.reports.listOrders).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05', channel: 'meta', q: 'silla', cursor: 'abc', limit: 50 });
    expect((await get('/api/orders?from=2026-10-01&to=2026-10-05&channel=tiktok')).status).toBe(400);
  });
  it('error con status 400 del repo se devuelve como 400', async () => {
    const err = Object.assign(new Error('cursor inválido'), { status: 400 });
    const { get } = setup({ reports: { ...setup().deps.reports, listOrders: vi.fn().mockRejectedValue(err) } });
    const res = await get('/api/orders?from=2026-10-01&to=2026-10-05&cursor=x');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cursor inválido' });
  });
  it('orden inexistente → 404', async () => {
    const { get } = setup();
    expect((await get('/api/orders/123')).status).toBe(404);
  });
  it('ads valida level y sort; missing-params no choca con /ads/:id', async () => {
    const { get, deps } = setup();
    expect((await get('/api/ads?from=2026-10-01&to=2026-10-05&level=foo')).status).toBe(400);
    await get('/api/ads?from=2026-10-01&to=2026-10-05&level=ad&parent=55&sort=cps');
    expect(deps.reports.adsRanking).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05', level: 'ad', parentId: '55', sort: 'cps', platform: 'meta' });
    await get('/api/ads?from=2026-10-01&to=2026-10-05&platform=google');
    expect(deps.reports.adsRanking).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-05', level: 'campaign', parentId: null, sort: 'spend', platform: 'google' });
    expect((await get('/api/ads?from=2026-10-01&to=2026-10-05&platform=tiktok')).status).toBe(400);
    const mp = await get('/api/ads/missing-params');
    expect(mp.body).toEqual([{ id: '1' }]);
    expect(deps.reports.adDetail).not.toHaveBeenCalled();
  });
  it('status junta corridas, errores, cobertura y conteos', async () => {
    const { get } = setup();
    const res = await get('/api/status');
    expect(res.body).toMatchObject({ runs: [], lastSuccess: [], errors: [], coverage: [], counts: { orders: 0 }, running: [] });
  });
  it('apply-url-tags valida ids y devuelve resultados', async () => {
    const { post, deps } = setup();
    expect((await post('/api/meta/apply-url-tags', { adIds: [] })).status).toBe(400);
    expect((await post('/api/meta/apply-url-tags', { adIds: ['abc'] })).status).toBe(400);
    expect((await post('/api/meta/apply-url-tags', { adIds: Array(51).fill('1') })).status).toBe(400);
    const res = await post('/api/meta/apply-url-tags', { adIds: ['123'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ adId: '123', status: 'applied' }] });
    expect(deps.jobs.run.mock.calls[0][0]).toBe('meta_url_tags');
  });
  it('apply-url-tags en curso → 409', async () => {
    const { post } = setup({ jobs: { run: vi.fn().mockResolvedValue({ skipped: true }), runInBackground: vi.fn(), isRunning: vi.fn() } });
    expect((await post('/api/meta/apply-url-tags', { adIds: ['123'] })).status).toBe(409);
  });
  it('sync/:job dispara en segundo plano; desconocido 404; en curso 409', async () => {
    const { post, deps } = setup();
    const res = await post('/api/sync/tn-backfill');
    expect(res.status).toBe(202);
    expect(deps.jobs.runInBackground).toHaveBeenCalledWith('tn_backfill', deps.jobCatalog['tn-backfill'].fn);
    expect((await post('/api/sync/nada')).status).toBe(404);
    deps.jobs.runInBackground.mockReturnValue(false);
    expect((await post('/api/sync/tn-backfill')).status).toBe(409);
  });
});
