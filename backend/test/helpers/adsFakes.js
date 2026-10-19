import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAuthMiddleware } from '../../src/routes/authMiddleware.js';
import { createAdsRepo } from '../../src/repo/ads.js';
import { createAdsRouter } from '../../src/routes/ads.js';
import { createAgentRunner, createExecutor, createIdentity } from '../../src/ads/agent.js';

export const config = { pageId: '111', igUserId: '222', pixelId: null, storeUrl: 'https://altorancho.com' };
export const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

export function fakeMeta() {
  const calls = [];
  const log = (name, ...args) => calls.push([name, ...args]);
  let images = 0;
  return {
    calls,
    getCampaigns: async () => [{ id: '900', name: 'AR | VENTAS', objective: 'OUTCOME_SALES', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000000' }],
    getAdsets: async () => [{
      id: '901', name: 'INT_DECO_AMBA', campaign_id: '900', status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS', promoted_object: { pixel_id: '777', custom_event_type: 'PURCHASE' },
    }],
    getAds: async () => [{ id: '902', name: 'AD1', adset_id: '901', campaign_id: '900', status: 'ACTIVE', effective_status: 'ACTIVE' }],
    getInsights: async (level) => (level === 'ad'
      ? [{ ad_id: '902', spend: '9000', impressions: '1000', frequency: '1.8', ctr: '1.2', actions: [{ action_type: 'purchase', value: '3' }] }]
      : [{ spend: '12000', actions: [{ action_type: 'purchase', value: '4' }], action_values: [{ action_type: 'purchase', value: '80000' }] }]),
    setStatus: async (...a) => { log('setStatus', ...a); return { success: true }; },
    setDailyBudget: async (...a) => { log('setDailyBudget', ...a); return { success: true }; },
    createAdset: async (p) => { log('createAdset', p); return { id: '903' }; },
    uploadImage: async () => { images += 1; log('uploadImage'); return { hash: `hash${images}`, url: `https://img/${images}.png` }; },
    uploadVideoFile: async (filePath, name) => { log('uploadVideoFile', name); return 'vid1'; },
    waitVideoReady: async (id) => { log('waitVideoReady', id); },
    videoThumbnail: async () => 'https://t/thumb.jpg',
    createCreative: async (spec) => { log('createCreative', spec); return { id: '904' }; },
    createAd: async (a) => { log('createAd', a); return { id: '905' }; },
    getByIds: async (level, ids) => {
      log('getByIds', level, ids);
      return ids.map((id) => ({ id, name: `PAUSADO ${id}`, adset_id: '901', campaign_id: '900', status: 'PAUSED', effective_status: 'PAUSED' }));
    },
    searchInterests: async () => [{ id: '6003', name: 'Decoración de interiores' }],
    discoverIdentity: async () => ({ pageId: '111', igUserId: '222' }),
    getIgMedia: async () => [
      { id: '17900000000123456', type: 'reel', caption: 'Así quedó el living con la lámpara Nórdica', thumbnail: 'https://t/1.jpg', permalink: 'https://ig/1', timestamp: '2026-10-10T10:00:00+0000', likes: 40, comments: 3, reach: 1200 },
      { id: '17900000000654321', type: 'post', caption: 'Sillas de paraíso', thumbnail: 'https://t/2.jpg', permalink: 'https://ig/2', timestamp: '2026-10-09T10:00:00+0000', likes: 12, comments: 0, reach: null },
    ],
  };
}

// Ventas reales de la tienda (lo que en producción sale de reports con las órdenes de Tienda Nube)
export function fakeReports() {
  const row = (id, o) => ({ id, spend: 0, sales: 0, revenue: 0, roas: null, costPerSale: null, metaPurchases: 0, ...o });
  const rows = {
    campaign: [row('900', { spend: 9000, sales: 2, revenue: 60000, roas: 6.67, costPerSale: 4500, metaPurchases: 3 })],
    adset: [row('901', { spend: 9000, sales: 2, revenue: 60000, roas: 6.67, costPerSale: 4500, metaPurchases: 3 })],
    ad: [row('902', { spend: 9000, sales: 2, revenue: 60000, roas: 6.67, costPerSale: 4500, metaPurchases: 3 })],
  };
  return {
    summary: async () => ({
      orders: 10, revenue: 300000, channels: [{ channel: 'meta', orders: 2, revenue: 60000 }, { channel: 'direct', orders: 8, revenue: 240000 }],
      meta: { spend: 9000, orders: 2, revenue: 60000, roas: 6.67, reported: { purchases: 3 } },
    }),
    adsRanking: async ({ level }) => ({ level, rows: rows[level] }),
  };
}

// Simula a Claude: devuelve los turnos del guion en orden; después, un informe "fin"
export function fakeAnthropic(script) {
  let turn = 0;
  return {
    beta: {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            fakeAnthropic.lastParams = params;
            fakeAnthropic.firstMessage ??= params.messages[0].content;
            return script[turn++] ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fin' }], usage: { input_tokens: 10, output_tokens: 5 } };
          },
        }),
      },
    },
  };
}

export const toolTurn = (...blocks) => ({ stop_reason: 'tool_use', content: blocks.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) });

// El contexto del agente es "## nombre\n{json}" por sección
export function contextSection(text, name) {
  const m = text.match(new RegExp(`## ${name}\\n(.*)`));
  if (!m) throw new Error(`no está la sección ${name}`);
  return JSON.parse(m[1]);
}

export function buildAdsApp({ db, meta = fakeMeta(), anthropic = null, reports = fakeReports(), cfg = config }) {
  const repo = createAdsRepo(db);
  const identity = createIdentity({ meta, config: cfg });
  const execute = meta ? createExecutor({ meta, repo, config: cfg, identity }) : null;
  const startRun = meta && anthropic ? createAgentRunner({ anthropic, meta, reports, repo, execute, identity, log: { error: () => {} } }) : null;
  const app = createApp({
    apiRouter: [createAuthMiddleware({ password: 'pw' }), createAdsRouter({ repo, meta, reports, startRun, execute, identity, config: cfg })],
  });
  const call = (method, url) => request(app)[method](url).set('authorization', 'Bearer pw');
  return { repo, meta, call, startRun };
}

export async function waitRun(call, id) {
  for (let i = 0; i < 100; i++) {
    const { body } = await call('get', '/api/ads/runs');
    const run = body.runs.find((r) => r.id === id);
    if (run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('la corrida no terminó');
}
