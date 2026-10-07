import { bulkUpsert } from './bulk.js';
import { mapGa4Channel } from '../engine/ga4Channel.js';

const COLS = ['transaction_id', 'first_channel', 'first_group', 'first_source', 'first_medium', 'session_group', 'date'];
const ymd = (d) => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

export function createGa4Repo(db) {
  return {
    // rows: [{ transactionId, firstGroup, firstSource, firstMedium, sessionGroup, date (YYYYMMDD) }]
    async upsertTransactions(rows) {
      const clean = rows
        .filter((r) => r.transactionId && r.transactionId !== '(not set)')
        .map((r) => ({
          transaction_id: String(r.transactionId),
          first_channel: mapGa4Channel(r.firstGroup, r.firstSource, r.firstMedium),
          first_group: r.firstGroup || null,
          first_source: r.firstSource || null,
          first_medium: r.firstMedium || null,
          session_group: r.sessionGroup || null,
          date: ymd(r.date),
        }));
      await bulkUpsert(db, { table: 'ga4_transactions', columns: COLS, conflict: ['transaction_id'], rows: clean, extraSet: ['synced_at = now()'] });
      return clean.length;
    },
  };
}
