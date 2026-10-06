import { Link, useParams } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas, fmtRelative, shortName } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

const LEVEL_LABEL = { campaign: 'Campaña', adset: 'Conjunto', ad: 'Anuncio' };

export default function AdDetail({ api, period }) {
  const { id } = useParams();
  const q = periodQuery(period);
  const { data, error } = usePolling(() => api.get(`/ads/${id}?${q}`), [api, id, q], 120_000);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;
  const { ad, metrics: m, orders } = data;

  return (
    <>
      <Link className="back" to="/anuncios">← Anuncios</Link>
      <div className="origin" style={{ marginBottom: 16 }}>
        {ad.thumbnail_url && <img className="thumb" src={ad.thumbnail_url} alt="" />}
        <div className="row-main">
          <div className="card-label">{LEVEL_LABEL[ad.level]} · {ad.status}</div>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>{ad.name}</h1>
          {ad.level === 'ad' && (
            <span className={ad.has_attribution_params ? 'badge' : 'badge warn'}>
              {ad.has_attribution_params ? 'Con parámetros de URL' : 'Sin parámetros de URL'}
            </span>
          )}
        </div>
      </div>
      <div className="cards">
        <div className="card">
          <div className="card-label">Gasto</div>
          <div className="card-value">{fmtMoney(m.spend)}</div>
        </div>
        <div className="card">
          <div className="card-label">Ventas reales</div>
          <div className="card-value">{fmtNumber(m.sales)}</div>
          <div className="card-sub">Meta dice {fmtNumber(m.metaPurchases)}</div>
        </div>
        <div className="card">
          <div className="card-label">Costo por venta</div>
          <div className="card-value">{fmtMoney(m.costPerSale)}</div>
        </div>
        <div className="card">
          <div className="card-label">ROAS real</div>
          <div className="card-value">{fmtRoas(m.roas)}</div>
          <div className="card-sub">Meta dice {fmtRoas(m.metaRoas)}</div>
        </div>
      </div>
      <h2 className="section-title">Ventas que trajo</h2>
      <ul className="list">
        {orders.map((o) => (
          <li key={o.id}>
            <Link className="row" to={`/orden/${o.id}`}>
              <div className="row-main">
                <div className="row-title">#{o.number} · {shortName(o.customer_name)}</div>
                <div className="row-sub">{fmtRelative(o.created_at)}</div>
              </div>
              <div className="row-side row-amount">{fmtMoney(o.total)}</div>
            </Link>
          </li>
        ))}
      </ul>
      {orders.length === 0 && <p className="muted">Sin ventas atribuidas en este período.</p>}
    </>
  );
}
