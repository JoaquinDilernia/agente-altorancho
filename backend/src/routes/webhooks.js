import express from 'express';
import { verifyTiendanubeHmac } from '../services/hmac.js';

const ORDER_EVENTS = new Set(['order/created', 'order/updated', 'order/paid', 'order/cancelled']);

export function createWebhookRouter({ secret, onOrderEvent }) {
  const router = express.Router();
  router.post('/tiendanube', express.raw({ type: '*/*' }), (req, res) => {
    if (!verifyTiendanubeHmac(req.body, req.get('x-linkedstore-hmac-sha256'), secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    const event = JSON.parse(req.body.toString('utf8'));
    res.json({ ok: true }); // responder YA — TN reintenta si tardamos
    if (ORDER_EVENTS.has(event.event)) {
      Promise.resolve(onOrderEvent(event)).catch((err) => console.error('[webhook] handler falló:', err));
    }
  });
  return router;
}
