import { URL_TAGS_TEMPLATE } from '../engine/urlTags.js';

// Spec de creative "clic a la tienda". Mismas reglas que uniformar:
//  - instagram_user_id (instagram_actor_id está deprecado desde Graph v22)
//  - sin mejoras de IA de Meta: opt-out función por función
//  - con pieza de historia: customización por ubicación (feed 4:5 / historia 9:16), image_label / video_label como objeto
// Diferencia con uniformar: el botón es "Comprar" con el link de la tienda, y todo creative lleva los url_tags
// de atribución (utm_content={{ad.id}}): así las ventas de Tienda Nube se atribuyen al anuncio desde el día uno.
const NO_AI_ENHANCEMENTS = {
  creative_features_spec: Object.fromEntries(
    [
      'image_brightness_and_contrast', 'enhance_cta', 'text_optimizations', 'image_touchups', 'image_uncrop',
      'inline_comment', 'adapt_to_placement', 'media_type_automation', 'description_automation',
      'add_text_overlay', 'image_animation', 'text_generation',
    ].map((f) => [f, { enroll_status: 'OPT_OUT' }]),
  ),
};

const POSITIONS = {
  feed: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream'] },
  story: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['story'], instagram_positions: ['story'] },
};
const cta = (link) => ({ type: 'SHOP_NOW', value: { link } });

// feed/story: { type: 'image', hash } | { type: 'video', videoId, thumbnailUrl }
export function buildLinkCreativeSpec({ name, pageId, igUserId, message, headline, link, feed, story }) {
  const identity = { page_id: pageId, ...(igUserId ? { instagram_user_id: igUserId } : {}) };
  const base = { name, url_tags: URL_TAGS_TEMPLATE, degrees_of_freedom_spec: NO_AI_ENHANCEMENTS };
  if (!story) {
    const data = feed.type === 'image'
      ? { link_data: { link, message, ...(headline ? { name: headline } : {}), image_hash: feed.hash, call_to_action: cta(link) } }
      : { video_data: { video_id: feed.videoId, image_url: feed.thumbnailUrl, message, ...(headline ? { title: headline } : {}), call_to_action: cta(link) } };
    return { ...base, object_story_spec: { ...identity, ...data } };
  }

  const images = [];
  const videos = [];
  const rule = (media, label) => {
    if (media.type === 'image') {
      images.push({ hash: media.hash, adlabels: [{ name: label }] });
      return { customization_spec: POSITIONS[label], image_label: { name: label } };
    }
    videos.push({ video_id: media.videoId, thumbnail_url: media.thumbnailUrl, adlabels: [{ name: label }] });
    return { customization_spec: POSITIONS[label], video_label: { name: label } };
  };
  const rules = [rule(feed, 'feed'), rule(story, 'story')];
  const format = feed.type !== story.type ? 'AUTOMATIC_FORMAT' : feed.type === 'image' ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO';
  return {
    ...base,
    object_story_spec: identity,
    asset_feed_spec: {
      ...(images.length ? { images } : {}),
      ...(videos.length ? { videos } : {}),
      bodies: [{ text: message }],
      titles: [{ text: headline || name }],
      link_urls: [{ website_url: link }],
      ad_formats: [format],
      call_to_action_types: ['SHOP_NOW'],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    },
  };
}

const clean = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

// Convención de nombres: {CONJUNTO}_{PIEZA}_{YYYYMMDD}
export function buildAdName({ adsetName, creativeName, date }) {
  const tag = clean(adsetName).replace(/\d{8}$/, '').slice(0, 30) || 'CONJUNTO';
  return `${tag}_${clean(creativeName).slice(0, 30)}_${date.replaceAll('-', '')}`;
}

export const IG_ACCESS_MSG = 'La cuenta publicitaria no tiene acceso a la cuenta de Instagram: asignala en el Business Manager (Configuración del negocio → Cuentas de Instagram → Activos conectados).';

// Promocionar un post/reel que ya está en Instagram: el anuncio usa el post original (suma likes y comentarios)
// y le agrega el botón "Comprar" con el link de la tienda. El texto es el del post.
export function buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link }) {
  return {
    name,
    object_id: pageId,
    instagram_user_id: igUserId,
    source_instagram_media_id: mediaId,
    call_to_action: cta(link),
    url_tags: URL_TAGS_TEMPLATE,
    degrees_of_freedom_spec: NO_AI_ENHANCEMENTS,
  };
}
