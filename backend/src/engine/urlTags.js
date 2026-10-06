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
// Campos que no sabemos copiar sin perder configuración: esos anuncios se editan a mano en Ads Manager.
export const UNSUPPORTED_FIELDS = ['platform_customizations', 'portrait_customizations', 'interactive_components_spec',
  'source_instagram_media_id', 'instagram_actor_id'];
export const CREATIVE_READ_FIELDS = ['name', 'url_tags', 'effective_object_story_id', ...CREATIVE_COPY_FIELDS, ...UNSUPPORTED_FIELDS];

const present = (v) => v !== undefined && v !== null;

export function buildCreativeCopy(creative) {
  const blocked = UNSUPPORTED_FIELDS.filter((f) => present(creative[f]));
  if (blocked.length) {
    throw new Error(`el creativo usa ${blocked.join(', ')}: agregá los parámetros de URL desde Ads Manager`);
  }
  const spec = { name: `${creative.name || 'Creativo'} [utm]` };
  if (present(creative.effective_object_story_id) && !present(creative.asset_feed_spec)) {
    // Reusar el post publicado conserva likes/comentarios y evita copiar el spec
    spec.object_story_id = creative.effective_object_story_id;
    if (present(creative.instagram_user_id)) spec.instagram_user_id = creative.instagram_user_id;
  } else {
    for (const f of CREATIVE_COPY_FIELDS) if (present(creative[f])) spec[f] = creative[f];
    // Meta rechaza object_story_id y object_story_spec juntos: si hay spec, va el spec
    if (present(spec.object_story_spec)) delete spec.object_story_id;
  }
  spec.url_tags = mergeUrlTags(creative.url_tags);
  return spec;
}
