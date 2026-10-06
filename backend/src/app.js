import path from 'node:path';
import express from 'express';
import cors from 'cors';

export function createApp({ webhookRouter, ingestRouter, apiRouter, corsOrigin, staticDir, health } = {}) {
  const app = express();
  // lista separada por comas; solo se devuelve el header a los orígenes permitidos
  if (corsOrigin) app.use(cors({ origin: corsOrigin.split(',').map((o) => o.trim()) }));
  // webhooks van ANTES de express.json(): la verificación HMAC necesita el raw body
  if (webhookRouter) app.use('/webhooks', webhookRouter);
  // ingreso de datos externos: antes de express.json() global (usa su propio límite de tamaño)
  if (ingestRouter) app.use('/ingest', ingestRouter);
  app.use(express.json());
  app.get('/health', async (_req, res) => {
    if (!health) return res.json({ ok: true });
    try {
      res.json({ ok: true, ...(await health()) });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });
  if (apiRouter) app.use('/api', ...[].concat(apiRouter));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'no encontrado' }));
  if (staticDir) {
    const noCache = (res) => res.set('Cache-Control', 'no-cache');
    app.use(express.static(staticDir, {
      index: false,
      setHeaders: (res, file) => {
        if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) noCache(res);
      },
    }));
    app.get(/^\/(?!api\/|webhooks\/|ingest\/).*/, (_req, res) => {
      noCache(res);
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  return app;
}
