import { bulkUpsert } from './bulk.js';

export function createGoogleRepo(db) {
  return {
    upsertCampaigns: (rows) => bulkUpsert(db, {
      table: 'google_campaigns', columns: ['id', 'name', 'status', 'channel_type'], conflict: ['id'], rows, extraSet: ['updated_at = now()'],
    }),
    upsertSpend: (rows) => bulkUpsert(db, {
      table: 'google_spend_daily',
      columns: ['campaign_id', 'date', 'spend', 'impressions', 'clicks', 'conversions', 'conversions_value', 'purchases', 'purchases_value'],
      conflict: ['campaign_id', 'date'], extraSet: ['synced_at = now()'],
      rows: rows.map((r) => ({ purchases: 0, purchases_value: 0, ...r })),
    }),
    upsertEntities: (rows) => bulkUpsert(db, {
      table: 'google_entities', columns: ['id', 'campaign_id', 'type'], conflict: ['id'], rows, extraSet: ['updated_at = now()'],
    }),
    // ventas atribuidas a un grupo (gad_campaignid de PMax) pasan a su campaña
    async resolveCampaigns() {
      await db.query(
        `UPDATE order_attribution oa SET campaign_id = e.campaign_id
           FROM google_entities e WHERE oa.channel = 'google' AND oa.campaign_id = e.id`,
      );
    },
  };
}
