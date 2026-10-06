const BASE = 'https://api.tiendanube.com/v1';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTiendanubeClient({ storeId, token, fetchFn = fetch, sleep = defaultSleep, maxRetries = 5 }) {
  const headers = {
    Authentication: `bearer ${token}`, // sí: "Authentication", no "Authorization" — quirk de TN
    'User-Agent': 'altorancho-ventas (jdilernia99@gmail.com)',
    'Content-Type': 'application/json',
  };

  async function req(path, opts = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchFn(`${BASE}/${storeId}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
      const h = (k) => res.headers?.get?.(k) ?? null;
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const reset = Number(h('x-rate-limit-reset'));
        await sleep(res.status === 429 && reset > 0 ? Math.min(reset, 10_000) : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Tienda Nube ${res.status}: ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      // Leaky bucket de TN: si quedan pocos pedidos, esperar a que se vacíe un poco
      const remaining = h('x-rate-limit-remaining');
      if (remaining !== null && Number(remaining) <= 2) await sleep(Number(h('x-rate-limit-reset')) || 1000);
      return res.json();
    }
  }

  return {
    getOrder: (id) => req(`/orders/${id}`),
    async listOrders({ page = 1, createdMin, createdMax, updatedMin } = {}) {
      const params = new URLSearchParams({ per_page: '200', page: String(page), status: 'any' });
      if (createdMin) params.set('created_at_min', createdMin);
      if (createdMax) params.set('created_at_max', createdMax);
      if (updatedMin) params.set('updated_at_min', updatedMin);
      try {
        return await req(`/orders?${params.toString()}`);
      } catch (err) {
        if (err.status === 404) return []; // TN responde 404 "Last page is N" fuera de rango o sin resultados
        throw err;
      }
    },
    listWebhooks: () => req('/webhooks'),
    createWebhook: (event, url) => req('/webhooks', { method: 'POST', body: JSON.stringify({ event, url }) }),
  };
}
