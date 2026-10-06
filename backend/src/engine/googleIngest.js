import { isYmd } from './dates.js';

const MAX_ROWS = 20000;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (v) => /^\d+$/.test(String(v ?? ''));
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} inválido`);
  return n;
};
const text = (v, max = 300) => (v === null || v === undefined ? null : String(v).slice(0, max));

export function parseGooglePayload(body) {
  if (!body || !Array.isArray(body.rows) || !Array.isArray(body.campaigns)) throw bad('payload inválido: faltan rows/campaigns');
  if (body.rows.length > MAX_ROWS) throw bad(`demasiadas filas (máx. ${MAX_ROWS})`);
  const campaigns = body.campaigns.map((c) => {
    if (!isId(c?.id)) throw bad('campaign id inválido');
    return { id: String(c.id), name: text(c.name), status: text(c.status, 40), channel_type: text(c.channel_type, 40) };
  });
  const spend = body.rows.map((r) => {
    if (!isId(r?.campaign_id)) throw bad('campaign_id inválido');
    if (!isYmd(r.date)) throw bad(`fecha inválida: ${r.date}`);
    return {
      campaign_id: String(r.campaign_id),
      date: r.date,
      spend: Math.round(num(r.cost_micros, 'cost_micros') / 1e4) / 100,
      impressions: Math.round(num(r.impressions, 'impressions')),
      clicks: Math.round(num(r.clicks, 'clicks')),
      conversions: num(r.conversions, 'conversions'),
      conversions_value: num(r.conversions_value, 'conversions_value'),
    };
  });
  return { campaigns, spend };
}
