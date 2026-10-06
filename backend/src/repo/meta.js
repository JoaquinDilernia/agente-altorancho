import { bulkUpsert } from './bulk.js';

const AD_COLS = ['id', 'level', 'name', 'status', 'parent_id', 'campaign_id', 'thumbnail_url', 'url_tags', 'has_attribution_params'];
const SPEND_COLS = ['ad_id', 'date', 'campaign_id', 'adset_id', 'spend', 'impressions', 'clicks', 'meta_purchases', 'meta_purchase_value'];

export function createMetaRepo(db) {
  return {
    upsertAds: (rows) => bulkUpsert(db, { table: 'meta_ads', columns: AD_COLS, conflict: ['id'], rows, extraSet: ['updated_at = now()'] }),
    upsertSpend: (rows) => bulkUpsert(db, { table: 'meta_spend_daily', columns: SPEND_COLS, conflict: ['ad_id', 'date'], rows, extraSet: ['synced_at = now()'] }),
    async markAdTags(adId, urlTags) {
      await db.query('UPDATE meta_ads SET url_tags = $2, has_attribution_params = true, updated_at = now() WHERE id = $1', [adId, urlTags]);
    },
    async listAdsMissingParams() {
      const { rows } = await db.query(
        `SELECT a.id, a.name, a.status, c.name AS campaign_name
           FROM meta_ads a LEFT JOIN meta_ads c ON c.id = a.campaign_id
          WHERE a.level = 'ad' AND a.status = 'ACTIVE' AND NOT a.has_attribution_params
          ORDER BY c.name, a.name`,
      );
      return rows;
    },
  };
}
