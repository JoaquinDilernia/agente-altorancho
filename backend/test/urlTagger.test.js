import { describe, it, expect, vi } from 'vitest';
import { createUrlTagger } from '../src/sync/urlTagger.js';
import { URL_TAGS_TEMPLATE } from '../src/engine/urlTags.js';

const metaRepo = () => ({ markAdTags: vi.fn().mockResolvedValue() });

describe('urlTagger', () => {
  it('crea creativo copia con url_tags y lo asigna al anuncio', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockResolvedValue('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', name: 'Pieza', object_story_id: '448608595902716_1', url_tags: 'utm_source=fb' }),
      createCreative: vi.fn().mockResolvedValue({ id: 'CR2' }),
      updateAdCreative: vi.fn().mockResolvedValue({ success: true }),
    };
    const repo = metaRepo();
    const r = await createUrlTagger({ meta, metaRepo: repo }).apply(['A1']);
    expect(r).toEqual([{ adId: 'A1', status: 'applied', creativeId: 'CR2' }]);
    expect(meta.createCreative).toHaveBeenCalledWith({ name: 'Pieza [utm]', object_story_id: '448608595902716_1', url_tags: URL_TAGS_TEMPLATE });
    expect(meta.updateAdCreative).toHaveBeenCalledWith('A1', 'CR2');
    expect(repo.markAdTags).toHaveBeenCalledWith('A1', URL_TAGS_TEMPLATE);
  });
  it('si ya tiene la plantilla no toca el anuncio', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockResolvedValue('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', url_tags: URL_TAGS_TEMPLATE }),
      createCreative: vi.fn(), updateAdCreative: vi.fn(),
    };
    const r = await createUrlTagger({ meta, metaRepo: metaRepo() }).apply(['A1']);
    expect(r).toEqual([{ adId: 'A1', status: 'already' }]);
    expect(meta.createCreative).not.toHaveBeenCalled();
  });
  it('un anuncio que falla no frena los demás', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockRejectedValueOnce(new Error('Meta 100: no existe')).mockResolvedValueOnce('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', url_tags: URL_TAGS_TEMPLATE }),
      createCreative: vi.fn(), updateAdCreative: vi.fn(),
    };
    const r = await createUrlTagger({ meta, metaRepo: metaRepo(), log: { error: () => {} } }).apply(['A1', 'A2']);
    expect(r).toEqual([{ adId: 'A1', status: 'error', error: 'Meta 100: no existe' }, { adId: 'A2', status: 'already' }]);
  });
});
