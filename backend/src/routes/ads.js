import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { buildSnapshot } from '../ads/snapshot.js';
import { loadIgPosts } from '../ads/igPosts.js';
import { isStoreLink } from '../ads/agent.js';
import { httpError } from '../repo/ads.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const bad = (msg) => httpError(400, msg);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,30}$/;
const uuidParam = (v) => {
  if (!UUID.test(v)) throw httpError(404, 'no encontrado');
  return v;
};
const metaIdOf = (v) => {
  if (!META_ID.test(String(v ?? ''))) throw bad('Id de Meta inválido');
  return String(v);
};
const text = (v, { max, required, label }) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null) throw bad(`${label}: tiene que ser texto`);
  if (required && !s) throw bad(`Falta ${label}`);
  if (s.length > max) throw bad(`${label}: máximo ${max} caracteres`);
  return s;
};

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 200 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
const isJpgOrPng = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG');
// MP4/MOV: la caja de tipo ('ftyp', o 'moov'/'wide'/'mdat' en MOV viejos) está en el byte 4
const isMp4OrMov = (b) => ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(b.subarray(4, 8).toString('latin1'));

function sizeLimit(max, msg) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      cb(n > max ? httpError(413, msg) : null, chunk);
    },
  });
}

async function readBuffer(req, max, msg) {
  const chunks = [];
  await pipeline(req, sizeLimit(max, msg), async function* (src) {
    for await (const c of src) chunks.push(c);
  });
  return Buffer.concat(chunks);
}

const LEVEL_LABEL = { campaign: 'la campaña', adset: 'el conjunto', ad: 'el anuncio' };
const SNAPSHOT_TTL_MS = 5 * 60_000;
const SNAPSHOT_ERROR_TTL_MS = 2 * 60_000;
const SNAPSHOT_WAIT_MS = 15_000; // el panel no espera más que esto: la consulta sigue y llena el cache
const SETTINGS = {
  agent_enabled: (v) => typeof v === 'boolean',
  autonomous: (v) => typeof v === 'boolean',
  monthly_cap_ars: (v) => Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  business_notes: (v) => typeof v === 'string' && v.length <= 5000,
};

// meta/startRun/execute pueden faltar: el panel avisa qué falta configurar
export function createAdsRouter({ repo, meta, reports, startRun, execute, identity, config }) {
  const r = express.Router();
  const needMeta = (_req, _res, next) => next(meta && execute ? undefined : httpError(503, 'Falta conectar Meta (META_ACCESS_TOKEN) en el servidor.'));

  // La foto de Meta se cachea unos minutos: cada carga del panel no le pega a la API.
  // Una sola consulta a la vez (si Meta limita, los reintentos tardan minutos y cada recarga sumaría llamadas)
  // y un error se recuerda un rato para no insistirle a una cuenta que ya está limitada.
  let cache = null;
  let inflight = null;
  let failure = null;
  async function snapshot(force) {
    if (!force && cache && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.data;
    if (!force && failure && Date.now() - failure.at < SNAPSHOT_ERROR_TTL_MS) throw failure.err;
    inflight ??= buildSnapshot({ meta, reports })
      .then((data) => {
        cache = { at: Date.now(), data };
        failure = null;
        return data;
      }, (err) => {
        failure = { at: Date.now(), err };
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }
  let igCache = null;
  async function igPosts(force) {
    if (!force && igCache && Date.now() - igCache.at < SNAPSHOT_TTL_MS) return igCache.data;
    const { igUserId } = await identity();
    if (!igUserId) throw new Error('la cuenta publicitaria no tiene una cuenta de Instagram vinculada (cargá META_ADS_IG_USER_ID)');
    const data = await loadIgPosts({ meta, repo, igUserId });
    igCache = { at: Date.now(), data };
    return data;
  }
  const invalidate = () => {
    cache = null;
    igCache = null;
  };

  async function runManual() {
    const { run, done } = await startRun('manual');
    done.finally(invalidate);
    return run;
  }

  r.get('/ads/overview', wrap(async (req, res) => {
    const [settings, runs, pendingCount, openQuestions] = await Promise.all([
      repo.getSettings(), repo.listRuns(1), repo.countPending(), repo.countOpenQuestions(),
    ]);
    let snap = null;
    let metaError = null;
    if (meta) {
      let timer;
      const slow = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('está tardando en responder (seguramente por el límite de llamadas); se sigue cargando, probá en un rato')), SNAPSHOT_WAIT_MS);
      });
      try {
        snap = await Promise.race([snapshot(req.query.refresh === '1'), slow]);
      } catch (err) {
        metaError = String(err.message || err);
        snap = cache?.data ?? null; // mejor la última foto que nada
      } finally {
        clearTimeout(timer);
      }
    }
    res.json({
      configured: { meta: Boolean(meta), agent: Boolean(startRun) },
      settings, lastRun: runs[0] ?? null, pendingCount, openQuestions, snapshot: snap, metaError, storeUrl: config.storeUrl,
    });
  }));

  // Para el globito de la navegación: sin tocar Meta
  r.get('/ads/badge', wrap(async (_req, res) => {
    const [pendingCount, openQuestions] = await Promise.all([repo.countPending(), repo.countOpenQuestions()]);
    res.json({ pendingCount, openQuestions });
  }));

  r.post('/ads/objects/:id/status', needMeta, wrap(async (req, res) => {
    const id = metaIdOf(req.params.id);
    const { level, status } = req.body ?? {};
    if (!LEVEL_LABEL[level]) throw bad('level inválido');
    if (!['ACTIVE', 'PAUSED'].includes(status)) throw bad('status inválido');
    const name = text(req.body.name, { max: 200, label: 'nombre' });
    const input = { level, object_id: id, object_name: name, status };
    const result = await execute('set_status', input);
    await repo.addDecision({
      tool: 'set_status', input, status: 'executed', result,
      title: `${status === 'ACTIVE' ? 'Activar' : 'Pausar'} ${LEVEL_LABEL[level]} ${name}`.trim(),
      reason: 'Hecho a mano desde el panel.',
    });
    invalidate();
    res.json({ ok: true });
  }));

  r.get('/ads/runs', wrap(async (_req, res) => res.json({ runs: await repo.listRuns(20) })));

  r.post('/ads/runs', needMeta, wrap(async (_req, res) => {
    if (!startRun) throw httpError(503, 'Falta la clave de Claude (ANTHROPIC_API_KEY) en el servidor.');
    res.status(202).json({ run: await runManual() });
  }));

  r.get('/ads/decisions', wrap(async (req, res) => {
    const { status } = req.query;
    if (status && !['pending', 'executed', 'rejected', 'failed'].includes(status)) throw bad('status inválido');
    res.json({ decisions: await repo.listDecisions({ status, limit: 100 }) });
  }));

  r.post('/ads/decisions/:id/approve', needMeta, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const d = await repo.claimPending(id, 'executed');
    try {
      const result = await execute(d.tool, d.input);
      await repo.setDecisionResult(id, { status: 'executed', result });
    } catch (err) {
      await repo.setDecisionResult(id, { status: 'failed', error: String(err.message || err) });
    }
    invalidate();
    res.json({ decision: await repo.getDecision(id) });
  }));

  r.post('/ads/decisions/:id/reject', wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    await repo.claimPending(id, 'rejected');
    res.json({ decision: await repo.getDecision(id) });
  }));

  // Videos sin miniatura todavía (Meta los estaba procesando al subirlos): se pide una vez más y queda guardada
  async function withThumbnails(creatives) {
    if (!meta) return creatives;
    await Promise.all(creatives.flatMap((c) => ['feed', 'story'].map(async (slot) => {
      const m = c[slot];
      if (m?.kind !== 'video' || m.thumbnail_url) return;
      try {
        m.thumbnail_url = await meta.videoThumbnail(m.video_id);
        if (m.thumbnail_url) await repo.setThumbnail(c.id, slot, m.thumbnail_url);
      } catch {
        // sigue sin miniatura: el panel muestra el ícono de video
      }
    })));
    return creatives;
  }

  r.get('/ads/creatives', wrap(async (_req, res) => {
    res.json({ creatives: await withThumbnails(await repo.listCreatives()) });
  }));

  r.post('/ads/creatives', wrap(async (req, res) => {
    const b = req.body ?? {};
    const link = text(b.link, { max: 1000, label: 'el link' }) || config.storeUrl;
    if (!isStoreLink(link)) throw bad('El link tiene que empezar con https://');
    const creative = await repo.createCreative({
      name: text(b.name, { max: 60, required: true, label: 'el nombre' }),
      copy: text(b.copy, { max: 2000, required: true, label: 'el texto del anuncio' }),
      headline: text(b.headline, { max: 80, label: 'el título' }),
      notes: text(b.notes, { max: 2000, label: 'las notas' }),
      link,
    });
    res.status(201).json({ creative });
  }));

  r.patch('/ads/creatives/:id', wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const b = req.body ?? {};
    const patch = {};
    if (b.status !== undefined) {
      if (!['unused', 'archived'].includes(b.status)) throw bad('status inválido');
      patch.status = b.status;
    }
    for (const [k, max] of [['name', 60], ['copy', 2000], ['headline', 80], ['notes', 2000]]) {
      if (b[k] !== undefined) patch[k] = text(b[k], { max, required: k === 'name' || k === 'copy', label: k });
    }
    if (b.link !== undefined) {
      if (!isStoreLink(b.link)) throw bad('El link tiene que empezar con https://');
      patch.link = b.link;
    }
    const current = await repo.getCreative(id);
    if (['used', 'publishing'].includes(current.status)) throw httpError(409, 'Esta pieza ya está publicada en Meta.');
    res.json({ creative: await repo.updateCreative(id, patch) });
  }));

  // Archivo de la pieza: el cuerpo es el archivo crudo. Va directo a la biblioteca de Meta
  // (imagen → hash; video → id), así no hace falta storage propio.
  r.put('/ads/creatives/:id/media/:slot', needMeta, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const { slot } = req.params;
    if (!['feed', 'story'].includes(slot)) throw httpError(404, 'no encontrado');
    const creative = await repo.getCreative(id);
    if (creative.status !== 'unused') throw httpError(409, 'Esta pieza ya no se puede editar.');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const originalName = decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 200);
    const declared = Number(req.get('content-length'));

    if (IMAGE_TYPES.includes(mime)) {
      if (declared > IMAGE_MAX) throw httpError(413, 'La imagen pesa más de 8 MB.');
      const buffer = await readBuffer(req, IMAGE_MAX, 'La imagen pesa más de 8 MB.');
      if (!isJpgOrPng(buffer)) throw httpError(415, 'Solo se aceptan imágenes JPG o PNG.');
      const img = await meta.uploadImage(buffer);
      const media = await repo.setMedia(id, slot, { kind: 'image', imageHash: img.hash, imageUrl: img.url, originalName });
      return res.status(201).json({ media });
    }
    if (!VIDEO_TYPES.includes(mime)) throw httpError(415, 'Elegí una imagen JPG/PNG o un video MP4/MOV.');
    if (declared > VIDEO_MAX) throw httpError(413, 'El video pesa más de 200 MB.');
    const tmp = path.join(os.tmpdir(), `ad-${crypto.randomUUID()}.mp4`);
    try {
      await pipeline(req, sizeLimit(VIDEO_MAX, 'El video pesa más de 200 MB.'), fs.createWriteStream(tmp));
      const head = Buffer.alloc(12);
      const fh = await fs.promises.open(tmp);
      await fh.read(head, 0, 12, 0).finally(() => fh.close());
      if (!isMp4OrMov(head)) throw httpError(415, 'El archivo no es un video MP4 o MOV.');
      const videoId = await meta.uploadVideoFile(tmp, originalName || creative.name);
      const media = await repo.setMedia(id, slot, { kind: 'video', videoId, originalName });
      res.status(201).json({ media });
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }));

  r.post('/ads/creatives/:id/publish', needMeta, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const adsetId = metaIdOf(req.body?.adset_id);
    const adsetName = text(req.body?.adset_name, { max: 200, label: 'conjunto' });
    const creative = await repo.getCreative(id);
    const input = { creative_id: id, adset_id: adsetId, adset_name: adsetName };
    const base = { tool: 'create_ad', input, title: `Publicar "${creative.name}" en ${adsetName || adsetId}`, reason: 'Hecho a mano desde el panel.' };
    try {
      const result = await execute('create_ad', input);
      await repo.addDecision({ ...base, status: 'executed', result });
      invalidate();
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status === 409) throw err;
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      throw httpError(502, `Meta rechazó el anuncio: ${err.message}`);
    }
  }));

  r.get('/ads/ig-posts', needMeta, wrap(async (req, res) => {
    try {
      res.json({ posts: await igPosts(req.query.refresh === '1') });
    } catch (err) {
      throw httpError(502, `Instagram no respondió: ${err.message}`);
    }
  }));

  r.post('/ads/ig-posts/:mediaId/promote', needMeta, wrap(async (req, res) => {
    const mediaId = metaIdOf(req.params.mediaId);
    const b = req.body ?? {};
    const adsetId = metaIdOf(b.adset_id);
    const adsetName = text(b.adset_name, { max: 200, label: 'conjunto' });
    const link = text(b.link, { max: 1000, label: 'el link' });
    if (link && !isStoreLink(link)) throw bad('El link tiene que empezar con https://');
    const input = { ig_media_id: mediaId, adset_id: adsetId, adset_name: adsetName, permalink: text(b.permalink, { max: 500, label: 'permalink' }), link: link || config.storeUrl };
    const base = { tool: 'promote_ig_post', input, title: `Promocionar post de Instagram en ${adsetName || adsetId}`, reason: 'Hecho a mano desde el panel.' };
    try {
      const result = await execute('promote_ig_post', input);
      await repo.addDecision({ ...base, status: 'executed', result });
      invalidate();
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status === 409) throw err;
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      throw httpError(502, `Meta rechazó el anuncio: ${err.message}`);
    }
  }));

  r.get('/ads/requests', wrap(async (_req, res) => res.json({ requests: await repo.listRequests({ status: 'open' }) })));
  r.post('/ads/requests/:id/done', wrap(async (req, res) => res.json({ request: await repo.closeRequest(uuidParam(req.params.id)) })));

  r.get('/ads/learnings', wrap(async (_req, res) => res.json({ learnings: await repo.listLearnings() })));
  r.delete('/ads/learnings/:id', wrap(async (req, res) => {
    await repo.deleteLearning(uuidParam(req.params.id));
    res.json({ ok: true });
  }));

  r.get('/ads/questions', wrap(async (req, res) => {
    const status = req.query.status || 'open';
    if (!['open', 'answered'].includes(status)) throw bad('status inválido');
    res.json({ questions: await repo.listQuestions({ status, limit: 30 }) });
  }));

  r.post('/ads/questions/:id/answer', wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const answer = text(req.body?.answer, { max: 2000, required: true, label: 'la respuesta' });
    const question = await repo.answerQuestion(id, answer);
    let run = null;
    let note = null;
    if (req.body?.analyze === true) {
      if (!startRun || !meta) {
        note = 'Respuesta guardada. El agente no está configurado para analizar ahora.';
      } else {
        try {
          run = await runManual();
        } catch (err) {
          if (err.status !== 409) throw err;
          note = 'Ya hay un análisis corriendo: el agente la toma en el próximo.';
        }
      }
    }
    res.json({ question, run, note });
  }));

  r.post('/ads/questions/:id/dismiss', wrap(async (req, res) => {
    res.json({ question: await repo.dismissQuestion(uuidParam(req.params.id)) });
  }));

  r.get('/ads/settings', wrap(async (_req, res) => res.json({ settings: await repo.getSettings() })));
  r.put('/ads/settings', wrap(async (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (!SETTINGS[k]) throw bad(`campo desconocido: ${k}`);
      if (!SETTINGS[k](v)) throw bad(`${k} inválido`);
      patch[k] = v;
    }
    res.json({ settings: await repo.updateSettings(patch) });
  }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if ([400, 404, 409, 413, 415, 502, 503].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error('[api pauta]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return r;
}
