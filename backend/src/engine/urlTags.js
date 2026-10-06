export const URL_TAGS_TEMPLATE = 'utm_source=meta&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}';

export const hasAttributionParams = (urlTags) => typeof urlTags === 'string' && urlTags.includes('utm_content={{ad.id}}');

// Conserva los parámetros que no son utm_* y agrega la plantilla (sin url-encodear las {{macros}}).
export function mergeUrlTags(existing) {
  const keep = (existing || '').split('&').filter((pair) => pair && !pair.toLowerCase().startsWith('utm_'));
  return [...keep, URL_TAGS_TEMPLATE].join('&');
}

// Campos del creativo que se copian al crear la versión con url_tags (el creativo de Meta es inmutable).
export const CREATIVE_COPY_FIELDS = ['object_story_spec', 'object_story_id', 'asset_feed_spec', 'degrees_of_freedom_spec',
  'product_set_id', 'template_url_spec', 'instagram_user_id', 'contextual_multi_ads'];

export function buildCreativeCopy(creative) {
  const spec = { name: `${creative.name || 'Creativo'} [utm]` };
  for (const f of CREATIVE_COPY_FIELDS) if (creative[f] !== undefined && creative[f] !== null) spec[f] = creative[f];
  spec.url_tags = mergeUrlTags(creative.url_tags);
  return spec;
}
