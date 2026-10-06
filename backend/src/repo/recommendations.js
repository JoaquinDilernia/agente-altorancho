const JSON_COLS = new Set(['current_value', 'proposed_value', 'snapshot', 'execution_result', 'previous_value', 'outcome']);
const encode = (k, v) => (JSON_COLS.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : v ?? null);
const COLUMNS = new Set(['run_id', 'type', 'status', 'level', 'object_id', 'target_id', 'title', 'reasoning', 'expected_impact',
  'confidence', 'dudoso_atribucion', 'signal', 'current_value', 'proposed_value', 'snapshot', 'decided_at', 'reject_reason',
  'executed_at', 'execution_result', 'previous_value', 'undo_until', 'undone_at', 'outcome', 'verdict']);

function setClause(fields, startIndex) {
  const keys = Object.keys(fields).filter((k) => COLUMNS.has(k));
  return {
    sql: keys.map((k, i) => `${k} = $${startIndex + i}`).join(', '),
    params: keys.map((k) => encode(k, fields[k])),
  };
}

const SELECT = `SELECT r.*, r.id::int AS id, o.name AS object_name, t.name AS target_name
  FROM recommendations r
  LEFT JOIN meta_ads o ON o.id = r.object_id
  LEFT JOIN meta_ads t ON t.id = r.target_id`;

export function createRecommendationsRepo(db) {
  return {
    async create(rec) {
      const keys = Object.keys(rec).filter((k) => COLUMNS.has(k) && rec[k] !== undefined);
      const { rows } = await db.query(
        `INSERT INTO recommendations (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::int AS id`,
        keys.map((k) => encode(k, rec[k])),
      );
      return rows[0].id;
    },
    async get(id) {
      const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
      return rows[0] || null;
    },
    async list({ statuses, type, beforeId, limit = 50 } = {}) {
      const params = [];
      const where = [];
      if (statuses?.length) { params.push(statuses); where.push(`r.status = ANY($${params.length}::text[])`); }
      if (type) { params.push(type); where.push(`r.type = $${params.length}`); }
      if (beforeId) { params.push(beforeId); where.push(`r.id < $${params.length}`); }
      params.push(limit);
      const { rows } = await db.query(
        `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
    async transition(id, fromStatuses, toStatus, fields = {}) {
      const set = setClause(fields, 4);
      const { rows } = await db.query(
        `UPDATE recommendations SET status = $2${set.sql ? `, ${set.sql}` : ''}
          WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`,
        [id, toStatus, fromStatuses, ...set.params],
      );
      return rows.length === 1;
    },
    async update(id, fields) {
      const set = setClause(fields, 2);
      if (!set.sql) return;
      await db.query(`UPDATE recommendations SET ${set.sql} WHERE id = $1`, [id, ...set.params]);
    },
    async recent({ days, now }) {
      const { rows } = await db.query(
        `${SELECT} WHERE r.created_at >= $1::timestamptz - ($2 || ' days')::interval ORDER BY r.id DESC`,
        [now, String(days)],
      );
      return rows;
    },
    async toMeasure({ now }) {
      const { rows } = await db.query(
        `${SELECT}
          WHERE r.status = 'executed' AND r.undone_at IS NULL AND r.executed_at IS NOT NULL
            AND ((r.executed_at <= $1::timestamptz - interval '3 days' AND (r.outcome IS NULL OR r.outcome->'d3' IS NULL))
              OR (r.executed_at <= $1::timestamptz - interval '7 days' AND (r.outcome IS NULL OR r.outcome->'d7' IS NULL)))
          ORDER BY r.id`,
        [now],
      );
      return rows;
    },
    async setOutcome(id, outcome, verdict) {
      await db.query('UPDATE recommendations SET outcome = $2, verdict = $3 WHERE id = $1', [id, JSON.stringify(outcome), verdict]);
    },
    async expire({ now, hours }) {
      const { rows } = await db.query(
        `UPDATE recommendations SET status = 'expired'
          WHERE status = 'pending' AND type <> 'idea' AND created_at <= $1::timestamptz - ($2 || ' hours')::interval
          RETURNING id`,
        [now, String(hours)],
      );
      return rows.length;
    },
    async countPending() {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM recommendations WHERE status = 'pending' AND type <> 'idea'");
      return rows[0].n;
    },
    async precision() {
      const { rows } = await db.query(
        `SELECT type, (count(*) FILTER (WHERE verdict = 'mejoro'))::int AS good, (count(*) FILTER (WHERE verdict IS NOT NULL))::int AS total
           FROM recommendations WHERE status IN ('executed', 'undone') AND verdict IS NOT NULL GROUP BY type ORDER BY type`,
      );
      return rows;
    },
    async measuredIds(ids) {
      if (!ids.length) return [];
      const { rows } = await db.query(
        'SELECT id::int AS id FROM recommendations WHERE id = ANY($1::int[]) AND verdict IS NOT NULL ORDER BY id',
        [ids],
      );
      return rows.map((r) => r.id);
    },
    async pendingRefs() {
      const { rows } = await db.query("SELECT id::int AS id, object_id, target_id FROM recommendations WHERE status = 'pending'");
      return rows;
    },
  };
}

export function createAgentRunsRepo(db) {
  const RUN_COLS = new Set(['status', 'baseline', 'candidates', 'skipped', 'input_tokens', 'output_tokens', 'cost_usd', 'error']);
  return {
    async start({ trigger, model, startedAt = null }) {
      const { rows } = await db.query(
        'INSERT INTO agent_runs (trigger, model, started_at) VALUES ($1, $2, COALESCE($3::timestamptz, now())) RETURNING id::int AS id',
        [trigger, model, startedAt],
      );
      return rows[0].id;
    },
    async finish(id, fields) {
      const keys = Object.keys(fields).filter((k) => RUN_COLS.has(k));
      const params = keys.map((k) => (['baseline', 'candidates', 'skipped'].includes(k) ? JSON.stringify(fields[k]) : fields[k]));
      await db.query(
        `UPDATE agent_runs SET finished_at = now()${keys.map((k, i) => `, ${k} = $${i + 2}`).join('')} WHERE id = $1`,
        [id, ...params],
      );
    },
    async manualCountSince(iso) {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM agent_runs WHERE trigger = 'manual' AND status <> 'skipped' AND started_at >= $1::timestamptz",
        [iso],
      );
      return rows[0].n;
    },
    async costSince(iso) {
      const { rows } = await db.query('SELECT COALESCE(sum(cost_usd), 0)::float8 AS c FROM agent_runs WHERE started_at >= $1::timestamptz', [iso]);
      return rows[0].c;
    },
    async last() {
      const { rows } = await db.query(
        `SELECT id::int AS id, trigger, started_at, finished_at, status, model, input_tokens, output_tokens, cost_usd::float8 AS cost_usd,
                error, jsonb_array_length(COALESCE(candidates, '[]'::jsonb))::int AS candidates_count
           FROM agent_runs ORDER BY id DESC LIMIT 1`,
      );
      return rows[0] || null;
    },
  };
}

export function createLearningsRepo(db) {
  return {
    async listActive() {
      const { rows } = await db.query("SELECT id::int AS id, text, evidence_ids, created_at FROM learnings WHERE status = 'active' ORDER BY id");
      return rows;
    },
    async create(text, evidenceIds) {
      const { rows } = await db.query('INSERT INTO learnings (text, evidence_ids) VALUES ($1, $2::int[]) RETURNING id::int AS id', [text, evidenceIds]);
      return rows[0].id;
    },
    async remove(id) {
      await db.query("UPDATE learnings SET status = 'deleted', updated_at = now() WHERE id = $1", [id]);
    },
  };
}
