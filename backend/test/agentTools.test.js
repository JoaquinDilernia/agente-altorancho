import { describe, it, expect, vi } from 'vitest';
import { TOOLS, createToolHandler } from '../src/agent/tools.js';
import { DEFAULT_CONFIG } from '../src/repo/agentConfig.js';

const m = { m7: { spend: 2500, sales: 0 } };
const cands = [
  { key: 'gasta_sin_vender:A', signal: 'gasta_sin_vender', level: 'ad', objectId: 'A', doubtful: false, budget: null, metrics: m },
  { key: 'gasta_sin_vender:D', signal: 'gasta_sin_vender', level: 'ad', objectId: 'D', doubtful: true, budget: null, metrics: m },
  { key: 'ganador:G', signal: 'ganador', level: 'campaign', objectId: 'G', doubtful: false, budget: 50000, metrics: m },
  { key: 'caro:C', signal: 'caro', level: 'campaign', objectId: 'C', doubtful: false, budget: 40000, metrics: m },
  { key: 'reasignar:C>G', signal: 'reasignar', level: 'campaign', objectId: 'C', targetId: 'G', doubtful: false, budget: { from: 40000, to: 50000 }, metrics: { from: m, to: m } },
  { key: 'pausado_que_vendia:P', signal: 'pausado_que_vendia', level: 'adset', objectId: 'P', doubtful: false, budget: null, metrics: m },
];
const txt = { titulo: 'T', razonamiento: 'R', impacto_esperado: 'I', confianza: 'alta' };

function setup() {
  let next = 1;
  const recs = { create: vi.fn(async () => next++), measuredIds: vi.fn(async (ids) => ids.filter((i) => i <= 3)) };
  const learnings = { create: vi.fn(async () => 9) };
  const h = createToolHandler({ runId: 7, candidates: cands, recs, learnings, config: DEFAULT_CONFIG });
  return { h, recs, learnings };
}

describe('TOOLS', () => {
  it('7 tools estrictas sin propiedades extra', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'recomendar_pausa', 'recomendar_reactivacion', 'recomendar_presupuesto', 'recomendar_reasignacion',
      'registrar_idea', 'descartar_candidato', 'guardar_leccion',
    ]);
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required.sort()).toEqual(Object.keys(t.input_schema.properties).sort());
    }
  });
});

describe('toolHandler', () => {
  it('pausa válida crea la recomendación con valores actual/propuesto y snapshot', async () => {
    const { h, recs } = setup();
    const r = await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:A', ...txt });
    expect(r.isError).toBe(false);
    expect(recs.create).toHaveBeenCalledWith(expect.objectContaining({
      run_id: 7, type: 'pause', level: 'ad', object_id: 'A', confidence: 'alta', signal: 'gasta_sin_vender',
      current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' }, snapshot: m,
    }));
    expect(h.handled.has('gasta_sin_vender:A')).toBe(true);
    expect(h.created).toEqual([1]);
  });
  it('dudoso por atribución fuerza confianza baja', async () => {
    const { h, recs } = setup();
    await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:D', ...txt });
    expect(recs.create.mock.calls[0][0]).toMatchObject({ confidence: 'baja', dudoso_atribucion: true });
  });
  it('rechaza candidato inexistente, repetido o acción que no corresponde a la señal', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_pausa', { candidato: 'x:Z', ...txt })).isError).toBe(true);
    expect((await h.handle('recomendar_reactivacion', { candidato: 'gasta_sin_vender:A', ...txt })).isError).toBe(true);
    await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:A', ...txt });
    expect((await h.handle('descartar_candidato', { candidato: 'gasta_sin_vender:A', motivo: 'x' })).isError).toBe(true);
    expect(recs.create).toHaveBeenCalledTimes(1);
  });
  it('presupuesto: respeta dirección y tope ±20%, redondea a pesos', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 45000, ...txt })).isError).toBe(true); // baja a un ganador
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 70000, ...txt })).isError).toBe(true); // +40%
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 59999.6, ...txt })).isError).toBe(false);
    expect(recs.create.mock.calls[0][0]).toMatchObject({ type: 'budget', object_id: 'G', current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 } });
    expect((await h.handle('recomendar_presupuesto', { candidato: 'caro:C', presupuesto_nuevo: 34000, ...txt })).isError).toBe(false);
  });
  it('reasignación: monto dentro del tope de ambas puntas', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_reasignacion', { candidato: 'reasignar:C>G', monto_diario: 9000, ...txt })).isError).toBe(true); // > 20% de 40000
    expect((await h.handle('recomendar_reasignacion', { candidato: 'reasignar:C>G', monto_diario: 8000, ...txt })).isError).toBe(false);
    expect(recs.create.mock.calls[0][0]).toMatchObject({
      type: 'shift', object_id: 'C', target_id: 'G', current_value: { from: 40000, to: 50000 }, proposed_value: { from: 32000, to: 58000 },
    });
  });
  it('reactivación, idea y descarte', async () => {
    const { h, recs } = setup();
    await h.handle('recomendar_reactivacion', { candidato: 'pausado_que_vendia:P', ...txt });
    expect(recs.create.mock.calls[0][0]).toMatchObject({ type: 'reactivate', current_value: { status: 'PAUSED' }, proposed_value: { status: 'ACTIVE' } });
    await h.handle('registrar_idea', { candidato: '', titulo: 'Probar video', detalle: 'D' });
    expect(recs.create.mock.calls[1][0]).toMatchObject({ type: 'idea', object_id: null, title: 'Probar video', reasoning: 'D' });
    await h.handle('descartar_candidato', { candidato: 'caro:C', motivo: 'en lanzamiento' });
    expect(h.skipped).toEqual([{ key: 'caro:C', motivo: 'en lanzamiento' }]);
  });
  it('lección exige 3 recomendaciones medidas', async () => {
    const { h, learnings } = setup();
    expect((await h.handle('guardar_leccion', { texto: 'X', evidencia_ids: [1, 2, 8] })).isError).toBe(true);
    expect((await h.handle('guardar_leccion', { texto: 'X', evidencia_ids: [1, 2, 3] })).isError).toBe(false);
    expect(learnings.create).toHaveBeenCalledWith('X', [1, 2, 3]);
  });
  it('herramienta desconocida → error', async () => {
    const { h } = setup();
    expect((await h.handle('borrar_todo', {})).isError).toBe(true);
  });
});
