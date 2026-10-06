import { artDate, addDays } from '../engine/dates.js';

const THRESHOLD = 0.1;
const roasOf = (w) => (w.spend > 0 ? w.revenue / w.spend : null);
const sum = (a, b) => ({ spend: a.spend + b.spend, sales: a.sales + b.sales, revenue: a.revenue + b.revenue });

function judge(before, after) {
  const rb = roasOf(before);
  const ra = roasOf(after);
  if (rb === null || ra === null) return { change: null, verdict: 'neutral', nota: 'sin datos suficientes' };
  if (rb === 0) return { change: null, verdict: ra > 0 ? 'mejoro' : 'neutral' };
  const change = (ra - rb) / rb;
  return { change, verdict: change >= THRESHOLD ? 'mejoro' : change <= -THRESHOLD ? 'empeoro' : 'neutral' };
}

export function createOutcomeMeter({ db, recs, metrics, now = () => new Date() }) {
  async function campaignOf(id) {
    const { rows } = await db.query('SELECT campaign_id FROM meta_ads WHERE id = $1', [id]);
    return rows[0]?.campaign_id || null;
  }

  async function subject(rec, window) {
    if (rec.type === 'pause') {
      if (rec.level === 'campaign') return metrics.salesWindow(window);
      const campaignId = await campaignOf(rec.object_id);
      return campaignId ? metrics.objectWindow({ level: 'campaign', id: campaignId, ...window }) : { spend: 0, sales: 0, revenue: 0 };
    }
    if (rec.type === 'shift') {
      return sum(
        await metrics.objectWindow({ level: rec.level, id: rec.object_id, ...window }),
        await metrics.objectWindow({ level: rec.level, id: rec.target_id, ...window }),
      );
    }
    return metrics.objectWindow({ level: rec.level, id: rec.object_id, ...window });
  }

  return {
    async measure() {
      const yesterday = addDays(artDate(now()), -1);
      let measured = 0;
      for (const rec of await recs.toMeasure({ now: now().toISOString() })) {
        const d0 = artDate(rec.executed_at);
        const outcome = { ...(rec.outcome || {}) };
        let changed = false;
        for (const n of [3, 7]) {
          const key = `d${n}`;
          if (outcome[key] || addDays(d0, n) > yesterday) continue;
          const before = await subject(rec, { from: addDays(d0, -7), to: addDays(d0, -1) });
          const after = await subject(rec, { from: addDays(d0, 1), to: addDays(d0, n) });
          outcome[key] = { before, after, ...judge(before, after) };
          changed = true;
        }
        if (changed) {
          await recs.setOutcome(rec.id, outcome, (outcome.d7 || outcome.d3).verdict);
          measured += 1;
        }
      }
      return measured;
    },
  };
}
