# Altorancho — Gasto de Google Ads vía script (Proyecto C, paso 1)

**Fecha:** 2026-10-06 · **Estado:** diseño aprobado en conversación.

## Objetivo
Traer el gasto diario por campaña de Google Ads para ver ROAS real y costo por venta de Google (las
ventas de Google ya se atribuyen por `gad_campaignid`). Paso 1 con **Google Ads Script**; cuando
Google apruebe el developer token, la API oficial reemplaza al script cargando **las mismas tablas**.

## Script (Google Ads → Herramientas → Scripts)
- GAQL sobre `campaign` con `segments.date`: id, nombre, estado, tipo de canal, `cost_micros`,
  impresiones, clics, `conversions`, `conversions_value`.
- Programado **cada hora**: envía los últimos 3 días. Modo `HISTORICO = true` (una vez): últimos 12
  meses, de a un mes por request.
- `POST https://<backend>/ingest/google` con header `X-Ingest-Token` (variable `GOOGLE_INGEST_TOKEN`,
  distinta de la contraseña del panel). Fechas en la zona horaria de la cuenta (ART).

## Backend
- Tablas `google_campaigns (id, name, status, channel_type, updated_at)` y
  `google_spend_daily (campaign_id, date, spend, impressions, clicks, conversions, conversions_value)`.
  `spend = cost_micros / 1e6` (ARS).
- `POST /ingest/google` (fuera de `/api`): valida token (comparación en tiempo constante) y payload
  (ids numéricos, fechas YYYY-MM-DD, números finitos ≥ 0, máx. 20.000 filas), upsert idempotente,
  registra `sync_runs` con source `google_ingest`.
- Reportes: `summary` agrega bloque `google` (gasto, ventas reales, facturación, ROAS real, costo por
  venta, lo que reporta Google, cobertura); `adsRanking({ platform: 'google' })` ranking por campaña
  (solo nivel campaña) + ventas Google sin campaña identificada; nombres de campañas de Google en
  lista y detalle de órdenes.
- `GET /api/ads?platform=meta|google`.

## Frontend
- Anuncios: selector **Meta | Google**; en Google solo campañas, sin drill-down ni bloque de
  parámetros de URL; "Google dice" en lugar de "Meta dice".
- Ventas: tarjetas de Google junto a las de Meta.
- Detalle de orden: nombre de la campaña de Google. Estado: "Google — gasto".

## Fuera de alcance
Agente sobre Google (llega con la API), atribución por grupo de anuncios (`click_view` de la API).
