// Fila de /insights (level=ad, time_increment=1) → fila de meta_spend_daily.
const PURCHASE_TYPES = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

function pickPurchase(list) {
  for (const type of PURCHASE_TYPES) {
    const hit = (list || []).find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function parseInsightRow(row) {
  return {
    ad_id: String(row.ad_id),
    date: row.date_start,
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    adset_id: row.adset_id ? String(row.adset_id) : null,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    meta_purchases: pickPurchase(row.actions),
    meta_purchase_value: pickPurchase(row.action_values),
  };
}
