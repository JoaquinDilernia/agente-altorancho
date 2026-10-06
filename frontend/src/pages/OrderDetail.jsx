import { Link, useParams } from 'react-router-dom';
import ChannelTag from '../components/ChannelTag.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtDateTime, fmtDate } from '../lib/format.js';
import { PAYMENT_LABEL } from './Ventas.jsx';

const CONFIDENCE_TEXT = {
  ad: 'Atribuida al anuncio exacto.',
  campaign: 'Atribuida a la campaña (el link no traía el anuncio).',
  none: 'No se pudo identificar la campaña.',
};

export default function OrderDetail({ api }) {
  const { id } = useParams();
  const { data: o, error } = usePolling(() => api.get(`/orders/${id}`), [api, id], 120_000);
  if (error) return <p className="error">{error}</p>;
  if (!o) return <p className="muted">Cargando…</p>;

  const paid = o.payment_status === 'paid' && !o.cancelled_at;
  const status = o.cancelled_at ? 'Cancelada' : paid ? 'Pagada' : PAYMENT_LABEL[o.payment_status] || o.payment_status;
  const paidChannel = o.channel === 'meta' || o.channel === 'google';

  return (
    <>
      <Link className="back" to="/">← Ventas</Link>
      <div className="detail-head">
        <h1>#{o.number} · {fmtMoney(o.total)}</h1>
        <p className="muted">{fmtDateTime(o.created_at)} · {o.customer_name || 'Sin nombre'}</p>
        <span className={paid ? 'badge' : 'badge warn'}>{status}</span>
      </div>

      <h2 className="section-title">Origen</h2>
      <div className="origin">
        {o.thumbnail_url && <img className="thumb" src={o.thumbnail_url} alt="" />}
        <div className="row-main">
          <ChannelTag channel={o.channel} />
          {o.channel === 'meta' && (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Anuncio</dt><dd>{o.ad_name || '—'}</dd>
              <dt>Conjunto</dt><dd>{o.adset_name || '—'}</dd>
              <dt>Campaña</dt><dd>{o.campaign_name || '—'}</dd>
            </dl>
          )}
          {o.channel === 'google' && <p style={{ marginTop: 8 }}>Campaña de Google: {o.campaign_name || o.campaign_id || 'sin identificar'}</p>}
          {o.channel === 'email' && o.campaign_name && <p style={{ marginTop: 8 }}>{o.campaign_name}</p>}
          {paidChannel && <p className="note">{CONFIDENCE_TEXT[o.confidence]}</p>}
        </div>
      </div>

      {o.costEstimate && (
        <div className="panel">
          <div className="card-label">Costo de publicidad de esta venta (promedio)</div>
          <div className="card-value">{fmtMoney(o.costEstimate.costPerSale)}</div>
          <div className="card-sub">
            {o.costEstimate.level === 'ad' ? 'El anuncio' : 'La campaña'} del {fmtDate(o.costEstimate.from)} al {fmtDate(o.costEstimate.to)}: gastó {fmtMoney(o.costEstimate.spend)} y trajo {o.costEstimate.sales} ventas.
          </div>
        </div>
      )}

      <h2 className="section-title">Productos</h2>
      <ul className="list">
        {o.items.map((it, i) => (
          <li key={i} className="row">
            <div className="row-main">
              <div className="row-title">{it.name}</div>
              <div className="row-sub">{it.sku || 'sin SKU'} · {it.quantity} u.</div>
            </div>
            <div className="row-side row-amount">{fmtMoney(it.price * it.quantity)}</div>
          </li>
        ))}
      </ul>

      <h2 className="section-title">Pago y envío</h2>
      <dl className="kv">
        <dt>Medio de pago</dt><dd>{o.gateway_name || '—'}</dd>
        <dt>Subtotal</dt><dd>{fmtMoney(o.subtotal)}</dd>
        <dt>Descuento</dt><dd>{fmtMoney(o.discount)}</dd>
        <dt>Envío</dt><dd>{fmtMoney(o.shipping_cost_customer)}</dd>
        <dt>Total</dt><dd>{fmtMoney(o.total)}</dd>
        <dt>Dispositivo</dt><dd>{o.storefront || '—'}</dd>
      </dl>

      <h2 className="section-title">Entró por</h2>
      <p className="note" style={{ overflowWrap: 'anywhere' }}>{o.visit_landing_page || o.landing_url || 'Sin datos de la visita'}</p>
    </>
  );
}
