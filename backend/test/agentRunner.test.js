import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo } from '../src/repo/agentConfig.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from '../src/repo/recommendations.js';
import { createAgentRunner } from '../src/agent/runner.js';
import { withRatios } from '../src/repo/agentMetrics.js';

const mm = (o = {}) => withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 10000, clicks: 200, metaPurchases: 0, metaValue: 0, ...o });
const object = {
  id: 'A', level: 'campaign', name: 'Campaña A', status: 'ACTIVE', campaignId: 'A', parentId: null, objective: 'OUTCOME_SALES', isSales: true,
  ageDays: 30, learning: false, statusUpdatedAt: null, budgetOwner: null, coverage: 1, m7: mm({ spend: 2500 }), mPrev: mm(), m30: mm(),
};
const dataset = (objects = [object]) => ({
  today: '2026-10-06', windows: {}, baseline: { spend: 100000, sales: 100, revenue: 400000, roas: 4, cpa: 1000 }, objects,
});
const NOW = new Date('2026-10-06T12:00:00Z');
const toolUse = (name, input, id = 'tu1') => ({
  stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 },
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id, name, input }],
});
const endTurn = { stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 100 }, content: [{ type: 'text', text: 'Listo.' }] };
const pausaA = { candidato: 'gasta_sin_vender:A', titulo: 'Pausar A', razonamiento: 'Gastó $2.500 sin ventas', impacto_esperado: 'Ahorra', confianza: 'alta' };

let db; let deps;
beforeEach(async () => {
  db = await createTestDb();
  deps = {
    configRepo: createAgentConfigRepo(db), runs: createAgentRunsRepo(db), recs: createRecommendationsRepo(db),
    learnings: createLearningsRepo(db), now: () => NOW, log: { warn: () => {}, error: () => {} },
  };
});
afterEach(() => db.close());

const runnerWith = (responses, ds = dataset()) => {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const runner = createAgentRunner({ ...deps, anthropic: { beta: { messages: { create } } }, loadDataset: async () => ds });
  return { runner, create };
};

describe('agentRunner', () => {
  it('corrida completa: llama a Claude con el request correcto, guarda la recomendación y el costo', async () => {
    const { runner, create } = runnerWith([toolUse('recomendar_pausa', pausaA), endTurn]);
    const r = await runner.run({ trigger: 'cron' });
    expect(r).toMatchObject({ candidates: 1, recommendations: 1 });
    expect(r.costUsd).toBeCloseTo((2500 * 4 + 300 * 20) / 1e6);
    const req = create.mock.calls[0][0];
    expect(req).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(req.thinking).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.tools.every((t) => t.strict)).toBe(true);
    expect(req.messages[0].content).toContain('gasta_sin_vender:A');
    const second = create.mock.calls[1][0].messages;
    expect(second[1]).toEqual({ role: 'assistant', content: toolUse('recomendar_pausa', pausaA).content }); // append-only, con thinking
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' });
    const [rec] = await deps.recs.list({ statuses: ['pending'] });
    expect(rec).toMatchObject({ type: 'pause', object_id: 'A', title: 'Pausar A' });
    const last = await deps.runs.last();
    expect(last).toMatchObject({ status: 'ok', input_tokens: 2500, output_tokens: 300, candidates_count: 1 });
  });
  it('tool call inválido vuelve como is_error y el loop sigue', async () => {
    const { runner, create } = runnerWith([toolUse('recomendar_pausa', { ...pausaA, candidato: 'x:Z' }), toolUse('recomendar_pausa', pausaA, 'tu2'), endTurn]);
    await runner.run({ trigger: 'cron' });
    expect(create.mock.calls[1][0].messages[2].content[0]).toMatchObject({ is_error: true });
    expect((await deps.recs.list({})).length).toBe(1);
  });
  it('sin candidatos no llama a Claude y cuesta 0', async () => {
    const { runner, create } = runnerWith([], dataset([{ ...object, m7: mm({ spend: 100 }) }]));
    expect(await runner.run({ trigger: 'cron' })).toMatchObject({ candidates: 0, costUsd: 0 });
    expect(create).not.toHaveBeenCalled();
  });
  it('cupo manual diario: la tercera corrida manual del día se saltea', async () => {
    const { runner } = runnerWith([toolUse('recomendar_pausa', pausaA), endTurn, toolUse('descartar_candidato', { candidato: 'gasta_sin_vender:A', motivo: 'x' }), endTurn]);
    await runner.run({ trigger: 'manual' });
    await deps.recs.list({}).then(async ([r]) => deps.recs.transition(r.id, ['pending'], 'rejected'));
    await db.query("UPDATE recommendations SET decided_at = '2026-09-01T00:00:00Z'"); // fuera del cooldown
    await runner.run({ trigger: 'manual' });
    expect(await runner.quotaLeft()).toBe(0);
    expect(await runner.run({ trigger: 'manual' })).toEqual({ skipped: 'quota' });
  });
  it('tope mensual alcanzado → no corre', async () => {
    const id = await deps.runs.start({ trigger: 'cron', model: 'claude-opus-5-5', startedAt: NOW.toISOString() });
    await deps.runs.finish(id, { status: 'ok', cost_usd: 25 });
    const { runner, create } = runnerWith([]);
    expect(await runner.run({ trigger: 'cron' })).toEqual({ skipped: 'budget' });
    expect(create).not.toHaveBeenCalled();
  });
  it('agente apagado → no corre', async () => {
    await deps.configRepo.update({ agentEnabled: false });
    const { runner } = runnerWith([]);
    expect(await runner.run({ trigger: 'cron' })).toEqual({ skipped: 'disabled' });
  });
  it('maxTurns corta un loop infinito; los candidatos sin decisión quedan registrados', async () => {
    await deps.configRepo.update({ maxTurns: 2 });
    const bad = toolUse('recomendar_pausa', { ...pausaA, candidato: 'x:Z' });
    const { runner, create } = runnerWith([bad, bad, bad]);
    await runner.run({ trigger: 'cron' });
    expect(create).toHaveBeenCalledTimes(2);
    const { rows } = await db.query('SELECT skipped FROM agent_runs');
    expect(rows[0].skipped).toEqual([{ key: 'gasta_sin_vender:A', motivo: 'sin decisión del agente' }]);
  });
  it('refusal → la corrida queda en error con el costo consumido', async () => {
    const { runner } = runnerWith([{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: { input_tokens: 500, output_tokens: 0 }, content: [] }]);
    await expect(runner.run({ trigger: 'cron' })).rejects.toThrow(/rechazó/);
    expect(await deps.runs.last()).toMatchObject({ status: 'error', input_tokens: 500 });
  });
  it("dos corridas a la vez: la segunda se saltea (sin doble costo)", async () => {
    const { runner, create } = runnerWith([toolUse("recomendar_pausa", pausaA), endTurn]);
    const [a, b] = await Promise.all([runner.run({ trigger: "cron" }), runner.run({ trigger: "cron" })]);
    expect([a, b].filter((r) => r.skipped === "running")).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("tope mensual cuenta la estimación de la corrida (promedio de las anteriores)", async () => {
    const id = await deps.runs.start({ trigger: "cron", model: "claude-opus-5-5", startedAt: NOW.toISOString() });
    await deps.runs.finish(id, { status: "ok", cost_usd: 19.8 });
    const { runner, create } = runnerWith([]);
    expect(await runner.check({ trigger: "cron" })).toBe("budget");
    expect(await runner.run({ trigger: "cron" })).toEqual({ skipped: "budget" });
    expect(create).not.toHaveBeenCalled();
  });
  it("check informa el motivo sin correr", async () => {
    const { runner } = runnerWith([]);
    expect(await runner.check({ trigger: "manual" })).toBeNull();
    await deps.configRepo.update({ agentEnabled: false });
    expect(await runner.check({ trigger: "manual" })).toBe("disabled");
  });
});
