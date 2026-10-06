// Registra los webhooks de órdenes en Tienda Nube (no duplica los existentes).
// Uso: BACKEND_URL=https://xxx.up.railway.app node scripts/registerWebhooks.js
import 'dotenv/config';
import { createTiendanubeClient } from '../src/services/tiendanube.js';

const { TIENDANUBE_STORE_ID, TIENDANUBE_TOKEN, BACKEND_URL } = process.env;
if (!BACKEND_URL) throw new Error('Falta BACKEND_URL');
const url = `${BACKEND_URL.replace(/\/$/, '')}/webhooks/tiendanube`;
const tn = createTiendanubeClient({ storeId: TIENDANUBE_STORE_ID, token: TIENDANUBE_TOKEN });

const existing = await tn.listWebhooks();
for (const event of ['order/created', 'order/updated', 'order/paid', 'order/cancelled']) {
  if (existing.some((w) => w.event === event && w.url === url)) {
    console.log(`${event}: ya existe`);
    continue;
  }
  const created = await tn.createWebhook(event, url);
  console.log(`${event}: creado (id ${created.id})`);
}
