import { PAID, RANGE } from './reports.js';

export const SALES_OBJECTIVES = ['OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES'];
const KEY = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const ratio = (a, b) => (b > 0 ? a / b : null);

export function withRatios(m) {
  return { ...m, roas: ratio(m.revenue, m.spend), cpa: m.sales > 0 ? m.spend / m.sales : null, ctr: ratio(m.clicks, m.impressions) };
}

export function createAgentMetrics({ db, reports }) {
  return {
    async byLevel({ level, from, to }) {
      const { rows } = await reports.adsRanking({ from, to, level });
      return new Map(rows.map((r) => [r.id, {
        spend: r.spend, impressions: r.impressions, clicks: r.clicks, sales: r.sales, revenue: r.revenue,
        metaPurchases: r.metaPurchases, metaValue: r.metaValue,
      }]));
    },
    async coverageByCampaign({ from, to }) {
      const { rows } = await db.query(
        `SELECT a.campaign_id AS id, (count(*) FILTER (WHERE a.confidence = 'ad'))::int AS ad, count(*)::int AS total
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.campaign_id IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)}
          GROUP BY 1`,
        [from, to],
      );
      return new Map(rows.map((r) => [r.id, r.ad / r.total]));
    },
    async objectWindow({ level, id, from, to }) {
      const key = KEY[level];
      if (!key) throw new Error(`level inválido: ${level}`);
      const { rows: [r] } = await db.query(
        `SELECT
           (SELECT COALESCE(sum(spend), 0) FROM meta_spend_daily WHERE ${key} = $1 AND date BETWEEN $2::date AND $3::date)::float8 AS spend,
           (SELECT count(*) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.${key} = $1 AND ${PAID} AND ${RANGE(2, 3)})::int AS sales,
           (SELECT COALESCE(sum(o.total), 0) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.${key} = $1 AND ${PAID} AND ${RANGE(2, 3)})::float8 AS revenue`,
        [id, from, to],
      );
      return r;
    },
    async salesWindow({ from, to }) {
      const { rows: [r] } = await db.query(
        `WITH c AS (SELECT id FROM meta_ads WHERE level = 'campaign' AND objective = ANY($3::text[]))
         SELECT
           (SELECT COALESCE(sum(spend), 0) FROM meta_spend_daily
             WHERE date BETWEEN $1::date AND $2::date AND campaign_id IN (SELECT id FROM c))::float8 AS spend,
           (SELECT count(*) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.channel = 'meta' AND a.campaign_id IN (SELECT id FROM c) AND ${PAID} AND ${RANGE(1, 2)})::int AS sales,
           (SELECT COALESCE(sum(o.total), 0) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.channel = 'meta' AND a.campaign_id IN (SELECT id FROM c) AND ${PAID} AND ${RANGE(1, 2)})::float8 AS revenue`,
        [from, to, SALES_OBJECTIVES],
      );
      return r;
    },
    async baseline(window) {
      const w = await this.salesWindow(window);
      return { ...w, roas: ratio(w.revenue, w.spend), cpa: w.sales > 0 ? w.spend / w.sales : null };
    },
  };
}
