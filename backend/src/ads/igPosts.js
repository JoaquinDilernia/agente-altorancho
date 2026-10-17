// Posts de IG con dónde ya se promocionaron (lo usan el panel y el contexto del agente)
export async function loadIgPosts({ meta, repo, igUserId }) {
  const [posts, promos] = await Promise.all([meta.getIgMedia(igUserId), repo.listIgPromotions()]);
  return posts.map((p) => ({
    ...p,
    promotedIn: promos
      .filter((x) => x.ig_media_id === p.id)
      .map((x) => ({ adset_id: x.meta_adset_id, adset_name: x.adset_name, ad_id: x.meta_ad_id, created_at: x.created_at })),
  }));
}
