export function createSyncRunsRepo(db) {
  return {
    async start(source) {
      const { rows } = await db.query('INSERT INTO sync_runs (source) VALUES ($1) RETURNING id::int AS id', [source]);
      return rows[0].id;
    },
    async progress(id, { rows, cursor }) {
      await db.query('UPDATE sync_runs SET rows = $2, cursor = $3 WHERE id = $1', [id, rows, cursor ? JSON.stringify(cursor) : null]);
    },
    async finish(id, { status, rows = 0, error = null, cursor = null }) {
      await db.query(
        `UPDATE sync_runs SET finished_at = now(), status = $2, rows = $3, error = $4, cursor = COALESCE($5::jsonb, cursor)
          WHERE id = $1`,
        [id, status, rows, error, cursor ? JSON.stringify(cursor) : null],
      );
    },
    async lastCursor(source) {
      const { rows } = await db.query(
        'SELECT cursor FROM sync_runs WHERE source = $1 AND cursor IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1',
        [source],
      );
      return rows[0]?.cursor ?? null;
    },
    async latestBySource() {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (source) source, started_at, finished_at, status, rows, error
           FROM sync_runs ORDER BY source, started_at DESC, id DESC`,
      );
      return rows;
    },
    async lastSuccessBySource() {
      const { rows } = await db.query("SELECT source, max(finished_at) AS finished_at FROM sync_runs WHERE status = 'ok' GROUP BY source");
      return rows;
    },
    async recentErrors(limit = 10) {
      const { rows } = await db.query(
        "SELECT source, started_at, error FROM sync_runs WHERE status = 'error' ORDER BY started_at DESC, id DESC LIMIT $1",
        [limit],
      );
      return rows;
    },
    async markStaleRunning() {
      await db.query("UPDATE sync_runs SET status = 'error', error = 'interrumpida (reinicio del servidor)', finished_at = now() WHERE status = 'running'");
    },
  };
}
