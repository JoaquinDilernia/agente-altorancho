import { describe, it, expect, vi } from 'vitest';
import { createMetaClient } from '../src/services/meta.js';

const ok = (body) => ({ json: async () => body });
const make = (fetchFn, extra = {}) => createMetaClient({ accessToken: 'tok', accountId: 'act_1', fetchFn, sleep: vi.fn().mockResolvedValue(), pollMs: 0, ...extra });

describe('cliente meta', () => {
  it('pagina siguiendo paging.cursors.after mientras haya paging.next', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ data: [{ id: '1' }], paging: { cursors: { after: 'A' }, next: 'https://x' } }))
      .mockResolvedValueOnce(ok({ data: [{ id: '2' }], paging: { cursors: { after: 'B' } } }));
    const r = await make(fetchFn).getDailyAdInsights('2026-10-01', '2026-10-01');
    expect(r).toEqual([{ id: '1' }, { id: '2' }]);
    const second = new URL(fetchFn.mock.calls[1][0]);
    expect(second.searchParams.get('after')).toBe('A');
    expect(second.pathname).toBe('/v23.0/act_1/insights');
  });
  it('el catálogo también trae lo archivado (segunda pasada filtrada) sin duplicar', async () => {
    const fetchFn = vi.fn(async (url) => {
      const filtering = new URL(url).searchParams.get('filtering');
      return ok({ data: filtering ? [{ id: '2' }, { id: '1' }] : [{ id: '1' }] });
    });
    const r = await make(fetchFn).listCampaigns();
    expect(r.map((c) => c.id)).toEqual(['1', '2']);
    const filters = fetchFn.mock.calls.map((c) => new URL(c[0]).searchParams.get('filtering')).filter(Boolean);
    expect(JSON.parse(filters[0])).toEqual([{ field: 'effective_status', operator: 'IN', value: ['ARCHIVED'] }]);
  });
  it('listAds pide páginas chicas (con el creativo Meta responde "reduce the amount of data" a 500)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    await make(fetchFn).listAds();
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.get('limit')).toBe('100');
  });
  it('error 1 "reduce the amount of data" se reintenta pidiendo la mitad', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ error: { code: 1, message: 'Please reduce the amount of data you\'re asking for, then retry your request' } }))
      .mockResolvedValue(ok({ data: [{ id: '1' }] }));
    const r = await make(fetchFn).getDailyAdInsights('2026-10-01', '2026-10-01');
    expect(r).toEqual([{ id: '1' }]);
    expect(new URL(fetchFn.mock.calls[1][0]).searchParams.get('limit')).toBe('250');
  });
  it('el catálogo pide objetivo, presupuesto, fechas y aprendizaje', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    const meta = make(fetchFn);
    await meta.listCampaigns();
    await meta.listAdsets();
    await meta.listAds();
    const fields = fetchFn.mock.calls.map((c) => new URL(c[0]).searchParams.get('fields'));
    expect(fields).toContain('id,name,effective_status,objective,daily_budget,created_time,updated_time');
    expect(fields).toContain('id,name,effective_status,campaign_id,daily_budget,created_time,updated_time,learning_stage_info');
    expect(fields).toContain('id,name,effective_status,adset_id,campaign_id,created_time,updated_time,creative{id,thumbnail_url,url_tags}');
  });
  it('getDailyAdInsights pide nivel ad, por día, con time_range', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    await make(fetchFn).getDailyAdInsights('2026-10-05', '2026-10-06');
    const u = new URL(fetchFn.mock.calls[0][0]);
    expect(u.searchParams.get('level')).toBe('ad');
    expect(u.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(u.searchParams.get('time_range'))).toEqual({ since: '2026-10-05', until: '2026-10-06' });
  });
  it('getDailyAdInsightsAsync crea el reporte, espera y lee resultados', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ report_run_id: 'R1' }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Running', async_percent_completion: 50 }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Completed', async_percent_completion: 100 }))
      .mockResolvedValueOnce(ok({ data: [{ ad_id: '9' }] }));
    const rows = await make(fetchFn).getDailyAdInsightsAsync('2026-01-01', '2026-01-31');
    expect(rows).toEqual([{ ad_id: '9' }]);
    expect(fetchFn.mock.calls[0][1].method).toBe('POST');
    expect(new URL(fetchFn.mock.calls[3][0]).pathname).toBe('/v23.0/R1/insights');
  });
  it('reporte asincrónico fallido → error', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ report_run_id: 'R1' }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Failed' }));
    await expect(make(fetchFn).getDailyAdInsightsAsync('2026-01-01', '2026-01-31')).rejects.toThrow(/Job Failed/);
  });
  it('reintenta rate limit (17) con backoff y después tira', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchFn = vi.fn().mockResolvedValue(ok({ error: { code: 17, message: 'User request limit reached' } }));
    const meta = createMetaClient({ accessToken: 't', accountId: 'act_1', fetchFn, sleep, maxRetries: 2 });
    await expect(meta.listCampaigns()).rejects.toMatchObject({ code: 17 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });
  it('error no recuperable (190 token) no se reintenta', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ error: { code: 190, message: 'Invalid OAuth access token' } }));
    await expect(make(fetchFn).listCampaigns()).rejects.toThrow(/Meta 190/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('updateAdCreative hace POST al anuncio con el creative_id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ success: true }));
    await make(fetchFn).updateAdCreative('AD1', 'CR2');
    const [url, opts] = fetchFn.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v23.0/AD1');
    expect(JSON.parse(opts.body)).toEqual({ creative: { creative_id: 'CR2' } });
  });
  it('escrituras: estado y presupuesto diario en centavos', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ success: true }));
    const meta = make(fetchFn);
    await meta.setStatus('AD1', 'PAUSED');
    await meta.setDailyBudget('C1', 55000.4);
    await meta.getObject('C1', 'daily_budget');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ status: 'PAUSED' });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ daily_budget: 5500040 });
    expect(new URL(fetchFn.mock.calls[2][0]).searchParams.get('fields')).toBe('daily_budget');
  });
});
