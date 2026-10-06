import { usePolling } from '../hooks/usePolling.js';
import { fmtNumber, fmtPct, fmtRelative, fmtDate, fmtDateTime } from '../lib/format.js';

const SOURCES = [
  ['tn_incremental', 'Tienda Nube (cada hora)'],
  ['tn_webhook', 'Tienda Nube (webhooks)'],
  ['tn_backfill', 'Tienda Nube (histórico)'],
  ['meta_catalog', 'Meta — catálogo'],
  ['meta_spend', 'Meta — gasto'],
  ['meta_backfill', 'Meta — histórico'],
  ['meta_url_tags', 'Parámetros de URL'],
  ['reattribute', 'Re-atribución'],
];
const LABEL = Object.fromEntries(SOURCES);

export default function Estado({ api }) {
  const { data, error } = usePolling(() => api.get('/status'), [api], 30_000);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;

  const last = Object.fromEntries(data.runs.map((r) => [r.source, r]));
  const ok = Object.fromEntries(data.lastSuccess.map((r) => [r.source, r.finished_at]));
  const visible = SOURCES.filter(([s]) => last[s] || data.running.includes(s));

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 0 }}>Sincronización</h2>
      <ul className="list">
        {visible.map(([source, label]) => {
          const run = last[source];
          const running = data.running.includes(source);
          const badge = running ? <span className="badge">Corriendo</span>
            : run?.status === 'error' ? <span className="badge warn">Error</span>
              : <span className="badge">OK</span>;
          return (
            <li key={source} className="row">
              <div className="row-main">
                <div className="row-title">{label}</div>
                <div className="row-sub">Último OK: {ok[source] ? fmtRelative(ok[source]) : 'nunca'}{run ? ` · ${fmtNumber(run.rows)} filas` : ''}</div>
                {run?.status === 'error' && !running && <div className="error">{run.error}</div>}
              </div>
              <div className="row-side">{badge}</div>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && <p className="muted">Todavía no corrió ninguna sincronización.</p>}

      <h2 className="section-title">Datos</h2>
      <dl className="kv">
        <dt>Órdenes guardadas</dt><dd>{fmtNumber(data.counts.orders)}</dd>
        <dt>Anuncios activos sin parámetros de URL</dt><dd>{fmtNumber(data.counts.adsMissingParams)}</dd>
      </dl>

      <h2 className="section-title">Atribución de ventas Meta por semana</h2>
      {data.coverage.length === 0 ? <p className="muted">Sin ventas de Meta en las últimas 8 semanas.</p> : (
        <table className="simple">
          <thead><tr><th>Semana</th><th>Anuncio</th><th>Campaña</th><th>Sin identificar</th></tr></thead>
          <tbody>
            {data.coverage.map((w) => {
              const total = w.ad + w.campaign + w.none;
              return (
                <tr key={w.week}>
                  <td>{fmtDate(w.week)}</td>
                  <td>{fmtPct(w.ad, total)}</td>
                  <td>{fmtPct(w.campaign, total)}</td>
                  <td>{fmtPct(w.none, total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note">El % "Anuncio" debería subir a medida que los anuncios tengan los parámetros de URL.</p>

      {data.errors.length > 0 && (
        <>
          <h2 className="section-title">Errores recientes</h2>
          <ul className="list">
            {data.errors.map((e, i) => (
              <li key={i} className="row">
                <div className="row-main">
                  <div className="row-title">{LABEL[e.source] || e.source}</div>
                  <div className="row-sub">{fmtDateTime(e.started_at)}</div>
                  <div className="error">{e.error}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
