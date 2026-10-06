import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { createJobRunner } from '../src/sync/jobs.js';

let db; let runs; let jobs;
const silent = { error: () => {}, log: () => {} };
beforeEach(async () => {
  db = await createTestDb();
  runs = createSyncRunsRepo(db);
  jobs = createJobRunner({ syncRuns: runs, log: silent });
});
afterEach(() => db.close());

describe('jobRunner', () => {
  it('registra corrida ok con filas', async () => {
    expect(await jobs.run('meta_spend', async () => 42)).toEqual({ ok: true, rows: 42 });
    expect((await runs.latestBySource())[0]).toMatchObject({ source: 'meta_spend', status: 'ok', rows: 42 });
  });
  it('registra error sin lanzar y guarda el último cursor', async () => {
    const r = await jobs.run('tn_backfill', async (ctx) => {
      await ctx.progress(7, { done: '2026-01', complete: false });
      throw new Error('se cayó TN');
    });
    expect(r).toEqual({ ok: false, error: 'se cayó TN' });
    expect((await runs.latestBySource())[0]).toMatchObject({ status: 'error', rows: 7, error: 'se cayó TN' });
    expect(await runs.lastCursor('tn_backfill')).toEqual({ done: '2026-01', complete: false });
  });
  it('no corre dos veces el mismo job en paralelo', async () => {
    let release;
    const first = jobs.run('tn_incremental', () => new Promise((r) => { release = () => r(1); }));
    await new Promise((r) => setTimeout(r, 5));
    expect(jobs.isRunning('tn_incremental')).toBe(true);
    expect(await jobs.run('tn_incremental', async () => 1)).toEqual({ skipped: true });
    expect(jobs.runInBackground('tn_incremental', async () => 1)).toBe(false);
    release();
    await first;
    expect(jobs.isRunning('tn_incremental')).toBe(false);
  });
});
