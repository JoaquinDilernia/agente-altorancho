import { artDate, addDays } from '../engine/dates.js';
import { centsToArs, metaTotals, realMetrics, summarizeMetaRow } from './metrics.js';

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const LEVELS = ['campaign', 'adset', 'ad'];

function channelSummary(s) {
  return {
    orders: s.orders, revenue: Math.round(s.revenue),
    meta: { spend: Math.round(s.meta.spend), sales: s.meta.orders, revenue: Math.round(s.meta.revenue), roas: r1(s.meta.roas), metaPurchases: s.meta.reported.purchases },
    byChannel: s.channels.map((c) => ({ channel: c.channel, orders: c.orders, revenue: Math.round(c.revenue) })),
  };
}

// Foto de la cuenta: estructura en vivo de Meta + ventas reales de la tienda por campaña/conjunto/anuncio.
// La usan el Resumen del panel y el contexto del agente.
export async function buildSnapshot({ meta, reports, now = new Date() }) {
  const today = artDate(now);
  const w7 = { from: addDays(today, -6), to: today };
  const prev = { from: addDays(today, -13), to: addDays(today, -7) };
  const monthFrom = `${today.slice(0, 7)}-01`;
  const [campaigns, adsets, ads, todayRows, monthRows, adWeek, store7, storeMonth, ...ranks] = await Promise.all([
    meta.getCampaigns(),
    meta.getAdsets(),
    meta.getAds(),
    meta.getInsights('account', today, today),
    meta.getInsights('account', monthFrom, today),
    meta.getInsights('ad', w7.from, today),
    reports.summary(w7),
    reports.summary({ from: monthFrom, to: today }),
    ...LEVELS.flatMap((level) => [reports.adsRanking({ ...w7, level }), reports.adsRanking({ ...prev, level })]),
  ]);
  const real = {};
  LEVELS.forEach((level, i) => {
    real[level] = { w7: new Map(ranks[i * 2].rows.map((r) => [r.id, r])), prev: new Map(ranks[i * 2 + 1].rows.map((r) => [r.id, r])) };
  });
  const metaByAd = new Map(adWeek.map((r) => [r.ad_id, summarizeMetaRow(r)]));
  const windows = (level, id) => ({ last7d: realMetrics(real[level].w7.get(id)), prev7d: realMetrics(real[level].prev.get(id)) });

  const live = (o) => !['DELETED', 'ARCHIVED'].includes(o.effective_status);
  return {
    generatedAt: now.toISOString(),
    today,
    spendToday: metaTotals(todayRows).spend,
    month: { ...metaTotals(monthRows), store: channelSummary(storeMonth) },
    last7d: channelSummary(store7),
    campaigns: campaigns.filter(live).map((c) => ({
      id: c.id, name: c.name, objective: c.objective, status: c.status, effectiveStatus: c.effective_status,
      dailyBudgetArs: centsToArs(c.daily_budget), isCbo: c.daily_budget != null || c.lifetime_budget != null,
      bidStrategy: c.bid_strategy ?? null, createdAt: c.created_time, ...windows('campaign', c.id),
    })),
    adsets: adsets.filter(live).map((a) => ({
      id: a.id, name: a.name, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status,
      dailyBudgetArs: centsToArs(a.daily_budget), optimizationGoal: a.optimization_goal,
      learningStage: a.learning_stage_info?.status ?? null, targeting: a.targeting, createdAt: a.created_time,
      ...windows('adset', a.id),
    })),
    ads: ads.filter(live).map((a) => ({
      id: a.id, name: a.name, adsetId: a.adset_id, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status,
      createdAt: a.created_time, copy: a.creative?.body ?? null, thumbnail: a.creative?.thumbnail_url ?? null,
      ...windows('ad', a.id),
      delivery7d: metaByAd.get(a.id) ?? summarizeMetaRow(),
    })),
  };
}
