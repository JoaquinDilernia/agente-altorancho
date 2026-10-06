// backend/test/urlTags.test.js
import { describe, it, expect } from 'vitest';
import { URL_TAGS_TEMPLATE, hasAttributionParams, mergeUrlTags, buildCreativeCopy } from '../src/engine/urlTags.js';

describe('urlTags', () => {
  it('detecta la plantilla', () => {
    expect(hasAttributionParams(URL_TAGS_TEMPLATE)).toBe(true);
    expect(hasAttributionParams('utm_source=meta&utm_campaign=x')).toBe(false);
    expect(hasAttributionParams(null)).toBe(false);
  });
  it('merge reemplaza utm_* existentes y conserva otros parámetros', () => {
    expect(mergeUrlTags('media_type=image&utm_source=fb&utm_campaign=viejo')).toBe(`media_type=image&${URL_TAGS_TEMPLATE}`);
    expect(mergeUrlTags(null)).toBe(URL_TAGS_TEMPLATE);
  });
  it('si el creativo tiene post publicado lo reusa (conserva likes y comentarios) y no manda el spec', () => {
    const spec = buildCreativeCopy({
      name: 'Pieza', url_tags: null, effective_object_story_id: '448608595902716_99',
      object_story_spec: { page_id: '448608595902716', link_data: { link: 'https://altorancho.com' } },
      instagram_user_id: '17841400000000000',
    });
    expect(spec).toEqual({
      name: 'Pieza [utm]', object_story_id: '448608595902716_99', instagram_user_id: '17841400000000000', url_tags: URL_TAGS_TEMPLATE,
    });
  });
  it('con asset_feed_spec no reusa el post: copia el spec y nunca manda object_story_id y spec juntos', () => {
    const spec = buildCreativeCopy({
      name: 'DPA', effective_object_story_id: '1_2', object_story_id: '1_2',
      object_story_spec: { page_id: '1' }, asset_feed_spec: { images: [] },
    });
    expect(spec.object_story_spec).toEqual({ page_id: '1' });
    expect(spec.asset_feed_spec).toEqual({ images: [] });
    expect(spec.object_story_id).toBeUndefined();
  });
  it('rechaza creativos con campos que no sabemos copiar (se editan en Ads Manager)', () => {
    expect(() => buildCreativeCopy({ name: 'Reel', object_story_spec: {}, platform_customizations: { instagram: {} } }))
      .toThrow(/Ads Manager/);
    expect(() => buildCreativeCopy({ name: 'IG', source_instagram_media_id: '123' })).toThrow(/Ads Manager/);
  });
  it('buildCreativeCopy copia solo los campos permitidos y pone los url_tags', () => {
    const spec = buildCreativeCopy({
      id: '1', name: 'Creativo', thumbnail_url: 'x', url_tags: 'utm_source=fb',
      object_story_spec: { page_id: '448608595902716', link_data: { link: 'https://altorancho.com' } },
      degrees_of_freedom_spec: { creative_features_spec: {} },
    });
    expect(spec).toEqual({
      name: 'Creativo [utm]',
      object_story_spec: { page_id: '448608595902716', link_data: { link: 'https://altorancho.com' } },
      degrees_of_freedom_spec: { creative_features_spec: {} },
      url_tags: URL_TAGS_TEMPLATE,
    });
  });
});
