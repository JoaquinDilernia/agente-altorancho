// INSERT … ON CONFLICT DO UPDATE en lotes. Deduplica por clave de conflicto
// (Postgres no permite tocar la misma fila dos veces en un mismo statement).
export async function bulkUpsert(db, { table, columns, conflict, rows, extraSet = [], chunk = 300 }) {
  const byKey = new Map();
  for (const r of rows) byKey.set(conflict.map((c) => r[c]).join('\u0000'), r);
  const unique = [...byKey.values()];
  const updates = [...columns.filter((c) => !conflict.includes(c)).map((c) => `${c} = EXCLUDED.${c}`), ...extraSet];
  for (let i = 0; i < unique.length; i += chunk) {
    const params = [];
    const tuples = unique.slice(i, i + chunk).map((r) => `(${columns.map((c) => {
      params.push(r[c] ?? null);
      return `$${params.length}`;
    }).join(', ')})`);
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
      params,
    );
  }
}
