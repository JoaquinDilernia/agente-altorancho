import { describe, it, expect } from 'vitest';
import { attribute, extractParams, RULES_VERSION } from '../src/engine/attribution.js';

const NULL_UTM = { utm_campaign: null, utm_content: null, utm_medium: null, utm_source: null, utm_term: null };
const v = (landing, utm = NULL_UTM) => ({ landingUrl: landing, visitLandingPage: landing, visitUtm: utm });

describe('attribute — Meta', () => {
  it('#59431: UTMs con IDs → anuncio, conjunto y campaña', () => {
    const r = attribute(v('https://altorancho.com/productos/MSI027TP/?variant=1216127748&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_valordeconv_dpa_aon&utm_content=120248950422870142&utm_id=120226653113540142&utm_term=120242524693650142&fbclid=PAZX'));
    expect(r).toMatchObject({
      channel: 'meta', confidence: 'ad',
      ad_id: '120248950422870142', adset_id: '120242524693650142', campaign_id: '120226653113540142',
      campaign_name: 'altorancho_valordeconv_dpa_aon', rules_version: RULES_VERSION,
    });
  });
  it('#59439: solo nombre de campaña → confidence campaign sin IDs', () => {
    const r = attribute(v('https://altorancho.com/search/?q=reposera&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_eventos_aon&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', campaign_id: null, ad_id: null, campaign_name: 'altorancho_conversiones_eventos_aon' });
  });
  it('#59420: utm_content no numérico no se toma como anuncio', () => {
    const r = attribute(v('https://altorancho.com/productos/x/?utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_dpa_aon&utm_content=altorancho_conversiones_dpa_postevento&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', ad_id: null });
  });
  it('fbclid solo, sin UTMs → redes orgánicas (FB/IG agregan fbclid a cualquier link: bio, posteos, historias)', () => {
    expect(attribute(v('https://altorancho.com/?fbclid=PAZX'))).toMatchObject({ channel: 'social_organic', confidence: 'none' });
    expect(attribute(v('https://altorancho.com/?fbclid=PAZX&gclid=G1')).channel).toBe('google');
  });
  it('source facebook + medium paid también es Meta', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=facebook&utm_medium=paid&utm_campaign=x')).channel).toBe('meta');
  });
});

describe('attribute — Google', () => {
  it('#59459: gad_campaignid + gclid → Google con campaña', () => {
    const r = attribute(v('https://altorancho.com/?gad_source=1&gad_campaignid=11472612872&gbraid=0AAA&gclid=Cj0K'));
    expect(r).toMatchObject({ channel: 'google', confidence: 'campaign', campaign_id: '11472612872' });
  });
  it('#59427: gclid sin campaña → Google sin identificar', () => {
    expect(attribute(v('https://altorancho.com/productos/mmc011ne/?_gl=1*cpnl5r&gclid=CjwK&gbraid=0AAA'))).toMatchObject({ channel: 'google', confidence: 'none' });
  });
  it('#59457: TN guarda "gclid:…" dentro de utm_campaign y la landing no trae params', () => {
    const r = attribute(v('https://altorancho.com/productos/MEC011PT/?variant=1185074032', { ...NULL_UTM, utm_campaign: 'gclid:Cj0KCQjwuJLW' }));
    expect(r).toMatchObject({ channel: 'google', campaign_name: null });
  });
});

describe('attribute — resto de canales', () => {
  it('#59437: link en bio de IG → redes orgánicas (aunque traiga fbclid)', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZX')).channel).toBe('social_organic');
  });
  it('#59413: email de Perfit con espacios y | en la campaña', () => {
    const r = attribute(v('https://altorancho.com/?utm_source=perfit&utm_medium=email&utm_campaign=Productos en 12 cuotas | Fresh&pc=44369'));
    expect(r).toMatchObject({ channel: 'email', campaign_name: 'Productos en 12 cuotas | Fresh' });
  });
  it('#59461: home sin parámetros → orgánica', () => {
    expect(attribute(v('https://altorancho.com/')).channel).toBe('organic');
  });
  it('#59419: landing en checkout success sin params → orgánica', () => {
    expect(attribute(v('https://altorancho.com/checkout/v3/success/2084232794/34b8')).channel).toBe('organic');
  });
  it('#59425: sin customer_visit → unknown', () => {
    expect(attribute({ landingUrl: null, visitLandingPage: null, visitUtm: NULL_UTM })).toMatchObject({ channel: 'unknown', confidence: 'none' });
  });
  it('utm_source desconocido → other', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=tiktok&utm_medium=bio')).channel).toBe('other');
  });
  it('URL malformada o relativa no rompe', () => {
    expect(attribute(v('http://')).channel).toBe('organic');
    expect(attribute(v('/productos/x?utm_source=meta&utm_medium=cpc&utm_campaign=c1')).channel).toBe('meta');
  });
  it('source_raw guarda solo los parámetros relevantes', () => {
    const r = attribute(v('https://altorancho.com/?variant=1&gclid=abc&gad_campaignid=12345678'));
    expect(r.source_raw).toEqual({ gclid: 'abc', gad_campaignid: '12345678' });
  });
});

describe('extractParams', () => {
  it('la landing gana sobre utm_parameters; utm_parameters completa lo que falta', () => {
    const p = extractParams({
      landingUrl: null,
      visitLandingPage: 'https://altorancho.com/?utm_source=meta&UTM_MEDIUM=cpc',
      visitUtm: { utm_source: 'otro', utm_campaign: 'camp' },
    });
    expect(p).toMatchObject({ utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'camp' });
  });
});
