import express from 'express';
import { isYmd } from '../engine/dates.js';

const CHANNELS = new Set(['meta', 'google', 'organic', 'email', 'social_organic', 'other', 'unknown']);
const LEVELS = new Set(['campaign', 'adset', 'ad']);
const SORTS = new Set(['spend', 'cps', 'roas']);
const SOURCES = ['tn_backfill', 'tn_incremental', 'tn_webhook', 'meta_catalog', 'meta_spend', 'meta_backfill', 'meta_url_tags', 'reattribute'];
const MAX_DAYS = 366;

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function period(req) {
  const { from, to } = req.query;
  if (!isYmd(from) || !isYmd(to)) throw badRequest('from y to tienen que ser fechas YYYY-MM-DD');
  if (from > to) throw badRequest('from no puede ser posterior a to');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) throw badRequest(`el período no puede superar ${MAX_DAYS} días`);
  return { from, to };
}

export function createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }) {
  const router = express.Router();

  router.get('/summary', wrap(async (req, res) => res.json(await reports.summary(period(req)))));

  router.get('/orders', wrap(async (req, res) => {
    const { channel, q, cursor } = req.query;
    if (channel && !CHANNELS.has(channel)) throw badRequest('canal inválido');
    res.json(await reports.listOrders({ ...period(req), channel: channel || undefined, q: q || undefined, cursor: cursor || undefined, limit: 50 }));
  }));

  router.get('/orders/:id', wrap(async (req, res) => {
    const order = await reports.orderDetail(req.params.id);
    if (!order) return res.status(404).json({ error: 'orden no encontrada' });
    res.json(order);
  }));

  router.get('/ads/missing-params', wrap(async (_req, res) => res.json(await metaRepo.listAdsMissingParams())));

  router.get('/ads', wrap(async (req, res) => {
    const level = req.query.level || 'campaign';
    const sort = req.query.sort || 'spend';
    if (!LEVELS.has(level)) throw badRequest('level inválido');
    if (!SORTS.has(sort)) throw badRequest('sort inválido');
    res.json(await reports.adsRanking({ ...period(req), level, parentId: req.query.parent || null, sort }));
  }));

  router.get('/ads/:id', wrap(async (req, res) => {
    const detail = await reports.adDetail({ id: req.params.id, ...period(req) });
    if (!detail) return res.status(404).json({ error: 'no encontrado' });
    res.json(detail);
  }));

  router.get('/status', wrap(async (_req, res) => {
    res.json({
      runs: await syncRuns.latestBySource(),
      lastSuccess: await syncRuns.lastSuccessBySource(),
      errors: await syncRuns.recentErrors(10),
      coverage: await reports.coverageWeekly(),
      counts: await reports.counts(),
      running: SOURCES.filter((s) => jobs.isRunning(s)),
    });
  }));

  router.post('/meta/apply-url-tags', wrap(async (req, res) => {
    const { adIds } = req.body || {};
    if (!Array.isArray(adIds) || adIds.length === 0 || adIds.length > 50 || !adIds.every((id) => /^\d+$/.test(String(id)))) {
      throw badRequest('adIds tiene que ser una lista de 1 a 50 IDs de anuncio');
    }
    let results = [];
    const run = await jobs.run('meta_url_tags', async () => {
      results = await urlTagger.apply(adIds.map(String));
      return results.filter((r) => r.status !== 'error').length;
    });
    if (run.skipped) return res.status(409).json({ error: 'ya se están aplicando parámetros, probá en un rato' });
    res.json({ results });
  }));

  router.post('/sync/:job', wrap(async (req, res) => {
    const job = jobCatalog[req.params.job];
    if (!job) return res.status(404).json({ error: 'job desconocido' });
    if (!jobs.runInBackground(job.source, job.fn)) return res.status(409).json({ error: 'ya está corriendo' });
    res.status(202).json({ started: job.source });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[api]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return router;
}
