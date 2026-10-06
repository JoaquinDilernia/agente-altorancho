# Altorancho — Plataforma de ventas con atribución (Proyecto A)

**Fecha:** 2026-10-06
**Estado:** Diseño aprobado en conversación, pendiente de revisión del spec.

## 1. Objetivo

Que el dueño de Altorancho vea **todas las ventas web** (como las ve en Tienda Nube) y,
para cada una, **por qué canal/anuncio entró** y **cuánto costó en publicidad conseguirla**.
Además, un ranking de campañas/anuncios de Meta con **ventas reales** (Tienda Nube) vs.
lo que reporta Meta, para detectar dónde se gasta de más.

Se usa principalmente desde el **celular, instalado como PWA**.

Este es el **Proyecto A**. El **Proyecto B** (agente de control de gasto en Meta, lo que
era Gineza) viene después y se alimenta de estos datos. Google Ads (costo) también viene
después; en A las ventas de Google ya se identifican como tales, sin costo.

### Fuera de alcance (A)
- Ventas de locales físicos (no pasan por Tienda Nube).
- Costo de producto / margen (los productos no tienen costo cargado). Se puede sumar después.
- Costo de Google Ads.
- El agente (Claude, decisiones, chat, creativos) — Proyecto B.

## 2. Contexto real verificado

- Tienda Nube store `2547699` (altorancho.com), ~54.000 órdenes históricas.
- La API de órdenes trae `customer_visit` (`landing_page`, `utm_parameters`, `created_at`)
  y `landing_url`. Muestra de 50 órdenes (2026-10-06):
  ~17 Google (`gclid`/`gbraid`/`gad_campaignid`), 7 Meta (`utm_source=meta` + `fbclid`),
  ~20 sin parámetros, 1 Instagram link en bio (`utm_source=ig&utm_medium=social`),
  1 email Perfit (`utm_medium=email`), 4 sin `customer_visit`.
- De las 7 de Meta, **solo 1** trae IDs (`utm_content`=ad, `utm_term`=adset, `utm_id`=campaign).
  Las demás traen solo `utm_campaign` con el **nombre** de campaña
  (ej. `altorancho_conversiones_dpa_aon`). Hay que estandarizar los parámetros de URL en Meta.
- Meta Business `340441633287047`, página `448608595902716`, app `1344904590300546`
  (la del botCRM; su system user token se usa si tiene `ads_read` + `ads_management`).

## 3. Stack y deploy

| Capa | Tecnología | Deploy |
|---|---|---|
| Backend | Node 20 + Express (se reconvierte el repo de Gineza) | Railway |
| Base de datos | **Postgres** (driver `pg`, migraciones SQL propias) | Railway, mismo proyecto |
| Frontend | React + Vite, PWA (`vite-plugin-pwa`) | Build estático **servido por el mismo Express** (un solo servicio y dominio, sin CORS) |
| Tienda Nube | API REST v1 con token de app interna | — |
| Meta | Graph API directa con system user token | — |

Se elimina Firebase y todo el código del agente de Gineza (queda en el historial de git;
el Proyecto B se reconstruye sobre Postgres). Se reusan: `services/meta.js`,
`services/tiendanube.js`, `services/hmac.js`, `routes/webhooks.js`, `routes/authMiddleware.js`,
y el esqueleto del frontend (Layout, Login, api.js, usePolling).

**Env vars:** `DATABASE_URL`, `TIENDANUBE_STORE_ID`, `TIENDANUBE_TOKEN`,
`TIENDANUBE_WEBHOOK_SECRET`, `META_ACCESS_TOKEN`, `META_ACCOUNT_ID`, `DASHBOARD_PASSWORD`.

## 4. Modelo de datos (Postgres)

- **`orders`** — PK `id` (id TN). `number`, `created_at`, `paid_at`, `cancelled_at`,
  `status`, `payment_status`, `total`, `subtotal`, `discount`, `shipping_cost_customer`,
  `currency`, `gateway_name`, `storefront`, `customer_name`, `customer_email`,
  `landing_url`, `visit_landing_page`, `visit_created_at`, `visit_utm` (jsonb), `updated_at_tn`,
  `synced_at`. Índices: `created_at`, `payment_status`, `number`, búsqueda por cliente.
  No se guarda el JSON crudo completo (controla tamaño).
- **`order_items`** — `order_id`, `product_id`, `variant_id`, `sku`, `name`, `quantity`, `price`.
  Se reemplazan completos en cada upsert de la orden.
- **`order_attribution`** — PK `order_id`. `channel`
  (`meta` | `google` | `organic` | `email` | `social_organic` | `other` | `unknown`),
  `confidence` (`ad` | `campaign` | `none`), `campaign_id`, `adset_id`, `ad_id`,
  `campaign_name`, `source_raw` (jsonb con los parámetros usados), `rules_version`.
- **`meta_ads`** — PK `id`, `level` (`campaign` | `adset` | `ad`), `name`, `status`,
  `parent_id`, `campaign_id`, `thumbnail_url`, `url_tags`, `has_attribution_params` (bool),
  `updated_at`.
- **`meta_spend_daily`** — PK (`ad_id`, `date`). `campaign_id`, `adset_id`, `spend`,
  `impressions`, `clicks`, `meta_purchases`, `meta_purchase_value`, `synced_at`.
- **`sync_runs`** — `id`, `source` (`tn_backfill` | `tn_incremental` | `tn_webhook` |
  `meta_spend` | `meta_catalog` | `meta_backfill`), `started_at`, `finished_at`, `status`,
  `rows`, `error`, `cursor` (jsonb, para retomar).

**Reglas de negocio**
- **Venta** = orden con `payment_status = 'paid'` y no cancelada. Las demás se guardan y se
  ven, pero no suman ventas ni entran al costo por venta.
- Fechas agrupadas en `America/Argentina/Buenos_Aires`. Montos en ARS.
- La facturación de una venta es `total` de la orden (incluye envío pagado por el cliente);
  se muestra también neta de envío en el detalle.

## 5. Sincronización

**Tienda Nube — órdenes**
- *Backfill:* script `scripts/backfillOrders.js` pagina `GET /orders?per_page=200` (todas las
  estados), ~275 páginas. Respeta el rate limit (leaky bucket de TN; lee los headers
  `x-rate-limit-*` y espera). Guarda cursor en `sync_runs` y retoma si se corta.
- *Webhooks:* `order/created`, `order/paid`, `order/updated`, `order/cancelled` → validar HMAC →
  responder 200 inmediato → `GET /orders/{id}` → upsert orden + items + atribución.
  Script `scripts/registerWebhooks.js` para darlos de alta.
- *Red de seguridad:* cron cada hora, `updated_at_min = ahora - 2h`, upsert de todo lo que vuelva.

**Meta — gasto y catálogo**
- *Gasto:* cron cada hora → insights `level=ad`, `time_increment=1`, hoy y ayer.
  Cron diario (05:00 ART) → últimos 7 días (correcciones tardías). Campos: `spend`,
  `impressions`, `clicks`, `actions`/`action_values` (purchase).
- *Backfill de gasto:* últimos 12 meses, por meses, con insights asincrónicos (report run).
- *Catálogo:* cron cada hora → campañas, adsets, ads (+ `creative{thumbnail_url,url_tags}`).
  Al actualizar el catálogo se re-resuelven las atribuciones `confidence=campaign` por nombre
  que estaban sin `campaign_id`.

**Robustez**
- Todos los writes son upserts idempotentes.
- Reintentos con backoff exponencial ante 429 / 5xx / errores de rate limit de Meta
  (códigos 4, 17, 32, 613, 80004).
- Cada corrida registra un `sync_runs`. Una sola corrida de cada tipo a la vez (lock en memoria
  + `pg_try_advisory_lock`).
- `/health` informa DB ok + última sincronización exitosa de cada fuente.

## 6. Atribución

Módulo puro `engine/attribution.js`: `attribute(visit, landingUrl, metaCatalogLookup) →
{ channel, confidence, campaign_id, adset_id, ad_id, campaign_name, source_raw }`.
Lee parámetros de `customer_visit.landing_page` (y como fallback `landing_url`) + `utm_parameters`.

Prioridad:
1. **Meta:** `utm_source` ∈ {meta, facebook, fb, instagram, ig} **y** `utm_medium` ∈
   {cpc, paid, paid_social, ads}; o `fbclid` presente junto con `utm_campaign`.
   - `utm_content` numérico → `ad_id`, `confidence=ad`; `utm_term` numérico → `adset_id`;
     `utm_id` numérico → `campaign_id`. Si hay `ad_id` sin campaña, se completa desde `meta_ads`.
   - Solo `utm_campaign` (nombre) → lookup por nombre en `meta_ads` → `confidence=campaign`
     (con o sin `campaign_id` según encuentre).
   - Solo `fbclid` sin UTMs → `channel=meta`, `confidence=none` ("Meta sin identificar").
2. **Google:** `gclid` | `gbraid` | `wbraid` | `gad_campaignid` → `channel=google`,
   `campaign_id = gad_campaignid` si existe.
3. **Email:** `utm_medium=email`.
4. **Redes orgánicas:** `utm_medium` ∈ {social, organic_social} o `utm_source=ig` sin medio pago.
5. **Orgánica/directa:** hay visita, sin parámetros de campaña.
6. **Sin datos:** sin `customer_visit` → `channel=unknown`.
7. Cualquier otro `utm_source` → `channel=other`.

`rules_version` se incrementa al cambiar reglas; script `scripts/reattribute.js` recalcula
todo desde lo guardado (sin llamar a Tienda Nube). Tests con las landings reales de la muestra.

### Costo de publicidad por venta
- **Agregado (anuncio / adset / campaña / canal, en un rango):**
  `costo_por_venta = SUM(spend) / COUNT(ventas atribuidas)`; `roas_real = SUM(total) / SUM(spend)`.
  Se muestra junto a `meta_purchases`, `meta_roas` y la diferencia.
- **Por orden:** costo promedio del nivel más fino conocido (ad si `confidence=ad`, si no
  campaña) en los **7 días que terminan el día de la orden**. Se rotula "promedio".
- **Gasto sin ventas:** entidades con `spend > 0` y 0 ventas atribuidas en el rango.
- **Cobertura:** % de ventas Meta con `confidence` ad / campaign / none en el rango, visible
  en cada pantalla que muestra métricas de Meta.

### Estandarizar parámetros de URL en Meta
Plantilla:
`utm_source=meta&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`

- `meta_ads.has_attribution_params` marca qué anuncios activos ya la tienen.
- Endpoint `POST /api/meta/apply-url-tags` con lista de `ad_id`s elegidos en el panel.
  Como el creativo de Meta no se puede editar, se crea un creativo copia con `url_tags`
  y se actualiza el anuncio. **Esto manda el anuncio a revisión y puede reiniciar el
  aprendizaje**, así que: (a) el panel lo advierte y pide confirmar, (b) se aplica por
  selección, no masivo automático, (c) la recomendación por defecto es cargarlo en
  campañas/anuncios **nuevos** y en los activos solo cuando convenga. Alternativa manual:
  editarlo en Ads Manager.
- Cada aplicación queda en log (`sync_runs` con `source=meta_url_tags`).

## 7. API (todas con auth por contraseña, excepto webhooks y health)

- `GET /api/summary?from&to` — facturación, ventas, ticket promedio, gasto Meta, ROAS real,
  reparto por canal, cobertura.
- `GET /api/orders?from&to&channel&q&cursor` — lista paginada por cursor (keyset sobre
  `created_at,id`), 50 por página.
- `GET /api/orders/:id` — detalle con items, atribución, anuncio/campaña y costo promedio.
- `GET /api/ads?from&to&level&sort` — ranking (campaign → adset → ad) con gasto, ventas reales,
  costo por venta, ROAS real, métricas Meta, flag sin ventas.
- `GET /api/ads/:id?from&to` — detalle + órdenes atribuidas.
- `GET /api/status` — últimas corridas por fuente, errores, cobertura semanal.
- `POST /api/meta/apply-url-tags` — ver §6.
- `POST /webhooks/tiendanube`, `GET /health`.

## 8. Frontend (PWA, mobile-first)

**Estilo:** Poppins; fondo `#FFFFFF`, texto/primario `#353434`, grises para separadores y
secundarios. Labels de canal: Meta azul, Google ámbar, Orgánica verde, Email violeta,
Redes orgánicas rosa, Otros/Sin datos gris. Sin sombras pesadas ni gradientes.

**PWA:** manifest (nombre "Altorancho Ventas", ícono, `display: standalone`, theme `#353434`),
service worker que cachea solo el shell de la app; los datos de `/api` van siempre a red
(sin datos viejos cacheados). Instalable con "Agregar a pantalla de inicio".

**Navegación inferior, 3 pestañas:**
1. **Ventas** — selector de período (Hoy, Ayer, 7d, 30d, Mes, Personalizado); tarjetas
   (facturación, ventas, ticket, gasto Meta, ROAS real); barra de reparto por canal; lista de
   órdenes con scroll infinito (número, cliente, total, tiempo, label de canal, anuncio/campaña),
   filtro por canal y búsqueda. Detalle de orden: items, pago, envío, origen completo con
   miniatura, costo promedio, landing.
2. **Anuncios** — ranking campaña → conjunto → anuncio, orden por gasto / costo por venta / ROAS,
   gasto sin ventas resaltado, métricas Meta en gris al lado. Detalle con órdenes atribuidas.
   Bloque de cobertura + selección de anuncios sin parámetros y botón "Aplicar parámetros de URL".
3. **Estado** — última sincronización de TN y Meta, errores, cobertura de atribución por semana.

**Login:** contraseña (`DASHBOARD_PASSWORD`), guardada en el dispositivo; 401 → vuelve al login.

## 9. Testing

- Unit: `attribution.js` (casos de las órdenes reales), mapeo orden TN → filas,
  cálculos de costo por venta/ROAS, parser de insights Meta.
- Integración: rutas API y repositorios contra Postgres real de test
  (`DATABASE_URL_TEST`, se crea esquema por corrida). Clientes TN/Meta con `fetchFn` falso.
- Frontend: Vitest + Testing Library para Ventas, Anuncios, detalle de orden.
- Verificación real: backfill completo + comparar total de ventas pagadas de un mes contra
  el panel de Tienda Nube (deben coincidir).

## 10. Riesgos / pendientes

- **Token Meta:** confirmar que el system user de la app `1344904590300546` tiene la cuenta
  publicitaria asignada y `ads_management`. Falta el `META_ACCOUNT_ID` de Altorancho.
- **Webhook secret de TN:** hace falta el client secret de la app interna para validar HMAC.
  Sin él, solo funciona la sincronización horaria (latencia ≤ 1 h).
- **Token de TN** compartido en el chat: rotarlo al terminar la configuración.
- Ventas Meta históricas sin IDs quedan a nivel campaña o "sin identificar"; la precisión
  por anuncio arranca cuando se cargan los parámetros de URL.
