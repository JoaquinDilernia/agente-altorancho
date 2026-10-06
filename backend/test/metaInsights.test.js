// backend/test/metaInsights.test.js
import { describe, it, expect } from 'vitest';
import { parseInsightRow } from '../src/engine/metaInsights.js';

describe('parseInsightRow', () => {
  it('convierte strings a números y toma compras de "purchase"', () => {
    expect(parseInsightRow({
      ad_id: '1', adset_id: '2', campaign_id: '3', date_start: '2026-10-05', date_stop: '2026-10-05',
      spend: '1234.56', impressions: '1000', clicks: '20',
      actions: [{ action_type: 'link_click', value: '20' }, { action_type: 'purchase', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }],
      action_values: [{ action_type: 'purchase', value: '90000.5' }],
    })).toEqual({
      ad_id: '1', date: '2026-10-05', campaign_id: '3', adset_id: '2', spend: 1234.56, impressions: 1000, clicks: 20,
      meta_purchases: 3, meta_purchase_value: 90000.5,
    });
  });
  it('si no hay "purchase" usa el evento del píxel; sin acciones → 0', () => {
    expect(parseInsightRow({ ad_id: '1', date_start: '2026-10-05', spend: '0', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }] }))
      .toMatchObject({ meta_purchases: 2, meta_purchase_value: 0, impressions: 0, clicks: 0 });
  });
});
