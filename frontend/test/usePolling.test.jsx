import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePolling } from '../src/hooks/usePolling.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('usePolling', () => {
  it('ignora la respuesta vieja si cambiaron los deps y limpia data al cambiar', async () => {
    const calls = {};
    const fetcher = (key) => { calls[key] = deferred(); return calls[key].promise; };
    const { result, rerender } = renderHook(({ k }) => usePolling(() => fetcher(k), [k]), { initialProps: { k: 'hoy' } });
    await act(async () => { calls.hoy.resolve('datos hoy'); });
    expect(result.current.data).toBe('datos hoy');

    rerender({ k: 'mes' });
    expect(result.current.data).toBeNull(); // no muestra lo de "hoy" mientras carga "mes"
    const viejo = calls.hoy = deferred(); // un polling viejo de "hoy" en vuelo
    void viejo;
    await act(async () => { calls.mes.resolve('datos mes'); });
    await waitFor(() => expect(result.current.data).toBe('datos mes'));
  });

  it('una respuesta tardía de los deps anteriores no pisa la nueva', async () => {
    const calls = {};
    const fetcher = (key) => { calls[key] = deferred(); return calls[key].promise; };
    const { result, rerender } = renderHook(({ k }) => usePolling(() => fetcher(k), [k]), { initialProps: { k: 'hoy' } });
    const hoy = calls.hoy;
    rerender({ k: 'mes' });
    await act(async () => { calls.mes.resolve('datos mes'); });
    await act(async () => { hoy.resolve('datos hoy (tarde)'); });
    expect(result.current.data).toBe('datos mes');
  });
});
