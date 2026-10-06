import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createWebhookRouter } from '../src/routes/webhooks.js';

const SECRET = 'test-secret';
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');

function makeApp(onOrderEvent = vi.fn().mockResolvedValue()) {
  const app = createApp({ webhookRouter: createWebhookRouter({ secret: SECRET, onOrderEvent }) });
  return { app, onOrderEvent };
}

describe('webhook tiendanube', () => {
  it('rechaza sin firma', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/webhooks/tiendanube').send({ event: 'order/paid', id: 1 });
    expect(res.status).toBe(401);
  });
  it('rechaza firma inválida', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/webhooks/tiendanube')
      .set('x-linkedstore-hmac-sha256', 'deadbeef').send({ event: 'order/paid', id: 1 });
    expect(res.status).toBe(401);
  });
  it('acepta firma válida y dispara el handler', async () => {
    const { app, onOrderEvent } = makeApp();
    const body = JSON.stringify({ event: 'order/paid', id: 999, store_id: 1 });
    const res = await request(app).post('/webhooks/tiendanube')
      .set('content-type', 'application/json')
      .set('x-linkedstore-hmac-sha256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10)); // handler corre post-respuesta
    expect(onOrderEvent).toHaveBeenCalledWith({ event: 'order/paid', id: 999, store_id: 1 });
  });
  it('ignora eventos que no son de órdenes', async () => {
    const { app, onOrderEvent } = makeApp();
    const body = JSON.stringify({ event: 'product/updated', id: 5 });
    await request(app).post('/webhooks/tiendanube')
      .set('content-type', 'application/json')
      .set('x-linkedstore-hmac-sha256', sign(body)).send(body);
    await new Promise((r) => setTimeout(r, 10));
    expect(onOrderEvent).not.toHaveBeenCalled();
  });
  it('acepta order/updated y order/cancelled', async () => {
    const { app, onOrderEvent } = makeApp();
    for (const event of ['order/updated', 'order/cancelled']) {
      const body = JSON.stringify({ event, id: 1 });
      await request(app).post('/webhooks/tiendanube')
        .set('content-type', 'application/json')
        .set('x-linkedstore-hmac-sha256', sign(body)).send(body);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(onOrderEvent).toHaveBeenCalledTimes(2);
  });
});
