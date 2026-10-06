import { describe, it, expect, vi } from 'vitest';
import { createTiendanubeClient } from '../src/services/tiendanube.js';

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers),
  json: async () => body, text: async () => JSON.stringify(body),
});
const make = (fetchFn) => createTiendanubeClient({ storeId: '2547699', token: 'tok', fetchFn, sleep: vi.fn().mockResolvedValue() });

describe('cliente tiendanube', () => {
  it('getOrder pega al endpoint con el header Authentication (quirk de TN)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, { id: 1 }));
    await make(fetchFn).getOrder(55);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.tiendanube.com/v1/2547699/orders/55');
    expect(opts.headers.Authentication).toBe('bearer tok');
  });
  it('listOrders arma filtros y status=any', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, []));
    await make(fetchFn).listOrders({ page: 3, createdMin: '2026-01-01T00:00:00-03:00', createdMax: '2026-01-31T23:59:59-03:00', updatedMin: '2026-10-06T10:00:00Z' });
    const u = new URL(fetchFn.mock.calls[0][0]);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      per_page: '200', page: '3', status: 'any',
      created_at_min: '2026-01-01T00:00:00-03:00', created_at_max: '2026-01-31T23:59:59-03:00', updated_at_min: '2026-10-06T10:00:00Z',
    });
  });
  it('listOrders: página fuera de rango (404 "Last page is N") devuelve []', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(404, { code: 404, message: 'Not Found', description: 'Last page is 5' }));
    expect(await make(fetchFn).listOrders({ page: 6 })).toEqual([]);
  });
  it('429 espera x-rate-limit-reset y reintenta', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(res(429, {}, { 'x-rate-limit-reset': '1500' }))
      .mockResolvedValueOnce(res(200, { id: 9 }));
    const tn = createTiendanubeClient({ storeId: '1', token: 't', fetchFn, sleep });
    expect(await tn.getOrder(9)).toEqual({ id: 9 });
    expect(sleep).toHaveBeenCalledWith(1500);
  });
  it('500 reintenta con backoff y al agotar reintentos tira con status', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchFn = vi.fn().mockResolvedValue(res(502, { error: 'bad gateway' }));
    const tn = createTiendanubeClient({ storeId: '1', token: 't', fetchFn, sleep, maxRetries: 2 });
    await expect(tn.getOrder(1)).rejects.toMatchObject({ status: 502 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });
  it('si quedan ≤2 pedidos en el bucket, espera antes de devolver', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchFn = vi.fn().mockResolvedValue(res(200, [], { 'x-rate-limit-remaining': '1', 'x-rate-limit-reset': '800' }));
    await createTiendanubeClient({ storeId: '1', token: 't', fetchFn, sleep }).listOrders();
    expect(sleep).toHaveBeenCalledWith(800);
  });
  it('401 no se reintenta', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(401, { error: 'unauthorized' }));
    await expect(make(fetchFn).getOrder(1)).rejects.toMatchObject({ status: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('createWebhook hace POST con event y url', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(201, { id: 1 }));
    await make(fetchFn).createWebhook('order/paid', 'https://x/webhooks/tiendanube');
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.tiendanube.com/v1/2547699/webhooks');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ event: 'order/paid', url: 'https://x/webhooks/tiendanube' });
  });
});
