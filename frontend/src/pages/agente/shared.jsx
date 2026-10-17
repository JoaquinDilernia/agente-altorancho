import { useCallback, useState } from 'react';

export const STATUS_LABEL = {
  ACTIVE: 'Activo', PAUSED: 'Pausado', CAMPAIGN_PAUSED: 'Campaña pausada', ADSET_PAUSED: 'Conjunto pausado',
  IN_PROCESS: 'En revisión', PENDING_REVIEW: 'En revisión', DISAPPROVED: 'Rechazado', WITH_ISSUES: 'Con problemas',
};
export const TOOL_LABEL = {
  pause_ad: 'Pausar anuncio', set_status: 'Activar / pausar', propose_budget_change: 'Presupuesto', propose_adset: 'Conjunto nuevo',
  create_ad: 'Publicar pieza', promote_ig_post: 'Promocionar post',
};
export const DECISION_LABEL = { pending: 'Pendiente', executed: 'Hecho', rejected: 'Rechazado', failed: 'Falló' };

export function StatusBadge({ status }) {
  const warn = ['DISAPPROVED', 'WITH_ISSUES'].includes(status);
  const active = status === 'ACTIVE';
  return <span className={warn ? 'badge warn' : active ? 'badge ok' : 'badge'}>{STATUS_LABEL[status] ?? status}</span>;
}

// El informe del agente viene en texto con **negritas**: se respetan los saltos de línea
export function Report({ text }) {
  return (
    <div className="report">
      {text.split('\n').map((line, i) => (
        <p key={i}>{line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith('**') && part.endsWith('**')
          ? <strong key={j}>{part.slice(2, -2)}</strong> : part))}</p>
      ))}
    </div>
  );
}

// Corre una acción contra la API marcando cuál está en curso; el error queda para mostrar
export function useAction(onDone) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      onDone?.(res);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, [onDone]);
  return { busy, error, run, setError };
}

// Botón que pide un segundo toque antes de hacer algo que toca Meta
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = 'btn' }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <>
      <button type="button" className="btn danger" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="btn secondary" onClick={() => setAsking(false)}>Cancelar</button>
    </>
  );
}

// Conjunto destino para publicar: todos los de la cuenta, con su estado
export function AdsetSelect({ adsets, value, onChange }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Conjunto">
      {adsets.map((a) => <option key={a.id} value={a.id}>{a.name} — {STATUS_LABEL[a.effectiveStatus] ?? a.effectiveStatus}</option>)}
    </select>
  );
}
