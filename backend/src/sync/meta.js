import { parseInsightRow } from '../engine/metaInsights.js';
import { hasAttributionParams } from '../engine/urlTags.js';
import { artDate, addDays, monthRanges } from '../engine/dates.js';

const base = {
  thumbnail_url: null, url_tags: null, has_attribution_params: false,
  objective: null, daily_budget: null, is_cbo: false, created_time: null, learning_status: null, status_updated_at: null,
};
// Meta devuelve daily_budget en centavos (ARS, offset 100)
const pesos = (v) => (v === undefined || v === null || v === '' ? null : Number(v) / 100);

export function createMetaSync({ meta, metaRepo, ordersRepo }) {
  return {
    async syncCatalog() {
      const campaigns = await meta.listCampaigns();
      const adsets = await meta.listAdsets();
      const ads = await meta.listAds();
      const rows = [
        ...campaigns.map((c) => ({
          ...base, id: c.id, level: 'campaign', name: c.name, status: c.effective_status, parent_id: null, campaign_id: c.id,
          objective: c.objective || null, daily_budget: pesos(c.daily_budget), is_cbo: Boolean(c.daily_budget),
          created_time: c.created_time || null, status_updated_at: c.updated_time || null,
        })),
        ...adsets.map((s) => ({
          ...base, id: s.id, level: 'adset', name: s.name, status: s.effective_status, parent_id: s.campaign_id, campaign_id: s.campaign_id,
          daily_budget: pesos(s.daily_budget), created_time: s.created_time || null,
          learning_status: s.learning_stage_info?.status || null, status_updated_at: s.updated_time || null,
        })),
        ...ads.map((a) => ({
          ...base, id: a.id, level: 'ad', name: a.name, status: a.effective_status, parent_id: a.adset_id, campaign_id: a.campaign_id,
          thumbnail_url: a.creative?.thumbnail_url || null,
          url_tags: a.creative?.url_tags || null,
          has_attribution_params: hasAttributionParams(a.creative?.url_tags),
          created_time: a.created_time || null, status_updated_at: a.updated_time || null,
        })),
      ];
      await metaRepo.upsertAds(rows);
      await ordersRepo.resolveMetaIds();
      return rows.length;
    },
    async syncSpend(since, until) {
      const rows = (await meta.getDailyAdInsights(since, until)).map(parseInsightRow);
      await metaRepo.upsertSpend(rows);
      await ordersRepo.resolveMetaIds();
      return rows.length;
    },
    async backfillSpend({ days = 365, now = new Date(), onMonthDone = async () => {} } = {}) {
      const to = artDate(now);
      let total = 0;
      for (const { since, until } of monthRanges(addDays(to, -days), to)) {
        const rows = (await meta.getDailyAdInsightsAsync(since, until)).map(parseInsightRow);
        await metaRepo.upsertSpend(rows);
        total += rows.length;
        await onMonthDone(since.slice(0, 7), total);
      }
      await ordersRepo.resolveMetaIds();
      return total;
    },
  };
}
