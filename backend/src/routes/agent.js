import express from 'express';
import { artDate } from '../engine/dates.js';

const GROUPS = {
  pending: ['pending'],
  history: ['approved', 'executed', 'failed', 'rejected', 'expired', 'stale', 'undone', 'seen'],
};
const TYPES = new Set(['pause', 'reactivate', 'budget', 'shift', 'idea']);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('no encontrado'), { status: 404 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const idParam = (req) => {
  if (!/^\d+$/.test(req.params.id)) throw notFound();
  return Number(req.params.id);
};

export function createAgentRouter({ runner, executor, recs, runs, learnings, configRepo, now = () => new Date() }) {
  const router = express.Router();

  router.get('/agent/overview', wrap(async (_req, res) => {
    const config = await configRepo.get();
    const monthStart = `${artDate(now()).slice(0, 7)}-01T00:00:00-03:00`;
    res.json({
      lastRun: await runs.last(),
      running: runner.isRunning(),
      pendingCount: await recs.countPending(),
      manualRemaining: await runner.quotaLeft(),
      monthCostUsd: await runs.costSince(monthStart),
      monthlyBudgetUsd: config.monthlyBudgetUsd,
      agentEnabled: config.agentEnabled,
      executionEnabled: config.executionEnabled,
      precision: await recs.precision(),
    });
  }));

  router.post('/agent/run', wrap(async (_req, res) => {
    if (runner.isRunning()) return res.status(409).json({ error: 'Ya hay un análisis corriendo' });
    if ((await runner.quotaLeft()) <= 0) return res.status(429).json({ error: 'No quedan análisis manuales por hoy' });
    runner.run({ trigger: 'manual' }).catch(() => {}); // el error queda registrado en agent_runs
    res.status(202).json({ started: true });
  }));

  router.get('/recommendations', wrap(async (req, res) => {
    const group = req.query.group || 'pending';
    if (!GROUPS[group]) throw badRequest('group inválido');
    if (req.query.type && !TYPES.has(req.query.type)) throw badRequest('type inválido');
    if (req.query.before && !/^\d+$/.test(req.query.before)) throw badRequest('before inválido');
    res.json(await recs.list({
      statuses: GROUPS[group], type: req.query.type || undefined,
      beforeId: req.query.before ? Number(req.query.before) : undefined, limit: 50,
    }));
  }));

  router.get('/recommendations/refs', wrap(async (_req, res) => res.json(await recs.pendingRefs())));

  router.get('/recommendations/:id', wrap(async (req, res) => {
    const rec = await recs.get(idParam(req));
    if (!rec) throw notFound();
    res.json(rec);
  }));

  router.post('/recommendations/:id/approve', wrap(async (req, res) => {
    res.json(await executor.approve(idParam(req), { amount: req.body?.amount }));
  }));

  router.post('/recommendations/:id/reject', wrap(async (req, res) => {
    const reason = req.body?.reason ?? null;
    if (reason !== null && (typeof reason !== 'string' || reason.length > 300)) throw badRequest('motivo inválido (máx. 300 caracteres)');
    await executor.reject(idParam(req), reason);
    res.json({ status: 'rejected' });
  }));

  router.post('/recommendations/:id/undo', wrap(async (req, res) => res.json(await executor.undo(idParam(req)))));

  router.post('/recommendations/:id/seen', wrap(async (req, res) => {
    await executor.markSeen(idParam(req));
    res.json({ status: 'seen' });
  }));

  router.get('/learnings', wrap(async (_req, res) => res.json(await learnings.listActive())));
  router.delete('/learnings/:id', wrap(async (req, res) => {
    await learnings.remove(idParam(req));
    res.json({ ok: true });
  }));

  router.get('/agent/config', wrap(async (_req, res) => res.json(await configRepo.get())));
  router.put('/agent/config', wrap(async (req, res) => res.json(await configRepo.update(req.body))));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if ([400, 404, 409, 429].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error('[api agente]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return router;
}
