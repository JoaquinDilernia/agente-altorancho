export const DEFAULT_CONFIG = {
  agentEnabled: true,
  executionEnabled: false,
  autoByType: { pause: false, reactivate: false, budget: false, shift: false },
  model: 'claude-opus-5-5',
  effort: 'medium',
  prices: { 'claude-opus-5-5': { input: 4, output: 20 }, 'claude-sonnet-5-5': { input: 2, output: 10 } },
  monthlyBudgetUsd: 20,
  manualRunsPerDay: 2,
  maxTurns: 8,
  maxOutputTokens: 16000,
  thresholds: {
    noSalesSpendMultiple: 2,
    noSalesForceMultiple: 4,
    expensiveRoasRatio: 0.5,
    expensiveSpendMultiple: 3,
    winnerRoasRatio: 1.5,
    winnerMinSales: 3,
    winnerTrendRatio: 0.8,
    fatigueCtrDrop: 0.3,
    fatigueMinImpressions: 5000,
    reactivateMinSales: 3,
    minAgeDays: 3,
    adLevelCoverage: 0.6,
    doubtfulMetaPurchases: 2,
    worsenRatio: 0.3,
    maxCandidates: 40,
  },
  budget: { maxChangePct: 20, minDaily: 1000, maxDaily: 5000000 },
  expireHours: 48,
  undoHours: 24,
  rejectCooldownDays: 7,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}

function validate(patch, merged) {
  const unknown = (obj, ref, path) => {
    for (const k of Object.keys(obj || {})) {
      if (!(k in ref)) throw badRequest(`campo desconocido: ${path}${k}`);
      if (isObj(obj[k]) && isObj(ref[k]) && k !== 'prices') unknown(obj[k], ref[k], `${path}${k}.`);
    }
  };
  unknown(patch, DEFAULT_CONFIG, '');
  const positive = (v, name) => { if (typeof v !== 'number' || !(v >= 0)) throw badRequest(`${name} tiene que ser un número ≥ 0`); };
  const intPositive = (v, name) => { if (!Number.isInteger(v) || v < 0) throw badRequest(`${name} tiene que ser un entero ≥ 0`); };
  for (const k of ['agentEnabled', 'executionEnabled']) if (typeof merged[k] !== 'boolean') throw badRequest(`${k} tiene que ser true/false`);
  for (const [k, v] of Object.entries(merged.autoByType)) if (typeof v !== 'boolean') throw badRequest(`autoByType.${k} inválido`);
  if (!merged.prices[merged.model]) throw badRequest(`modelo sin precio configurado: ${merged.model}`);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.effort)) throw badRequest('effort inválido');
  positive(merged.monthlyBudgetUsd, 'monthlyBudgetUsd');
  intPositive(merged.manualRunsPerDay, 'manualRunsPerDay');
  intPositive(merged.maxTurns, 'maxTurns');
  intPositive(merged.maxOutputTokens, 'maxOutputTokens');
  for (const [k, v] of Object.entries(merged.thresholds)) positive(v, `thresholds.${k}`);
  positive(merged.budget.minDaily, 'budget.minDaily');
  positive(merged.budget.maxDaily, 'budget.maxDaily');
  if (!(merged.budget.maxChangePct > 0 && merged.budget.maxChangePct <= 50)) throw badRequest('budget.maxChangePct tiene que estar entre 1 y 50');
  for (const k of ['expireHours', 'undoHours', 'rejectCooldownDays']) intPositive(merged[k], k);
}

export function createAgentConfigRepo(db) {
  async function get() {
    const { rows } = await db.query('SELECT value FROM agent_config WHERE id = 1');
    return merge(DEFAULT_CONFIG, rows[0]?.value || {});
  }
  return {
    get,
    async update(patch) {
      if (!isObj(patch)) throw badRequest('config inválida');
      const merged = merge(await get(), patch);
      validate(patch, merged);
      await db.query(
        `INSERT INTO agent_config (id, value, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(merged)],
      );
      return merged;
    },
  };
}
