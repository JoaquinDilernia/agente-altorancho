import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { buildAdsApp, fakeMeta, fakeReports, fakeAnthropic, toolTurn, waitRun, contextSection, PNG_1x1, MP4 } from './helpers/adsFakes.js';
import { buildLinkCreativeSpec, buildAdName, buildIgPostCreativeSpec } from '../src/ads/creativeSpec.js';
import { summarizeMetaRow, realMetrics } from '../src/ads/metrics.js';
import { createIdentity, trimForAgent } from '../src/ads/agent.js';
import { URL_TAGS_TEMPLATE } from '../src/engine/urlTags.js';

describe('métricas y creativos', () => {
  it('lee lo de Meta como señal y las ventas reales como métrica', () => {
    expect(summarizeMetaRow({ spend: '9000.4', frequency: '1.834', actions: [{ action_type: 'omni_purchase', value: '2' }] }))
      .toMatchObject({ spend: 9000, frequency: 1.83, metaPurchases: 2 });
    expect(realMetrics({ spend: 9000.2, sales: 2, revenue: 60000, roas: 6.666, costPerSale: 4500.1, metaPurchases: 3 }))
      .toEqual({ spend: 9000, sales: 2, revenue: 60000, roas: 6.7, costPerSale: 4500, metaPurchases: 3 });
    expect(realMetrics(undefined)).toMatchObject({ spend: 0, sales: 0, roas: null });
  });

  it('el creative lleva a la tienda con botón Comprar y los UTMs de atribución', () => {
    const img = (hash) => ({ type: 'image', hash });
    const vid = (videoId) => ({ type: 'video', videoId, thumbnailUrl: `https://t/${videoId}.jpg` });
    const base = { name: 'X', pageId: '1', igUserId: '2', message: 'hola', headline: 'Título', link: 'https://altorancho.com/productos/nordica' };

    const simple = buildLinkCreativeSpec({ ...base, feed: img('h1') });
    expect(simple.url_tags).toBe(URL_TAGS_TEMPLATE);
    expect(simple.object_story_spec.link_data).toMatchObject({
      link: base.link, image_hash: 'h1', name: 'Título', call_to_action: { type: 'SHOP_NOW', value: { link: base.link } },
    });

    const video = buildLinkCreativeSpec({ ...base, feed: vid('v1') });
    expect(video.object_story_spec.video_data).toMatchObject({ video_id: 'v1', image_url: 'https://t/v1.jpg', title: 'Título', call_to_action: { type: 'SHOP_NOW' } });

    const placed = buildLinkCreativeSpec({ ...base, feed: img('h1'), story: vid('v2') });
    expect(placed.url_tags).toBe(URL_TAGS_TEMPLATE);
    expect(placed.asset_feed_spec).toMatchObject({
      ad_formats: ['AUTOMATIC_FORMAT'], call_to_action_types: ['SHOP_NOW'], link_urls: [{ website_url: base.link }],
    });
    expect(placed.asset_feed_spec.asset_customization_rules.map((r) => r.image_label ?? r.video_label)).toEqual([{ name: 'feed' }, { name: 'story' }]);

    expect(buildAdName({ adsetName: 'INT_DECO_AMBA_20261009', creativeName: 'Lámpara Nórdica', date: '2026-10-09' })).toBe('INTDECOAMBA_LAMPARANORDICA_20261009');
  });

  it('promocionar un post usa el post original con botón Comprar y UTMs', () => {
    const spec = buildIgPostCreativeSpec({ name: 'X', pageId: '111', igUserId: '222', mediaId: '1789', link: 'https://altorancho.com' });
    expect(spec).toMatchObject({
      object_id: '111', instagram_user_id: '222', source_instagram_media_id: '1789', url_tags: URL_TAGS_TEMPLATE,
      call_to_action: { type: 'SHOP_NOW', value: { link: 'https://altorancho.com' } },
    });
    expect(spec.degrees_of_freedom_spec.creative_features_spec.enhance_cta).toEqual({ enroll_status: 'OPT_OUT' });
  });

  it('página e Instagram: env primero, si no se descubren una sola vez', async () => {
    let n = 0;
    const meta = { discoverIdentity: async () => { n += 1; return { pageId: 'P', igUserId: 'I' }; } };
    expect(await createIdentity({ meta, config: { pageId: '1', igUserId: '2' } })()).toEqual({ pageId: '1', igUserId: '2' });
    const found = createIdentity({ meta, config: { pageId: null, igUserId: null } });
    expect(await found()).toEqual({ pageId: 'P', igUserId: 'I' });
    await found();
    expect(n).toBe(1);
    await expect(createIdentity({ meta: { discoverIdentity: async () => ({ pageId: null }) }, config: {} })()).rejects.toThrow(/META_ADS_PAGE_ID/);
  });
});

describe('agente de pauta', () => {
  let db, app, meta;
  beforeAll(async () => {
    db = await createTestDb();
    const anthropic = fakeAnthropic([
      toolTurn(
        ['pause_ad', { ad_id: '902', title: 'Pausar AD1', reason: 'gastó sin ventas', expected_impact: 'menos gasto' }],
        ['request_creative', { concept: 'Lámpara Nórdica ambientada', style_notes: 'feed 4:5', reason: 'no hay piezas' }],
        ['ask_team', { question: '¿Hay stock de la Nórdica?', why: 'para subir presupuesto', quick_answers: ['Sí', 'No', ' '] }],
      ),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Cómo vamos** todo en orden' }], usage: { input_tokens: 1000, output_tokens: 200 } },
    ]);
    app = buildAdsApp({ db, anthropic });
    meta = app.meta;
  });
  afterAll(() => db.close());
  beforeEach(() => { meta.calls.length = 0; });

  it('pide la contraseña del panel', async () => {
    const { call } = app;
    expect((await call('get', '/api/ads/overview').set('authorization', 'Bearer otra')).status).toBe(401);
  });

  it('resumen: estructura de Meta en pesos con las ventas reales de la tienda', async () => {
    const res = await app.call('get', '/api/ads/overview');
    expect(res.status).toBe(200);
    expect(res.body.configured).toEqual({ meta: true, agent: true });
    const snap = res.body.snapshot;
    expect(snap.campaigns[0]).toMatchObject({ dailyBudgetArs: 50000, isCbo: true, last7d: { sales: 2, revenue: 60000, roas: 6.7 } });
    expect(snap.ads[0]).toMatchObject({ last7d: { sales: 2, costPerSale: 4500 }, delivery7d: { frequency: 1.8, metaPurchases: 3 } });
    expect(snap.last7d.meta).toMatchObject({ sales: 2, roas: 6.7, metaPurchases: 3 });
    expect(snap.month.spend).toBe(12000);
  });

  it('el agente corre con el contexto de ventas, deja recomendaciones, pedidos, preguntas e informe', async () => {
    const res = await app.call('post', '/api/ads/runs');
    expect(res.status).toBe(202);
    const run = await waitRun(app.call, res.body.run.id);
    expect(run).toMatchObject({ status: 'done', input_tokens: 1000, output_tokens: 200 });
    expect(run.report).toContain('Cómo vamos');
    expect(fakeAnthropic.lastParams.model).toBe('claude-opus-5-5');
    expect(contextSection(fakeAnthropic.firstMessage, 'ads')[0].last7d).toMatchObject({ sales: 2, roas: 6.7 });
    expect(contextSection(fakeAnthropic.firstMessage, 'igPosts')).toHaveLength(2);

    const pending = (await app.call('get', '/api/ads/decisions?status=pending')).body.decisions;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tool: 'pause_ad', title: 'Pausar AD1' });
    expect(meta.calls.find((c) => c[0] === 'setStatus')).toBeUndefined();
    expect((await app.call('get', '/api/ads/requests')).body.requests[0].concept).toBe('Lámpara Nórdica ambientada');
    const [q] = (await app.call('get', '/api/ads/questions')).body.questions;
    expect(q).toMatchObject({ question: '¿Hay stock de la Nórdica?', quick_answers: ['Sí', 'No'] });
    expect((await app.call('get', '/api/ads/overview')).body).toMatchObject({ pendingCount: 1, openQuestions: 1 });
    expect((await app.call('get', '/api/ads/badge')).body).toEqual({ pendingCount: 1, openQuestions: 1 });
  });

  it('responder una pregunta: una sola vez, y le llega al agente en la próxima corrida', async () => {
    const [q] = (await app.call('get', '/api/ads/questions')).body.questions;
    const res = await app.call('post', `/api/ads/questions/${q.id}/answer`).send({ answer: 'Sí, 40 unidades' });
    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({ status: 'answered', answer: 'Sí, 40 unidades' });
    expect((await app.call('post', `/api/ads/questions/${q.id}/answer`).send({ answer: 'otra' })).status).toBe(409);
    expect((await app.call('post', `/api/ads/questions/${q.id}/answer`).send({ answer: '  ' })).status).toBe(400);
    const answered = await app.repo.answeredSinceLastRun();
    expect(answered.map((a) => a.answer)).toEqual(['Sí, 40 unidades']);
  });

  it('aprobar ejecuta en Meta; no se puede aprobar dos veces', async () => {
    const [d] = (await app.call('get', '/api/ads/decisions?status=pending')).body.decisions;
    const res = await app.call('post', `/api/ads/decisions/${d.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.decision.status).toBe('executed');
    expect(meta.calls).toContainEqual(['setStatus', '902', 'PAUSED']);
    expect((await app.call('post', `/api/ads/decisions/${d.id}/approve`)).status).toBe(409);
  });

  it('pieza: se crea con link a la tienda, la imagen va a Meta y se publica con UTMs', async () => {
    const created = await app.call('post', '/api/ads/creatives').send({ name: 'Lámpara Nórdica', copy: 'Iluminá tu living 👇' });
    expect(created.status).toBe(201);
    expect(created.body.creative.link).toBe('https://altorancho.com');
    const id = created.body.creative.id;

    const webp = await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'image/webp').send(Buffer.from('RIFF0000WEBPVP8 '));
    expect(webp.status).toBe(415);
    const fake = await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'image/png').send(Buffer.from('no soy un png'));
    expect(fake.status).toBe(415);
    const up = await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'image/png').set('x-file-name', 'feed.png').send(PNG_1x1);
    expect(up.status).toBe(201);
    expect(up.body.media).toMatchObject({ kind: 'image', image_hash: 'hash1', image_url: 'https://img/1.png', original_name: 'feed.png' });
    const [listed] = (await app.call('get', '/api/ads/creatives')).body.creatives;
    expect(listed.feed).toMatchObject({ kind: 'image', image_hash: 'hash1' });
    expect(listed.story).toBeNull();

    const pub = await app.call('post', `/api/ads/creatives/${id}/publish`).send({ adset_id: '901', adset_name: 'INT_DECO_AMBA' });
    expect(pub.status).toBe(200);
    expect(pub.body.ad_id).toBe('905');
    const spec = meta.calls.find((c) => c[0] === 'createCreative')[1];
    expect(spec.object_story_spec).toMatchObject({ page_id: '111', instagram_user_id: '222', link_data: { image_hash: 'hash1', link: 'https://altorancho.com' } });
    expect(spec.url_tags).toContain('utm_content={{ad.id}}');
    expect(meta.calls.find((c) => c[0] === 'createAd')[1]).toMatchObject({ adsetId: '901', creativeId: '904', status: 'ACTIVE' });
    expect((await app.call('post', `/api/ads/creatives/${id}/publish`).send({ adset_id: '901' })).status).toBe(409);
    expect((await app.call('put', `/api/ads/creatives/${id}/media/story`).set('content-type', 'image/png').send(PNG_1x1)).status).toBe(409);
  });

  it('pieza con video: se sube a Meta y al publicar espera el procesamiento', async () => {
    const created = await app.call('post', '/api/ads/creatives').send({ name: 'Reel sillas', copy: 'texto', link: 'https://altorancho.com/productos/silla' });
    const id = created.body.creative.id;
    const up = await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'video/mp4').send(MP4);
    expect(up.status).toBe(201);
    expect(up.body.media).toMatchObject({ kind: 'video', video_id: 'vid1' });
    const [listed] = (await app.call('get', '/api/ads/creatives')).body.creatives;
    expect(listed.feed.thumbnail_url).toBe('https://t/thumb.jpg');
    const notVideo = await app.call('put', `/api/ads/creatives/${id}/media/story`).set('content-type', 'video/mp4').send(Buffer.alloc(32));
    expect(notVideo.status).toBe(415);

    const pub = await app.call('post', `/api/ads/creatives/${id}/publish`).send({ adset_id: '901' });
    expect(pub.status).toBe(200);
    expect(meta.calls).toContainEqual(['waitVideoReady', 'vid1']);
    const spec = meta.calls.find((c) => c[0] === 'createCreative')[1];
    expect(spec.object_story_spec.video_data).toMatchObject({ video_id: 'vid1', call_to_action: { value: { link: 'https://altorancho.com/productos/silla' } } });
  });

  it('si no hay acceso a la cuenta de Instagram, publica con la de la página', async () => {
    const id = (await app.call('post', '/api/ads/creatives').send({ name: 'Sin IG', copy: 'texto' })).body.creative.id;
    await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'image/png').send(PNG_1x1);
    const original = meta.createCreative;
    meta.createCreative = async (spec) => {
      meta.calls.push(['createCreative', spec]);
      if (spec.object_story_spec.instagram_user_id) throw new Error('Meta 200: Permissions error (sin acceso a esta cuenta de Instagram)');
      return { id: '906' };
    };
    try {
      expect((await app.call('post', `/api/ads/creatives/${id}/publish`).send({ adset_id: '901' })).status).toBe(200);
      const specs = meta.calls.filter((c) => c[0] === 'createCreative').map((c) => c[1]);
      expect(specs).toHaveLength(2);
      expect(specs[1].object_story_spec.instagram_user_id).toBeUndefined();
    } finally {
      meta.createCreative = original;
    }
  });

  it('si Meta rechaza, la pieza vuelve a quedar sin usar y queda el error en el historial', async () => {
    const id = (await app.call('post', '/api/ads/creatives').send({ name: 'Rechazada', copy: 'texto' })).body.creative.id;
    await app.call('put', `/api/ads/creatives/${id}/media/feed`).set('content-type', 'image/png').send(PNG_1x1);
    const original = meta.createAd;
    meta.createAd = async () => { throw new Error('Meta 100: Invalid parameter'); };
    try {
      const res = await app.call('post', `/api/ads/creatives/${id}/publish`).send({ adset_id: '901' });
      expect(res.status).toBe(502);
      expect((await app.repo.getCreative(id)).status).toBe('unused');
      const [d] = (await app.call('get', '/api/ads/decisions?status=failed')).body.decisions;
      expect(d.error).toMatch(/Invalid parameter/);
    } finally {
      meta.createAd = original;
    }
  });

  it('conjunto nuevo: optimiza con el mismo píxel y evento que los de la campaña', async () => {
    const d = await app.repo.addDecision({
      tool: 'propose_adset', status: 'pending', title: 'Probar público abierto',
      input: { campaign_id: '900', name: 'ABIERTO_AMBA', targeting: { geo_locations: { countries: ['AR'] } } },
    });
    const res = await app.call('post', `/api/ads/decisions/${d.id}/approve`);
    expect(res.body.decision).toMatchObject({ status: 'executed', result: { adset_id: '903' } });
    expect(meta.calls.find((c) => c[0] === 'createAdset')[1]).toMatchObject({
      campaign_id: '900', status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
      promoted_object: { pixel_id: '777', custom_event_type: 'PURCHASE' }, targeting: { targeting_automation: { advantage_audience: 0 } },
    });
  });

  it('presupuesto en pesos y estado a mano desde el panel', async () => {
    const d = await app.repo.addDecision({ tool: 'propose_budget_change', status: 'pending', input: { level: 'campaign', object_id: '900', proposed_budget_ars: 55000 } });
    await app.call('post', `/api/ads/decisions/${d.id}/approve`);
    expect(meta.calls).toContainEqual(['setDailyBudget', '900', 55000]);

    const res = await app.call('post', '/api/ads/objects/900/status').send({ level: 'campaign', status: 'PAUSED', name: 'AR | VENTAS' });
    expect(res.status).toBe(200);
    expect(meta.calls).toContainEqual(['setStatus', '900', 'PAUSED']);
    const [last] = (await app.call('get', '/api/ads/decisions')).body.decisions;
    expect(last).toMatchObject({ tool: 'set_status', status: 'executed', title: 'Pausar la campaña AR | VENTAS' });
    expect((await app.call('post', '/api/ads/objects/abc/status').send({ level: 'campaign', status: 'PAUSED' })).status).toBe(400);
  });

  it('posts de Instagram: promocionar una vez por conjunto, con link de producto', async () => {
    const REEL = '17900000000123456';
    const list = await app.call('get', '/api/ads/ig-posts');
    expect(list.body.posts[0]).toMatchObject({ id: REEL, type: 'reel', promotedIn: [] });
    const res = await app.call('post', `/api/ads/ig-posts/${REEL}/promote`)
      .send({ adset_id: '901', adset_name: 'INT_DECO_AMBA', permalink: 'https://ig/1', link: 'https://altorancho.com/productos/nordica' });
    expect(res.status).toBe(200);
    expect(res.body.name).toMatch(/^INTDECOAMBA_IG123456_\d{8}$/);
    expect(meta.calls.find((c) => c[0] === 'createCreative')[1]).toMatchObject({
      source_instagram_media_id: REEL, call_to_action: { value: { link: 'https://altorancho.com/productos/nordica' } },
    });
    const again = await app.call('get', '/api/ads/ig-posts?refresh=1');
    expect(again.body.posts[0].promotedIn).toMatchObject([{ adset_id: '901', ad_id: '905' }]);
    expect((await app.call('post', `/api/ads/ig-posts/${REEL}/promote`).send({ adset_id: '901' })).status).toBe(409);
    expect((await app.call('post', `/api/ads/ig-posts/${REEL}/promote`).send({ adset_id: '901', link: 'http://otro' })).status).toBe(400);
  });

  it('ajustes validados', async () => {
    const res = await app.call('put', '/api/ads/settings').send({ monthly_cap_ars: 1500000, autonomous: true, business_notes: 'Empujar iluminación' });
    expect(res.body.settings).toMatchObject({ monthly_cap_ars: 1500000, autonomous: true, agent_enabled: true, business_notes: 'Empujar iluminación' });
    expect((await app.call('put', '/api/ads/settings').send({ monthly_cap_ars: -1 })).status).toBe(400);
    expect((await app.call('put', '/api/ads/settings').send({ otra: 1 })).status).toBe(400);
  });

  it('con el modo autónomo, pausar un anuncio se ejecuta solo', async () => {
    const run = await app.repo.startRun('manual');
    const { createDispatcher } = await import('../src/ads/agent.js');
    const executed = [];
    const dispatch = createDispatcher({ meta, repo: app.repo, execute: async (tool, input) => { executed.push(tool); return { paused: input.ad_id }; } });
    const out = await dispatch('pause_ad', { ad_id: '902', title: 'x' }, { runId: run.id, settings: { autonomous: true } });
    expect(out).toMatchObject({ executed: true });
    const other = await dispatch('set_status', { object_id: '900', status: 'ACTIVE' }, { runId: run.id, settings: { autonomous: true } });
    expect(other).toMatchObject({ queued: true });
    expect(executed).toEqual(['pause_ad']);
  });
});

describe('pauta con Meta limitado', () => {
  it('avisa el error y no le vuelve a pegar a Meta en cada recarga', async () => {
    const db = await createTestDb();
    let calls = 0;
    const meta = { ...fakeMeta(), getCampaigns: async () => { calls += 1; throw new Error('Meta 80004: too many calls'); } };
    const { call } = buildAdsApp({ db, meta });
    const first = await call('get', '/api/ads/overview');
    expect(first.status).toBe(200);
    expect(first.body.metaError).toMatch(/80004/);
    expect((await call('get', '/api/ads/overview')).body.metaError).toMatch(/80004/);
    expect(calls).toBe(1);
    await db.close();
  });
});

describe('foto de la cuenta', () => {
  it('trae lo que entrega y, por id, lo pausado que vendió hace poco', async () => {
    const db = await createTestDb();
    const meta = fakeMeta();
    const reports = fakeReports();
    const ranking = reports.adsRanking;
    reports.adsRanking = async (args) => {
      const r = await ranking(args);
      return args.level === 'ad' ? { ...r, rows: [...r.rows, { id: '950', spend: 0, sales: 1, revenue: 30000, roas: null, costPerSale: null, metaPurchases: 0 }] } : r;
    };
    const { call } = buildAdsApp({ db, meta, reports });
    const snap = (await call('get', '/api/ads/overview')).body.snapshot;
    expect(snap.ads.map((a) => a.id)).toEqual(['902', '950']);
    expect(meta.calls.filter(([n]) => n === 'getByIds')).toEqual([['getByIds', 'ad', ['950']]]);
    await db.close();
  });
});

describe('pauta sin Meta configurado', () => {
  it('avisa qué falta', async () => {
    const db = await createTestDb();
    const { call } = buildAdsApp({ db, meta: null });
    const res = await call('get', '/api/ads/overview');
    expect(res.body.configured).toEqual({ meta: false, agent: false });
    expect((await call('post', '/api/ads/runs')).status).toBe(503);
    await db.close();
  });
});

describe('contexto del agente', () => {
  const quiet = { spend: 0, sales: 0 };
  const obj = (id, effectiveStatus, last7d = quiet, extra = {}) => ({ id, effectiveStatus, last7d, prev7d: quiet, ...extra });
  it('no manda lo pausado sin gasto ni ventas en 14 días (solo lo cuenta)', () => {
    const out = trimForAgent({
      campaigns: [obj('c1', 'ACTIVE'), obj('c2', 'PAUSED'), obj('c3', 'PAUSED')],
      adsets: [obj('s1', 'ACTIVE', quiet, { campaignId: 'c1' }), obj('s2', 'PAUSED', quiet, { campaignId: 'c2' }), obj('s3', 'PAUSED', quiet, { campaignId: 'c3' })],
      ads: [
        obj('a1', 'ACTIVE', quiet, { adsetId: 's1', thumbnail: 'https://t', copy: 'x'.repeat(1000), delivery7d: quiet }),
        obj('a2', 'ADSET_PAUSED', { spend: 500, sales: 0 }, { adsetId: 's2', delivery7d: quiet }),
        obj('a3', 'PAUSED', quiet, { adsetId: 's3', delivery7d: quiet }),
      ],
    });
    expect(out.ads.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(out.adsets.map((a) => a.id)).toEqual(['s1', 's2']); // s2 queda porque su anuncio gastó
    expect(out.campaigns.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(out.omitted).toEqual({ campaigns: 1, adsets: 1, ads: 1 });
    expect(out.ads[0].thumbnail).toBeUndefined();
    expect(out.ads[0].copy).toHaveLength(400);
  });
});
