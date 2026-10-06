import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createOrdersRepo } from './repo/orders.js';
import { createMetaRepo } from './repo/meta.js';
import { createSyncRunsRepo } from './repo/syncRuns.js';
import { createReportsRepo } from './repo/reports.js';
import { createTiendanubeClient } from './services/tiendanube.js';
import { createMetaClient } from './services/meta.js';
import { createOrderSync } from './sync/orders.js';
import { createMetaSync } from './sync/meta.js';
import { createUrlTagger } from './sync/urlTagger.js';
import { createJobRunner } from './sync/jobs.js';
import { createJobCatalog } from './jobsCatalog.js';
import { artDate, addDays } from './engine/dates.js';
import Anthropic from '@anthropic-ai/sdk';
import { createAgentConfigRepo } from './repo/agentConfig.js';
import { createAgentMetrics } from './repo/agentMetrics.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from './repo/recommendations.js';
import { buildDataset } from './agent/dataset.js';
import { createAgentRunner } from './agent/runner.js';
import { createExecutor } from './agent/executor.js';
import { createOutcomeMeter } from './agent/outcomes.js';
import { createAgentRouter } from './routes/agent.js';
import { createGoogleRepo } from './repo/google.js';
import { createIngestRouter } from './routes/ingest.js';
import { createApp } from './app.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createApiRouter } from './routes/api.js';
import { createAuthMiddleware } from './routes/authMiddleware.js';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta env var: ${k}`);
  return v;
};

const db = createPgDb(env('DATABASE_URL'));
const applied = await migrate(db);
if (applied.length) console.log('[db] migraciones aplicadas:', applied.join(', '));

const syncRuns = createSyncRunsRepo(db);
await syncRuns.markStaleRunning();
const ordersRepo = createOrdersRepo(db);
const metaRepo = createMetaRepo(db);
const reports = createReportsRepo(db);

const tn = createTiendanubeClient({ storeId: env('TIENDANUBE_STORE_ID'), token: env('TIENDANUBE_TOKEN') });
const meta = createMetaClient({ accessToken: env('META_ACCESS_TOKEN'), accountId: env('META_ACCOUNT_ID') });
const orderSync = createOrderSync({ tn, ordersRepo });
const metaSync = createMetaSync({ meta, metaRepo, ordersRepo });
const urlTagger = createUrlTagger({ meta, metaRepo });
const jobs = createJobRunner({ syncRuns });
const jobCatalog = createJobCatalog({ orderSync, metaSync, ordersRepo, syncRuns });
const runJob = (name) => jobs.run(jobCatalog[name].source, jobCatalog[name].fn);

const configRepo = createAgentConfigRepo(db);
const recsRepo = createRecommendationsRepo(db);
const agentRuns = createAgentRunsRepo(db);
const learningsRepo = createLearningsRepo(db);
const agentMetrics = createAgentMetrics({ db, reports });
const runner = createAgentRunner({
  anthropic: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }),
  configRepo, runs: agentRuns, recs: recsRepo, learnings: learningsRepo,
  loadDataset: () => buildDataset({ db, metrics: agentMetrics, today: artDate() }),
});
const executor = createExecutor({ meta, recs: recsRepo, configRepo });
const meter = createOutcomeMeter({ db, recs: recsRepo, metrics: agentMetrics });

async function onOrderEvent(event) {
  try {
    await orderSync.syncOrder(event.id);
  } catch (err) {
    console.error(`[webhook] orden ${event.id}:`, err);
    const id = await syncRuns.start('tn_webhook');
    await syncRuns.finish(id, { status: 'error', error: `orden ${event.id}: ${err.message}` });
  }
}

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
const app = createApp({
  corsOrigin: process.env.FRONTEND_ORIGIN,
  ingestRouter: createIngestRouter({ token: process.env.GOOGLE_INGEST_TOKEN, googleRepo: createGoogleRepo(db), syncRuns }),
  webhookRouter: createWebhookRouter({ secret: process.env.TIENDANUBE_WEBHOOK_SECRET, onOrderEvent }),
  apiRouter: [
    createAuthMiddleware({ password: env('DASHBOARD_PASSWORD') }),
    createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }),
    createAgentRouter({ runner, executor, recs: recsRepo, runs: agentRuns, learnings: learningsRepo, configRepo }),
  ],
  staticDir: fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined,
  health: async () => {
    await db.query('SELECT 1');
    return { db: true };
  },
});

const TZ = { timezone: 'America/Argentina/Buenos_Aires' };
// Red de seguridad de órdenes (webhooks perdidos) — cada hora
cron.schedule('5 * * * *', () => runJob('tn-incremental'), TZ);
// Catálogo + gasto de hoy/ayer — cada hora
cron.schedule('15 * * * *', async () => {
  await runJob('meta-catalog');
  await jobs.run('meta_spend', () => {
    const today = artDate();
    return metaSync.syncSpend(addDays(today, -1), today);
  });
}, TZ);
// Correcciones tardías de Meta — últimos 7 días, 05:00 ART
cron.schedule('0 5 * * *', () => runJob('meta-spend'), TZ);

// Análisis diario del agente: datos frescos de Meta y corrida (08:00 ART)
cron.schedule('0 8 * * *', async () => {
  await runJob('meta-catalog');
  await runJob('meta-spend');
  await runner.run({ trigger: 'cron' }).catch(() => {});
}, TZ);
// Resultados de lo ejecutado (09:00 ART) y vencimiento de pendientes (cada hora)
cron.schedule('0 9 * * *', () => meter.measure().catch((e) => console.error('[agente] medición falló:', e)), TZ);
cron.schedule('30 * * * *', () => executor.expire().catch((e) => console.error('[agente] vencimiento falló:', e)), TZ);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`altorancho-backend escuchando en :${port}`));
