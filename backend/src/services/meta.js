import { CREATIVE_READ_FIELDS } from '../engine/urlTags.js';

const V = 'v23.0';
const RETRYABLE = new Set([4, 17, 32, 613, 80004]); // rate limits de Graph API / Marketing API
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSIGHT_FIELDS = 'ad_id,adset_id,campaign_id,spend,impressions,clicks,actions,action_values,date_start';

export function createMetaClient({ accessToken, accountId, fetchFn = fetch, sleep = defaultSleep, maxRetries = 4, pollMs = 3000 }) {
  const BASE = `https://graph.facebook.com/${V}`;

  async function reqOnce(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await fetchFn(url.toString(), {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
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
  };
}
