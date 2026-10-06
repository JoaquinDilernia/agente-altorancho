import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAgentRouter } from '../src/routes/agent.js';
import { createAuthMiddleware } from '../src/routes/authMiddleware.js';

const domainError = (status, msg) => Object.assign(new Error(msg), { status });

function setup(over = {}) {
  const deps = {
    runner: { run: vi.fn().mockResolvedValue({}), quotaLeft: vi.fn().mockResolvedValue(2), isRunning: vi.fn().mockReturnValue(false), check: vi.fn().mockResolvedValue(null) },
    executor: {
      approve: vi.fn().mockResolvedValue({ status: 'executed' }), reject: vi.fn().mockResolvedValue(), undo: vi.fn().mockResolvedValue({ status: 'undone' }),
      markSeen: vi.fn().mockResolvedValue(),
    },
    recs: {
      list: vi.fn().mockResolvedValue([{ id: 1 }]), get: vi.fn().mockResolvedValue(null), countPending: vi.fn().mockResolvedValue(3),
      precision: vi.fn().mockResolvedValue([]), pendingRefs: vi.fn().mockResolvedValue([{ id: 1, object_id: 'A', target_id: null }]),
    },
    runs: { last: vi.fn().mockResolvedValue(null), costSince: vi.fn().mockResolvedValue(1.5) },
    learnings: { listActive: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue() },
    configRepo: { get: vi.fn().mockResolvedValue({ monthlyBudgetUsd: 20, agentEnabled: true, executionEnabled: false }), update: vi.fn().mockResolvedValue({}) },
    now: () => new Date('2026-10-06T12:00:00Z'),
    ...over,
  };
  const app = createApp({ apiRouter: [createAuthMiddleware({ password: 'pw' }), createAgentRouter(deps)] });
  const call = (method, url, body) => request(app)[method](url).set('authorization', 'Bearer pw').send(body);
  return { deps, call };
}

describe('API del agente', () => {
  it('overview junta estado, cupo y costo del mes', async () => {
    const { call, deps } = setup();
    const res = await call('get', '/api/agent/overview');
    expect(res.body).toMatchObject({ pendingCount: 3, manualRemaining: 2, monthCostUsd: 1.5, monthlyBudgetUsd: 20, executionEnabled: false, running: false });
    expect(deps.runs.costSince).toHaveBeenCalledWith('2026-10-01T00:00:00-03:00');
  });
  it('run: 202 en segundo plano; si no puede correr informa el motivo', async () => {
    const { call, deps } = setup();
    expect((await call('post', '/api/agent/run')).status).toBe(202);
    expect(deps.runner.run).toHaveBeenCalledWith({ trigger: 'manual' });
    for (const [reason, status, msg] of [['quota', 429, /análisis manuales/], ['budget', 429, /tope mensual/], ['running', 409, /corriendo/], ['disabled', 409, /apagado/]]) {
      deps.runner.check.mockResolvedValueOnce(reason);
      const r = await call('post', '/api/agent/run');
      expect(r.status).toBe(status);
      expect(r.body.error).toMatch(msg);
    }
    expect(deps.runner.run).toHaveBeenCalledTimes(1);
  });
  it('lista por grupo y tipo; valida parámetros', async () => {
    const { call, deps } = setup();
    await call('get', '/api/recommendations?group=history&type=pause&before=10');
    expect(deps.recs.list).toHaveBeenCalledWith({
      statuses: ['approved', 'executed', 'failed', 'rejected', 'expired', 'stale', 'undone', 'seen'], type: 'pause', beforeId: 10, limit: 50,
    });
    expect((await call('get', '/api/recommendations?group=otra')).status).toBe(400);
    expect((await call('get', '/api/recommendations?type=borrar')).status).toBe(400);
  });
  it('refs no choca con /:id; detalle inexistente → 404', async () => {
    const { call } = setup();
    expect((await call('get', '/api/recommendations/refs')).body).toEqual([{ id: 1, object_id: 'A', target_id: null }]);
    expect((await call('get', '/api/recommendations/5')).status).toBe(404);
    expect((await call('get', '/api/recommendations/abc')).status).toBe(404);
  });
  it('approve pasa el monto y mapea errores del dominio', async () => {
    const { call, deps } = setup();
    expect((await call('post', '/api/recommendations/7/approve', { amount: 55000 })).body).toEqual({ status: 'executed' });
    expect(deps.executor.approve).toHaveBeenCalledWith(7, { amount: 55000 });
    deps.executor.approve.mockRejectedValueOnce(domainError(409, 'ya fue resuelta'));
    const r = await call('post', '/api/recommendations/7/approve', {});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'ya fue resuelta' });
  });
  it('reject, undo, seen, lecciones y config', async () => {
    const { call, deps } = setup();
    await call('post', '/api/recommendations/7/reject', { reason: 'Está en lanzamiento' });
    expect(deps.executor.reject).toHaveBeenCalledWith(7, 'Está en lanzamiento');
    expect((await call('post', '/api/recommendations/7/reject', { reason: 'x'.repeat(301) })).status).toBe(400);
    expect((await call('post', '/api/recommendations/7/undo')).body).toEqual({ status: 'undone' });
    await call('post', '/api/recommendations/7/seen');
    expect(deps.executor.markSeen).toHaveBeenCalledWith(7);
    await call('delete', '/api/learnings/4');
    expect(deps.learnings.remove).toHaveBeenCalledWith(4);
    deps.configRepo.update.mockRejectedValueOnce(domainError(400, 'effort inválido'));
    expect((await call('put', '/api/agent/config', { effort: 'mucho' })).status).toBe(400);
  });
  it('error inesperado → 500 genérico', async () => {
    const { call, deps } = setup();
    deps.recs.countPending.mockRejectedValueOnce(new Error('db caída'));
    const r = await call('get', '/api/agent/overview');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'error interno' });
  });
});
