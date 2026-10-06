import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo } from '../src/repo/agentConfig.js';
import { createRecommendationsRepo } from '../src/repo/recommendations.js';
import { createExecutor } from '../src/agent/executor.js';

const NOW = new Date('2026-10-06T12:00:00Z');
let db; let recs; let configRepo; let meta; let ex;

function fakeMeta(state) {
  return {
    getObject: vi.fn(async (id) => state[id]),
    setStatus: vi.fn(async (id, status) => { state[id] = { ...state[id], status }; }),
    setDailyBudget: vi.fn(async (id, pesos) => { state[id] = { ...state[id], daily_budget: String(Math.round(pesos * 100)) }; }),
  };
}
const pauseRec = { type: 'pause', level: 'ad', object_id: 'A', title: 'Pausar A', reasoning: 'r', confidence: 'alta', signal: 'gasta_sin_vender', current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' } };
const budgetRec = { type: 'budget', level: 'campaign', object_id: 'G', title: 'Subir G', reasoning: 'r', confidence: 'alta', signal: 'ganador', current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 } };
const shiftRec = { type: 'shift', level: 'campaign', object_id: 'C', target_id: 'G', title: 'Mover', reasoning: 'r', confidence: 'media', signal: 'reasignar', current_value: { from: 40000, to: 50000 }, proposed_value: { from: 32000, to: 58000 } };

beforeEach(async () => {
  db = await createTestDb();
  recs = createRecommendationsRepo(db);
  configRepo = createAgentConfigRepo(db);
  await configRepo.update({ executionEnabled: true });
  meta = fakeMeta({ A: { status: 'ACTIVE' }, G: { daily_budget: '5000000' }, C: { daily_budget: '4000000' } });
  ex = createExecutor({ meta, recs, configRepo, now: () => NOW, log: { error: () => {} } });
});
afterEach(() => db.close());

describe('executor.approve', () => {
  it('con ejecución apagada solo registra la aprobación', async () => {
    await configRepo.update({ executionEnabled: false });
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'approved' });
    expect(meta.setStatus).not.toHaveBeenCalled();
    expect((await recs.get(id)).status).toBe('approved');
  });
  it('pausa: pre-chequea, ejecuta y deja deshacer por 24 h', async () => {
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'executed' });
    expect(meta.setStatus).toHaveBeenCalledWith('A', 'PAUSED');
    const r = await recs.get(id);
    expect(r).toMatchObject({ status: 'executed', previous_value: { status: 'ACTIVE' } });
    expect(new Date(r.undo_until).toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });
  it('doble aprobación simultánea ejecuta una sola vez', async () => {
    const id = await recs.create(pauseRec);
    const results = await Promise.allSettled([ex.approve(id), ex.approve(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 409 });
    expect(meta.setStatus).toHaveBeenCalledTimes(1);
  });
  it('si cambió en Meta desde la recomendación queda desactualizada y no se toca', async () => {
    meta = fakeMeta({ A: { status: 'PAUSED' } });
    ex = createExecutor({ meta, recs, configRepo, now: () => NOW });
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'stale' });
    expect(meta.setStatus).not.toHaveBeenCalled();
    expect((await recs.get(id)).execution_result).toMatchObject({ actual: { status: 'PAUSED' } });
  });
  it('presupuesto con monto ajustado dentro del tope; fuera del tope → 400 y sigue pendiente', async () => {
    const id = await recs.create(budgetRec);
    await expect(ex.approve(id, { amount: 70000 })).rejects.toMatchObject({ status: 400 });
    expect((await recs.get(id)).status).toBe('pending');
    expect(await ex.approve(id, { amount: 55000 })).toEqual({ status: 'executed' });
    expect(meta.setDailyBudget).toHaveBeenCalledWith('G', 55000);
    expect((await recs.get(id)).proposed_value).toEqual({ daily_budget: 55000 });
  });
  it('reasignación: si falla la segunda escritura revierte la primera', async () => {
    meta.setDailyBudget.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('Meta 100: error')).mockImplementationOnce(async () => {});
    const id = await recs.create(shiftRec);
    const r = await ex.approve(id);
    expect(r).toMatchObject({ status: 'failed' });
    expect(meta.setDailyBudget.mock.calls).toEqual([['C', 32000], ['G', 58000], ['C', 40000]]);
  });
  it('error de Meta al ejecutar → failed con el motivo', async () => {
    meta.setStatus.mockRejectedValueOnce(new Error('Meta 190: token vencido'));
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'failed', error: 'Meta 190: token vencido' });
  });
  it('idea o inexistente no se aprueban', async () => {
    const idea = await recs.create({ type: 'idea', title: 'x', reasoning: 'y', confidence: 'media' });
    await expect(ex.approve(idea)).rejects.toMatchObject({ status: 400 });
    await expect(ex.approve(999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('executor: rechazar, ideas, deshacer, vencer', () => {
  it('rechazar guarda el motivo; dos veces → 409', async () => {
    const id = await recs.create(pauseRec);
    await ex.reject(id, 'Está en lanzamiento');
    expect(await recs.get(id)).toMatchObject({ status: 'rejected', reject_reason: 'Está en lanzamiento' });
    await expect(ex.reject(id, 'x')).rejects.toMatchObject({ status: 409 });
  });
  it('idea vista', async () => {
    const id = await recs.create({ type: 'idea', title: 'x', reasoning: 'y', confidence: 'media' });
    await ex.markSeen(id);
    expect((await recs.get(id)).status).toBe('seen');
  });
  it('deshacer dentro de la ventana vuelve al estado anterior; después → 409', async () => {
    const id = await recs.create(shiftRec);
    await ex.approve(id);
    expect(await ex.undo(id)).toEqual({ status: 'undone' });
    expect(meta.setDailyBudget.mock.calls.slice(2)).toEqual([['C', 40000], ['G', 50000]]);
    await expect(ex.undo(id)).rejects.toMatchObject({ status: 409 });
    const id2 = await recs.create(pauseRec);
    await ex.approve(id2);
    const later = createExecutor({ meta, recs, configRepo, now: () => new Date('2026-10-08T12:00:00Z') });
    await expect(later.undo(id2)).rejects.toMatchObject({ status: 409 });
  });
  it('expire vence pendientes viejas según config', async () => {
    const id = await recs.create(pauseRec);
    await db.query("UPDATE recommendations SET created_at = '2026-10-03T00:00:00Z' WHERE id = $1", [id]);
    expect(await ex.expire()).toBe(1);
  });
});
