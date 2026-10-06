// Detección de candidatos con números duros. Pura: no toca DB ni APIs.
const DAY = 86400000;

function worsened(now, snap, w) {
  if (snap.roas && now.roas !== null) return now.roas <= snap.roas * (1 - w);
  return now.spend >= snap.spend * (1 + w);
}

function blockedIds(recent, byId, config, nowMs) {
  const blocked = new Set();
  const cooldown = config.rejectCooldownDays * DAY;
  for (const r of recent) {
    const ids = [r.object_id, r.target_id].filter(Boolean);
    const decided = new Date(r.decided_at || r.created_at || 0).getTime(); // acepta Date (pg) o string
    const withinCooldown = nowMs - decided < cooldown;
    for (const id of ids) {
      if (['pending', 'approved'].includes(r.status)) blocked.add(id);
      else if (['executed', 'undone'].includes(r.status) && withinCooldown) blocked.add(id);
      else if (r.status === 'rejected' && withinCooldown) {
        const o = byId.get(id);
        const snap = r.snapshot?.m7;
        if (!o || !snap || !worsened(o.m7, snap, config.thresholds.worsenRatio)) blocked.add(id);
      }
    }
  }
  return blocked;
}

function candidate(signal, o, suggested, doubtful = false) {
  return {
    key: `${signal}:${o.id}`, signal, level: o.level, objectId: o.id, name: o.name, campaignId: o.campaignId, parentId: o.parentId,
    suggested, doubtful, ageDays: o.ageDays, learning: o.learning, coverage: o.coverage,
    budget: o.budgetOwner?.daily ?? null, status: o.status, metrics: { m7: o.m7, mPrev: o.mPrev, m30: o.m30 },
  };
}

const spendOf = (c) => (c.signal === 'reasignar' ? c.metrics.from.m7.spend : c.metrics.m7.spend);

export function detectCandidates({ dataset, config, recent = [] }) {
  const t = config.thresholds;
  const { baseline, objects, today } = dataset;
  if (!baseline?.roas || !baseline?.cpa) return [];
  const nowMs = Date.parse(`${today}T03:00:00Z`);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const blocked = blockedIds(recent, byId, config, nowMs);

  const levelOk = (o) => o.level === 'campaign' || (o.coverage !== null && o.coverage >= t.adLevelCoverage);
  const mature = (o) => (o.ageDays === null || o.ageDays >= t.minAgeDays) && !o.learning;
  const found = [];

  for (const o of objects) {
    if (!o.isSales || !levelOk(o) || blocked.has(o.id)) continue;
    const m = o.m7;
    if (o.status === 'ACTIVE') {
      const noSales = m.sales === 0 && m.spend >= t.noSalesSpendMultiple * baseline.cpa;
      if (noSales && (mature(o) || m.spend >= t.noSalesForceMultiple * baseline.cpa)) {
        found.push(candidate('gasta_sin_vender', o, 'pause', m.metaPurchases >= t.doubtfulMetaPurchases));
        continue;
      }
      if (!mature(o)) continue;
      const ownsBudget = o.budgetOwner?.id === o.id;
      if (m.sales > 0 && m.roas < t.expensiveRoasRatio * baseline.roas && m.spend >= t.expensiveSpendMultiple * baseline.cpa) {
        found.push(candidate('caro', o, ownsBudget ? 'budget_down' : 'pause'));
        continue;
      }
      if (ownsBudget && m.roas !== null && m.roas >= t.winnerRoasRatio * baseline.roas && m.sales >= t.winnerMinSales
        && (o.mPrev.roas === null || m.roas >= t.winnerTrendRatio * o.mPrev.roas)) {
        found.push(candidate('ganador', o, 'budget_up'));
        continue;
      }
      if (o.level === 'ad' && m.impressions >= t.fatigueMinImpressions && o.mPrev.ctr && m.ctr !== null
        && m.ctr < (1 - t.fatigueCtrDrop) * o.mPrev.ctr) {
        found.push(candidate('fatiga', o, 'idea'));
      }
    } else if (o.status === 'PAUSED') {
      const pausedAt = o.statusUpdatedAt ? Date.parse(o.statusUpdatedAt) : null;
      if (pausedAt && nowMs - pausedAt <= 30 * DAY && o.m30.sales >= t.reactivateMinSales && o.m30.roas >= baseline.roas) {
        found.push(candidate('pausado_que_vendia', o, 'reactivate'));
      }
    }
  }

  // Un padre que gasta sin vender tapa a sus hijos con la misma señal
  const noSalesIds = new Set(found.filter((c) => c.signal === 'gasta_sin_vender').map((c) => c.objectId));
  const out = found.filter((c) => !(c.signal === 'gasta_sin_vender' && c.level !== 'campaign'
    && (noSalesIds.has(c.campaignId) || noSalesIds.has(c.parentId))));

  // Reasignación: el caro con peor ROAS con el mejor ganador del mismo nivel (cada uno se usa una vez)
  const caros = out.filter((c) => c.signal === 'caro' && c.suggested === 'budget_down').sort((a, b) => a.metrics.m7.roas - b.metrics.m7.roas);
  const ganadores = out.filter((c) => c.signal === 'ganador').sort((a, b) => b.metrics.m7.roas - a.metrics.m7.roas);
  const used = new Set();
  for (const c of caros) {
    const g = ganadores.find((x) => x.level === c.level && !used.has(x.objectId));
    if (!g) continue;
    used.add(g.objectId);
    out.push({
      key: `reasignar:${c.objectId}>${g.objectId}`, signal: 'reasignar', level: c.level, objectId: c.objectId, targetId: g.objectId,
      name: `${c.name} → ${g.name}`, campaignId: c.campaignId, parentId: c.parentId, suggested: 'shift', doubtful: false,
      ageDays: null, learning: false, coverage: null, status: 'ACTIVE',
      budget: { from: c.budget, to: g.budget }, metrics: { from: c.metrics, to: g.metrics },
    });
  }
  return out.sort((a, b) => spendOf(b) - spendOf(a)).slice(0, t.maxCandidates);
}
