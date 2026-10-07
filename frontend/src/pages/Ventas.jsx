import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import PeriodPicker from '../components/PeriodPicker.jsx';
import ChannelTag, { CHANNELS } from '../components/ChannelTag.jsx';
import { ChannelTrail } from '../components/ChannelIcon.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas, fmtPct, fmtRelative } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

export const PAYMENT_LABEL = {
  pending: 'Pendiente', authorized: 'Autorizada', voided: 'Anulada', refunded: 'Reembolsada', abandoned: 'Abandonada',
  expired: 'Vencida', partially_paid: 'Pago parcial', partially_refunded: 'Reembolso parcial', chargeback: 'Contracargo',
};

export function originText(o) {
  if (o.channel === 'meta') return o.ad_name || o.campaign_name || 'Meta sin identificar';
  if (o.channel === 'google') return o.campaign_id ? `Campaña ${o.campaign_id}` : 'Google sin identificar';
  if (o.channel === 'email') return o.campaign_name || null;
  return null;
}

function Summary({ s, channel, onChannel }) {
  const { meta, coverage } = s;
  return (
    <>
      <div className="cards">
        <div className="card wide">
          <div className="card-label">Facturación</div>
          <div className="card-value">{fmtMoney(s.revenue)}</div>
          <div className="card-sub">{fmtNumber(s.orders)} ventas · ticket {fmtMoney(s.avgTicket)}</div>
        </div>
        <div className="card">
          <div className="card-label">Gasto Meta</div>
          <div className="card-value">{fmtMoney(meta.spend)}</div>
          <div className="card-sub">{fmtMoney(meta.costPerSale)} por venta</div>
        </div>
        <div className="card">
          <div className="card-label">ROAS real Meta</div>
          <div className="card-value">{fmtRoas(meta.roas)}</div>
          <div className="card-sub">Meta dice {fmtRoas(meta.reported.roas)}</div>
        </div>
        <div className="card wide">
          <div className="card-label">Ventas de Meta</div>
          <div className="card-value">{fmtNumber(meta.orders)}</div>
          <div className="card-sub">Meta dice {fmtNumber(meta.reported.purchases)} · facturaron {fmtMoney(meta.revenue)}</div>
        </div>
        {s.google && (
          <>
            <div className="card">
              <div className="card-label">Gasto Google</div>
              <div className="card-value">{fmtMoney(s.google.spend)}</div>
              <div className="card-sub">{fmtMoney(s.google.costPerSale)} por venta</div>
            </div>
            <div className="card">
              <div className="card-label">ROAS real Google</div>
              <div className="card-value">{fmtRoas(s.google.roas)}</div>
              <div className="card-sub">Google dice {fmtRoas(s.google.reported.roas)}</div>
            </div>
          </>
        )}
      </div>

      <h2 className="section-title">Origen de las ventas</h2>
      <div className="bar" aria-hidden="true">
        {s.channels.map((c) => (
          <span key={c.channel} style={{ width: fmtPct(c.revenue, s.revenue), '--tag': (CHANNELS[c.channel] || CHANNELS.unknown).color }} />
        ))}
      </div>
      <ul className="legend">
        {s.channels.map((c) => (
          <li key={c.channel}>
            <button type="button" onClick={() => onChannel(channel === c.channel ? '' : c.channel)} aria-pressed={channel === c.channel}>
              <ChannelTag channel={c.channel} />
              <span className="muted">{fmtNumber(c.orders)} ventas</span>
            </button>
            <span>{fmtMoney(c.revenue)} <span className="muted">{fmtPct(c.revenue, s.revenue)}</span></span>
          </li>
        ))}
      </ul>
      {meta.orders > 0 && (
        <p className="note">
          De {meta.orders} ventas de Meta: {coverage.ad} con anuncio, {coverage.campaign} solo campaña, {coverage.none} sin identificar.
        </p>
      )}
    </>
  );
}

function OrderRow({ o, api }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const origin = originText(o);
  const status = o.cancelled ? 'Cancelada' : o.payment_status !== 'paid' ? PAYMENT_LABEL[o.payment_status] || o.payment_status : null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) api.get(`/orders/${o.id}`).then(setDetail).catch((e) => setDetailError(e.message));
  };
  const count = o.items_count ?? 0;
  return (
    <li className="order">
      <div className="order-row">
        <Link className="order-link" to={`/orden/${o.id}`}>
          <ChannelTrail active={[o.channel, o.first_channel]} />
          <div className="row-main">
            <div className="row-title"><span className="order-num">#{o.number}</span> <span>{o.customer_name || 'Sin nombre'}</span></div>
            <div className="row-sub">
              <span className="bought">Compró por {(CHANNELS[o.channel] || CHANNELS.unknown).label}</span>
              {origin && <span>{origin}</span>}
              <span aria-hidden="true">·</span>
              <span>{count === 1 ? '1 producto' : `${count} productos`}</span>
            </div>
          </div>
          <div className="row-side">
            <div className="row-amount">{fmtMoney(o.total)}</div>
            <div className="row-sub">{status ? <span className="badge warn">{status}</span> : fmtRelative(o.created_at)}</div>
          </div>
        </Link>
        <button type="button" className="expand" aria-expanded={open} aria-label={`Ver productos de #${o.number}`} onClick={toggle}>
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div className="order-extra">
          {detailError && <p className="error">{detailError}</p>}
          {!detail && !detailError && <p className="muted">Cargando…</p>}
          {detail && (
            <>
              <ul className="items">
                {detail.items.map((it, i) => (
                  <li key={i}><span>{it.quantity} × {it.name}</span><span>{fmtMoney(it.price * it.quantity)}</span></li>
                ))}
              </ul>
              <dl className="kv">
                <dt>Medio de pago</dt><dd>{detail.gateway_name || '—'}</dd>
                <dt>Envío</dt><dd>{fmtMoney(detail.shipping_cost_customer)}</dd>
                <dt>Entró por</dt><dd style={{ overflowWrap: 'anywhere' }}>{detail.visit_landing_page || detail.landing_url || 'Sin datos'}</dd>
              </dl>
              <Link className="note" to={`/orden/${o.id}`}>Ver detalle completo →</Link>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function Ventas({ api, period, setPeriod }) {
  const q = periodQuery(period);
  const { data: summary, error: summaryError } = usePolling(() => api.get(`/summary?${q}`), [api, q], 60_000);
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [list, setList] = useState({ items: [], nextCursor: null, loading: true, error: null });

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const base = `/orders?${q}${channel ? `&channel=${channel}` : ''}${term ? `&q=${encodeURIComponent(term)}` : ''}`;

  // Query vigente: las respuestas de una query anterior (lista o "Ver más") se descartan
  const currentBase = useRef(base);
  currentBase.current = base;

  useEffect(() => {
    setList({ items: [], nextCursor: null, loading: true, error: null });
    api.get(base)
      .then((r) => currentBase.current === base && setList({ items: r.items, nextCursor: r.nextCursor, loading: false, error: null }))
      .catch((e) => currentBase.current === base && setList((l) => ({ ...l, loading: false, error: e.message })));
  }, [api, base]);

  const loadMore = useCallback(() => {
    if (!list.nextCursor || list.loading) return;
    const requested = base;
    setList((l) => ({ ...l, loading: true }));
    api.get(`${base}&cursor=${encodeURIComponent(list.nextCursor)}`)
      .then((r) => currentBase.current === requested && setList((l) => ({ items: [...l.items, ...r.items], nextCursor: r.nextCursor, loading: false, error: null })))
      .catch((e) => currentBase.current === requested && setList((l) => ({ ...l, loading: false, error: e.message })));
  }, [api, base, list.nextCursor, list.loading]);

  const sentinel = useRef(null);
  useEffect(() => {
    if (!sentinel.current || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <>
      <PeriodPicker period={period} onChange={setPeriod} />
      {summaryError && <p className="error">{summaryError}</p>}
      {summary ? <Summary s={summary} channel={channel} onChannel={setChannel} /> : !summaryError && <p className="muted">Cargando…</p>}

      <h2 className="section-title">Órdenes</h2>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Buscar por número, cliente o producto" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {channel && (
        <div className="filters">
          <button type="button" className="chip active" onClick={() => setChannel('')}>{CHANNELS[channel]?.label} ✕</button>
        </div>
      )}
      <ul className="orders">
        {list.items.map((o) => <OrderRow key={o.id} o={o} api={api} />)}
      </ul>
      {list.error && <p className="error">{list.error}</p>}
      {!list.loading && list.items.length === 0 && !list.error && <p className="muted">No hay órdenes en este período.</p>}
      {list.nextCursor && (
        <button ref={sentinel} type="button" className="btn secondary more" onClick={loadMore} disabled={list.loading}>
          {list.loading ? 'Cargando…' : 'Ver más'}
        </button>
      )}
    </>
  );
}
