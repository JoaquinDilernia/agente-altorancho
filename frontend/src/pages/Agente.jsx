import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtDateTime, fmtMoney, fmtNumber, fmtRoas } from '../lib/format.js';
import { ConfirmButton, Report, StatusBadge, useAction } from './agente/shared.jsx';
import Preguntas from './agente/Preguntas.jsx';
import Recomendaciones from './agente/Recomendaciones.jsx';
import Piezas from './agente/Piezas.jsx';

const TAB_KEY = 'ar_agente_tab';
const loadTab = () => {
  try {
    return localStorage.getItem(TAB_KEY) || 'resumen';
  } catch {
    return 'resumen';
  }
};

export default function Agente({ api }) {
  const [tab, setTabState] = useState(loadTab);
  const setTab = (t) => {
    setTabState(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* sin storage */ }
  };
  // Mientras el agente analiza, el resumen se vuelve a pedir cada 5 s
  const [fast, setFast] = useState(false);
  const overview = usePolling(() => api.get('/ads/overview').then((d) => {
    setFast(d.lastRun?.status === 'running');
    return d;
  }), [api], fast ? 5000 : 120_000);
  const data = overview.data;
  const running = data?.lastRun?.status === 'running';
  const { busy, error, run } = useAction(() => overview.reload());

  const tabs = [
    { id: 'resumen', label: `Resumen${data?.openQuestions ? ` (${data.openQuestions})` : ''}` },
    { id: 'recomendaciones', label: `Recomendaciones${data?.pendingCount ? ` (${data.pendingCount})` : ''}` },
    { id: 'piezas', label: 'Piezas' },
    { id: 'ajustes', label: 'Ajustes' },
  ];

  return (
    <>
      <PageHeader
        title="Agente de pauta"
        subtitle="Meta Ads · ventas en la tienda"
        actions={data?.configured.agent && (
          <button type="button" className="btn" disabled={running || !!busy} onClick={() => run('run', () => api.post('/ads/runs'))}>
            {running ? 'Analizando…' : 'Analizar ahora'}
          </button>
        )}
      />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!data && !overview.error && <p className="muted">Cargando…</p>}
      {overview.error && <p className="error">{overview.error}</p>}
      {error && <p className="error">{error}</p>}
      {data && !data.configured.meta && <p className="banner error">Falta conectar Meta en el servidor (META_ACCESS_TOKEN).</p>}
      {data && data.configured.meta && !data.configured.agent && <p className="banner error">Falta la clave de Claude (ANTHROPIC_API_KEY): el agente no puede analizar.</p>}
      {data?.metaError && <p className="banner error">Meta no respondió: {data.metaError}</p>}
      {data && tab === 'resumen' && <Resumen api={api} data={data} reload={overview.reload} />}
      {data && tab === 'recomendaciones' && <Recomendaciones api={api} onChange={overview.reload} />}
      {data && tab === 'piezas' && <Piezas api={api} snapshot={data.snapshot} storeUrl={data.storeUrl} />}
      {data && tab === 'ajustes' && <Ajustes api={api} settings={data.settings} onSaved={overview.reload} />}
    </>
  );
}

function Resumen({ api, data, reload }) {
  const snap = data.snapshot;
  const cap = data.settings.monthly_cap_ars;
  const last = data.lastRun;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.get('/ads/overview?refresh=1');
      reload();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      {snap && (
        <div className="cards">
          <div className="card"><div className="card-label">Gasto hoy</div><div className="card-value">{fmtMoney(snap.spendToday)}</div></div>
          <div className="card">
            <div className="card-label">Gasto del mes</div><div className="card-value">{fmtMoney(snap.month.spend)}</div>
            {cap > 0
              ? (
                <>
                  <div className="bar" style={{ marginTop: 6 }} role="progressbar" aria-label="Gasto contra el tope" aria-valuenow={snap.month.spend} aria-valuemax={cap}>
                    <span style={{ width: `${Math.min(100, (snap.month.spend * 100) / cap)}%`, '--tag': snap.month.spend > cap ? 'var(--warn)' : 'var(--text)' }} />
                  </div>
                  <div className="card-sub">Tope {fmtMoney(cap)}</div>
                </>
              )
              : <div className="card-sub">Sin tope cargado (Ajustes)</div>}
          </div>
          <div className="card">
            <div className="card-label">Ventas reales Meta (7 días)</div><div className="card-value">{fmtNumber(snap.last7d.meta.sales)}</div>
            <div className="card-sub">Meta dice {fmtNumber(snap.last7d.meta.metaPurchases)} · {fmtMoney(snap.last7d.meta.revenue)}</div>
          </div>
          <div className="card"><div className="card-label">ROAS real (7 días)</div><div className="card-value">{fmtRoas(snap.last7d.meta.roas)}</div></div>
        </div>
      )}

      <section className="rec">
        <div className="rec-head" style={{ justifyContent: 'space-between' }}>
          <strong>Último informe del agente</strong>
          {last && <span className="note" style={{ margin: 0 }}>{last.status === 'running' ? 'Analizando…' : fmtDateTime(last.finished_at || last.started_at)}</span>}
        </div>
        {!last && <p className="muted">Todavía no corrió. Corre solo todos los días a las 8:00, o tocá “Analizar ahora”.</p>}
        {last?.status === 'running' && <p className="muted">El agente está mirando la cuenta y las ventas. Tarda unos minutos.</p>}
        {last?.status === 'failed' && <p className="error">Falló el análisis: {last.error}</p>}
        {last?.report && last.status !== 'running' && <Report text={last.report} />}
      </section>

      <Preguntas api={api} onChange={reload} />

      {snap && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="section-title">Campañas</h2>
            <button type="button" className="chip" disabled={refreshing} onClick={refresh}>{refreshing ? 'Actualizando…' : 'Actualizar'}</button>
          </div>
          {snap.campaigns.length === 0 && <p className="muted">No hay campañas en la cuenta.</p>}
          {snap.campaigns.map((c) => <Campaign key={c.id} api={api} c={c} snap={snap} onChange={reload} />)}
        </>
      )}
    </>
  );
}

const realLine = (m) => `${fmtNumber(m.sales)} ventas · ${fmtMoney(m.spend)} · ROAS ${fmtRoas(m.roas)}`;

function StatusToggle({ api, level, obj, onChange }) {
  const { busy, error, run } = useAction(onChange);
  const active = obj.status === 'ACTIVE';
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <ConfirmButton className="chip" label={active ? 'Pausar' : 'Activar'} confirmLabel={active ? 'Sí, pausar' : 'Sí, activar (gasta)'} disabled={!!busy}
        onConfirm={() => run('s', () => api.post(`/ads/objects/${obj.id}/status`, { level, status: active ? 'PAUSED' : 'ACTIVE', name: obj.name }))} />
      {error && <span className="error">{error}</span>}
    </span>
  );
}

function Campaign({ api, c, snap, onChange }) {
  const adsets = snap.adsets.filter((a) => a.campaignId === c.id);
  return (
    <div className="tree">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="row-main">
          <div className="row-title">{c.name}</div>
          <div className="row-sub">{c.dailyBudgetArs ? `${fmtMoney(c.dailyBudgetArs)} por día` : 'Presupuesto por conjunto'} · {realLine(c.last7d)}</div>
        </div>
        <div className="row-side"><StatusBadge status={c.effectiveStatus} /> <StatusToggle api={api} level="campaign" obj={c} onChange={onChange} /></div>
      </div>
      {adsets.map((a) => {
        const ads = snap.ads.filter((ad) => ad.adsetId === a.id);
        return (
          <div key={a.id} className="tree-adset">
            <div className="row" style={{ alignItems: 'center' }}>
              <div className="row-main">
                <div className="row-title">{a.name}</div>
                <div className="row-sub">
                  {a.dailyBudgetArs ? `${fmtMoney(a.dailyBudgetArs)}/día · ` : ''}{realLine(a.last7d)}{a.learningStage === 'LEARNING' ? ' · en aprendizaje' : ''}
                </div>
              </div>
              <div className="row-side"><StatusBadge status={a.effectiveStatus} /> <StatusToggle api={api} level="adset" obj={a} onChange={onChange} /></div>
            </div>
            {ads.length === 0 && <p className="error" style={{ padding: '6px 0' }}>Sin anuncios: cargá una pieza en “Piezas” y publicala acá.</p>}
            {ads.map((ad) => (
              <div key={ad.id} className="row tree-ad" style={{ alignItems: 'center' }}>
                {ad.thumbnail && <img src={ad.thumbnail} alt="" className="thumb-sm" />}
                <div className="row-main">
                  <div className="row-title">{ad.name}</div>
                  <div className="row-sub">{realLine(ad.last7d)}{ad.delivery7d.frequency ? ` · frec. ${String(ad.delivery7d.frequency).replace('.', ',')}` : ''}</div>
                </div>
                <div className="row-side"><StatusBadge status={ad.effectiveStatus} /> <StatusToggle api={api} level="ad" obj={ad} onChange={onChange} /></div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Ajustes({ api, settings, onSaved }) {
  const [form, setForm] = useState(settings);
  const [msg, setMsg] = useState(null);
  const { busy, error, run } = useAction(() => {
    setMsg('Guardado');
    onSaved();
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const save = () => run('save', () => api.put('/ads/settings', {
    agent_enabled: form.agent_enabled, autonomous: form.autonomous, monthly_cap_ars: form.monthly_cap_ars, business_notes: form.business_notes,
  }));
  return (
    <section className="form">
      <label className="check">
        <input type="checkbox" checked={form.agent_enabled} onChange={(e) => setForm({ ...form, agent_enabled: e.target.checked })} />
        <span><strong>Informe diario</strong><span className="note">El agente analiza la cuenta todos los días a las 8:00.</span></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.autonomous} onChange={(e) => setForm({ ...form, autonomous: e.target.checked })} />
        <span><strong>Pausar anuncios solo</strong><span className="note">Si está prendido, el agente pausa anuncios que gastan sin vender sin esperar aprobación. Todo lo demás siempre se aprueba acá.</span></span>
      </label>
      <label className="field">Tope mensual de inversión en Meta (pesos)
        <input className="input" type="number" min={0} step={10000} value={form.monthly_cap_ars}
          onChange={(e) => setForm({ ...form, monthly_cap_ars: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        <span className="note">0 = sin tope: el agente te lo va a preguntar antes de proponer subas.</span>
      </label>
      <label className="field">Contexto para el agente
        <textarea className="input" rows={5} maxLength={5000} value={form.business_notes} onChange={(e) => setForm({ ...form, business_notes: e.target.value })}
          placeholder="Promos, productos o categorías a empujar, stock, qué no hacer…" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={!dirty || !!busy} onClick={save}>Guardar</button>
        {msg && !dirty && <span className="note" role="status">{msg}</span>}
      </div>
    </section>
  );
}
