import { describe, it, expect } from 'vitest';
import { detectCandidates } from '../src/agent/candidates.js';
import { DEFAULT_CONFIG } from '../src/repo/agentConfig.js';
import { withRatios } from '../src/repo/agentMetrics.js';

const mm = (o = {}) => withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 10000, clicks: 200, metaPurchases: 0, metaValue: 0, ...o });
const obj = (id, o = {}) => ({
  id, level: 'campaign', name: `obj ${id}`, status: 'ACTIVE', campaignId: id, parentId: null, objective: 'OUTCOME_SALES', isSales: true,
  ageDays: 30, learning: false, statusUpdatedAt: null, budgetOwner: null, coverage: 1, m7: mm(), mPrev: mm(), m30: mm(), ...o,
});
const BASE = { spend: 100000, sales: 100, revenue: 400000, roas: 4, cpa: 1000 };
const run = (objects, { recent = [], config = DEFAULT_CONFIG, baseline = BASE } = {}) =>
  detectCandidates({ dataset: { today: '2026-10-06', baseline, objects }, config, recent });
const signals = (cs) => cs.map((c) => `${c.signal}:${c.objectId}${c.targetId ? `>${c.targetId}` : ''}`);

describe('gasta sin vender', () => {
  it('activo y maduro con gasto ≥ 2×CPA y 0 ventas → pausar', () => {
    const [c] = run([obj('A', { m7: mm({ spend: 2500 }) })]);
    expect(c).toMatchObject({ key: 'gasta_sin_vender:A', suggested: 'pause', doubtful: false });
  });
  it('si Meta dice que vendió ≥ 2 → dudoso por atribución', () => {
    expect(run([obj('A', { m7: mm({ spend: 2500, metaPurchases: 3 }) })])[0].doubtful).toBe(true);
  });
  it('en aprendizaje solo si el gasto es ≥ 4×CPA', () => {
    expect(run([obj('A', { learning: true, m7: mm({ spend: 2500 }) })])).toEqual([]);
    expect(signals(run([obj('A', { learning: true, m7: mm({ spend: 4500 }) })]))).toEqual(['gasta_sin_vender:A']);
  });
  it('un hijo no se repite si su campaña ya gasta sin vender', () => {
    const cs = run([
      obj('C', { m7: mm({ spend: 9000 }) }),
      obj('S', { level: 'adset', campaignId: 'C', parentId: 'C', m7: mm({ spend: 3000 }) }),
    ]);
    expect(signals(cs)).toEqual(['gasta_sin_vender:C']);
  });
});

describe('caro y ganador', () => {
  it('caro con presupuesto propio → bajar presupuesto; sin presupuesto (anuncio) → pausar', () => {
    const cs = run([
      obj('C', { budgetOwner: { id: 'C', level: 'campaign', daily: 50000 }, m7: mm({ spend: 4000, sales: 2, revenue: 6000 }) }),
      obj('AD', { level: 'ad', campaignId: 'X', parentId: 'S', m7: mm({ spend: 3500, sales: 1, revenue: 1000 }) }),
    ]);
    expect(cs.find((c) => c.objectId === 'C')).toMatchObject({ signal: 'caro', suggested: 'budget_down', budget: 50000 });
    expect(cs.find((c) => c.objectId === 'AD')).toMatchObject({ signal: 'caro', suggested: 'pause' });
  });
  it('ganador con tendencia estable → subir; si viene cayendo fuerte → no', () => {
    const owner = { budgetOwner: { id: 'G', level: 'campaign', daily: 30000 } };
    expect(signals(run([obj('G', { ...owner, m7: mm({ spend: 5000, sales: 5, revenue: 40000 }), mPrev: mm({ spend: 5000, sales: 5, revenue: 42000 }) })])))
      .toEqual(['ganador:G']);
    expect(run([obj('G', { ...owner, m7: mm({ spend: 5000, sales: 5, revenue: 40000 }), mPrev: mm({ spend: 5000, sales: 9, revenue: 90000 }) })]))
      .toEqual([]);
  });
  it('caro + ganador del mismo nivel generan además una reasignación', () => {
    const cs = run([
      obj('CARO', { budgetOwner: { id: 'CARO', level: 'campaign', daily: 50000 }, m7: mm({ spend: 4000, sales: 2, revenue: 6000 }) }),
      obj('GAN', { budgetOwner: { id: 'GAN', level: 'campaign', daily: 30000 }, m7: mm({ spend: 5000, sales: 6, revenue: 40000 }) }),
    ]);
    expect(signals(cs)).toContain('reasignar:CARO>GAN');
    expect(cs.find((c) => c.signal === 'reasignar')).toMatchObject({ suggested: 'shift', budget: { from: 50000, to: 30000 } });
  });
});

describe('otras señales y protecciones', () => {
  it('fatiga: CTR del anuncio cae > 30%', () => {
    const cs = run([obj('AD', { level: 'ad', m7: mm({ spend: 500, sales: 1, revenue: 4000, impressions: 10000, clicks: 100 }), mPrev: mm({ impressions: 10000, clicks: 200 }) })]);
    expect(cs[0]).toMatchObject({ signal: 'fatiga', suggested: 'idea' });
  });
  it('pausado hace poco que vendía bien → reactivar; pausado hace meses → no', () => {
    const good = { status: 'PAUSED', m30: mm({ spend: 10000, sales: 8, revenue: 60000 }) };
    expect(signals(run([obj('P', { ...good, statusUpdatedAt: '2026-09-28T12:00:00.000Z' })]))).toEqual(['pausado_que_vendia:P']);
    expect(run([obj('P', { ...good, statusUpdatedAt: '2026-06-01T12:00:00.000Z' })])).toEqual([]);
  });
  it('campañas que no son de ventas, objetos nuevos y anuncios con poca cobertura no son candidatos', () => {
    expect(run([obj('E', { isSales: false, m7: mm({ spend: 9000 }) })])).toEqual([]);
    expect(run([obj('N', { ageDays: 1, budgetOwner: { id: 'N', level: 'campaign', daily: 1 }, m7: mm({ spend: 5000, sales: 6, revenue: 40000 }) })])).toEqual([]);
    expect(run([obj('AD', { level: 'ad', coverage: 0.3, m7: mm({ spend: 9000 }) })])).toEqual([]);
  });
  it('pendiente bloquea; rechazada reciente bloquea salvo que haya empeorado ≥ 30%', () => {
    const A = obj('A', { m7: mm({ spend: 2500 }) });
    expect(run([A], { recent: [{ status: 'pending', object_id: 'A' }] })).toEqual([]);
    const rejected = { status: 'rejected', object_id: 'A', decided_at: '2026-10-04T12:00:00Z', snapshot: { m7: { spend: 2400, roas: null } } };
    expect(run([A], { recent: [rejected] })).toEqual([]);
    const worse = obj('A', { m7: mm({ spend: 3200 }) });
    expect(signals(run([worse], { recent: [rejected] }))).toEqual(['gasta_sin_vender:A']);
  });
  it('ejecutada en los últimos días también bloquea (no reactivar lo que recién pausamos)', () => {
    const P = obj('P', { status: 'PAUSED', statusUpdatedAt: '2026-10-05T12:00:00.000Z', m30: mm({ spend: 10000, sales: 8, revenue: 60000 }) });
    expect(run([P], { recent: [{ status: 'executed', object_id: 'P', decided_at: '2026-10-05T12:00:00Z' }] })).toEqual([]);
  });
  it('sin línea de base no se juzga nada', () => {
    expect(run([obj('A', { m7: mm({ spend: 9000 }) })], { baseline: { spend: 0, sales: 0, revenue: 0, roas: null, cpa: null } })).toEqual([]);
  });
  it('ordena por gasto y respeta el máximo', () => {
    const config = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, maxCandidates: 2 } };
    const cs = run([obj('A', { m7: mm({ spend: 2500 }) }), obj('B', { m7: mm({ spend: 9000 }) }), obj('C', { m7: mm({ spend: 5000 }) })], { config });
    expect(cs.map((c) => c.objectId)).toEqual(['B', 'C']);
  });
});
