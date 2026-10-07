// Reglas de atribución de una orden de Tienda Nube a partir de su customer_visit.
// Puro: no toca la DB. Los IDs faltantes se completan después con ordersRepo.resolveMetaIds().
export const RULES_VERSION = 2;

const META_SOURCES = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig']);
const PAID_MEDIUMS = new Set(['cpc', 'paid', 'paid_social', 'paidsocial', 'ads']);
const SOCIAL_MEDIUMS = new Set(['social', 'organic_social']);
const GOOGLE_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'gad_campaignid'];
const RAW_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_campaignid'];

const numericId = (v) => (typeof v === 'string' && /^\d{6,}$/.test(v) ? v : null);

function paramsFromUrl(u) {
  if (!u) return {};
  try {
    const out = {};
    for (const [k, val] of new URL(u, 'https://placeholder.invalid').searchParams) out[k.toLowerCase()] = val;
    return out;
  } catch {
    return {};
  }
}

export function extractParams({ landingUrl, visitLandingPage, visitUtm }) {
  const p = { ...paramsFromUrl(landingUrl), ...paramsFromUrl(visitLandingPage) };
  for (const [k, val] of Object.entries(visitUtm || {})) {
    if (val && !p[k]) p[k] = String(val);
  }
  // Quirk de TN: a veces guarda "gclid:XXXX" dentro de utm_campaign
  if (p.utm_campaign && p.utm_campaign.startsWith('gclid:')) {
    if (!p.gclid) p.gclid = p.utm_campaign.slice('gclid:'.length);
    delete p.utm_campaign;
  }
  return p;
}

export function attribute(visit) {
  const p = extractParams(visit);
  const raw = Object.fromEntries(RAW_KEYS.filter((k) => p[k]).map((k) => [k, p[k]]));
  const result = (channel, confidence = 'none', extra = {}) => ({
    channel, confidence, campaign_id: null, adset_id: null, ad_id: null, campaign_name: null,
    source_raw: raw, rules_version: RULES_VERSION, ...extra,
  });
  const hasVisit = Boolean(visit.visitLandingPage || visit.landingUrl);
  const src = (p.utm_source || '').toLowerCase();
  const med = (p.utm_medium || '').toLowerCase();

  const isMeta = (META_SOURCES.has(src) && PAID_MEDIUMS.has(med))
    || (p.fbclid && p.utm_campaign && !SOCIAL_MEDIUMS.has(med) && med !== 'email');
  if (isMeta) {
    const ad_id = numericId(p.utm_content);
    const adset_id = numericId(p.utm_term);
    const campaign_id = numericId(p.utm_id) || numericId(p.utm_campaign);
    const campaign_name = p.utm_campaign && !numericId(p.utm_campaign) ? p.utm_campaign.trim() : null;
    const confidence = ad_id ? 'ad' : (campaign_id || campaign_name) ? 'campaign' : 'none';
    return result('meta', confidence, { ad_id, adset_id, campaign_id, campaign_name });
  }
  if (GOOGLE_CLICK_IDS.some((k) => p[k]) || (src === 'google' && PAID_MEDIUMS.has(med))) {
    const campaign_id = numericId(p.gad_campaignid);
    return result('google', campaign_id ? 'campaign' : 'none', { campaign_id, campaign_name: p.utm_campaign || null });
  }
  if (med === 'email') return result('email', 'none', { campaign_name: p.utm_campaign || null });
  // fbclid sin UTMs: FB/IG lo agregan a cualquier link (bio, posteos, historias), no prueba un anuncio
  if (SOCIAL_MEDIUMS.has(med) || META_SOURCES.has(src) || (p.fbclid && !src && !med)) return result('social_organic');
  if (src) return result('other', 'none', { campaign_name: p.utm_campaign || null });
  return hasVisit ? result('organic') : result('unknown');
}
