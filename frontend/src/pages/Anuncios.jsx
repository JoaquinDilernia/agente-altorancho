import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import PeriodPicker from '../components/PeriodPicker.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

const SORTS = [
  { id: 'spend', label: 'Gasto' },
  { id: 'cps', label: 'Costo por venta' },
  { id: 'roas', label: 'ROAS' },
];
const NEXT = { campaign: 'adset', adset: 'ad' };
const RESULT_LABEL = { applied: 'Aplicado', already: 'Ya tenía', error: 'Error' };

function UrlParams({ api }) {
  const [missing, setMissing] = useState(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/ads/missing-params').then(setMissing).catch((e) => setError(e.message)), [api]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/meta/apply-url-tags', { adIds: [...selected] });
      setResults(r.results);
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!missing) return error ? <p className="error">{error}</p> : null;
  return (
    <section>
      <h2 className="section-title">Parámetros de URL</h2>
      {missing.length === 0 ? (
        <p className="note">Todos los anuncios activos tienen los parámetros de atribución.</p>
      ) : (
        <>
          <p className="note">{missing.length} anuncios activos no tienen los parámetros de URL: sus ventas no se pueden atribuir al anuncio exacto.</p>
          {!open && <div className="actions"><button type="button" className="btn secondary" onClick={() => setOpen(true)}>Revisar</button></div>}
          {open && (
            <div className="panel">
              {missing.slice(0, 50).map((a) => (
                <label key={a.id}>
                  <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.name} <span className="muted">· {a.campaign_name || 'sin campaña'}</span></span>
                </label>
              ))}
              {!confirming ? (
                <div className="actions">
                  <button type="button" className="btn" disabled={selected.size === 0} onClick={() => setConfirming(true)}>Aplicar a {selected.size} anuncios</button>
                  <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cerrar</button>
                </div>
              ) : (
                <>
                  <p className="error" style={{ marginTop: 10 }}>
                    Ojo: cada anuncio se copia con un creativo nuevo que incluye los parámetros. Meta lo vuelve a revisar y puede
                    reiniciar el aprendizaje. Conviene hacerlo en anuncios nuevos o que no estén rindiendo.
                  </p>
                  <div className="actions">
                    <button type="button" className="btn danger" disabled={busy} onClick={apply}>{busy ? 'Aplicando…' : 'Sí, aplicar'}</button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      {results && (
        <ul className="list">
          {results.map((r) => (
            <li key={r.adId} className="row">
              <span>{r.adId}</span>
              <span className={r.status === 'error' ? 'badge warn' : 'badge'}>{RESULT_LABEL[r.status]}{r.error ? `: ${r.error}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default function Anuncios({ api, period, setPeriod }) {
  const navigate = useNavigate();
  const [stack, setStack] = useState([{ level: 'campaign', parentId: null, name: 'Campañas' }]);
  const [sort, setSort] = useState('spend');
  const [platform, setPlatform] = useState('meta');
  const [refs, setRefs] = useState(() => new Set());
  useEffect(() => {
    api.get('/recommendations/refs')
      .then((r) => setRefs(new Set((Array.isArray(r) ? r : []).flatMap((x) => [x.object_id, x.target_id]).filter(Boolean))))
      .catch(() => {});
  }, [api]);
  const cur = stack[stack.length - 1];
  const q = platform === 'google'
    ? `${periodQuery(period)}&level=campaign&sort=${sort}&platform=google`
    : `${periodQuery(period)}&level=${cur.level}&sort=${sort}${cur.parentId ? `&parent=${cur.parentId}` : ''}`;
  const reportedLabel = platform === 'google' ? 'Google dice' : 'Meta dice';
  const { data, error } = usePolling(() => api.get(`/ads?${q}`), [api, q], 120_000);

  const open = (r) => {
    if (platform === 'google') return;
    if (cur.level === 'ad') navigate(`/anuncios/${r.id}`);
    else setStack([...stack, { level: NEXT[cur.level], parentId: r.id, name: r.name || r.id }]);
  };

  return (
    <>
      <PeriodPicker period={period} onChange={setPeriod} />
      <div className="chips" style={{ marginBottom: 10 }}>
        {[['meta', 'Meta'], ['google', 'Google']].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={platform === id} className={platform === id ? 'chip active' : 'chip'}
            onClick={() => { setPlatform(id); setStack([{ level: 'campaign', parentId: null, name: 'Campañas' }]); }}>{label}</button>
        ))}
      </div>
      {platform === 'meta' && (<div className="crumbs">
        {stack.map((s, i) => (i < stack.length - 1
          ? <span key={s.name + i}><button type="button" onClick={() => setStack(stack.slice(0, i + 1))}>{s.name}</button> ›</span>
          : <strong key={s.name + i}>{s.name}</strong>))}
      </div>)}
      <div className="chips" role="tablist" aria-label="Ordenar por" style={{ marginBottom: 10 }}>
        {SORTS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={sort === s.id} className={sort === s.id ? 'chip active' : 'chip'} onClick={() => setSort(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && (
        <>
          <ul className="list">
            {data.rows.map((r) => (
              <li key={r.id}>
                <button type="button" className={`row row-btn${r.noSales ? ' no-sales' : ''}`} onClick={() => open(r)}>
                  <div className="row-main">
                    <div className="row-title">{r.name || `ID ${r.id}`}</div>
                    <div className="row-sub">
                      <span>{fmtNumber(r.sales)} ventas · {reportedLabel} {fmtNumber(r.metaPurchases)}</span>
                      {r.noSales && <span className="badge warn">Gastó sin ventas</span>}
                      {refs.has(r.id) && <span className="badge">Recomendación pendiente</span>}
                    </div>
                  </div>
                  <div className="row-side">
                    <div className="row-amount">{fmtMoney(r.spend)}</div>
                    <div className="row-sub">{fmtMoney(r.costPerSale)} c/u · ROAS {fmtRoas(r.roas)}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {data.rows.length === 0 && <p className="muted">Sin gasto ni ventas en este período.</p>}
          {data.unidentified?.orders > 0 && (
            <p className="note">
              Además hubo {data.unidentified.orders} ventas de {platform === 'google' ? 'Google' : 'Meta'} ({fmtMoney(data.unidentified.revenue)}) que no se pudieron asignar a una campaña.
            </p>
          )}
        </>
      )}
      {platform === 'meta' && <UrlParams api={api} />}
    </>
  );
}
