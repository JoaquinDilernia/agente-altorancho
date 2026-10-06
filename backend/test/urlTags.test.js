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
