// Tools del agente: SOLO crean registros (recomendaciones, ideas, descartes, lecciones). Nunca ejecutan en Meta.
const str = { type: 'string' };
const COMMON = { titulo: str, razonamiento: str, impacto_esperado: str, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] } };
const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tool = (name, description, properties) => ({ name, description, strict: true, input_schema: schema(properties) });

export const TOOLS = [
  tool('recomendar_pausa', 'Recomienda pausar el objeto de un candidato con señal gasta_sin_vender o caro.', { candidato: str, ...COMMON }),
  tool('recomendar_reactivacion', 'Recomienda reactivar un objeto pausado (señal pausado_que_vendia).', { candidato: str, ...COMMON }),
  tool('recomendar_presupuesto', 'Recomienda un nuevo presupuesto diario en pesos: subir a un ganador o bajar a un caro con presupuesto propio. Respetá el tope de cambio.',
    { candidato: str, presupuesto_nuevo: { type: 'number' }, ...COMMON }),
  tool('recomendar_reasignacion', 'Recomienda mover un monto diario en pesos del objeto caro al ganador (señal reasignar).',
    { candidato: str, monto_diario: { type: 'number' }, ...COMMON }),
  tool('registrar_idea', 'Registra una idea sin acción directa (ej. renovar creativo). candidato puede ser "" si no aplica a uno.',
    { candidato: str, titulo: str, detalle: str }),
  tool('descartar_candidato', 'Deja registrado por qué un candidato no merece acción ahora.', { candidato: str, motivo: str }),
  tool('guardar_leccion', 'Guarda una lección aprendida. Requiere al menos 3 ids de recomendaciones con resultado medido.',
    { texto: str, evidencia_ids: { type: 'array', items: { type: 'integer' } } }),
];

const ACTION_SIGNALS = {
  recomendar_pausa: ['gasta_sin_vender', 'caro'],
  recomendar_reactivacion: ['pausado_que_vendia'],
  recomendar_presupuesto: ['ganador', 'caro'],
  recomendar_reasignacion: ['reasignar'],
};

export function createToolHandler({ runId, candidates, recs, learnings, config }) {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const handled = new Set();
  const skipped = [];
  const created = [];
  const fail = (msg) => ({ content: `Error: ${msg}`, isError: true });
  const ok = (msg) => ({ content: msg, isError: false });
  const maxPct = config.budget.maxChangePct / 100;

  function take(key, signals) {
    const c = byKey.get(key);
    if (!c) return { error: `candidato inexistente: ${key}` };
    if (handled.has(key)) return { error: `el candidato ${key} ya fue resuelto` };
    if (signals && !signals.includes(c.signal)) return { error: `esa acción no corresponde a la señal ${c.signal}` };
    return { c };
  }

  const baseRec = (c, input, type) => ({
    run_id: runId, type, level: c.level, object_id: c.objectId, target_id: c.targetId ?? null,
    title: input.titulo, reasoning: input.razonamiento, expected_impact: input.impacto_esperado,
    confidence: c.doubtful ? 'baja' : input.confianza, dudoso_atribucion: Boolean(c.doubtful), signal: c.signal, snapshot: c.metrics,
  });

  async function save(c, rec) {
    const id = await recs.create(rec);
    created.push(id);
    if (c) handled.add(c.key);
    return ok(`Recomendación #${id} guardada.`);
  }

  const inRange = (v) => v >= config.budget.minDaily && v <= config.budget.maxDaily;

  const handlers = {
    async recomendar_pausa(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_pausa);
      if (error) return fail(error);
      return save(c, { ...baseRec(c, input, 'pause'), current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' } });
    },
    async recomendar_reactivacion(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_reactivacion);
      if (error) return fail(error);
      return save(c, { ...baseRec(c, input, 'reactivate'), current_value: { status: 'PAUSED' }, proposed_value: { status: 'ACTIVE' } });
    },
    async recomendar_presupuesto(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_presupuesto);
      if (error) return fail(error);
      if (!c.budget) return fail('el objeto no tiene presupuesto propio (el presupuesto está en otro nivel)');
      const next = Math.round(input.presupuesto_nuevo);
      if (c.signal === 'ganador' && next <= c.budget) return fail('a un ganador solo se le puede subir el presupuesto');
      if (c.signal === 'caro' && next >= c.budget) return fail('a un caro solo se le puede bajar el presupuesto');
      if (Math.abs(next - c.budget) / c.budget > maxPct + 1e-9) return fail(`el cambio supera el tope de ±${config.budget.maxChangePct}% (actual $${c.budget})`);
      if (!inRange(next)) return fail(`el presupuesto tiene que estar entre $${config.budget.minDaily} y $${config.budget.maxDaily}`);
      return save(c, { ...baseRec(c, input, 'budget'), current_value: { daily_budget: c.budget }, proposed_value: { daily_budget: next } });
    },
    async recomendar_reasignacion(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_reasignacion);
      if (error) return fail(error);
      const amount = Math.round(input.monto_diario);
      const { from, to } = c.budget;
      if (!(amount > 0)) return fail('el monto tiene que ser positivo');
      if (amount > from * maxPct + 1e-9 || amount > to * maxPct + 1e-9) return fail(`el monto supera el tope de ${config.budget.maxChangePct}% de alguna de las puntas`);
      if (!inRange(from - amount) || !inRange(to + amount)) return fail('algún presupuesto resultante queda fuera de los mínimos/máximos');
      return save(c, { ...baseRec(c, input, 'shift'), current_value: { from, to }, proposed_value: { from: from - amount, to: to + amount } });
    },
    async registrar_idea(input) {
      let c = null;
      if (input.candidato) {
        const r = take(input.candidato, null);
        if (r.error) return fail(r.error);
        c = r.c;
      }
      return save(c, {
        run_id: runId, type: 'idea', level: c?.level ?? null, object_id: c?.objectId ?? null, target_id: null,
        title: input.titulo, reasoning: input.detalle, expected_impact: null, confidence: 'media',
        dudoso_atribucion: false, signal: c?.signal ?? null, snapshot: c?.metrics ?? null,
      });
    },
    async descartar_candidato(input) {
      const { c, error } = take(input.candidato, null);
      if (error) return fail(error);
      handled.add(c.key);
      skipped.push({ key: c.key, motivo: input.motivo });
      return ok('Descarte registrado.');
    },
    async guardar_leccion(input) {
      const ids = [...new Set(input.evidencia_ids)];
      if (!input.texto.trim()) return fail('la lección no puede estar vacía');
      const measured = await recs.measuredIds(ids);
      if (measured.length < 3) return fail(`hacen falta al menos 3 recomendaciones con resultado medido (válidas: ${measured.join(', ') || 'ninguna'})`);
      const id = await learnings.create(input.texto.trim(), measured);
      return ok(`Lección #${id} guardada.`);
    },
  };

  return {
    handled,
    skipped,
    created,
    async handle(name, input) {
      const fn = handlers[name];
      if (!fn) return fail(`herramienta desconocida: ${name}`);
      try {
        return await fn(input || {});
      } catch (err) {
        return fail(err.message);
      }
    },
  };
}
