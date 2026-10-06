import { useState } from 'react';
import { fmtMoney, fmtNumber, fmtRoas } from '../lib/format.js';

export const TYPE_LABEL = { pause: 'Pausar', reactivate: 'Reactivar', budget: 'Presupuesto', shift: 'Reasignar', idea: 'Idea' };
const CONF = { alta: { label: 'Alta', color: '#1E9E5A' }, media: { label: 'Media', color: '#F29900' }, baja: { label: 'Baja', color: '#8A8A8A' } };
export const REJECT_REASONS = ['No es momento', 'Está en lanzamiento', 'No estoy de acuerdo', 'Otro'];

function initialAmount(rec) {
  if (rec.type === 'budget') return rec.proposed_value.daily_budget;
  if (rec.type === 'shift') return rec.current_value.from - rec.proposed_value.from;
  return null;
}

export default function RecommendationCard({ rec, onApprove, onReject, busy }) {
  const [amount, setAmount] = useState(initialAmount(rec));
  const [rejecting, setRejecting] = useState(false);
  const m = rec.snapshot?.m7 || rec.snapshot?.from?.m7;
  const conf = CONF[rec.confidence] || CONF.media;
  const editable = rec.type === 'budget' || rec.type === 'shift';
  const changed = editable && Number(amount) !== initialAmount(rec);

  return (
    <article className="rec">
      <div className="rec-head">
        <span className="tag" style={{ '--tag': '#353434' }}>{TYPE_LABEL[rec.type]}</span>
        <span className="tag" style={{ '--tag': conf.color }}>{conf.label}</span>
        {rec.dudoso_atribucion && <span className="badge warn">Atribución dudosa</span>}
      </div>
      <div className="rec-title">{rec.title}</div>
      {(rec.object_name || rec.object_id) && (
        <div className="rec-object">{rec.object_name || rec.object_id}{rec.target_id ? ` → ${rec.target_name || rec.target_id}` : ''}</div>
      )}
      {m && (
        <dl className="rec-grid">
          <div><dt>Gasto 7 días</dt><dd>{fmtMoney(m.spend)}</dd></div>
          <div><dt>Ventas reales</dt><dd>{fmtNumber(m.sales)} <span className="muted">· Meta dice {fmtNumber(m.metaPurchases)}</span></dd></div>
          <div><dt>ROAS real</dt><dd>{fmtRoas(m.roas)}</dd></div>
          <div><dt>Costo por venta</dt><dd>{fmtMoney(m.cpa)}</dd></div>
        </dl>
      )}
      {rec.type === 'budget' && <p className="note">Presupuesto diario: {fmtMoney(rec.current_value.daily_budget)} → {fmtMoney(Number(amount))}</p>}
      {rec.type === 'shift' && (
        <p className="note">
          Mover {fmtMoney(Number(amount))} por día: {fmtMoney(rec.current_value.from)} → {fmtMoney(rec.current_value.from - Number(amount))} y{' '}
          {fmtMoney(rec.current_value.to)} → {fmtMoney(rec.current_value.to + Number(amount))}
        </p>
      )}
      {rec.expected_impact && <p className="note">Impacto esperado: {rec.expected_impact}</p>}
      <details>
        <summary>Por qué</summary>
        <p>{rec.reasoning}</p>
      </details>
      {editable && (
        <label className="amount">
          {rec.type === 'budget' ? 'Nuevo presupuesto diario ($)' : 'Monto a mover por día ($)'}
          <input type="number" inputMode="numeric" value={amount ?? ''} onChange={(e) => setAmount(e.target.value)} />
        </label>
      )}
      {!rejecting ? (
        <div className="actions">
          <button type="button" className="btn" disabled={busy || (editable && !(Number(amount) > 0))}
            onClick={() => onApprove(changed ? Number(amount) : undefined)}>Aprobar</button>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => setRejecting(true)}>Rechazar</button>
        </div>
      ) : (
        <div className="reasons">
          {REJECT_REASONS.map((r) => (
            <button key={r} type="button" className="chip" disabled={busy} onClick={() => onReject(r === 'Otro' ? null : r)}>{r}</button>
          ))}
          <button type="button" className="chip" onClick={() => setRejecting(false)}>Cancelar</button>
        </div>
      )}
    </article>
  );
}
