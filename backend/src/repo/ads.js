export const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const notFound = (msg) => httpError(404, msg);
const conflict = (msg) => httpError(409, msg);

const MEDIA_COLS = `
  (SELECT row_to_json(m) FROM ad_creative_media m WHERE m.creative_id = c.id AND m.slot = 'feed') AS feed,
  (SELECT row_to_json(m) FROM ad_creative_media m WHERE m.creative_id = c.id AND m.slot = 'story') AS story`;

export function createAdsRepo(db) {
  const one = async (sql, params, msg) => {
    const { rows } = await db.query(sql, params);
    if (!rows[0] && msg) throw notFound(msg);
    return rows[0];
  };

  return {
    getSettings: () => one('SELECT agent_enabled, autonomous, monthly_cap_ars, business_notes, updated_at FROM ad_settings WHERE id = 1'),
    async updateSettings(patch) {
      const cols = Object.keys(patch);
      if (!cols.length) return this.getSettings();
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await db.query(`UPDATE ad_settings SET ${set}, updated_at = now() WHERE id = 1`, Object.values(patch));
      return this.getSettings();
    },

    startRun: (kind) => one('INSERT INTO ad_runs (kind) VALUES ($1) RETURNING *', [kind]),
    finishRun: (id, { status, report = '', error = null, inputTokens = 0, outputTokens = 0 }) => one(
      `UPDATE ad_runs SET status = $2, report = $3, error = $4, input_tokens = $5, output_tokens = $6, finished_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status, report, error, inputTokens, outputTokens],
    ),
    runningRun: () => one("SELECT * FROM ad_runs WHERE status = 'running' AND started_at > now() - interval '30 minutes' ORDER BY started_at DESC LIMIT 1"),
    // Corridas que quedaron 'running' por un reinicio del servidor
    markStaleRuns: () => db.query("UPDATE ad_runs SET status = 'failed', error = 'El servidor se reinició durante el análisis.', finished_at = now() WHERE status = 'running'"),
    async listRuns(limit = 10) {
      const { rows } = await db.query('SELECT * FROM ad_runs ORDER BY started_at DESC LIMIT $1', [limit]);
      return rows;
    },

    addDecision: (d) => one(
      `INSERT INTO ad_decisions (run_id, tool, input, title, reason, expected_impact, status, result, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [d.runId ?? null, d.tool, d.input ?? {}, d.title ?? '', d.reason ?? '', d.expectedImpact ?? '', d.status, d.result ?? null, d.error ?? null],
    ),
    getDecision: (id) => one('SELECT * FROM ad_decisions WHERE id = $1', [id], 'No existe esa recomendación.'),
    async listDecisions({ status, limit = 50 } = {}) {
      const { rows } = await db.query(
        'SELECT * FROM ad_decisions WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2',
        [status ?? null, limit],
      );
      return rows;
    },
    countPending: async () => (await one("SELECT count(*)::int AS n FROM ad_decisions WHERE status = 'pending'")).n,
    // Marca la decisión como tomada solo si seguía pendiente (evita doble aprobación)
    async claimPending(id, status) {
      const { rows } = await db.query(
        "UPDATE ad_decisions SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
        [id, status],
      );
      if (!rows[0]) {
        await this.getDecision(id);
        throw conflict('Esta recomendación ya fue resuelta.');
      }
      return rows[0];
    },
    setDecisionResult: (id, { status, result = null, error = null }) => one(
      'UPDATE ad_decisions SET status = $2, result = $3, error = $4 WHERE id = $1 RETURNING *', [id, status, result, error],
    ),
    recordOutcome: (id, outcome) => one('UPDATE ad_decisions SET outcome = $2 WHERE id = $1 RETURNING id', [id, outcome], 'No existe esa decisión.'),
    async executedWithoutOutcome(olderThanHours = 48) {
      const { rows } = await db.query(
        `SELECT id, tool, input, title, reason, created_at, decided_at FROM ad_decisions
         WHERE status = 'executed' AND outcome IS NULL AND coalesce(decided_at, created_at) < now() - make_interval(hours => $1)
         ORDER BY created_at LIMIT 20`,
        [olderThanHours],
      );
      return rows;
    },

    createCreative: (c) => one(
      'INSERT INTO ad_creatives (name, copy, headline, link, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [c.name, c.copy, c.headline ?? '', c.link, c.notes ?? ''],
    ),
    getCreative: (id) => one(`SELECT c.*, ${MEDIA_COLS} FROM ad_creatives c WHERE c.id = $1`, [id], 'No existe esa pieza.'),
    async updateCreative(id, patch) {
      const cols = Object.keys(patch);
      if (!cols.length) return this.getCreative(id);
      const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await one(`UPDATE ad_creatives SET ${set} WHERE id = $1 RETURNING id`, [id, ...Object.values(patch)], 'No existe esa pieza.');
      return this.getCreative(id);
    },
    // La pieza se reclama antes de tocar Meta: un segundo "Publicar" a la vez recibe 409
    async claimCreative(id) {
      const { rows } = await db.query("UPDATE ad_creatives SET status = 'publishing' WHERE id = $1 AND status = 'unused' RETURNING id", [id]);
      if (rows[0]) return this.getCreative(id);
      const c = await this.getCreative(id);
      if (c.status === 'used') throw conflict(`La pieza "${c.name}" ya se publicó (anuncio ${c.meta_ad_id}).`);
      if (c.status === 'publishing') throw conflict(`La pieza "${c.name}" se está publicando. Esperá a que termine.`);
      throw conflict(`La pieza "${c.name}" está archivada.`);
    },
    releaseCreative: (id) => db.query("UPDATE ad_creatives SET status = 'unused' WHERE id = $1 AND status = 'publishing'", [id]),
    markCreativeUsed: (id, adId, adsetId) => one(
      "UPDATE ad_creatives SET status = 'used', meta_ad_id = $2, meta_adset_id = $3, used_at = now() WHERE id = $1 RETURNING *",
      [id, adId, adsetId],
    ),
    async listCreatives({ status } = {}) {
      const { rows } = await db.query(
        `SELECT c.*, ${MEDIA_COLS} FROM ad_creatives c WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.created_at DESC`,
        [status ?? null],
      );
      return rows;
    },
    // Una pieza tiene a lo sumo un archivo por ubicación: subir otro lo reemplaza
    setMedia: (creativeId, slot, m) => one(
      `INSERT INTO ad_creative_media (creative_id, slot, kind, image_hash, image_url, video_id, thumbnail_url, original_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (creative_id, slot) DO UPDATE SET kind = EXCLUDED.kind, image_hash = EXCLUDED.image_hash, image_url = EXCLUDED.image_url,
         video_id = EXCLUDED.video_id, thumbnail_url = EXCLUDED.thumbnail_url, original_name = EXCLUDED.original_name, created_at = now()
       RETURNING *`,
      [creativeId, slot, m.kind, m.imageHash ?? null, m.imageUrl ?? null, m.videoId ?? null, m.thumbnailUrl ?? null, m.originalName ?? ''],
    ),
    setThumbnail: (creativeId, slot, url) => db.query(
      'UPDATE ad_creative_media SET thumbnail_url = $3 WHERE creative_id = $1 AND slot = $2', [creativeId, slot, url],
    ),

    addRequest: (r) => one('INSERT INTO ad_creative_requests (concept, style_notes, reason) VALUES ($1, $2, $3) RETURNING *', [r.concept, r.styleNotes ?? '', r.reason ?? '']),
    async listRequests({ status = 'open' } = {}) {
      const { rows } = await db.query('SELECT * FROM ad_creative_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 50', [status]);
      return rows;
    },
    closeRequest: (id) => one("UPDATE ad_creative_requests SET status = 'done', closed_at = now() WHERE id = $1 RETURNING *", [id], 'No existe ese pedido.'),

    async upsertLearning({ learning_id: id, text, evidence, status = 'active' }) {
      if (id) {
        return one('UPDATE ad_learnings SET text = $2, evidence = $3, status = $4, updated_at = now() WHERE id = $1 RETURNING *',
          [id, text, evidence ?? '', status], 'No existe ese aprendizaje.');
      }
      return one('INSERT INTO ad_learnings (text, evidence, status) VALUES ($1, $2, $3) RETURNING *', [text, evidence ?? '', status]);
    },
    async listLearnings({ activeOnly = false } = {}) {
      const { rows } = await db.query(
        `SELECT * FROM ad_learnings WHERE ($1::boolean = false OR status = 'active') ORDER BY updated_at DESC LIMIT 100`, [activeOnly],
      );
      return rows;
    },
    async deleteLearning(id) {
      const { rowCount } = await db.query('DELETE FROM ad_learnings WHERE id = $1', [id]);
      if (!rowCount) throw notFound('No existe ese aprendizaje.');
    },

    // quick_answers es jsonb: el array va serializado (pg mandaría un array de Postgres)
    addQuestion: (q) => one(
      'INSERT INTO ad_questions (run_id, question, why, quick_answers) VALUES ($1, $2, $3, $4) RETURNING *',
      [q.runId ?? null, q.question, q.why ?? '', JSON.stringify(q.quickAnswers ?? [])],
    ),
    getQuestion: (id) => one('SELECT * FROM ad_questions WHERE id = $1', [id], 'No existe esa pregunta.'),
    async listQuestions({ status = 'open', limit = 30 } = {}) {
      const { rows } = await db.query(
        'SELECT * FROM ad_questions WHERE status = $1 ORDER BY coalesce(answered_at, created_at) DESC LIMIT $2',
        [status, limit],
      );
      return rows;
    },
    countOpenQuestions: async () => (await one("SELECT count(*)::int AS n FROM ad_questions WHERE status = 'open'")).n,
    // Solo si sigue abierta: evita responder dos veces la misma
    async answerQuestion(id, answer) {
      const { rows } = await db.query(
        "UPDATE ad_questions SET status = 'answered', answer = $2, answered_at = now() WHERE id = $1 AND status = 'open' RETURNING id",
        [id, answer],
      );
      if (!rows[0]) {
        await this.getQuestion(id);
        throw conflict('Esta pregunta ya fue respondida o descartada.');
      }
      return this.getQuestion(id);
    },
    async dismissQuestion(id) {
      const { rows } = await db.query("UPDATE ad_questions SET status = 'dismissed' WHERE id = $1 AND status = 'open' RETURNING id", [id]);
      if (!rows[0]) {
        await this.getQuestion(id);
        throw conflict('Esta pregunta ya fue respondida o descartada.');
      }
      return this.getQuestion(id);
    },
    // Respondidas desde que ARRANCÓ la última corrida terminada: lo que se contestó durante esa corrida no lo vio
    async answeredSinceLastRun() {
      const { rows } = await db.query(
        `SELECT question, answer, answered_at FROM ad_questions
         WHERE status = 'answered'
           AND answered_at > coalesce((SELECT max(started_at) FROM ad_runs WHERE status = 'done'), '-infinity'::timestamptz)
         ORDER BY answered_at LIMIT 20`,
      );
      return rows;
    },

    // Reserva antes de llamar a Meta: si el post ya está (o se está promocionando) en ese conjunto, 409
    async reserveIgPromotion(p) {
      const { rows } = await db.query(
        `INSERT INTO ad_ig_promotions (ig_media_id, permalink, meta_adset_id, adset_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (ig_media_id, meta_adset_id) DO NOTHING RETURNING *`,
        [p.igMediaId, p.permalink ?? '', p.adsetId, p.adsetName ?? ''],
      );
      if (!rows[0]) throw conflict('Ese post ya está promocionado en ese conjunto.');
      return rows[0];
    },
    completeIgPromotion: (id, adId) => one('UPDATE ad_ig_promotions SET meta_ad_id = $2 WHERE id = $1 RETURNING *', [id, adId]),
    releaseIgPromotion: (id) => db.query('DELETE FROM ad_ig_promotions WHERE id = $1 AND meta_ad_id IS NULL', [id]),
    async listIgPromotions() {
      const { rows } = await db.query('SELECT * FROM ad_ig_promotions WHERE meta_ad_id IS NOT NULL ORDER BY created_at DESC LIMIT 500');
      return rows;
    },
  };
}
