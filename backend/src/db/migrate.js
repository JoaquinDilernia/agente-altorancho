import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Aplica en orden los .sql de migrations/ que todavía no estén en schema_migrations.
export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await fs.readFile(path.join(DIR, f), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${f}');\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}
