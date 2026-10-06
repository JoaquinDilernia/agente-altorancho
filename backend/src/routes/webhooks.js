import express from 'express';
import { verifyTiendanubeHmac } from '../services/hmac.js';

const ORDER_EVENTS = new Set(['order/created', 'order/updated', 'order/paid', 'order/cancelled']);

// Del aviso solo se usa el evento y el id: la orden se vuelve a pedir a la API de TN con nuestro token.
// Por eso, si no hay secret configurado (claves de API sin client secret), se acepta sin firma:
// un aviso falso a lo sumo dispara una consulta de más.
export function createWebhookRouter({ secret, onOrderEvent }) {
  const router = express.Router();
  if (!secret) console.warn('[webhook] TIENDANUBE_WEBHOOK_SECRET vacío: se aceptan avisos sin firma (solo se usa el id)');
  router.post('/tiendanube', express.raw({ type: '*/*' }), (req, res) => {
    if (secret && !verifyTiendanubeHmac(req.body, req.get('x-linkedstore-hmac-sha256'), secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    } catch {
      return res.status(400).json({ error: 'json inválido' });
    }
    if (!/^\d+$/.test(String(event?.id ?? ''))) return res.status(400).json({ error: 'id inválido' });
    res.json({ ok: true }); // responder YA — TN reintenta si tardamos
    if (ORDER_EVENTS.has(event.event)) {
      Promise.resolve(onOrderEvent({ event: event.event, id: event.id }))
        .catch((err) => console.error('[webhook] handler falló:', err));
    }
  });
  return router;
}
