import { useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import { fmtRelative } from '../../lib/format.js';
import { useAction } from './shared.jsx';

// Preguntas que el agente deja con ask_team: se contestan acá y las lee en la próxima corrida
export default function Preguntas({ api, onChange }) {
  const open = usePolling(() => api.get('/ads/questions?status=open').then((r) => r.questions), [api], 60_000);
  const answered = usePolling(() => api.get('/ads/questions?status=answered').then((r) => r.questions), [api], 300_000);
  const list = open.data || [];
  const done = answered.data || [];
  const reload = () => {
    open.reload();
    answered.reload();
    onChange?.();
  };
  if (!open.data || (list.length === 0 && done.length === 0)) return null;

  return (
    <section>
      <h2 className="section-title">El agente pregunta {list.length > 0 && <span className="badge warn">{list.length} sin responder</span>}</h2>
      {list.length === 0 && <p className="muted">No hay preguntas pendientes.</p>}
      {list.map((q) => <Pregunta key={q.id} q={q} api={api} onDone={reload} />)}
      {done.length > 0 && (
        <details className="rec">
          <summary>Respondidas ({done.length})</summary>
          <ul className="list">
            {done.map((q) => (
              <li key={q.id} className="row">
                <div className="row-main">
                  <div style={{ whiteSpace: 'normal' }}>{q.question}</div>
                  <div className="note" style={{ whiteSpace: 'pre-wrap' }}>{q.answer} · {fmtRelative(q.answered_at)}</div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Pregunta({ q, api, onDone }) {
  const [answer, setAnswer] = useState('');
  const [notice, setNotice] = useState(null);
  const { busy, error, run } = useAction();
  const empty = !answer.trim();

  async function send(analyze) {
    const res = await run(analyze ? 'analyze' : 'save', () => api.post(`/ads/questions/${q.id}/answer`, { answer: answer.trim(), analyze }));
    if (!res) return;
    setNotice(res.note || (analyze ? 'Respuesta guardada. El agente arrancó a analizar.' : 'Respuesta guardada.'));
    onDone();
  }
  async function discard() {
    if (await run('dismiss', () => api.post(`/ads/questions/${q.id}/dismiss`))) onDone();
  }

  return (
    <article className="rec">
      <div className="rec-head"><span className="tag" style={{ '--tag': '#353434' }}>Pregunta</span><span className="note" style={{ margin: 0 }}>{fmtRelative(q.created_at)}</span></div>
      <div className="rec-title">{q.question}</div>
      {q.why && <p className="note">{q.why}</p>}
      {q.quick_answers?.length > 0 && (
        <div className="reasons">
          {q.quick_answers.map((a) => (
            <button key={a} type="button" className={answer === a ? 'chip active' : 'chip'} onClick={() => setAnswer(a)}>{a}</button>
          ))}
        </div>
      )}
      <label className="field">
        Tu respuesta
        <textarea className="input" rows={2} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      {notice && <p className="note" role="status">{notice}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={empty || !!busy} onClick={() => send(false)}>Guardar</button>
        <button type="button" className="btn secondary" disabled={empty || !!busy} onClick={() => send(true)}>Guardar y analizar ahora</button>
        <button type="button" className="chip" disabled={!!busy} onClick={discard}>Descartar</button>
      </div>
    </article>
  );
}
