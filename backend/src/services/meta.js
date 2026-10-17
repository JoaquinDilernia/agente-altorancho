import fs from 'node:fs';
import { CREATIVE_READ_FIELDS } from '../engine/urlTags.js';

const V = 'v23.0';
const RETRYABLE = new Set([4, 17, 32, 613, 80004]); // rate limits de Graph API / Marketing API
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSIGHT_FIELDS = 'ad_id,adset_id,campaign_id,spend,impressions,clicks,actions,action_values,date_start';

export function createMetaClient({ accessToken, accountId, fetchFn = fetch, sleep = defaultSleep, maxRetries = 4, pollMs = 3000 }) {
  const BASE = `https://graph.facebook.com/${V}`;
  // Los archivos de video se suben a este host: graph.facebook.com corta el upload y responde vacío
  const VIDEO_BASE = `https://graph-video.facebook.com/${V}`;

  async function reqOnce(path, { method = 'GET', params = {}, body, form, base = BASE } = {}) {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await fetchFn(url.toString(), {
      method,
      ...(form ? { body: form } : body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => {
      throw new Error(`Meta respondió HTTP ${res.status} sin datos válidos`);
    });
    if (json.error) {
      const detail = json.error.error_user_msg || (json.error.error_subcode ? `subcode ${json.error.error_subcode}` : null);
      const err = new Error(`Meta ${json.error.code}: ${json.error.message}${detail ? ` (${detail})` : ''}`);
      err.code = json.error.code;
      err.subcode = json.error.error_subcode;
      throw err;
    }
    return json;
  }

  async function req(path, opts) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await reqOnce(path, opts);
      } catch (err) {
        if (!RETRYABLE.has(err.code) || attempt >= maxRetries) throw err;
        await sleep(5000 * 2 ** attempt);
      }
    }
  }

  // Meta responde código 1 "reduce the amount of data" si la página es muy pesada: se reintenta con la mitad
  const TOO_MUCH_DATA = /reduce the amount of data/i;
  async function getAll(path, params) {
    const out = [];
    let after;
    let limit = Number(params.limit || 500);
    for (;;) {
      let json;
      try {
        json = await req(path, { params: { ...params, limit: String(limit), ...(after ? { after } : {}) } });
      } catch (err) {
        if (err.code === 1 && TOO_MUCH_DATA.test(err.message) && limit > 25) {
          limit = Math.floor(limit / 2);
          continue;
        }
        throw err;
      }
      out.push(...(json.data || []));
      after = json.paging?.cursors?.after;
      if (!json.paging?.next || !after) return out;
    }
  }

  // Por defecto Graph no devuelve lo ARCHIVED; el histórico de gasto sí lo incluye, así que se pide aparte
  const ARCHIVED = [{ field: 'effective_status', operator: 'IN', value: ['ARCHIVED'] }];
  async function getCatalog(path, fields, limit = '500') {
    const byId = new Map();
    for (const row of [...await getAll(path, { fields, limit }), ...await getAll(path, { fields, limit, filtering: ARCHIVED })]) byId.set(row.id, row);
    return [...byId.values()];
  }

  // Agente de pauta: estructura en vivo (sin archivados) y métricas de la cuenta
  const LIVE = {
    campaign: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time',
    adset: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,destination_type,promoted_object,targeting,learning_stage_info,created_time',
    ad: 'id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id,body,title,thumbnail_url}',
    igMedia: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count',
    insights: 'campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,clicks,ctr,cpm,actions,action_values',
  };

  const insightParams = (since, until) => ({ level: 'ad', time_increment: '1', time_range: { since, until }, fields: INSIGHT_FIELDS });

  return {
    listCampaigns: () => getCatalog(`${accountId}/campaigns`, 'id,name,effective_status,objective,daily_budget,created_time,updated_time'),
    listAdsets: () => getCatalog(`${accountId}/adsets`, 'id,name,effective_status,campaign_id,daily_budget,created_time,updated_time,learning_stage_info'),
    listAds: () => getCatalog(`${accountId}/ads`, 'id,name,effective_status,adset_id,campaign_id,created_time,updated_time,creative{id,thumbnail_url,url_tags}', '100'),
    getDailyAdInsights: (since, until) => getAll(`${accountId}/insights`, insightParams(since, until)),
    async getDailyAdInsightsAsync(since, until) {
      const { report_run_id: runId } = await req(`${accountId}/insights`, { method: 'POST', params: insightParams(since, until) });
      for (let i = 0; i < 400; i += 1) {
        const status = await req(runId, { params: { fields: 'async_status,async_percent_completion' } });
        if (status.async_status === 'Job Completed') return getAll(`${runId}/insights`, {});
        if (['Job Failed', 'Job Skipped'].includes(status.async_status)) throw new Error(`Reporte de Meta ${runId}: ${status.async_status}`);
        await sleep(pollMs);
      }
      throw new Error(`Reporte de Meta ${runId}: timeout`);
    },
    async getAdCreativeId(adId) {
      const json = await req(adId, { params: { fields: 'creative{id}' } });
      return json.creative.id;
    },
    getCreative: (creativeId) => req(creativeId, { params: { fields: CREATIVE_READ_FIELDS.join(',') } }),
    getObject: (id, fields) => req(id, { params: { fields } }),
    setStatus: (id, status) => req(id, { method: 'POST', body: { status } }),
    // daily_budget en Meta va en centavos (ARS, offset 100)
    setDailyBudget: (id, pesos) => req(id, { method: 'POST', body: { daily_budget: Math.round(pesos * 100) } }),
    createCreative: (spec) => req(`${accountId}/adcreatives`, { method: 'POST', body: spec }),
    updateAdCreative: (adId, creativeId) => req(adId, { method: 'POST', body: { creative: { creative_id: creativeId } } }),

    getCampaigns: () => getAll(`${accountId}/campaigns`, { fields: LIVE.campaign, limit: '200' }),
    getAdsets: () => getAll(`${accountId}/adsets`, { fields: LIVE.adset, limit: '200' }),
    getAds: () => getAll(`${accountId}/ads`, { fields: LIVE.ad, limit: '200' }),
    // since/until en YYYY-MM-DD (hora de la cuenta)
    getInsights: (level, since, until) => getAll(`${accountId}/insights`, { level, fields: LIVE.insights, time_range: { since, until }, limit: '500' }),
    createAdset: (payload) => req(`${accountId}/adsets`, { method: 'POST', body: payload }),
    createAd: ({ name, adsetId, creativeId, status }) =>
      req(`${accountId}/ads`, { method: 'POST', body: { name, adset_id: adsetId, creative: { creative_id: creativeId }, status } }),
    // { hash, url }: la url sirve para mostrar la pieza en el panel
    async uploadImage(buffer) {
      const json = await req(`${accountId}/adimages`, { method: 'POST', body: { bytes: buffer.toString('base64') } });
      const img = Object.values(json.images)[0];
      return { hash: img.hash, url: img.url ?? null };
    },
    // El archivo se manda desde el disco en streaming (hasta 200 MB sin cargarlo en memoria). Sin reintento: duplicaría el video
    async uploadVideoFile(filePath, name) {
      const form = new FormData();
      if (name) form.append('name', name);
      form.append('source', await fs.openAsBlob(filePath), 'video.mp4');
      return (await reqOnce(`${accountId}/advideos`, { method: 'POST', form, base: VIDEO_BASE })).id;
    },
    async waitVideoReady(videoId, { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const { status } = await req(videoId, { params: { fields: 'status' } });
        if (status?.video_status === 'ready') return;
        if (status?.video_status === 'error') {
          throw new Error(`Meta no pudo procesar el video: ${status.processing_phase?.errors?.[0]?.message ?? 'error desconocido'}`);
        }
        if (Date.now() >= until) throw new Error('Meta sigue procesando el video, probá publicar de nuevo en unos minutos.');
        await sleep(intervalMs);
      }
    },
    async videoThumbnail(videoId) {
      const { data = [] } = await req(`${videoId}/thumbnails`);
      return (data.find((t) => t.is_preferred) ?? data[0])?.uri ?? null;
    },
    async searchInterests(query) {
      // La búsqueda de segmentación NO va bajo la cuenta publicitaria
      const json = await req('search', { params: { type: 'adinterest', q: query, limit: '15' } });
      return (json.data ?? []).map((d) => ({ id: d.id, name: d.name, audienceMin: d.audience_size_lower_bound, audienceMax: d.audience_size_upper_bound }));
    },
    // Página de Facebook con la que anuncia la cuenta y su Instagram (cuando no vienen por env)
    async discoverIdentity() {
      const { data: pages = [] } = await req(`${accountId}/promote_pages`, { params: { fields: 'id,name,instagram_business_account', limit: '25' } });
      const page = pages.find((p) => p.instagram_business_account) ?? pages[0];
      return { pageId: page?.id ?? null, igUserId: page?.instagram_business_account?.id ?? null };
    },
    // Últimos posts/reels de la cuenta de IG. El alcance orgánico necesita instagram_manage_insights: si falta, queda null
    async getIgMedia(igUserId, limit = 25) {
      const { data: media = [] } = await req(`${igUserId}/media`, { params: { fields: LIVE.igMedia, limit: String(limit) } });
      return Promise.all(media.map(async (m) => {
        let reach = null;
        try {
          const ins = await reqOnce(`${m.id}/insights`, { params: { metric: 'reach' } });
          reach = ins.data?.[0]?.values?.[0]?.value ?? null;
        } catch {
          reach = null;
        }
        return {
          id: m.id,
          type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'post',
          caption: m.caption ?? '',
          thumbnail: m.thumbnail_url ?? m.media_url ?? null,
          permalink: m.permalink ?? '',
          timestamp: m.timestamp,
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          reach,
        };
      }));
    },
  };
}
