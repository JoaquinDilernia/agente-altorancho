// Corre jobs de sincronización: uno por source a la vez (lock en memoria, una sola réplica),
// registrando cada corrida en sync_runs. run() nunca lanza: los errores quedan en la corrida.
export function createJobRunner({ syncRuns, log = console }) {
  const running = new Set();

  async function run(source, fn) {
    if (running.has(source)) return { skipped: true };
    running.add(source);
    try {
      const id = await syncRuns.start(source);
      const ctx = {
        rows: 0,
        cursor: null,
        async progress(rows, cursor) {
          ctx.rows = rows;
          if (cursor) ctx.cursor = cursor;
          await syncRuns.progress(id, { rows: ctx.rows, cursor: ctx.cursor });
        },
      };
      try {
        const rows = await fn(ctx);
        const total = typeof rows === 'number' ? rows : ctx.rows;
        await syncRuns.finish(id, { status: 'ok', rows: total, cursor: ctx.cursor });
        return { ok: true, rows: total };
      } catch (err) {
        log.error(`[job ${source}] falló:`, err);
        const message = String(err?.message || err);
        await syncRuns.finish(id, { status: 'error', rows: ctx.rows, error: message.slice(0, 2000), cursor: ctx.cursor });
        return { ok: false, error: message };
      }
    } catch (err) {
      log.error(`[job ${source}] no se pudo registrar:`, err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running.delete(source);
    }
  }

  function runInBackground(source, fn) {
    if (running.has(source)) return false;
    run(source, fn);
    return true;
  }

  return { run, runInBackground, isRunning: (source) => running.has(source) };
}
