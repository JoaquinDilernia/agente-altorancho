import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { migrate } from '../src/db/migrate.js';

describe('migraciones', () => {
  it('crea todas las tablas', async () => {
    const db = await createTestDb();
    const { rows } = await db.query(
      "SELECT table_name::text AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((r) => r.t)).toEqual([
      'meta_ads', 'meta_spend_daily', 'order_attribution', 'order_items', 'orders', 'schema_migrations', 'sync_runs',
    ]);
    await db.close();
  });
  it('es idempotente: correrla de nuevo no aplica nada', async () => {
    const db = await createTestDb();
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });
  it('tx hace rollback si falla', async () => {
    const db = await createTestDb();
    await expect(db.tx(async (q) => {
      await q.query("INSERT INTO sync_runs (source) VALUES ('x')");
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM sync_runs');
    expect(rows[0].n).toBe(0);
    await db.close();
  });
});
