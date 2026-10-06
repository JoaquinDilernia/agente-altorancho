import { addDays } from '../engine/dates.js';
import { SALES_OBJECTIVES, withRatios } from '../repo/agentMetrics.js';

const EMPTY = { spend: 0, impressions: 0, clicks: 0, sales: 0, revenue: 0, metaPurchases: 0, metaValue: 0 };
const DAY_MS = 86400000;

function budgetOwner(r) {
  if (r.level === 'campaign') return r.is_cbo && r.daily_budget ? { id: r.id, level: 'campaign', daily: r.daily_budget } : null;
  if (r.level === 'adset') return !r.campaign_is_cbo && r.daily_budget ? { id: r.id, level: 'adset', daily: r.daily_budget } : null;
  return null;
}

export async function buildDataset({ db, metrics, today }) {
  const w7 = { from: addDays(today, -7), to: addDays(today, -1) };
  const wp = { from: addDays(today, -14), to: addDays(today, -8) };
  const w30 = { from: addDays(today, -30), to: addDays(today, -1) };
  const baseline = await metrics.baseline(w30);
  const coverage = await metrics.coverageByCampaign(w30);

  const { rows } = await db.query(
    `SELECT a.id, a.level, a.name, a.status, a.parent_id, a.campaign_id, a.daily_budget::float8 AS daily_budget, a.is_cbo,
            a.created_time, a.learning_status, a.status_updated_at,
            c.objective AS campaign_objective, c.is_cbo AS campaign_is_cbo, s.learning_status AS adset_learning
       FROM meta_ads a
       LEFT JOIN meta_ads c ON c.id = a.campaign_id AND c.level = 'campaign'
       LEFT JOIN meta_ads s ON s.id = a.parent_id AND s.level = 'adset'
      WHERE a.status IN ('ACTIVE', 'PAUSED')`,
  );

  const windows = {};
  for (const level of ['campaign', 'adset', 'ad']) {
    windows[level] = {
      m7: await metrics.byLevel({ level, ...w7 }),
      mPrev: await metrics.byLevel({ level, ...wp }),
      m30: await metrics.byLevel({ level, ...w30 }),
    };
  }
  const todayMs = Date.parse(`${today}T03:00:00Z`); // 00:00 ART

  const objects = rows.map((r) => {
    const w = windows[r.level];
    const learningStatus = r.level === 'ad' ? r.adset_learning : r.level === 'adset' ? r.learning_status : null;
    return {
      id: r.id,
      level: r.level,
      name: r.name,
      status: r.status,
      campaignId: r.campaign_id,
      parentId: r.parent_id,
      objective: r.campaign_objective,
      isSales: SALES_OBJECTIVES.includes(r.campaign_objective),
      ageDays: r.created_time ? Math.floor((todayMs - new Date(r.created_time).getTime()) / DAY_MS) : null,
      learning: learningStatus === 'LEARNING',
      statusUpdatedAt: r.status_updated_at ? new Date(r.status_updated_at).toISOString() : null,
      budgetOwner: budgetOwner(r),
      coverage: coverage.has(r.campaign_id) ? coverage.get(r.campaign_id) : null,
      m7: withRatios(w.m7.get(r.id) || EMPTY),
      mPrev: withRatios(w.mPrev.get(r.id) || EMPTY),
      m30: withRatios(w.m30.get(r.id) || EMPTY),
    };
  });
  return { today, windows: { w7, wp, w30 }, baseline, objects };
}
