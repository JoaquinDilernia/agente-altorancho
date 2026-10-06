import { hasAttributionParams, buildCreativeCopy } from '../engine/urlTags.js';

// Los creativos de Meta son inmutables: para agregar url_tags se crea una copia y se asigna al anuncio.
// Esto manda el anuncio a revisión (el panel lo advierte antes de llamar).
export function createUrlTagger({ meta, metaRepo, log = console }) {
  async function applyOne(adId) {
    const creative = await meta.getCreative(await meta.getAdCreativeId(adId));
    if (hasAttributionParams(creative.url_tags)) {
      await metaRepo.markAdTags(adId, creative.url_tags);
      return { adId, status: 'already' };
    }
    const spec = buildCreativeCopy(creative);
    const { id } = await meta.createCreative(spec);
    await meta.updateAdCreative(adId, id);
    await metaRepo.markAdTags(adId, spec.url_tags);
    return { adId, status: 'applied', creativeId: id };
  }

  return {
    async apply(adIds) {
      const results = [];
      for (const adId of adIds) {
        try {
          results.push(await applyOne(adId));
        } catch (err) {
          log.error(`[url-tags] anuncio ${adId}:`, err);
          results.push({ adId, status: 'error', error: err.message });
        }
      }
      return results;
    },
  };
}
