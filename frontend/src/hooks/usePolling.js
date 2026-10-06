import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// Fetch + polling + refetch al volver el foco. Devuelve { data, error, loading, reload }.
// Al cambiar los deps no muestra los datos anteriores, y una respuesta vieja nunca pisa una nueva.
export function usePolling(fn, deps = [], intervalMs = 30_000) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const token = useMemo(() => ({}), deps);
  const [state, setState] = useState({ owner: null, data: null, error: null });
  const seq = useRef(0);

  const reload = useCallback(() => {
    const id = ++seq.current;
    fn()
      .then((d) => { if (id === seq.current) setState({ owner: token, data: d, error: null }); })
      .catch((e) => { if (id === seq.current) setState((s) => ({ owner: token, data: s.owner === token ? s.data : null, error: e.message })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, intervalMs);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [reload, intervalMs]);

  const current = state.owner === token;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current, reload };
}
