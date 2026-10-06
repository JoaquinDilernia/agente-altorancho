import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/db/migrate.js';

// Postgres real (WASM) en memoria, con la misma interfaz que createPgDb.
export async function createTestDb() {
  const pg = new PGlite();
  const db = {
    query: (text, params) => pg.query(text, params),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
