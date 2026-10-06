import { useState, useCallback, useEffect } from 'react';
import RecommendationCard, { TYPE_LABEL } from '../components/RecommendationCard.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtDateTime, fmtRelative } from '../lib/format.js';

const TABS = [
  { id: 'pendientes', label: 'Pendientes' },
  { id: 'historial', label: 'Historial' },
  { id: 'aprendizaje', label: 'Aprendizaje' },
  { id: 'config', label: 'Configuración' },
];
const STATUS_LABEL = {
  pending: 'Pendiente', approved: 'Aprobada (sin ejecutar)', executed: 'Ejecutada', failed: 'Falló', rejected: 'Rechazada',
  expired: 'Vencida', stale: 'Desactualizada', undone: 'Deshecha', seen: 'Vista',
};
const VERDICT = { mejoro: 'Mejoró', neutral: 'Neutral', empeoro: 'Empeoró' };

function verdictText(rec) {
  if (!rec.verdict) return null;
  const o = rec.outcome?.d7 || rec.outcome?.d3;
  const pct = o?.change === null || o?.change === undefined ? '' : ` ${o.change >= 0 ? '+' : ''}${Math.round(o.change * 100)}%`;
  return `${VERDICT[rec.verdict]}${pct}`;
}

function approveNotice(res) {
  switch (res?.status) {
    case 'executed': return { ok: true, text: 'Listo: se aplicó en Meta. Podés deshacerlo desde Historial durante 24 h.' };
    case 'approved': return { ok: true, text: 'Aprobada. No se tocó Meta porque la ejecución está apagada.' };
    case 'stale': return { ok: false, text: 'No se ejecutó: cambió en Meta desde la recomendación.' };
    case 'failed': return { ok: false, text: `No se pudo ejecutar: ${res.error || 'error desconocido'}` };
    default: return null;
  }
}

function executionDetail(r) {
  const e = r.execution_result;
  if (!e) return null;
  if (e.partial) return `Quedó a mitad: el origen ya bajó a ${e.partial.applied_from}. Revisalo en Ads Manager.`;
  if (e.reason) return e.reason;
  return null;
}

function Pendientes({ api, overview, reloadOverview }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const { data: recs, reload } = usePolling(() => api.get('/recommendations?group=pending'), [api], 60_000);

  const act = useCallback(async (id, fn, describe) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (describe) setNotice(describe(res));
      reload();
      reloadOverview();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, [reload, reloadOverview]);

  const runNow = () => act('run', () => api.post('/agent/run'));
  const actions = (recs || []).filter((r) => r.type !== 'idea');
  const ideas = (recs || []).filter((r) => r.type === 'idea');
  const last = overview?.lastRun;
  const left = overview?.manualRemaining ?? 0;

  return (
    <>
      {overview && (
        <div className="banner">
          {last ? `Último análisis: ${fmtDateTime(last.started_at)} · ${last.candidates_count} candidatos · USD ${Number(last.cost_usd).toFixed(2)}` : 'Todavía no hubo análisis.'}
          {last?.status === 'error' && <div className="error">El último análisis falló.</div>}
          {!overview.executionEnabled && <div>La ejecución está apagada: aprobar solo registra la decisión (se activa en Configuración).</div>}
        </div>
      )}
      <div className="actions" style={{ marginBottom: 12 }}>
        <button type="button" className="btn secondary" disabled={left <= 0 || overview?.running || busy === 'run'} onClick={runNow}>
          {overview?.running ? 'Analizando…' : left > 0 ? `Analizar ahora (te quedan ${left})` : 'Disponible mañana'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p role="status" className={notice.ok ? 'banner' : 'banner error'}>{notice.text}</p>}
      {recs && actions.length === 0 && <p className="muted">No hay recomendaciones pendientes.</p>}
      {actions.map((r) => (
        <RecommendationCard key={r.id} rec={r} busy={busy === r.id}
          onApprove={(amount) => act(r.id, () => api.post(`/recommendations/${r.id}/approve`, amount === undefined ? {} : { amount }), approveNotice)}
          onReject={(reason) => act(r.id, () => api.post(`/recommendations/${r.id}/reject`, { reason }))} />
      ))}
      {ideas.length > 0 && (
        <>
          <h2 className="section-title">Ideas</h2>
          <ul className="list">
            {ideas.map((r) => (
              <li key={r.id} className="row">
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: 'normal' }}>{r.title}</div>
                  <div className="note">{r.reasoning}</div>
                </div>
                <div className="row-side">
                  <button type="button" className="chip" disabled={busy === r.id} onClick={() => act(r.id, () => api.post(`/recommendations/${r.id}/seen`))}>Vista</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Historial({ api }) {
  const [type, setType] = useState('');
  const [error, setError] = useState(null);
  const { data: recs, reload } = usePolling(() => api.get(`/recommendations?group=history${type ? `&type=${type}` : ''}`), [api, type], 120_000);
  const undo = async (id) => {
    setError(null);
    try {
      await api.post(`/recommendations/${id}/undo`);
      reload();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <>
      <div className="chips" style={{ marginBottom: 10 }}>
        {[['', 'Todas'], ...Object.entries(TYPE_LABEL)].map(([id, label]) => (
          <button key={id || 'all'} type="button" className={type === id ? 'chip active' : 'chip'} onClick={() => setType(id)}>{label}</button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {(recs || []).map((r) => {
          const canUndo = r.status === 'executed' && r.undo_until && new Date(r.undo_until) > new Date();
          return (
            <li key={r.id} className="row">
              <div className="row-main">
                <div className="row-title" style={{ whiteSpace: 'normal' }}>{r.title}</div>
                <div className="row-sub">
                  <span className={['failed', 'stale'].includes(r.status) ? 'badge warn' : 'badge'}>{STATUS_LABEL[r.status]}</span>
                  {r.decided_at && <span>{fmtRelative(r.decided_at)}</span>}
                  {r.reject_reason && <span>· {r.reject_reason}</span>}
                </div>
                {verdictText(r) && <div className="note">Resultado: {verdictText(r)}</div>}
                {r.execution_result?.error && <div className="error">Error: {r.execution_result.error}</div>}
                {executionDetail(r) && <div className="note">{executionDetail(r)}</div>}
              </div>
              {canUndo && (
                <div className="row-side"><button type="button" className="chip" onClick={() => undo(r.id)}>Deshacer</button></div>
              )}
            </li>
          );
        })}
      </ul>
      {recs && recs.length === 0 && <p className="muted">Todavía no hay historial.</p>}
    </>
  );
}

function Aprendizaje({ api, overview }) {
  const { data: learnings, reload } = usePolling(() => api.get('/learnings'), [api], 300_000);
  const remove = async (id) => {
    await api.del(`/learnings/${id}`);
    reload();
  };
  return (
    <>
      <h2 className="section-title" style={{ marginTop: 0 }}>Precisión del agente</h2>
      {(overview?.precision || []).length === 0 && <p className="muted">Todavía no hay resultados medidos.</p>}
      <ul className="list">
        {(overview?.precision || []).map((p) => (
          <li key={p.type} className="row"><span>{TYPE_LABEL[p.type]}</span><span>{p.good} de {p.total} mejoraron</span></li>
        ))}
      </ul>
      <h2 className="section-title">Lecciones</h2>
      {(learnings || []).length === 0 && <p className="muted">El agente todavía no guardó lecciones.</p>}
      <ul className="list">
        {(learnings || []).map((l) => (
          <li key={l.id} className="row">
            <div className="row-main">
              <div style={{ whiteSpace: 'normal' }}>{l.text}</div>
              <div className="row-sub">Evidencia: recomendaciones {l.evidence_ids.join(', ')}</div>
            </div>
            <div className="row-side"><button type="button" className="chip" onClick={() => remove(l.id)}>Borrar</button></div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Config({ api, overview }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.get('/agent/config').then(setCfg).catch((e) => setMsg(e.message)); }, [api]);
  if (!cfg) return msg ? <p className="error">{msg}</p> : <p className="muted">Cargando…</p>;

  const set = (path, value) => setCfg((c) => {
    const [a, b] = path.split('.');
    return b ? { ...c, [a]: { ...c[a], [b]: value } } : { ...c, [a]: value };
  });
  const num = (path, label) => {
    const [a, b] = path.split('.');
    const value = b ? cfg[a][b] : cfg[a];
    return (
      <label className="form-row">
        {label}
        <input type="number" step="any" value={value} onChange={(e) => set(path, Number(e.target.value))} />
      </label>
    );
  };
  const save = async () => {
    setMsg(null);
    try {
      const { agentEnabled, executionEnabled, monthlyBudgetUsd, manualRunsPerDay, expireHours, budget, thresholds } = cfg;
      setCfg(await api.put('/agent/config', { agentEnabled, executionEnabled, monthlyBudgetUsd, manualRunsPerDay, expireHours, budget, thresholds }));
      setMsg('Guardado');
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <>
      <label className="form-row">Agente activado
        <input type="checkbox" checked={cfg.agentEnabled} onChange={(e) => set('agentEnabled', e.target.checked)} />
      </label>
      <label className="form-row">Ejecución habilitada
        <input type="checkbox" checked={cfg.executionEnabled} onChange={(e) => set('executionEnabled', e.target.checked)} />
      </label>
      <p className="note">Automático por tipo de acción: todo apagado (todas las acciones requieren aprobación).</p>
      <h2 className="section-title">Detección</h2>
      {num('thresholds.noSalesSpendMultiple', 'Gasta sin vender: gasto ≥ × costo por venta')}
      {num('thresholds.expensiveRoasRatio', 'Caro: ROAS < × promedio')}
      {num('thresholds.winnerRoasRatio', 'Ganador: ROAS ≥ × promedio')}
      {num('thresholds.winnerMinSales', 'Ganador: ventas mínimas (7 días)')}
      <h2 className="section-title">Topes</h2>
      {num('budget.maxChangePct', 'Cambio máximo de presupuesto (%)')}
      {num('expireHours', 'Vencimiento de tarjetas (horas)')}
      {num('manualRunsPerDay', 'Análisis manuales por día')}
      {num('monthlyBudgetUsd', 'Tope mensual de API (USD)')}
      <p className="note">Consumido este mes: USD {Number(overview?.monthCostUsd || 0).toFixed(2)}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={save}>Guardar</button>
        {msg && <span className={msg === 'Guardado' ? 'note' : 'error'}>{msg}</span>}
      </div>
    </>
  );
}

export default function Agente({ api }) {
  const [tab, setTab] = useState('pendientes');
  const { data: overview, reload: reloadOverview } = usePolling(() => api.get('/agent/overview'), [api], 30_000);
  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pendientes' && <Pendientes api={api} overview={overview} reloadOverview={reloadOverview} />}
      {tab === 'historial' && <Historial api={api} />}
      {tab === 'aprendizaje' && <Aprendizaje api={api} overview={overview} />}
      {tab === 'config' && <Config api={api} overview={overview} />}
    </>
  );
}
