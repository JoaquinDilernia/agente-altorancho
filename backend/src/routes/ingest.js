import crypto from 'node:crypto';
import express from 'express';
import { parseGooglePayload } from '../engine/googleIngest.js';

// Ingreso de datos de plataformas externas (hoy: script de Google Ads). Auth por token propio.
export function createIngestRouter({ token, googleRepo, syncRuns, log = console }) {
  const router = express.Router();
  const expected = token ? Buffer.from(token) : null;
  const authorized = (req) => {
    const got = Buffer.from(req.get('x-ingest-token') || '');
    return Boolean(expected) && got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  // Un rechazo silencioso deja el gasto en 0 sin pista: se anota como error para verlo en Estado
  const reject = async (message) => {
    try {
      const id = await syncRuns.start('google_ingest');
      await syncRuns.finish(id, { status: 'error', error: message });
    } catch (err) {
      log.error('[ingest google]', err);
    }
  };

  router.post('/google', express.json({ limit: '10mb' }), async (req, res) => {
    if (!authorized(req)) {
      await reject('rechazado: token inválido (actualizar el token del script de Google Ads)');
      return res.status(401).json({ error: 'token inválido' });
    }
    let parsed;
    try {
      parsed = parseGooglePayload(req.body);
    } catch (err) {
      await reject(`rechazado: ${err.message}`);
      return res.status(err.status || 400).json({ error: err.message });
    }
    let runId = null;
    try {
      runId = await syncRuns.start('google_ingest');
      await googleRepo.upsertCampaigns(parsed.campaigns);
      await googleRepo.upsertSpend(parsed.spend);
      if (parsed.entities.length) {
        await googleRepo.upsertEntities(parsed.entities);
        await googleRepo.resolveCampaigns();
      }
      await syncRuns.finish(runId, { status: 'ok', rows: parsed.spend.length });
      res.json({ ok: true, rows: parsed.spend.length });
    } catch (err) {
      log.error('[ingest google]', err);
      // nunca dejar escapar una promesa rechazada: tiraría el proceso entero
      if (runId !== null) await syncRuns.finish(runId, { status: 'error', error: err.message }).catch(() => {});
      res.status(500).json({ error: 'no se pudo guardar' });
    }
  });
  return router;
}
