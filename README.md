# Altorancho Ventas — ventas web con atribución

Backend Node/Express + Postgres en Railway, que además sirve el dashboard (PWA React/Vite).
Spec: `docs/superpowers/specs/2026-10-06-altorancho-ventas-atribucion-design.md`.

## Variables de entorno (Railway)
Ver `backend/.env.example`: DATABASE_URL (referencia al servicio Postgres), TIENDANUBE_STORE_ID,
TIENDANUBE_TOKEN, TIENDANUBE_WEBHOOK_SECRET, META_ACCESS_TOKEN, META_ACCOUNT_ID, DASHBOARD_PASSWORD.

## Primer arranque
1. Deploy (Railway usa `railway.json` de la raíz: build front + back, start back).
2. Disparar backfills (con la contraseña del dashboard como Bearer):
   - `curl -X POST -H "Authorization: Bearer $PW" https://<app>/api/sync/tn-backfill`
   - `curl -X POST -H "Authorization: Bearer $PW" https://<app>/api/sync/meta-catalog`
   - `curl -X POST -H "Authorization: Bearer $PW" https://<app>/api/sync/meta-backfill`
   Progreso en la pestaña Estado del dashboard.
3. Webhooks: `cd backend && BACKEND_URL=https://<app> node scripts/registerWebhooks.js`.

## Jobs disponibles (`POST /api/sync/:job`)
tn-backfill, tn-incremental, meta-catalog, meta-spend, meta-backfill, reattribute
(recalcula la atribución de todo el histórico después de cambiar reglas).

## Local
cd backend && npm install && npx vitest run      # tests (Postgres en memoria con PGlite)
cd frontend && npm install && npm run dev         # http://localhost:5173 (proxy /api → :3000)
