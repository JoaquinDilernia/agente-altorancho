import { usePolling } from '../../hooks/usePolling.js';
import { fmtMoney, fmtRelative } from '../../lib/format.js';
import { ConfirmButton, DECISION_LABEL, TOOL_LABEL, useAction } from './shared.jsx';

function Detail({ d }) {
  const i = d.input || {};
  if (d.tool === 'propose_budget_change') {
    return <p className="note">Presupuesto diario: {fmtMoney(i.current_budget_ars)} → {fmtMoney(i.proposed_budget_ars)}</p>;
  }
  if (d.tool === 'set_status') return <p className="note">{i.status === 'ACTIVE' ? 'Activar' : 'Pausar'} {i.object_name || i.object_id}</p>;
  if (d.tool === 'pause_ad') return <p className="note">Anuncio: {i.ad_name || i.ad_id}</p>;
  if (d.tool === 'create_ad' || d.tool === 'promote_ig_post') return <p className="note">En el conjunto {i.adset_name || i.adset_id}{i.link ? ` · lleva a ${i.link}` : ''}</p>;
  if (d.tool === 'propose_adset') return <p className="note">Conjunto {i.name} (se crea pausado)</p>;
  return null;
}

export default function Recomendaciones({ api, onChange }) {
  const decisions = usePolling(() => api.get('/ads/decisions').then((r) => r.decisions), [api], 60_000);
  const requests = usePolling(() => api.get('/ads/requests').then((r) => r.requests), [api], 300_000);
  const learnings = usePolling(() => api.get('/ads/learnings').then((r) => r.learnings), [api], 300_000);
  const igPosts = usePolling(() => api.get('/ads/ig-posts').then((r) => r.posts).catch(() => []), [api], 600_000);
  const { busy, error, run } = useAction(() => {
    decisions.reload();
    requests.reload();
    learnings.reload();
    onChange?.();
  });
  const list = decisions.data || [];
  const pending = list.filter((d) => d.status === 'pending');
  const history = list.filter((d) => d.status !== 'pending').slice(0, 30);

  return (
    <>
      {error && <p className="error">{error}</p>}
      <h2 className="section-title" style={{ marginTop: 0 }}>Para aprobar</h2>
      {decisions.data && pending.length === 0 && <p className="muted">No hay recomendaciones pendientes.</p>}
      {pending.map((d) => {
        const post = d.tool === 'promote_ig_post' ? igPosts.data?.find((p) => p.id === d.input.ig_media_id) : null;
        return (
          <article key={d.id} className="rec">
            <div className="rec-head">
              <span className="tag" style={{ '--tag': '#353434' }}>{TOOL_LABEL[d.tool] ?? d.tool}</span>
              <span className="note" style={{ margin: 0 }}>{fmtRelative(d.created_at)}</span>
            </div>
            <div className="rec-title">{d.title || TOOL_LABEL[d.tool]}</div>
            <Detail d={d} />
            {post?.thumbnail && <img src={post.thumbnail} alt="" className="thumb" style={{ marginTop: 8 }} />}
            {d.reason && <p style={{ fontSize: 14, marginTop: 8, whiteSpace: 'pre-wrap' }}>{d.reason}</p>}
            {d.expected_impact && <p className="note">Qué esperamos: {d.expected_impact}</p>}
            <div className="actions">
              <ConfirmButton label="Aprobar" confirmLabel="Aplicar en Meta" disabled={!!busy}
                onConfirm={() => run(d.id, () => api.post(`/ads/decisions/${d.id}/approve`))} />
              <button type="button" className="btn secondary" disabled={!!busy} onClick={() => run(d.id, () => api.post(`/ads/decisions/${d.id}/reject`))}>Rechazar</button>
            </div>
          </article>
        );
      })}

      <h2 className="section-title">Piezas que pide el agente</h2>
      {(requests.data || []).length === 0 && <p className="muted">No hay pedidos abiertos.</p>}
      {(requests.data || []).map((r) => (
        <article key={r.id} className="rec">
          <div className="rec-title">{r.concept}</div>
          {r.style_notes && <p style={{ fontSize: 14, marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.style_notes}</p>}
          {r.reason && <p className="note">{r.reason}</p>}
          <div className="actions">
            <button type="button" className="chip" disabled={!!busy} onClick={() => run(r.id, () => api.post(`/ads/requests/${r.id}/done`))}>Ya la cargamos</button>
          </div>
        </article>
      ))}

      <h2 className="section-title">Historial</h2>
      {decisions.data && history.length === 0 && <p className="muted">Todavía no hay movimientos.</p>}
      <ul className="list">
        {history.map((d) => (
          <li key={d.id} className="row">
            <div className="row-main">
              <div className="row-title" style={{ whiteSpace: 'normal' }}>{d.title || TOOL_LABEL[d.tool]}</div>
              <div className="row-sub" style={{ whiteSpace: 'normal', flexWrap: 'wrap' }}>
                <span className={d.status === 'failed' ? 'badge warn' : d.status === 'executed' ? 'badge ok' : 'badge'}>{DECISION_LABEL[d.status]}</span>
                <span>{fmtRelative(d.decided_at || d.created_at)}</span>
              </div>
              {d.error && <div className="error">{d.error}</div>}
              {d.outcome && <div className="note">Resultado: {d.outcome}</div>}
            </div>
          </li>
        ))}
      </ul>

      {(learnings.data || []).length > 0 && (
        <>
          <h2 className="section-title">Lo que fue aprendiendo</h2>
          <ul className="list">
            {learnings.data.map((l) => (
              <li key={l.id} className="row">
                <div className="row-main">
                  <div style={{ whiteSpace: 'normal' }}>{l.text}</div>
                  <div className="note">{l.evidence}</div>
                </div>
                <div className="row-side">
                  <button type="button" className="chip" disabled={!!busy} onClick={() => run(l.id, () => api.del(`/ads/learnings/${l.id}`))}>Borrar</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
