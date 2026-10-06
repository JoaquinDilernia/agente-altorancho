// Aplica en Meta las recomendaciones aprobadas. Nunca pisa un cambio manual: pre-chequea el estado actual.
const err = (status, msg) => Object.assign(new Error(msg), { status });

function adjust(rec, amount, config) {
  const pct = config.budget.maxChangePct / 100;
  const inRange = (v) => v >= config.budget.minDaily && v <= config.budget.maxDaily;
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw err(400, 'monto inválido');
  if (rec.type === 'budget') {
    const cur = rec.current_value.daily_budget;
    const up = rec.proposed_value.daily_budget > cur;
    if (up ? value <= cur : value >= cur) throw err(400, up ? 'el ajuste tiene que seguir subiendo el presupuesto' : 'el ajuste tiene que seguir bajando el presupuesto');
    if (Math.abs(value - cur) / cur > pct + 1e-9) throw err(400, `el cambio supera el tope de ±${config.budget.maxChangePct}%`);
    if (!inRange(value)) throw err(400, 'presupuesto fuera de los mínimos/máximos');
    return { daily_budget: value };
  }
  if (rec.type === 'shift') {
    const { from, to } = rec.current_value;
    if (value > from * pct + 1e-9 || value > to * pct + 1e-9) throw err(400, `el monto supera el tope de ${config.budget.maxChangePct}%`);
    if (!inRange(from - value) || !inRange(to + value)) throw err(400, 'algún presupuesto queda fuera de los mínimos/máximos');
    return { from: from - value, to: to + value };
  }
  throw err(400, 'este tipo de recomendación no admite monto');
}

export function createExecutor({ meta, recs, configRepo, now = () => new Date(), log = console }) {
  const budgetOf = async (id) => Number((await meta.getObject(id, 'daily_budget')).daily_budget) / 100;

  async function readState(rec) {
    if (rec.type === 'pause' || rec.type === 'reactivate') return { status: (await meta.getObject(rec.object_id, 'status')).status };
    if (rec.type === 'budget') return { daily_budget: await budgetOf(rec.object_id) };
    return { from: await budgetOf(rec.object_id), to: await budgetOf(rec.target_id) };
  }

  function sameState(type, expected, actual) {
    if (type === 'pause' || type === 'reactivate') return expected.status === actual.status;
    const close = (a, b) => Math.abs(a - b) < 1;
    if (type === 'budget') return close(expected.daily_budget, actual.daily_budget);
    return close(expected.from, actual.from) && close(expected.to, actual.to);
  }

  // revertTo: valores para deshacer la primera escritura de una reasignación si falla la segunda
  async function apply(rec, values, revertTo) {
    if (rec.type === 'pause' || rec.type === 'reactivate') return meta.setStatus(rec.object_id, values.status);
    if (rec.type === 'budget') return meta.setDailyBudget(rec.object_id, values.daily_budget);
    await meta.setDailyBudget(rec.object_id, values.from);
    try {
      await meta.setDailyBudget(rec.target_id, values.to);
    } catch (e) {
      try {
        await meta.setDailyBudget(rec.object_id, revertTo.from);
      } catch (revertErr) {
        log.error(`[executor] no se pudo revertir la reasignación #${rec.id}:`, revertErr);
      }
      throw e;
    }
    return undefined;
  }

  async function load(id) {
    const rec = await recs.get(id);
    if (!rec) throw err(404, 'recomendación no encontrada');
    return rec;
  }

  const fail = async (id, e) => {
    await recs.transition(id, ['approved'], 'failed', { execution_result: { error: e.message } });
    return { status: 'failed', error: e.message };
  };

  return {
    async approve(id, { amount } = {}) {
      const rec = await load(id);
      if (rec.type === 'idea') throw err(400, 'las ideas no se aprueban');
      if (rec.status !== 'pending') throw err(409, `la recomendación ya está ${rec.status}`);
      const config = await configRepo.get();
      const proposed = amount === undefined || amount === null ? rec.proposed_value : adjust(rec, amount, config);
      const claimed = await recs.transition(id, ['pending'], 'approved', { decided_at: now().toISOString(), proposed_value: proposed });
      if (!claimed) throw err(409, 'la recomendación ya fue resuelta');
      if (!config.executionEnabled) return { status: 'approved' };

      let actual;
      try {
        actual = await readState(rec);
      } catch (e) {
        return fail(id, e);
      }
      if (!sameState(rec.type, rec.current_value, actual)) {
        await recs.transition(id, ['approved'], 'stale', { execution_result: { reason: 'cambió en Meta desde la recomendación', actual } });
        return { status: 'stale' };
      }
      try {
        await apply(rec, proposed, rec.current_value);
      } catch (e) {
        return fail(id, e);
      }
      await recs.transition(id, ['approved'], 'executed', {
        executed_at: now().toISOString(),
        previous_value: rec.current_value,
        undo_until: new Date(now().getTime() + config.undoHours * 3600e3).toISOString(),
        execution_result: { applied: proposed },
      });
      return { status: 'executed' };
    },

    async reject(id, reason) {
      await load(id);
      const ok = await recs.transition(id, ['pending'], 'rejected', { decided_at: now().toISOString(), reject_reason: reason || null });
      if (!ok) throw err(409, 'la recomendación ya fue resuelta');
    },

    async markSeen(id) {
      const rec = await load(id);
      if (rec.type !== 'idea') throw err(400, 'solo las ideas se marcan como vistas');
      if (!(await recs.transition(id, ['pending'], 'seen', { decided_at: now().toISOString() }))) throw err(409, 'ya fue marcada');
    },

    async undo(id) {
      const rec = await load(id);
      if (rec.status !== 'executed' || rec.undone_at || !rec.undo_until || new Date(rec.undo_until) <= now()) {
        throw err(409, 'esta acción ya no se puede deshacer');
      }
      const applied = rec.execution_result?.applied || rec.proposed_value;
      await apply(rec, rec.previous_value, applied);
      if (!(await recs.transition(id, ['executed'], 'undone', { undone_at: now().toISOString() }))) throw err(409, 'ya fue deshecha');
      return { status: 'undone' };
    },

    async expire() {
      const config = await configRepo.get();
      return recs.expire({ now: now().toISOString(), hours: config.expireHours });
    },
  };
}
