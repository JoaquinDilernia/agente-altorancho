import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from '../src/repo/recommendations.js';
import { createMetaRepo } from '../src/repo/meta.js';

let db; let recs; let runs; let learnings;
beforeEach(async () => {
  db = await createTestDb();
  recs = createRecommendationsRepo(db);
  runs = createAgentRunsRepo(db);
  learnings = createLearningsRepo(db);
});
afterEach(() => db.close());

const base = (o = {}) => ({
  type: 'pause', level: 'ad', object_id: '1000001', title: 'Pausar X', reasoning: 'porque', expected_impact: 'baja CPA',
  confidence: 'alta', signal: 'gasta_sin_vender', current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' },
  snapshot: { m7: { spend: 2500 } }, ...o,
});

describe('recommendationsRepo', () => {
  it('create/get con nombres del catálogo y jsonb', async () => {
    await createMetaRepo(db).upsertAds([{ id: '1000001', level: 'ad', name: 'Anuncio uno', status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null, has_attribution_params: false }]);
    const id = await recs.create(base());
    const r = await recs.get(id);
    expect(r).toMatchObject({ id, status: 'pending', object_name: 'Anuncio uno', proposed_value: { status: 'PAUSED' }, snapshot: { m7: { spend: 2500 } } });
    expect(await recs.get(999)).toBeNull();
  });
  it('transition es atómica: la segunda aprobación no pasa', async () => {
    const id = await recs.create(base());
    expect(await recs.transition(id, ['pending'], 'approved', { decided_at: new Date().toISOString() })).toBe(true);
    expect(await recs.transition(id, ['pending'], 'approved')).toBe(false);
    expect((await recs.get(id)).status).toBe('approved');
  });
  it('list filtra por estado y tipo; countPending no cuenta ideas', async () => {
    await recs.create(base());
    await recs.create(base({ type: 'idea', object_id: null, current_value: null, proposed_value: null }));
    const done = await recs.create(base({ object_id: '2' }));
    await recs.transition(done, ['pending'], 'rejected');
    expect((await recs.list({ statuses: ['pending'] })).length).toBe(2);
    expect((await recs.list({ statuses: ['pending'], type: 'idea' })).length).toBe(1);
    expect(await recs.countPending()).toBe(1);
    expect((await recs.pendingRefs()).map((r) => r.object_id).sort()).toEqual([null, '1000001'].sort());
  });
  it('expire vence pendientes viejas', async () => {
    const id = await recs.create(base());
    await db.query("UPDATE recommendations SET created_at = now() - interval '50 hours' WHERE id = $1", [id]);
    expect(await recs.expire({ now: new Date().toISOString(), hours: 48 })).toBe(1);
    expect((await recs.get(id)).status).toBe('expired');
  });
  it('toMeasure devuelve las que deben medición a 3 y 7 días; precision por tipo', async () => {
    const a = await recs.create(base());
    const b = await recs.create(base({ object_id: '2' }));
    await recs.transition(a, ['pending'], 'executed', { executed_at: '2026-10-01T12:00:00Z' });
    await recs.transition(b, ['pending'], 'executed', { executed_at: '2026-09-20T12:00:00Z' });
    await recs.setOutcome(b, { d3: { verdict: 'mejoro' } }, 'mejoro');
    const due = await recs.toMeasure({ now: '2026-10-06T12:00:00Z' });
    expect(due.map((r) => r.id).sort()).toEqual([a, b].sort()); // a debe d3; b debe d7
    await recs.setOutcome(b, { d3: { verdict: 'mejoro' }, d7: { verdict: 'mejoro' } }, 'mejoro');
    expect((await recs.toMeasure({ now: '2026-10-06T12:00:00Z' })).map((r) => r.id)).toEqual([a]);
    expect(await recs.precision()).toEqual([{ type: 'pause', good: 1, total: 1 }]);
    expect(await recs.measuredIds([a, b])).toEqual([b]);
  });
  it('recent trae las de los últimos N días', async () => {
    const id = await recs.create(base());
    await db.query("UPDATE recommendations SET created_at = now() - interval '20 days' WHERE id = $1", [id]);
    await recs.create(base({ object_id: '2' }));
    expect((await recs.recent({ days: 14, now: new Date().toISOString() })).map((r) => r.object_id)).toEqual(['2']);
  });
});

describe('agentRunsRepo y learningsRepo', () => {
  it('cuenta corridas manuales y costo desde una fecha', async () => {
    const r1 = await runs.start({ trigger: 'manual', model: 'claude-opus-5-5' });
    await runs.finish(r1, { status: 'ok', input_tokens: 100, output_tokens: 50, cost_usd: 0.12 });
    const r2 = await runs.start({ trigger: 'cron', model: 'claude-opus-5-5' });
    await runs.finish(r2, { status: 'ok', cost_usd: 0.2 });
    const since = new Date(Date.now() - 3600e3).toISOString();
    expect(await runs.manualCountSince(since)).toBe(1);
    expect(await runs.costSince(since)).toBeCloseTo(0.32);
    expect((await runs.last()).id).toBe(r2);
  });
  it('lecciones: crear, listar activas, borrar', async () => {
    const id = await learnings.create('Las DPA venden tarde', [1, 2, 3]);
    expect((await learnings.listActive()).map((l) => l.text)).toEqual(['Las DPA venden tarde']);
    await learnings.remove(id);
    expect(await learnings.listActive()).toEqual([]);
  });
});
