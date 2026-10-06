import { bulkUpsert } from './bulk.js';

export function createGoogleRepo(db) {
  return {
    upsertCampaigns: (rows) => bulkUpsert(db, {
      table: 'google_campaigns', columns: ['id', 'name', 'status', 'channel_type'], conflict: ['id'], rows, extraSet: ['updated_at = now()'],
    }),
    upsertSpend: (rows) => bulkUpsert(db, {
      table: 'google_spend_daily',
      columns: ['campaign_id', 'date', 'spend', 'impressions', 'clicks', 'conversions', 'conversions_value'],
      conflict: ['campaign_id', 'date'], rows, extraSet: ['synced_at = now()'],
    }),
  };
}
