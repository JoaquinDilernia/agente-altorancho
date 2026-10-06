# Altorancho Ventas con Atribución — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconvertir el repo de Gineza en una plataforma (backend + PWA) que muestra todas las ventas web de Altorancho con su origen (anuncio/campaña/canal) y el costo de publicidad por venta.

**Architecture:** Backend Node/Express en Railway que sincroniza órdenes de Tienda Nube (backfill + webhooks + barrido horario) y gasto/catálogo de Meta (horario + diario) a Postgres. Un módulo puro calcula la atribución de cada orden desde `customer_visit`. Reportes en SQL. El mismo Express sirve el build del frontend React/Vite (PWA).

**Tech Stack:** Node ≥20 (ESM), Express 4, `pg`, `node-cron`, Vitest + supertest, `@electric-sql/pglite` (Postgres real en WASM para tests), React 18 + Vite 5 + react-router 6, `vite-plugin-pwa`, `@vite-pwa/assets-generator`.

**Spec:** `docs/superpowers/specs/2026-10-06-altorancho-ventas-atribucion-design.md`

## Global Constraints

- Node ≥ 20, ESM (`"type": "module"`), tests con Vitest (`npx vitest run`).
- Todo el copy de UI en español rioplatense.
- Venta = `payment_status = 'paid' AND cancelled_at IS NULL`. El período filtra por `orders.created_at`.
- Zona horaria: Argentina es UTC−3 fijo (sin DST). En SQL NO usar nombres de zona: límite de día = `($ymd::text || 'T00:00:00-03:00')::timestamptz`; día ART de un timestamptz = `((col AT TIME ZONE 'UTC') - interval '3 hours')::date`.
- Convención SQL de lectura (para que `pg` y PGlite devuelvan lo mismo): ids → `::text`, montos → `::float8`, conteos → `::int`, columnas `date` → `::text`.
- IDs de Meta siempre `text` (superan 2^53).
- Interfaz de base de datos única en todo el backend: `db = { query(text, params) → { rows }, exec(sqlMultiStatement), tx(async (q) => …) , close() }` donde `q = { query(text, params) }`.
- Locks de jobs: en memoria (Railway corre una sola réplica). Desvío consciente del spec (decía advisory lock).
- Backfills y re-atribución se disparan por endpoints admin (`POST /api/sync/:job`) que corren en el servidor, no por scripts locales (la DB de Railway es interna). Desvío consciente del spec (decía scripts).
- Plantilla de parámetros de URL de Meta (literal): `utm_source=meta&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`
- Estilo UI: Poppins; fondo `#FFFFFF`; texto/primario `#353434`. Labels: Meta `#1877F2`, Google `#F29900`, Orgánica `#1E9E5A`, Email `#7B5CD6`, Redes orgánicas `#D6457A`, Otros/Sin datos `#8A8A8A`.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Landings raras** (sin `customer_visit`, URL relativa o malformada, `utm_campaign` con espacios y `|`, TN guardando `gclid:` dentro de `utm_campaign`) → la orden se guarda igual y cae en un canal razonable; nunca tira el sync. Tests en Task 3.
2. **Orden de Meta que llega antes que su campaña al catálogo** (atribuida solo por nombre) → queda `campaign_id = null` y se resuelve sola en la próxima sync de catálogo. Test en Task 5.
3. **Bordes del día en ART**: una orden de las 01:30 UTC del día D pertenece al día D−1 en Argentina. Test en Task 10.
4. **La misma orden re-sincronizada** (pending → paid → cancelled, webhook duplicado) → sin items duplicados y los totales del período cambian. Test en Task 5 y Task 10.
5. **Anuncio con gasto y sin ventas / ventas de un anuncio cuyo gasto aún no se sincronizó** → aparecen ambos en el ranking, sin divisiones por cero (costo por venta `null`). Test en Task 10.

---

## File Structure

**Backend (`backend/`)**
- `src/app.js` — arma Express (webhooks raw, json, health, /api, estáticos + fallback SPA).
- `src/index.js` — wiring de producción + crons.
- `src/db/index.js` — `createPgDb(url)`.
- `src/db/migrate.js` + `src/db/migrations/001_init.sql` — esquema.
- `src/engine/attribution.js` — reglas puras de atribución.
- `src/engine/mapOrder.js` — orden TN → filas.
- `src/engine/dates.js` — fechas ART.
- `src/engine/metaInsights.js` — fila de insights → fila de gasto.
- `src/engine/urlTags.js` — plantilla, detección y merge de `url_tags`, copia de creativo.
- `src/repo/orders.js`, `src/repo/meta.js`, `src/repo/syncRuns.js`, `src/repo/reports.js` — acceso a datos.
- `src/services/tiendanube.js`, `src/services/meta.js`, `src/services/hmac.js` — clientes HTTP.
- `src/sync/jobs.js` — runner de jobs con lock + registro en `sync_runs`.
- `src/sync/orders.js`, `src/sync/meta.js`, `src/sync/urlTagger.js` — casos de uso de sincronización.
- `src/routes/webhooks.js`, `src/routes/api.js`, `src/routes/authMiddleware.js`.
- `scripts/registerWebhooks.js` — alta de webhooks en TN.
- `test/helpers/testDb.js` — PGlite + migraciones.

**Frontend (`frontend/`)**
- `src/App.jsx`, `src/main.jsx`, `src/api.js`, `src/styles.css`
- `src/lib/format.js`, `src/lib/period.js`
- `src/components/Layout.jsx`, `Login.jsx`, `PeriodPicker.jsx`, `ChannelTag.jsx`
- `src/hooks/usePolling.js`
- `src/pages/Ventas.jsx`, `OrderDetail.jsx`, `Anuncios.jsx`, `AdDetail.jsx`, `Estado.jsx`
- `public/logo.svg`, `pwa-assets.config.js`, `vite.config.js`

**Raíz:** `railway.json` (build front + back, start back), `README.md`.

---

### Task 1: Limpieza del repo de Gineza y base del backend

**Files:**
- Delete: `backend/src/agent/`, `backend/src/config/`, `backend/src/store/`, `backend/src/firebase.js`, `backend/src/services/metrics.js`, `backend/src/services/storage.js`, `backend/src/engine/` (todo), `backend/src/routes/api.js`, `backend/scripts/` (todo), `backend/test/` (todo excepto `app.test.js` y `webhook.test.js`), `backend/railway.json`
- Modify: `backend/package.json`, `backend/.env.example`, `backend/src/index.js`

**Interfaces:**
- Produces: backend que arranca con solo `/health` y webhooks; dependencias `pg` y `@electric-sql/pglite` instaladas.

- [ ] **Step 1: Borrar código de Gineza**

```bash
cd backend
git rm -r -q src/agent src/config src/store src/engine src/firebase.js src/services/metrics.js src/services/storage.js src/routes/api.js scripts railway.json
git rm -q test/api.test.js test/chatDispatcher.test.js test/chatMessages.test.js test/configStore.test.js test/contextBuilder.test.js test/createAd.test.js test/creativeRequests.test.js test/decisionExecutor.test.js test/dispatcher.test.js test/meta.test.js test/metrics.test.js test/prefixedDb.test.js test/profit.test.js test/runner.test.js test/runnerChat.test.js test/saleProcessor.test.js test/stores.test.js test/tiendanube.test.js test/helpers/fakeFirestore.js
```

- [ ] **Step 2: Reescribir `backend/package.json`**

```json
{
  "name": "altorancho-backend",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "node-cron": "^3.0.3",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.12",
    "supertest": "^7.0.0",
    "vitest": "^2.0.0"
  }
}
```

Run: `cd backend && npm install`
Expected: instala sin errores.

- [ ] **Step 3: `backend/.env.example`**

```
# Postgres (Railway lo inyecta como DATABASE_URL al linkear el servicio)
DATABASE_URL=postgres://user:pass@localhost:5432/altorancho

# Tienda Nube (app interna de la tienda 2547699)
TIENDANUBE_STORE_ID=2547699
TIENDANUBE_TOKEN=
TIENDANUBE_WEBHOOK_SECRET=

# Meta (system user token con ads_read + ads_management y la cuenta asignada)
META_ACCESS_TOKEN=
META_ACCOUNT_ID=act_XXXXXXXX

# Dashboard
DASHBOARD_PASSWORD=
```

- [ ] **Step 4: `backend/src/index.js` mínimo (se completa en Task 13)**

```js
import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`altorancho-backend escuchando en :${port}`));
```

- [ ] **Step 5: Correr tests**

Run: `cd backend && npx vitest run`
Expected: PASS (`app.test.js`, `webhook.test.js`).

- [ ] **Step 6: Commit**

```bash
git add -A backend
git commit -m "chore: limpiar código de Gineza, base del backend de Altorancho

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Capa de base de datos y migraciones

**Files:**
- Create: `backend/src/db/index.js`, `backend/src/db/migrate.js`, `backend/src/db/migrations/001_init.sql`, `backend/test/helpers/testDb.js`
- Test: `backend/test/db.test.js`

**Interfaces:**
- Produces:
  - `createPgDb(connectionString: string) → db` (interfaz de Global Constraints).
  - `migrate(db) → Promise<string[]>` (nombres de migraciones aplicadas en esta corrida).
  - `createTestDb() → Promise<db>` (PGlite en memoria, ya migrado).

- [ ] **Step 1: Escribir `backend/src/db/migrations/001_init.sql`**

```sql
CREATE TABLE orders (
  id bigint PRIMARY KEY,
  number int NOT NULL,
  created_at timestamptz NOT NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  status text NOT NULL,
  payment_status text NOT NULL,
  total numeric(14,2) NOT NULL,
  subtotal numeric(14,2),
  discount numeric(14,2),
  shipping_cost_customer numeric(14,2),
  currency text,
  gateway_name text,
  storefront text,
  customer_name text,
  customer_email text,
  landing_url text,
  visit_landing_page text,
  visit_created_at timestamptz,
  visit_utm jsonb,
  updated_at_tn timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_idx ON orders (created_at DESC, id DESC);
CREATE INDEX orders_payment_status_idx ON orders (payment_status);
CREATE INDEX orders_number_idx ON orders (number);

CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint,
  variant_id bigint,
  sku text,
  name text,
  quantity int NOT NULL,
  price numeric(14,2) NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_attribution (
  order_id bigint PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  channel text NOT NULL,
  confidence text NOT NULL,
  campaign_id text,
  adset_id text,
  ad_id text,
  campaign_name text,
  source_raw jsonb,
  rules_version int NOT NULL
);
CREATE INDEX order_attr_channel_idx ON order_attribution (channel);
CREATE INDEX order_attr_ad_idx ON order_attribution (ad_id);
CREATE INDEX order_attr_adset_idx ON order_attribution (adset_id);
CREATE INDEX order_attr_campaign_idx ON order_attribution (campaign_id);

CREATE TABLE meta_ads (
  id text PRIMARY KEY,
  level text NOT NULL,
  name text,
  status text,
  parent_id text,
  campaign_id text,
  thumbnail_url text,
  url_tags text,
  has_attribution_params boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meta_ads_campaign_name_idx ON meta_ads (lower(name)) WHERE level = 'campaign';

CREATE TABLE meta_spend_daily (
  ad_id text NOT NULL,
  date date NOT NULL,
  campaign_id text,
  adset_id text,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  meta_purchases numeric(12,2) NOT NULL DEFAULT 0,
  meta_purchase_value numeric(14,2) NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, date)
);
CREATE INDEX meta_spend_date_idx ON meta_spend_daily (date);
CREATE INDEX meta_spend_campaign_idx ON meta_spend_daily (campaign_id, date);
CREATE INDEX meta_spend_adset_idx ON meta_spend_daily (adset_id, date);

CREATE TABLE sync_runs (
  id serial PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  rows int NOT NULL DEFAULT 0,
  error text,
  cursor jsonb
);
CREATE INDEX sync_runs_source_idx ON sync_runs (source, started_at DESC);
```

- [ ] **Step 2: Escribir el test que falla `backend/test/db.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { migrate } from '../src/db/migrate.js';

describe('migraciones', () => {
  it('crea todas las tablas', async () => {
    const db = await createTestDb();
    const { rows } = await db.query(
      "SELECT table_name::text AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((r) => r.t)).toEqual([
      'meta_ads', 'meta_spend_daily', 'order_attribution', 'order_items', 'orders', 'schema_migrations', 'sync_runs',
    ]);
    await db.close();
  });
  it('es idempotente: correrla de nuevo no aplica nada', async () => {
    const db = await createTestDb();
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });
  it('tx hace rollback si falla', async () => {
    const db = await createTestDb();
    await expect(db.tx(async (q) => {
      await q.query("INSERT INTO sync_runs (source) VALUES ('x')");
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM sync_runs');
    expect(rows[0].n).toBe(0);
    await db.close();
  });
});
```

- [ ] **Step 3: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/db.test.js`
Expected: FAIL (no existe `./helpers/testDb.js`).

- [ ] **Step 4: Implementar `backend/src/db/migrate.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Aplica en orden los .sql de migrations/ que todavía no estén en schema_migrations.
export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await fs.readFile(path.join(DIR, f), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${f}');\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}
```

- [ ] **Step 5: Implementar `backend/src/db/index.js`**

```js
import pg from 'pg';

// Interfaz común { query, exec, tx, close } — la misma que implementa el helper de tests con PGlite.
export function createPgDb(connectionString) {
  const ssl = /proxy\.rlwy\.net|sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, max: 5, ssl });
  return {
    query: (text, params) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, p) => client.query(t, p) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
```

- [ ] **Step 6: Implementar `backend/test/helpers/testDb.js`**

```js
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/db/migrate.js';

// Postgres real (WASM) en memoria, con la misma interfaz que createPgDb.
export async function createTestDb() {
  const pg = new PGlite();
  const db = {
    query: (text, params) => pg.query(text, params),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
```

- [ ] **Step 7: Correr tests**

Run: `cd backend && npx vitest run test/db.test.js`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add backend/src/db backend/test/db.test.js backend/test/helpers/testDb.js
git commit -m "feat: capa Postgres con migraciones y helper PGlite para tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Motor de atribución

**Files:**
- Create: `backend/src/engine/attribution.js`
- Test: `backend/test/attribution.test.js`

**Interfaces:**
- Produces:
  - `RULES_VERSION: number` (= 1).
  - `extractParams({ landingUrl, visitLandingPage, visitUtm }) → Record<string,string>` (claves en minúscula).
  - `attribute({ landingUrl, visitLandingPage, visitUtm }) → { channel, confidence, campaign_id, adset_id, ad_id, campaign_name, source_raw, rules_version }`. `channel ∈ meta|google|organic|email|social_organic|other|unknown`; `confidence ∈ ad|campaign|none`. IDs string o `null`. NO resuelve IDs contra el catálogo (eso es `ordersRepo.resolveMetaIds`, Task 5).

- [ ] **Step 1: Escribir los tests (casos reales de la muestra del 2026-10-06)**

```js
import { describe, it, expect } from 'vitest';
import { attribute, extractParams, RULES_VERSION } from '../src/engine/attribution.js';

const NULL_UTM = { utm_campaign: null, utm_content: null, utm_medium: null, utm_source: null, utm_term: null };
const v = (landing, utm = NULL_UTM) => ({ landingUrl: landing, visitLandingPage: landing, visitUtm: utm });

describe('attribute — Meta', () => {
  it('#59431: UTMs con IDs → anuncio, conjunto y campaña', () => {
    const r = attribute(v('https://altorancho.com/productos/MSI027TP/?variant=1216127748&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_valordeconv_dpa_aon&utm_content=120248950422870142&utm_id=120226653113540142&utm_term=120242524693650142&fbclid=PAZX'));
    expect(r).toMatchObject({
      channel: 'meta', confidence: 'ad',
      ad_id: '120248950422870142', adset_id: '120242524693650142', campaign_id: '120226653113540142',
      campaign_name: 'altorancho_valordeconv_dpa_aon', rules_version: RULES_VERSION,
    });
  });
  it('#59439: solo nombre de campaña → confidence campaign sin IDs', () => {
    const r = attribute(v('https://altorancho.com/search/?q=reposera&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_eventos_aon&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', campaign_id: null, ad_id: null, campaign_name: 'altorancho_conversiones_eventos_aon' });
  });
  it('#59420: utm_content no numérico no se toma como anuncio', () => {
    const r = attribute(v('https://altorancho.com/productos/x/?utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_dpa_aon&utm_content=altorancho_conversiones_dpa_postevento&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', ad_id: null });
  });
  it('fbclid solo, sin UTMs → Meta sin identificar', () => {
    expect(attribute(v('https://altorancho.com/?fbclid=PAZX'))).toMatchObject({ channel: 'meta', confidence: 'none' });
  });
  it('source facebook + medium paid también es Meta', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=facebook&utm_medium=paid&utm_campaign=x')).channel).toBe('meta');
  });
});

describe('attribute — Google', () => {
  it('#59459: gad_campaignid + gclid → Google con campaña', () => {
    const r = attribute(v('https://altorancho.com/?gad_source=1&gad_campaignid=11472612872&gbraid=0AAA&gclid=Cj0K'));
    expect(r).toMatchObject({ channel: 'google', confidence: 'campaign', campaign_id: '11472612872' });
  });
  it('#59427: gclid sin campaña → Google sin identificar', () => {
    expect(attribute(v('https://altorancho.com/productos/mmc011ne/?_gl=1*cpnl5r&gclid=CjwK&gbraid=0AAA'))).toMatchObject({ channel: 'google', confidence: 'none' });
  });
  it('#59457: TN guarda "gclid:…" dentro de utm_campaign y la landing no trae params', () => {
    const r = attribute(v('https://altorancho.com/productos/MEC011PT/?variant=1185074032', { ...NULL_UTM, utm_campaign: 'gclid:Cj0KCQjwuJLW' }));
    expect(r).toMatchObject({ channel: 'google', campaign_name: null });
  });
});

describe('attribute — resto de canales', () => {
  it('#59437: link en bio de IG → redes orgánicas (aunque traiga fbclid)', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZX')).channel).toBe('social_organic');
  });
  it('#59413: email de Perfit con espacios y | en la campaña', () => {
    const r = attribute(v('https://altorancho.com/?utm_source=perfit&utm_medium=email&utm_campaign=Productos en 12 cuotas | Fresh&pc=44369'));
    expect(r).toMatchObject({ channel: 'email', campaign_name: 'Productos en 12 cuotas | Fresh' });
  });
  it('#59461: home sin parámetros → orgánica', () => {
    expect(attribute(v('https://altorancho.com/')).channel).toBe('organic');
  });
  it('#59419: landing en checkout success sin params → orgánica', () => {
    expect(attribute(v('https://altorancho.com/checkout/v3/success/2084232794/34b8')).channel).toBe('organic');
  });
  it('#59425: sin customer_visit → unknown', () => {
    expect(attribute({ landingUrl: null, visitLandingPage: null, visitUtm: NULL_UTM })).toMatchObject({ channel: 'unknown', confidence: 'none' });
  });
  it('utm_source desconocido → other', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=tiktok&utm_medium=bio')).channel).toBe('other');
  });
  it('URL malformada o relativa no rompe', () => {
    expect(attribute(v('http://')).channel).toBe('organic');
    expect(attribute(v('/productos/x?utm_source=meta&utm_medium=cpc&utm_campaign=c1')).channel).toBe('meta');
  });
  it('source_raw guarda solo los parámetros relevantes', () => {
    const r = attribute(v('https://altorancho.com/?variant=1&gclid=abc&gad_campaignid=12345678'));
    expect(r.source_raw).toEqual({ gclid: 'abc', gad_campaignid: '12345678' });
  });
});

describe('extractParams', () => {
  it('la landing gana sobre utm_parameters; utm_parameters completa lo que falta', () => {
    const p = extractParams({
      landingUrl: null,
      visitLandingPage: 'https://altorancho.com/?utm_source=meta&UTM_MEDIUM=cpc',
      visitUtm: { utm_source: 'otro', utm_campaign: 'camp' },
    });
    expect(p).toMatchObject({ utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'camp' });
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/attribution.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `backend/src/engine/attribution.js`**

```js
// Reglas de atribución de una orden de Tienda Nube a partir de su customer_visit.
// Puro: no toca la DB. Los IDs faltantes se completan después con ordersRepo.resolveMetaIds().
export const RULES_VERSION = 1;

const META_SOURCES = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig']);
const PAID_MEDIUMS = new Set(['cpc', 'paid', 'paid_social', 'paidsocial', 'ads']);
const SOCIAL_MEDIUMS = new Set(['social', 'organic_social']);
const GOOGLE_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'gad_campaignid'];
const RAW_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_campaignid'];

const numericId = (v) => (typeof v === 'string' && /^\d{6,}$/.test(v) ? v : null);

function paramsFromUrl(u) {
  if (!u) return {};
  try {
    const out = {};
    for (const [k, val] of new URL(u, 'https://placeholder.invalid').searchParams) out[k.toLowerCase()] = val;
    return out;
  } catch {
    return {};
  }
}

export function extractParams({ landingUrl, visitLandingPage, visitUtm }) {
  const p = { ...paramsFromUrl(landingUrl), ...paramsFromUrl(visitLandingPage) };
  for (const [k, val] of Object.entries(visitUtm || {})) {
    if (val && !p[k]) p[k] = String(val);
  }
  // Quirk de TN: a veces guarda "gclid:XXXX" dentro de utm_campaign
  if (p.utm_campaign && p.utm_campaign.startsWith('gclid:')) {
    if (!p.gclid) p.gclid = p.utm_campaign.slice('gclid:'.length);
    delete p.utm_campaign;
  }
  return p;
}

export function attribute(visit) {
  const p = extractParams(visit);
  const raw = Object.fromEntries(RAW_KEYS.filter((k) => p[k]).map((k) => [k, p[k]]));
  const result = (channel, confidence = 'none', extra = {}) => ({
    channel, confidence, campaign_id: null, adset_id: null, ad_id: null, campaign_name: null,
    source_raw: raw, rules_version: RULES_VERSION, ...extra,
  });
  const hasVisit = Boolean(visit.visitLandingPage || visit.landingUrl);
  const src = (p.utm_source || '').toLowerCase();
  const med = (p.utm_medium || '').toLowerCase();

  const isMeta = (META_SOURCES.has(src) && PAID_MEDIUMS.has(med))
    || (p.fbclid && p.utm_campaign && !SOCIAL_MEDIUMS.has(med) && med !== 'email')
    || (p.fbclid && !src && !med);
  if (isMeta) {
    const ad_id = numericId(p.utm_content);
    const adset_id = numericId(p.utm_term);
    const campaign_id = numericId(p.utm_id) || numericId(p.utm_campaign);
    const campaign_name = p.utm_campaign && !numericId(p.utm_campaign) ? p.utm_campaign.trim() : null;
    const confidence = ad_id ? 'ad' : (campaign_id || campaign_name) ? 'campaign' : 'none';
    return result('meta', confidence, { ad_id, adset_id, campaign_id, campaign_name });
  }
  if (GOOGLE_CLICK_IDS.some((k) => p[k]) || (src === 'google' && PAID_MEDIUMS.has(med))) {
    const campaign_id = numericId(p.gad_campaignid);
    return result('google', campaign_id ? 'campaign' : 'none', { campaign_id, campaign_name: p.utm_campaign || null });
  }
  if (med === 'email') return result('email', 'none', { campaign_name: p.utm_campaign || null });
  if (SOCIAL_MEDIUMS.has(med) || META_SOURCES.has(src)) return result('social_organic');
  if (src) return result('other', 'none', { campaign_name: p.utm_campaign || null });
  return hasVisit ? result('organic') : result('unknown');
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/attribution.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/engine/attribution.js backend/test/attribution.test.js
git commit -m "feat: motor de atribución de órdenes (Meta/Google/email/orgánica)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mapeo de órdenes TN y utilidades de fecha ART

**Files:**
- Create: `backend/src/engine/mapOrder.js`, `backend/src/engine/dates.js`
- Test: `backend/test/mapOrder.test.js`, `backend/test/dates.test.js`

**Interfaces:**
- Produces:
  - `mapOrder(tnOrder) → { order, items, visit }`. `order` tiene exactamente las columnas de `orders` salvo `synced_at` (ids string, montos number, timestamps string ISO o null). `items: [{ product_id, variant_id, sku, name, quantity, price }]`. `visit: { landingUrl, visitLandingPage, visitUtm }` (entrada de `attribute`).
  - `artDate(date?: Date|string) → 'YYYY-MM-DD'` (día en Argentina).
  - `addDays(ymd, n) → ymd`.
  - `artDayStart(ymd) → 'YYYY-MM-DDT00:00:00-03:00'`.
  - `monthRanges(fromYmd, toYmd) → [{ since, until }]`.
  - `isYmd(s) → boolean`.

- [ ] **Step 1: Tests de fechas `backend/test/dates.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { artDate, addDays, artDayStart, monthRanges, isYmd } from '../src/engine/dates.js';

describe('dates ART', () => {
  it('01:30 UTC del día D es el día D-1 en Argentina', () => {
    expect(artDate(new Date('2026-10-06T01:30:00Z'))).toBe('2026-10-05');
    expect(artDate(new Date('2026-10-06T03:00:00Z'))).toBe('2026-10-06');
  });
  it('addDays cruza meses y años', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('artDayStart', () => {
    expect(artDayStart('2026-10-06')).toBe('2026-10-06T00:00:00-03:00');
  });
  it('monthRanges recorta extremos', () => {
    expect(monthRanges('2026-08-15', '2026-10-06')).toEqual([
      { since: '2026-08-15', until: '2026-08-31' },
      { since: '2026-09-01', until: '2026-09-30' },
      { since: '2026-10-01', until: '2026-10-06' },
    ]);
  });
  it('isYmd', () => {
    expect(isYmd('2026-10-06')).toBe(true);
    expect(isYmd('2026-13-01')).toBe(false);
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('06/10/2026')).toBe(false);
    expect(isYmd(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Tests de mapeo `backend/test/mapOrder.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { mapOrder } from '../src/engine/mapOrder.js';

// Recorte de una orden real de la API de TN (datos personales ficticios)
export const tnOrder = {
  id: 2087839852, number: 59461, status: 'open', payment_status: 'paid',
  created_at: '2026-10-06T12:30:11+0000', paid_at: '2026-10-06T12:31:00+0000', cancelled_at: null,
  updated_at: '2026-10-06T12:35:00+0000',
  total: '40497.12', subtotal: '39990.00', discount: '0.00', shipping_cost_customer: '507.12',
  currency: 'ARS', gateway_name: 'Pago Nube', storefront: 'mobile',
  contact_name: 'Cliente Prueba', contact_email: 'cliente@example.com',
  customer: { name: 'Cliente Prueba', email: 'cliente@example.com' },
  landing_url: 'https://altorancho.com/',
  customer_visit: {
    created_at: '2026-10-06T12:23:02+0000', landing_page: 'https://altorancho.com/',
    utm_parameters: { utm_campaign: null, utm_content: null, utm_medium: null, utm_source: null, utm_term: null },
  },
  products: [{ product_id: 291289895, variant_id: 1303147630, sku: 'IME040PR', name: 'Lampara Baby Fungi', quantity: 1, price: '39990.00' }],
};

describe('mapOrder', () => {
  it('mapea columnas de orders', () => {
    expect(mapOrder(tnOrder).order).toEqual({
      id: '2087839852', number: 59461, created_at: '2026-10-06T12:30:11+00:00', paid_at: '2026-10-06T12:31:00+00:00',
      cancelled_at: null, status: 'open', payment_status: 'paid', total: 40497.12, subtotal: 39990, discount: 0,
      shipping_cost_customer: 507.12, currency: 'ARS', gateway_name: 'Pago Nube', storefront: 'mobile',
      customer_name: 'Cliente Prueba', customer_email: 'cliente@example.com', landing_url: 'https://altorancho.com/',
      visit_landing_page: 'https://altorancho.com/', visit_created_at: '2026-10-06T12:23:02+00:00',
      visit_utm: tnOrder.customer_visit.utm_parameters, updated_at_tn: '2026-10-06T12:35:00+00:00',
    });
  });
  it('mapea items', () => {
    expect(mapOrder(tnOrder).items).toEqual([
      { product_id: '291289895', variant_id: '1303147630', sku: 'IME040PR', name: 'Lampara Baby Fungi', quantity: 1, price: 39990 },
    ]);
  });
  it('arma la entrada de attribute', () => {
    expect(mapOrder(tnOrder).visit).toEqual({
      landingUrl: 'https://altorancho.com/', visitLandingPage: 'https://altorancho.com/', visitUtm: tnOrder.customer_visit.utm_parameters,
    });
  });
  it('tolera orden sin customer_visit, sin customer y con nombre multi-idioma', () => {
    const { order, items, visit } = mapOrder({
      ...tnOrder, customer_visit: null, customer: null, landing_url: null,
      products: [{ product_id: 1, variant_id: 2, name: { es: 'Silla' }, quantity: '2', price: '100' }],
    });
    expect(order.visit_landing_page).toBeNull();
    expect(order.customer_name).toBe('Cliente Prueba');
    expect(items[0]).toMatchObject({ name: 'Silla', quantity: 2, price: 100, sku: null });
    expect(visit).toEqual({ landingUrl: null, visitLandingPage: null, visitUtm: null });
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/dates.test.js test/mapOrder.test.js`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 4: Implementar `backend/src/engine/dates.js`**

```js
// Argentina es UTC-3 fijo (sin horario de verano).
const OFFSET_MS = 3 * 3600 * 1000;

export const artDate = (d = new Date()) => new Date(new Date(d).getTime() - OFFSET_MS).toISOString().slice(0, 10);

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const artDayStart = (ymd) => `${ymd}T00:00:00-03:00`;

export function monthRanges(fromYmd, toYmd) {
  const out = [];
  let cur = `${fromYmd.slice(0, 7)}-01`;
  while (cur <= toYmd) {
    const d = new Date(`${cur}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const next = d.toISOString().slice(0, 10);
    const until = addDays(next, -1);
    out.push({ since: cur < fromYmd ? fromYmd : cur, until: until > toYmd ? toYmd : until });
    cur = next;
  }
  return out;
}

export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
```

- [ ] **Step 5: Implementar `backend/src/engine/mapOrder.js`**

```js
// Orden cruda de la API de Tienda Nube → filas para orders / order_items + entrada de attribute().
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
// TN manda offsets "+0000"; se normalizan a "+00:00"
const ts = (v) => (v ? String(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : null);
const idStr = (v) => (v === null || v === undefined ? null : String(v));
const text = (v) => (typeof v === 'string' ? v : v?.es ?? null);

export function mapOrder(o) {
  const visit = o.customer_visit || {};
  const landingUrl = o.landing_url || null;
  const visitLandingPage = visit.landing_page || null;
  const visitUtm = visit.utm_parameters || null;
  return {
    order: {
      id: String(o.id),
      number: Number(o.number),
      created_at: ts(o.created_at),
      paid_at: ts(o.paid_at),
      cancelled_at: ts(o.cancelled_at),
      status: o.status,
      payment_status: o.payment_status,
      total: num(o.total) ?? 0,
      subtotal: num(o.subtotal),
      discount: num(o.discount),
      shipping_cost_customer: num(o.shipping_cost_customer),
      currency: o.currency || null,
      gateway_name: o.gateway_name || null,
      storefront: o.storefront || null,
      customer_name: o.customer?.name || o.contact_name || null,
      customer_email: o.customer?.email || o.contact_email || null,
      landing_url: landingUrl,
      visit_landing_page: visitLandingPage,
      visit_created_at: ts(visit.created_at),
      visit_utm: visitUtm,
      updated_at_tn: ts(o.updated_at),
    },
    items: (o.products || []).map((p) => ({
      product_id: idStr(p.product_id),
      variant_id: idStr(p.variant_id),
      sku: p.sku || null,
      name: text(p.name),
      quantity: Number(p.quantity) || 0,
      price: num(p.price) ?? 0,
    })),
    visit: { landingUrl, visitLandingPage, visitUtm },
  };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/dates.test.js test/mapOrder.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/engine/dates.js backend/src/engine/mapOrder.js backend/test/dates.test.js backend/test/mapOrder.test.js
git commit -m "feat: mapeo de órdenes TN y utilidades de fecha ART

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Repositorios (órdenes, Meta, corridas de sync)

**Files:**
- Create: `backend/src/repo/bulk.js`, `backend/src/repo/orders.js`, `backend/src/repo/meta.js`, `backend/src/repo/syncRuns.js`
- Test: `backend/test/repos.test.js`

**Interfaces:**
- Consumes: `db` (Task 2), `mapOrder` (Task 4), `attribute` (Task 3) — solo en tests.
- Produces:
  - `bulkUpsert(db, { table, columns, conflict, rows, extraSet?, chunk? }) → Promise<void>` (deduplica por clave de conflicto; la última fila gana).
  - `createOrdersRepo(db) → { upsert({ order, items, attribution }), resolveMetaIds(orderId?: string|null), listForReattribution(afterId: string, limit: number) → [{ id, landing_url, visit_landing_page, visit_utm }], setAttribution(orderId, attribution) }`
  - `createMetaRepo(db) → { upsertAds(rows), upsertSpend(rows), markAdTags(adId, urlTags), listAdsMissingParams() → [{ id, name, status, campaign_name }] }`
    - fila de ad: `{ id, level, name, status, parent_id, campaign_id, thumbnail_url, url_tags, has_attribution_params }`
    - fila de gasto: `{ ad_id, date, campaign_id, adset_id, spend, impressions, clicks, meta_purchases, meta_purchase_value }`
  - `createSyncRunsRepo(db) → { start(source) → id:number, progress(id, { rows, cursor }), finish(id, { status, rows, error, cursor }), lastCursor(source) → object|null, latestBySource() → [{ source, started_at, finished_at, status, rows, error }], lastSuccessBySource() → [{ source, finished_at }], recentErrors(limit) → [{ source, started_at, error }], markStaleRunning() }`

- [ ] **Step 1: Escribir los tests `backend/test/repos.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const baseTn = {
  id: 1001, number: 500, status: 'open', payment_status: 'pending', created_at: '2026-10-05T15:00:00+0000',
  total: '1000.00', products: [{ product_id: 1, variant_id: 11, sku: 'A', name: 'Lámpara', quantity: 1, price: '1000' }],
  customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=Camp Uno', utm_parameters: {} },
};
const prepare = (tn) => { const m = mapOrder(tn); return { ...m, attribution: attribute(m.visit) }; };

let db; let orders; let meta; let runs;
beforeEach(async () => {
  db = await createTestDb();
  orders = createOrdersRepo(db);
  meta = createMetaRepo(db);
  runs = createSyncRunsRepo(db);
});
afterEach(() => db.close());

describe('ordersRepo.upsert', () => {
  it('re-sincronizar la misma orden no duplica items y actualiza estado', async () => {
    await orders.upsert(prepare(baseTn));
    await orders.upsert(prepare({ ...baseTn, payment_status: 'paid' }));
    await orders.upsert(prepare({ ...baseTn, payment_status: 'paid', cancelled_at: '2026-10-06T10:00:00+0000' }));
    const { rows: o } = await db.query('SELECT payment_status, cancelled_at IS NOT NULL AS cancelled FROM orders');
    const { rows: it } = await db.query('SELECT count(*)::int AS n FROM order_items');
    expect(o).toEqual([{ payment_status: 'paid', cancelled: true }]);
    expect(it[0].n).toBe(1);
  });
  it('campaña por nombre sin catálogo queda sin id y se resuelve cuando llega el catálogo', async () => {
    await orders.upsert(prepare(baseTn));
    let { rows } = await db.query('SELECT campaign_id FROM order_attribution');
    expect(rows[0].campaign_id).toBeNull();
    await meta.upsertAds([{ id: '900', level: 'campaign', name: 'camp uno', status: 'ACTIVE', parent_id: null, campaign_id: '900', thumbnail_url: null, url_tags: null, has_attribution_params: false }]);
    await orders.resolveMetaIds();
    ({ rows } = await db.query('SELECT campaign_id FROM order_attribution'));
    expect(rows[0].campaign_id).toBe('900');
  });
  it('anuncio conocido completa conjunto y campaña al guardar', async () => {
    const tn = { ...baseTn, customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=777777', utm_parameters: {} } };
    await meta.upsertAds([{ id: '777777', level: 'ad', name: 'Ad2', status: 'ACTIVE', parent_id: '555', campaign_id: '900', thumbnail_url: null, url_tags: null, has_attribution_params: true }]);
    await orders.upsert(prepare(tn));
    const { rows } = await db.query('SELECT ad_id, adset_id, campaign_id, confidence FROM order_attribution');
    expect(rows[0]).toEqual({ ad_id: '777777', adset_id: '555', campaign_id: '900', confidence: 'ad' });
  });
  it('listForReattribution pagina por id y setAttribution reemplaza', async () => {
    await orders.upsert(prepare(baseTn));
    await orders.upsert(prepare({ ...baseTn, id: 1002, number: 501 }));
    const page = await orders.listForReattribution('0', 1);
    expect(page.map((r) => r.id)).toEqual(['1001']);
    expect((await orders.listForReattribution('1001', 10)).map((r) => r.id)).toEqual(['1002']);
    await orders.setAttribution('1001', { ...attribute({ landingUrl: null, visitLandingPage: null, visitUtm: null }) });
    const { rows } = await db.query("SELECT channel FROM order_attribution WHERE order_id = 1001");
    expect(rows[0].channel).toBe('unknown');
  });
});

describe('metaRepo', () => {
  it('upsertSpend deduplica por (ad_id, date) y actualiza', async () => {
    const row = { ad_id: '1', date: '2026-10-01', campaign_id: 'c', adset_id: 's', spend: 10, impressions: 100, clicks: 5, meta_purchases: 1, meta_purchase_value: 50 };
    await meta.upsertSpend([row, { ...row, spend: 12 }]);
    await meta.upsertSpend([{ ...row, spend: 15 }]);
    const { rows } = await db.query('SELECT spend::float8 AS spend, date::text AS date FROM meta_spend_daily');
    expect(rows).toEqual([{ spend: 15, date: '2026-10-01' }]);
  });
  it('listAdsMissingParams y markAdTags', async () => {
    await meta.upsertAds([
      { id: 'c1', level: 'campaign', name: 'Camp', status: 'ACTIVE', parent_id: null, campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
      { id: 'a1', level: 'ad', name: 'Ad 1', status: 'ACTIVE', parent_id: 's1', campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
      { id: 'a2', level: 'ad', name: 'Ad 2', status: 'PAUSED', parent_id: 's1', campaign_id: 'c1', thumbnail_url: null, url_tags: null, has_attribution_params: false },
    ]);
    expect(await meta.listAdsMissingParams()).toEqual([{ id: 'a1', name: 'Ad 1', status: 'ACTIVE', campaign_name: 'Camp' }]);
    await meta.markAdTags('a1', 'utm_content={{ad.id}}');
    expect(await meta.listAdsMissingParams()).toEqual([]);
  });
});

describe('syncRunsRepo', () => {
  it('start/progress/finish y lastCursor', async () => {
    const id = await runs.start('tn_backfill');
    await runs.progress(id, { rows: 10, cursor: { month: '2026-01' } });
    await runs.finish(id, { status: 'error', rows: 10, error: 'boom' });
    expect(await runs.lastCursor('tn_backfill')).toEqual({ month: '2026-01' });
    expect(await runs.lastCursor('meta_spend')).toBeNull();
    const latest = await runs.latestBySource();
    expect(latest[0]).toMatchObject({ source: 'tn_backfill', status: 'error', rows: 10, error: 'boom' });
    expect((await runs.recentErrors(5))[0]).toMatchObject({ source: 'tn_backfill', error: 'boom' });
  });
  it('markStaleRunning cierra corridas colgadas por reinicio', async () => {
    await runs.start('meta_spend');
    await runs.markStaleRunning();
    expect((await runs.latestBySource())[0].status).toBe('error');
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/repos.test.js`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar `backend/src/repo/bulk.js`**

```js
// INSERT … ON CONFLICT DO UPDATE en lotes. Deduplica por clave de conflicto
// (Postgres no permite tocar la misma fila dos veces en un mismo statement).
export async function bulkUpsert(db, { table, columns, conflict, rows, extraSet = [], chunk = 300 }) {
  const byKey = new Map();
  for (const r of rows) byKey.set(conflict.map((c) => r[c]).join('\u0000'), r);
  const unique = [...byKey.values()];
  const updates = [...columns.filter((c) => !conflict.includes(c)).map((c) => `${c} = EXCLUDED.${c}`), ...extraSet];
  for (let i = 0; i < unique.length; i += chunk) {
    const params = [];
    const tuples = unique.slice(i, i + chunk).map((r) => `(${columns.map((c) => {
      params.push(r[c] ?? null);
      return `$${params.length}`;
    }).join(', ')})`);
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
      params,
    );
  }
}
```

- [ ] **Step 4: Implementar `backend/src/repo/orders.js`**

```js
const ORDER_COLS = ['id', 'number', 'created_at', 'paid_at', 'cancelled_at', 'status', 'payment_status', 'total',
  'subtotal', 'discount', 'shipping_cost_customer', 'currency', 'gateway_name', 'storefront', 'customer_name',
  'customer_email', 'landing_url', 'visit_landing_page', 'visit_created_at', 'visit_utm', 'updated_at_tn'];
const ATTR_COLS = ['channel', 'confidence', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'source_raw', 'rules_version'];

// Completa adset/campaign desde el catálogo de Meta. $1 = order_id o null (todas).
const RESOLVE_SQL = [
  `UPDATE order_attribution oa
      SET adset_id = COALESCE(oa.adset_id, a.parent_id), campaign_id = COALESCE(oa.campaign_id, a.campaign_id)
     FROM meta_ads a
    WHERE a.level = 'ad' AND a.id = oa.ad_id AND (oa.adset_id IS NULL OR oa.campaign_id IS NULL)
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
  `UPDATE order_attribution oa SET campaign_id = a.campaign_id
     FROM meta_ads a
    WHERE a.level = 'adset' AND a.id = oa.adset_id AND oa.campaign_id IS NULL
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
  `UPDATE order_attribution oa SET campaign_id = c.id
     FROM meta_ads c
    WHERE oa.channel = 'meta' AND oa.campaign_id IS NULL AND oa.campaign_name IS NOT NULL
      AND c.level = 'campaign' AND lower(c.name) = lower(oa.campaign_name)
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
];

async function writeAttribution(q, orderId, a) {
  const values = ATTR_COLS.map((c) => (c === 'source_raw' ? JSON.stringify(a.source_raw ?? {}) : a[c] ?? null));
  await q.query(
    `INSERT INTO order_attribution (order_id, ${ATTR_COLS.join(', ')})
     VALUES ($1, ${ATTR_COLS.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (order_id) DO UPDATE SET ${ATTR_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [orderId, ...values],
  );
}

async function resolveWith(q, orderId) {
  for (const sql of RESOLVE_SQL) await q.query(sql, [orderId]);
}

export function createOrdersRepo(db) {
  return {
    async upsert({ order, items, attribution }) {
      await db.tx(async (q) => {
        const values = ORDER_COLS.map((c) => (c === 'visit_utm' ? (order.visit_utm ? JSON.stringify(order.visit_utm) : null) : order[c]));
        await q.query(
          `INSERT INTO orders (${ORDER_COLS.join(', ')}) VALUES (${ORDER_COLS.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (id) DO UPDATE SET ${ORDER_COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, synced_at = now()`,
          values,
        );
        await q.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
        for (const it of items) {
          await q.query(
            'INSERT INTO order_items (order_id, product_id, variant_id, sku, name, quantity, price) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [order.id, it.product_id, it.variant_id, it.sku, it.name, it.quantity, it.price],
          );
        }
        await writeAttribution(q, order.id, attribution);
        await resolveWith(q, order.id);
      });
    },
    resolveMetaIds: (orderId = null) => resolveWith(db, orderId),
    async listForReattribution(afterId, limit) {
      const { rows } = await db.query(
        `SELECT id::text AS id, landing_url, visit_landing_page, visit_utm
           FROM orders WHERE id > $1::bigint ORDER BY id LIMIT $2`,
        [afterId, limit],
      );
      return rows;
    },
    setAttribution: (orderId, attribution) => db.tx((q) => writeAttribution(q, orderId, attribution)),
  };
}
```

- [ ] **Step 5: Implementar `backend/src/repo/meta.js`**

```js
import { bulkUpsert } from './bulk.js';

const AD_COLS = ['id', 'level', 'name', 'status', 'parent_id', 'campaign_id', 'thumbnail_url', 'url_tags', 'has_attribution_params'];
const SPEND_COLS = ['ad_id', 'date', 'campaign_id', 'adset_id', 'spend', 'impressions', 'clicks', 'meta_purchases', 'meta_purchase_value'];

export function createMetaRepo(db) {
  return {
    upsertAds: (rows) => bulkUpsert(db, { table: 'meta_ads', columns: AD_COLS, conflict: ['id'], rows, extraSet: ['updated_at = now()'] }),
    upsertSpend: (rows) => bulkUpsert(db, { table: 'meta_spend_daily', columns: SPEND_COLS, conflict: ['ad_id', 'date'], rows, extraSet: ['synced_at = now()'] }),
    async markAdTags(adId, urlTags) {
      await db.query('UPDATE meta_ads SET url_tags = $2, has_attribution_params = true, updated_at = now() WHERE id = $1', [adId, urlTags]);
    },
    async listAdsMissingParams() {
      const { rows } = await db.query(
        `SELECT a.id, a.name, a.status, c.name AS campaign_name
           FROM meta_ads a LEFT JOIN meta_ads c ON c.id = a.campaign_id
          WHERE a.level = 'ad' AND a.status = 'ACTIVE' AND NOT a.has_attribution_params
          ORDER BY c.name, a.name`,
      );
      return rows;
    },
  };
}
```

- [ ] **Step 6: Implementar `backend/src/repo/syncRuns.js`**

```js
export function createSyncRunsRepo(db) {
  return {
    async start(source) {
      const { rows } = await db.query('INSERT INTO sync_runs (source) VALUES ($1) RETURNING id::int AS id', [source]);
      return rows[0].id;
    },
    async progress(id, { rows, cursor }) {
      await db.query('UPDATE sync_runs SET rows = $2, cursor = $3 WHERE id = $1', [id, rows, cursor ? JSON.stringify(cursor) : null]);
    },
    async finish(id, { status, rows = 0, error = null, cursor = null }) {
      await db.query(
        `UPDATE sync_runs SET finished_at = now(), status = $2, rows = $3, error = $4, cursor = COALESCE($5::jsonb, cursor)
          WHERE id = $1`,
        [id, status, rows, error, cursor ? JSON.stringify(cursor) : null],
      );
    },
    async lastCursor(source) {
      const { rows } = await db.query(
        'SELECT cursor FROM sync_runs WHERE source = $1 AND cursor IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1',
        [source],
      );
      return rows[0]?.cursor ?? null;
    },
    async latestBySource() {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (source) source, started_at, finished_at, status, rows, error
           FROM sync_runs ORDER BY source, started_at DESC, id DESC`,
      );
      return rows;
    },
    async lastSuccessBySource() {
      const { rows } = await db.query("SELECT source, max(finished_at) AS finished_at FROM sync_runs WHERE status = 'ok' GROUP BY source");
      return rows;
    },
    async recentErrors(limit = 10) {
      const { rows } = await db.query(
        "SELECT source, started_at, error FROM sync_runs WHERE status = 'error' ORDER BY started_at DESC, id DESC LIMIT $1",
        [limit],
      );
      return rows;
    },
    async markStaleRunning() {
      await db.query("UPDATE sync_runs SET status = 'error', error = 'interrumpida (reinicio del servidor)', finished_at = now() WHERE status = 'running'");
    },
  };
}
```

- [ ] **Step 7: Correr tests**

Run: `cd backend && npx vitest run test/repos.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/repo backend/test/repos.test.js
git commit -m "feat: repositorios de órdenes, Meta y corridas de sincronización

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cliente de Tienda Nube robusto (paginación, rate limit, reintentos)

**Files:**
- Modify (reescribir): `backend/src/services/tiendanube.js`
- Test: `backend/test/tiendanube.test.js`

**Interfaces:**
- Produces: `createTiendanubeClient({ storeId, token, fetchFn?, sleep?, maxRetries? }) → {`
  - `getOrder(id) → order`
  - `listOrders({ page?, createdMin?, createdMax?, updatedMin? }) → order[]` (200 por página, `status=any`; página fuera de rango (404) → `[]`)
  - `listWebhooks() → webhook[]`
  - `createWebhook(event, url) → webhook` `}`
  - Errores HTTP no recuperables: `Error` con `.status`.

- [ ] **Step 1: Escribir los tests `backend/test/tiendanube.test.js`**

```js
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
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/tiendanube.test.js`
Expected: FAIL (`listOrders` no existe / firma vieja).

- [ ] **Step 3: Reescribir `backend/src/services/tiendanube.js`**

```js
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
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/tiendanube.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/tiendanube.js backend/test/tiendanube.test.js
git commit -m "feat: cliente Tienda Nube con paginación, rate limit y reintentos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Runner de jobs y sincronización de órdenes

**Files:**
- Create: `backend/src/sync/jobs.js`, `backend/src/sync/orders.js`
- Test: `backend/test/jobs.test.js`, `backend/test/orderSync.test.js`

**Interfaces:**
- Consumes: `createSyncRunsRepo` (Task 5), `createOrdersRepo` (Task 5), `mapOrder` (Task 4), `attribute` (Task 3), `artDate`/`monthRanges`/`artDayStart`/`addDays` (Task 4), cliente TN (Task 6).
- Produces:
  - `createJobRunner({ syncRuns, log? }) → { run(source, fn) → Promise<{ ok, rows?, error?, skipped? }>, runInBackground(source, fn) → boolean, isRunning(source) → boolean }`. `fn(ctx)` recibe `ctx = { progress(rows, cursor?) }` y devuelve la cantidad de filas. `run` nunca lanza.
  - `createOrderSync({ tn, ordersRepo, log? }) → { ingest(tnOrder), syncOrder(id) → 1, syncUpdatedSince(iso) → rows, backfill({ from?, to?, resumeAfter?, onMonthDone? }) → rows }`. Si alguna orden falla al guardarse, el resto sigue y al final lanza `Error` con los ids fallidos.
  - Cursor del backfill: `{ done: 'YYYY-MM', complete: boolean }`.

- [ ] **Step 1: Tests del runner `backend/test/jobs.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { createJobRunner } from '../src/sync/jobs.js';

let db; let runs; let jobs;
const silent = { error: () => {}, log: () => {} };
beforeEach(async () => {
  db = await createTestDb();
  runs = createSyncRunsRepo(db);
  jobs = createJobRunner({ syncRuns: runs, log: silent });
});
afterEach(() => db.close());

describe('jobRunner', () => {
  it('registra corrida ok con filas', async () => {
    expect(await jobs.run('meta_spend', async () => 42)).toEqual({ ok: true, rows: 42 });
    expect((await runs.latestBySource())[0]).toMatchObject({ source: 'meta_spend', status: 'ok', rows: 42 });
  });
  it('registra error sin lanzar y guarda el último cursor', async () => {
    const r = await jobs.run('tn_backfill', async (ctx) => {
      await ctx.progress(7, { done: '2026-01', complete: false });
      throw new Error('se cayó TN');
    });
    expect(r).toEqual({ ok: false, error: 'se cayó TN' });
    expect((await runs.latestBySource())[0]).toMatchObject({ status: 'error', rows: 7, error: 'se cayó TN' });
    expect(await runs.lastCursor('tn_backfill')).toEqual({ done: '2026-01', complete: false });
  });
  it('no corre dos veces el mismo job en paralelo', async () => {
    let release;
    const first = jobs.run('tn_incremental', () => new Promise((r) => { release = () => r(1); }));
    await new Promise((r) => setTimeout(r, 5));
    expect(jobs.isRunning('tn_incremental')).toBe(true);
    expect(await jobs.run('tn_incremental', async () => 1)).toEqual({ skipped: true });
    expect(jobs.runInBackground('tn_incremental', async () => 1)).toBe(false);
    release();
    await first;
    expect(jobs.isRunning('tn_incremental')).toBe(false);
  });
});
```

- [ ] **Step 2: Tests de la sync de órdenes `backend/test/orderSync.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createOrderSync } from '../src/sync/orders.js';

const order = (id, extra = {}) => ({
  id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-09-10T15:00:00+0000', total: '100',
  products: [], customer_visit: { landing_page: 'https://altorancho.com/', utm_parameters: {} }, ...extra,
});
const page = (start, n) => Array.from({ length: n }, (_, i) => order(start + i));

let db; let ordersRepo;
beforeEach(async () => { db = await createTestDb(); ordersRepo = createOrdersRepo(db); });
afterEach(() => db.close());
const count = async () => (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;

describe('orderSync', () => {
  it('syncOrder trae la orden completa y la guarda con atribución', async () => {
    const tn = { getOrder: vi.fn().mockResolvedValue(order(5, { customer_visit: { landing_page: 'https://altorancho.com/?gclid=x', utm_parameters: {} } })) };
    await createOrderSync({ tn, ordersRepo }).syncOrder(5);
    const { rows } = await db.query('SELECT channel FROM order_attribution WHERE order_id = 5');
    expect(rows[0].channel).toBe('google');
  });
  it('syncUpdatedSince pagina hasta una página incompleta', async () => {
    const listOrders = vi.fn()
      .mockResolvedValueOnce(page(1, 200))
      .mockResolvedValueOnce(page(201, 3));
    const rows = await createOrderSync({ tn: { listOrders }, ordersRepo }).syncUpdatedSince('2026-10-06T10:00:00Z');
    expect(rows).toBe(203);
    expect(await count()).toBe(203);
    expect(listOrders.mock.calls.map((c) => c[0])).toEqual([
      { updatedMin: '2026-10-06T10:00:00Z', page: 1 }, { updatedMin: '2026-10-06T10:00:00Z', page: 2 },
    ]);
  });
  it('backfill recorre meses, informa cada mes y retoma después de resumeAfter', async () => {
    const listOrders = vi.fn().mockImplementation(async ({ createdMin }) => (createdMin.startsWith('2026-08') ? [order(1)] : [order(2)]));
    const onMonthDone = vi.fn();
    const sync = createOrderSync({ tn: { listOrders }, ordersRepo });
    await sync.backfill({ from: '2026-07-01', to: '2026-09-15', resumeAfter: '2026-07', onMonthDone });
    expect(listOrders.mock.calls.map((c) => [c[0].createdMin, c[0].createdMax])).toEqual([
      ['2026-08-01T00:00:00-03:00', '2026-09-01T00:00:00-03:00'],
      ['2026-09-01T00:00:00-03:00', '2026-09-16T00:00:00-03:00'],
    ]);
    expect(onMonthDone.mock.calls.map((c) => c[0])).toEqual(['2026-08', '2026-09']);
    expect(await count()).toBe(2);
  });
  it('una orden rota no frena el resto y al final informa el id', async () => {
    const listOrders = vi.fn().mockResolvedValueOnce([order(1), { id: 2, number: 2 }, order(3)]);
    const sync = createOrderSync({ tn: { listOrders }, ordersRepo, log: { error: () => {} } });
    await expect(sync.syncUpdatedSince('2026-10-06T10:00:00Z')).rejects.toThrow(/1 órdenes fallaron.*2/);
    expect(await count()).toBe(2);
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/jobs.test.js test/orderSync.test.js`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 4: Implementar `backend/src/sync/jobs.js`**

```js
// Corre jobs de sincronización: uno por source a la vez (lock en memoria, una sola réplica),
// registrando cada corrida en sync_runs. run() nunca lanza: los errores quedan en la corrida.
export function createJobRunner({ syncRuns, log = console }) {
  const running = new Set();

  async function run(source, fn) {
    if (running.has(source)) return { skipped: true };
    running.add(source);
    try {
      const id = await syncRuns.start(source);
      const ctx = {
        rows: 0,
        cursor: null,
        async progress(rows, cursor) {
          ctx.rows = rows;
          if (cursor) ctx.cursor = cursor;
          await syncRuns.progress(id, { rows: ctx.rows, cursor: ctx.cursor });
        },
      };
      try {
        const rows = await fn(ctx);
        const total = typeof rows === 'number' ? rows : ctx.rows;
        await syncRuns.finish(id, { status: 'ok', rows: total, cursor: ctx.cursor });
        return { ok: true, rows: total };
      } catch (err) {
        log.error(`[job ${source}] falló:`, err);
        const message = String(err?.message || err);
        await syncRuns.finish(id, { status: 'error', rows: ctx.rows, error: message.slice(0, 2000), cursor: ctx.cursor });
        return { ok: false, error: message };
      }
    } catch (err) {
      log.error(`[job ${source}] no se pudo registrar:`, err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running.delete(source);
    }
  }

  function runInBackground(source, fn) {
    if (running.has(source)) return false;
    run(source, fn);
    return true;
  }

  return { run, runInBackground, isRunning: (source) => running.has(source) };
}
```

- [ ] **Step 5: Implementar `backend/src/sync/orders.js`**

```js
import { mapOrder } from '../engine/mapOrder.js';
import { attribute } from '../engine/attribution.js';
import { artDate, addDays, artDayStart, monthRanges } from '../engine/dates.js';

const PAGE_SIZE = 200;

export function createOrderSync({ tn, ordersRepo, log = console }) {
  async function ingest(tnOrder) {
    const m = mapOrder(tnOrder);
    await ordersRepo.upsert({ ...m, attribution: attribute(m.visit) });
  }

  // Pagina con los filtros dados; las órdenes que fallan se acumulan en `failed` sin frenar el resto.
  async function syncPages(filters, failed) {
    let rows = 0;
    for (let page = 1; ; page += 1) {
      const list = await tn.listOrders({ ...filters, page });
      for (const o of list) {
        try {
          await ingest(o);
          rows += 1;
        } catch (err) {
          log.error(`[orders] no se pudo guardar la orden ${o?.id}:`, err);
          failed.push(o?.id);
        }
      }
      if (list.length < PAGE_SIZE) return rows;
    }
  }

  function assertNoFailures(failed) {
    if (failed.length) throw new Error(`${failed.length} órdenes fallaron: ${failed.slice(0, 20).join(', ')}`);
  }

  return {
    ingest,
    async syncOrder(id) {
      await ingest(await tn.getOrder(id));
      return 1;
    },
    async syncUpdatedSince(iso) {
      const failed = [];
      const rows = await syncPages({ updatedMin: iso }, failed);
      assertNoFailures(failed);
      return rows;
    },
    async backfill({ from = '2018-01-01', to = artDate(), resumeAfter = null, onMonthDone = async () => {} } = {}) {
      const failed = [];
      let rows = 0;
      for (const { since, until } of monthRanges(from, to)) {
        const month = since.slice(0, 7);
        if (resumeAfter && month <= resumeAfter) continue;
        rows += await syncPages({ createdMin: artDayStart(since), createdMax: artDayStart(addDays(until, 1)) }, failed);
        await onMonthDone(month, rows);
      }
      assertNoFailures(failed);
      return rows;
    },
  };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/jobs.test.js test/orderSync.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/sync backend/test/jobs.test.js backend/test/orderSync.test.js
git commit -m "feat: runner de jobs y sincronización de órdenes (webhook, incremental, backfill)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Cliente de Meta (catálogo, insights diarios, creativos) y helpers puros

**Files:**
- Modify (reescribir): `backend/src/services/meta.js`
- Create: `backend/src/engine/metaInsights.js`, `backend/src/engine/urlTags.js`
- Test: `backend/test/meta.test.js`, `backend/test/metaInsights.test.js`, `backend/test/urlTags.test.js`

**Interfaces:**
- Produces:
  - `createMetaClient({ accessToken, accountId, fetchFn?, sleep?, maxRetries?, pollMs? }) → {`
    - `listCampaigns() → [{ id, name, effective_status }]`
    - `listAdsets() → [{ id, name, effective_status, campaign_id }]`
    - `listAds() → [{ id, name, effective_status, adset_id, campaign_id, creative?: { id, thumbnail_url, url_tags } }]`
    - `getDailyAdInsights(since, until) → row[]` (sincrónico, paginado)
    - `getDailyAdInsightsAsync(since, until) → row[]` (report run asincrónico + polling)
    - `getAdCreativeId(adId) → creativeId`
    - `getCreative(creativeId) → creative` (campos de `CREATIVE_COPY_FIELDS` + `url_tags`, `name`)
    - `createCreative(spec) → { id }`
    - `updateAdCreative(adId, creativeId)` `}`
    - Reintenta errores de rate limit de Meta (códigos 4, 17, 32, 613, 80004) con backoff exponencial.
  - `parseInsightRow(row) → { ad_id, date, campaign_id, adset_id, spend, impressions, clicks, meta_purchases, meta_purchase_value }`
  - `URL_TAGS_TEMPLATE: string` (Global Constraints), `hasAttributionParams(urlTags) → boolean`, `mergeUrlTags(existing) → string`, `CREATIVE_COPY_FIELDS: string[]`, `buildCreativeCopy(creative) → spec`.

- [ ] **Step 1: Tests de helpers puros `backend/test/metaInsights.test.js` y `backend/test/urlTags.test.js`**

```js
// backend/test/metaInsights.test.js
import { describe, it, expect } from 'vitest';
import { parseInsightRow } from '../src/engine/metaInsights.js';

describe('parseInsightRow', () => {
  it('convierte strings a números y toma compras de "purchase"', () => {
    expect(parseInsightRow({
      ad_id: '1', adset_id: '2', campaign_id: '3', date_start: '2026-10-05', date_stop: '2026-10-05',
      spend: '1234.56', impressions: '1000', clicks: '20',
      actions: [{ action_type: 'link_click', value: '20' }, { action_type: 'purchase', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }],
      action_values: [{ action_type: 'purchase', value: '90000.5' }],
    })).toEqual({
      ad_id: '1', date: '2026-10-05', campaign_id: '3', adset_id: '2', spend: 1234.56, impressions: 1000, clicks: 20,
      meta_purchases: 3, meta_purchase_value: 90000.5,
    });
  });
  it('si no hay "purchase" usa el evento del píxel; sin acciones → 0', () => {
    expect(parseInsightRow({ ad_id: '1', date_start: '2026-10-05', spend: '0', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }] }))
      .toMatchObject({ meta_purchases: 2, meta_purchase_value: 0, impressions: 0, clicks: 0 });
  });
});
```

```js
// backend/test/urlTags.test.js
import { describe, it, expect } from 'vitest';
import { URL_TAGS_TEMPLATE, hasAttributionParams, mergeUrlTags, buildCreativeCopy } from '../src/engine/urlTags.js';

describe('urlTags', () => {
  it('detecta la plantilla', () => {
    expect(hasAttributionParams(URL_TAGS_TEMPLATE)).toBe(true);
    expect(hasAttributionParams('utm_source=meta&utm_campaign=x')).toBe(false);
    expect(hasAttributionParams(null)).toBe(false);
  });
  it('merge reemplaza utm_* existentes y conserva otros parámetros', () => {
    expect(mergeUrlTags('media_type=image&utm_source=fb&utm_campaign=viejo')).toBe(`media_type=image&${URL_TAGS_TEMPLATE}`);
    expect(mergeUrlTags(null)).toBe(URL_TAGS_TEMPLATE);
  });
  it('buildCreativeCopy copia solo los campos permitidos y pone los url_tags', () => {
    const spec = buildCreativeCopy({
      id: '1', name: 'Creativo', thumbnail_url: 'x', url_tags: 'utm_source=fb',
      object_story_spec: { page_id: '448608595902716', link_data: { link: 'https://altorancho.com' } },
      degrees_of_freedom_spec: { creative_features_spec: {} },
    });
    expect(spec).toEqual({
      name: 'Creativo [utm]',
      object_story_spec: { page_id: '448608595902716', link_data: { link: 'https://altorancho.com' } },
      degrees_of_freedom_spec: { creative_features_spec: {} },
      url_tags: URL_TAGS_TEMPLATE,
    });
  });
});
```

- [ ] **Step 2: Tests del cliente `backend/test/meta.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMetaClient } from '../src/services/meta.js';

const ok = (body) => ({ json: async () => body });
const make = (fetchFn, extra = {}) => createMetaClient({ accessToken: 'tok', accountId: 'act_1', fetchFn, sleep: vi.fn().mockResolvedValue(), pollMs: 0, ...extra });

describe('cliente meta', () => {
  it('pagina siguiendo paging.cursors.after mientras haya paging.next', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ data: [{ id: '1' }], paging: { cursors: { after: 'A' }, next: 'https://x' } }))
      .mockResolvedValueOnce(ok({ data: [{ id: '2' }], paging: { cursors: { after: 'B' } } }));
    const r = await make(fetchFn).listCampaigns();
    expect(r).toEqual([{ id: '1' }, { id: '2' }]);
    const second = new URL(fetchFn.mock.calls[1][0]);
    expect(second.searchParams.get('after')).toBe('A');
    expect(second.pathname).toBe('/v23.0/act_1/campaigns');
  });
  it('listAds pide el creativo con thumbnail y url_tags', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    await make(fetchFn).listAds();
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.get('fields'))
      .toBe('id,name,effective_status,adset_id,campaign_id,creative{id,thumbnail_url,url_tags}');
  });
  it('getDailyAdInsights pide nivel ad, por día, con time_range', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    await make(fetchFn).getDailyAdInsights('2026-10-05', '2026-10-06');
    const u = new URL(fetchFn.mock.calls[0][0]);
    expect(u.searchParams.get('level')).toBe('ad');
    expect(u.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(u.searchParams.get('time_range'))).toEqual({ since: '2026-10-05', until: '2026-10-06' });
  });
  it('getDailyAdInsightsAsync crea el reporte, espera y lee resultados', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ report_run_id: 'R1' }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Running', async_percent_completion: 50 }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Completed', async_percent_completion: 100 }))
      .mockResolvedValueOnce(ok({ data: [{ ad_id: '9' }] }));
    const rows = await make(fetchFn).getDailyAdInsightsAsync('2026-01-01', '2026-01-31');
    expect(rows).toEqual([{ ad_id: '9' }]);
    expect(fetchFn.mock.calls[0][1].method).toBe('POST');
    expect(new URL(fetchFn.mock.calls[3][0]).pathname).toBe('/v23.0/R1/insights');
  });
  it('reporte asincrónico fallido → error', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ report_run_id: 'R1' }))
      .mockResolvedValueOnce(ok({ async_status: 'Job Failed' }));
    await expect(make(fetchFn).getDailyAdInsightsAsync('2026-01-01', '2026-01-31')).rejects.toThrow(/Job Failed/);
  });
  it('reintenta rate limit (17) con backoff y después tira', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchFn = vi.fn().mockResolvedValue(ok({ error: { code: 17, message: 'User request limit reached' } }));
    const meta = createMetaClient({ accessToken: 't', accountId: 'act_1', fetchFn, sleep, maxRetries: 2 });
    await expect(meta.listCampaigns()).rejects.toMatchObject({ code: 17 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });
  it('error no recuperable (190 token) no se reintenta', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ error: { code: 190, message: 'Invalid OAuth access token' } }));
    await expect(make(fetchFn).listCampaigns()).rejects.toThrow(/Meta 190/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('updateAdCreative hace POST al anuncio con el creative_id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ success: true }));
    await make(fetchFn).updateAdCreative('AD1', 'CR2');
    const [url, opts] = fetchFn.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v23.0/AD1');
    expect(JSON.parse(opts.body)).toEqual({ creative: { creative_id: 'CR2' } });
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/meta.test.js test/metaInsights.test.js test/urlTags.test.js`
Expected: FAIL.

- [ ] **Step 4: Implementar `backend/src/engine/metaInsights.js`**

```js
// Fila de /insights (level=ad, time_increment=1) → fila de meta_spend_daily.
const PURCHASE_TYPES = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

function pickPurchase(list) {
  for (const type of PURCHASE_TYPES) {
    const hit = (list || []).find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function parseInsightRow(row) {
  return {
    ad_id: String(row.ad_id),
    date: row.date_start,
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    adset_id: row.adset_id ? String(row.adset_id) : null,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    meta_purchases: pickPurchase(row.actions),
    meta_purchase_value: pickPurchase(row.action_values),
  };
}
```

- [ ] **Step 5: Implementar `backend/src/engine/urlTags.js`**

```js
export const URL_TAGS_TEMPLATE = 'utm_source=meta&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}';

export const hasAttributionParams = (urlTags) => typeof urlTags === 'string' && urlTags.includes('utm_content={{ad.id}}');

// Conserva los parámetros que no son utm_* y agrega la plantilla (sin url-encodear las {{macros}}).
export function mergeUrlTags(existing) {
  const keep = (existing || '').split('&').filter((pair) => pair && !pair.toLowerCase().startsWith('utm_'));
  return [...keep, URL_TAGS_TEMPLATE].join('&');
}

// Campos del creativo que se copian al crear la versión con url_tags (el creativo de Meta es inmutable).
export const CREATIVE_COPY_FIELDS = ['object_story_spec', 'object_story_id', 'asset_feed_spec', 'degrees_of_freedom_spec',
  'product_set_id', 'template_url_spec', 'instagram_user_id', 'contextual_multi_ads'];

export function buildCreativeCopy(creative) {
  const spec = { name: `${creative.name || 'Creativo'} [utm]` };
  for (const f of CREATIVE_COPY_FIELDS) if (creative[f] !== undefined && creative[f] !== null) spec[f] = creative[f];
  spec.url_tags = mergeUrlTags(creative.url_tags);
  return spec;
}
```

- [ ] **Step 6: Reescribir `backend/src/services/meta.js`**

```js
import { CREATIVE_COPY_FIELDS } from '../engine/urlTags.js';

const V = 'v23.0';
const RETRYABLE = new Set([4, 17, 32, 613, 80004]); // rate limits de Graph API / Marketing API
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSIGHT_FIELDS = 'ad_id,adset_id,campaign_id,spend,impressions,clicks,actions,action_values,date_start';

export function createMetaClient({ accessToken, accountId, fetchFn = fetch, sleep = defaultSleep, maxRetries = 4, pollMs = 3000 }) {
  const BASE = `https://graph.facebook.com/${V}`;

  async function reqOnce(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await fetchFn(url.toString(), {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    if (json.error) {
      const detail = json.error.error_user_msg || (json.error.error_subcode ? `subcode ${json.error.error_subcode}` : null);
      const err = new Error(`Meta ${json.error.code}: ${json.error.message}${detail ? ` (${detail})` : ''}`);
      err.code = json.error.code;
      err.subcode = json.error.error_subcode;
      throw err;
    }
    return json;
  }

  async function req(path, opts) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await reqOnce(path, opts);
      } catch (err) {
        if (!RETRYABLE.has(err.code) || attempt >= maxRetries) throw err;
        await sleep(5000 * 2 ** attempt);
      }
    }
  }

  async function getAll(path, params) {
    const out = [];
    let after;
    for (;;) {
      const json = await req(path, { params: { limit: '500', ...params, ...(after ? { after } : {}) } });
      out.push(...(json.data || []));
      after = json.paging?.cursors?.after;
      if (!json.paging?.next || !after) return out;
    }
  }

  const insightParams = (since, until) => ({ level: 'ad', time_increment: '1', time_range: { since, until }, fields: INSIGHT_FIELDS });

  return {
    listCampaigns: () => getAll(`${accountId}/campaigns`, { fields: 'id,name,effective_status' }),
    listAdsets: () => getAll(`${accountId}/adsets`, { fields: 'id,name,effective_status,campaign_id' }),
    listAds: () => getAll(`${accountId}/ads`, { fields: 'id,name,effective_status,adset_id,campaign_id,creative{id,thumbnail_url,url_tags}' }),
    getDailyAdInsights: (since, until) => getAll(`${accountId}/insights`, insightParams(since, until)),
    async getDailyAdInsightsAsync(since, until) {
      const { report_run_id: runId } = await req(`${accountId}/insights`, { method: 'POST', params: insightParams(since, until) });
      for (let i = 0; i < 400; i += 1) {
        const status = await req(runId, { params: { fields: 'async_status,async_percent_completion' } });
        if (status.async_status === 'Job Completed') return getAll(`${runId}/insights`, {});
        if (['Job Failed', 'Job Skipped'].includes(status.async_status)) throw new Error(`Reporte de Meta ${runId}: ${status.async_status}`);
        await sleep(pollMs);
      }
      throw new Error(`Reporte de Meta ${runId}: timeout`);
    },
    async getAdCreativeId(adId) {
      const json = await req(adId, { params: { fields: 'creative{id}' } });
      return json.creative.id;
    },
    getCreative: (creativeId) => req(creativeId, { params: { fields: ['name', 'url_tags', ...CREATIVE_COPY_FIELDS].join(',') } }),
    createCreative: (spec) => req(`${accountId}/adcreatives`, { method: 'POST', body: spec }),
    updateAdCreative: (adId, creativeId) => req(adId, { method: 'POST', body: { creative: { creative_id: creativeId } } }),
  };
}
```

- [ ] **Step 7: Correr tests**

Run: `cd backend && npx vitest run test/meta.test.js test/metaInsights.test.js test/urlTags.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/meta.js backend/src/engine/metaInsights.js backend/src/engine/urlTags.js backend/test/meta.test.js backend/test/metaInsights.test.js backend/test/urlTags.test.js
git commit -m "feat: cliente Meta con paginación, insights diarios (sync/async) y creativos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Sincronización de Meta y aplicación de parámetros de URL

**Files:**
- Create: `backend/src/sync/meta.js`, `backend/src/sync/urlTagger.js`
- Test: `backend/test/metaSync.test.js`, `backend/test/urlTagger.test.js`

**Interfaces:**
- Consumes: cliente Meta (Task 8), `parseInsightRow`/`hasAttributionParams`/`buildCreativeCopy` (Task 8), `createMetaRepo`/`createOrdersRepo` (Task 5), `artDate`/`addDays`/`monthRanges` (Task 4).
- Produces:
  - `createMetaSync({ meta, metaRepo, ordersRepo }) → { syncCatalog() → rows, syncSpend(since, until) → rows, backfillSpend({ days?, now?, onMonthDone? }) → rows }`. `syncCatalog` termina llamando `ordersRepo.resolveMetaIds()`.
  - `createUrlTagger({ meta, metaRepo, log? }) → { apply(adIds: string[]) → [{ adId, status: 'applied'|'already'|'error', creativeId?, error? }] }`. Nunca lanza por un anuncio individual.

- [ ] **Step 1: Tests `backend/test/metaSync.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaSync } from '../src/sync/meta.js';
import { URL_TAGS_TEMPLATE } from '../src/engine/urlTags.js';

let db; let metaRepo; let ordersRepo;
beforeEach(async () => { db = await createTestDb(); metaRepo = createMetaRepo(db); ordersRepo = createOrdersRepo(db); });
afterEach(() => db.close());

const fakeMeta = () => ({
  listCampaigns: vi.fn().mockResolvedValue([{ id: 'C1', name: 'altorancho_dpa', effective_status: 'ACTIVE' }]),
  listAdsets: vi.fn().mockResolvedValue([{ id: 'S1', name: 'Conjunto', effective_status: 'ACTIVE', campaign_id: 'C1' }]),
  listAds: vi.fn().mockResolvedValue([
    { id: 'A1', name: 'Con params', effective_status: 'ACTIVE', adset_id: 'S1', campaign_id: 'C1', creative: { id: 'CR1', thumbnail_url: 'https://t/1.jpg', url_tags: URL_TAGS_TEMPLATE } },
    { id: 'A2', name: 'Sin params', effective_status: 'PAUSED', adset_id: 'S1', campaign_id: 'C1' },
  ]),
  getDailyAdInsights: vi.fn().mockResolvedValue([{ ad_id: 'A1', adset_id: 'S1', campaign_id: 'C1', date_start: '2026-10-05', spend: '100' }]),
  getDailyAdInsightsAsync: vi.fn().mockResolvedValue([{ ad_id: 'A1', adset_id: 'S1', campaign_id: 'C1', date_start: '2026-09-01', spend: '50' }]),
});

describe('metaSync', () => {
  it('syncCatalog guarda campañas, conjuntos y anuncios con flag de parámetros', async () => {
    const n = await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    expect(n).toBe(4);
    const { rows } = await db.query('SELECT id, level, parent_id, campaign_id, has_attribution_params, thumbnail_url FROM meta_ads ORDER BY id');
    expect(rows).toEqual([
      { id: 'A1', level: 'ad', parent_id: 'S1', campaign_id: 'C1', has_attribution_params: true, thumbnail_url: 'https://t/1.jpg' },
      { id: 'A2', level: 'ad', parent_id: 'S1', campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
      { id: 'C1', level: 'campaign', parent_id: null, campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
      { id: 'S1', level: 'adset', parent_id: 'C1', campaign_id: 'C1', has_attribution_params: false, thumbnail_url: null },
    ]);
  });
  it('syncCatalog resuelve atribuciones pendientes por nombre de campaña', async () => {
    const resolve = vi.spyOn(ordersRepo, 'resolveMetaIds');
    await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    expect(resolve).toHaveBeenCalledWith();
  });
  it('syncSpend guarda filas diarias', async () => {
    const meta = fakeMeta();
    expect(await createMetaSync({ meta, metaRepo, ordersRepo }).syncSpend('2026-10-05', '2026-10-06')).toBe(1);
    expect(meta.getDailyAdInsights).toHaveBeenCalledWith('2026-10-05', '2026-10-06');
    const { rows } = await db.query('SELECT ad_id, date::text AS date, spend::float8 AS spend FROM meta_spend_daily');
    expect(rows).toEqual([{ ad_id: 'A1', date: '2026-10-05', spend: 100 }]);
  });
  it('backfillSpend recorre meses con el reporte asincrónico', async () => {
    const meta = fakeMeta();
    const onMonthDone = vi.fn();
    await createMetaSync({ meta, metaRepo, ordersRepo }).backfillSpend({ days: 40, now: new Date('2026-10-06T15:00:00Z'), onMonthDone });
    expect(meta.getDailyAdInsightsAsync.mock.calls).toEqual([
      ['2026-08-27', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-06'],
    ]);
    expect(onMonthDone).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Tests `backend/test/urlTagger.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createUrlTagger } from '../src/sync/urlTagger.js';
import { URL_TAGS_TEMPLATE } from '../src/engine/urlTags.js';

const metaRepo = () => ({ markAdTags: vi.fn().mockResolvedValue() });

describe('urlTagger', () => {
  it('crea creativo copia con url_tags y lo asigna al anuncio', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockResolvedValue('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', name: 'Pieza', object_story_id: '448608595902716_1', url_tags: 'utm_source=fb' }),
      createCreative: vi.fn().mockResolvedValue({ id: 'CR2' }),
      updateAdCreative: vi.fn().mockResolvedValue({ success: true }),
    };
    const repo = metaRepo();
    const r = await createUrlTagger({ meta, metaRepo: repo }).apply(['A1']);
    expect(r).toEqual([{ adId: 'A1', status: 'applied', creativeId: 'CR2' }]);
    expect(meta.createCreative).toHaveBeenCalledWith({ name: 'Pieza [utm]', object_story_id: '448608595902716_1', url_tags: URL_TAGS_TEMPLATE });
    expect(meta.updateAdCreative).toHaveBeenCalledWith('A1', 'CR2');
    expect(repo.markAdTags).toHaveBeenCalledWith('A1', URL_TAGS_TEMPLATE);
  });
  it('si ya tiene la plantilla no toca el anuncio', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockResolvedValue('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', url_tags: URL_TAGS_TEMPLATE }),
      createCreative: vi.fn(), updateAdCreative: vi.fn(),
    };
    const r = await createUrlTagger({ meta, metaRepo: metaRepo() }).apply(['A1']);
    expect(r).toEqual([{ adId: 'A1', status: 'already' }]);
    expect(meta.createCreative).not.toHaveBeenCalled();
  });
  it('un anuncio que falla no frena los demás', async () => {
    const meta = {
      getAdCreativeId: vi.fn().mockRejectedValueOnce(new Error('Meta 100: no existe')).mockResolvedValueOnce('CR1'),
      getCreative: vi.fn().mockResolvedValue({ id: 'CR1', url_tags: URL_TAGS_TEMPLATE }),
      createCreative: vi.fn(), updateAdCreative: vi.fn(),
    };
    const r = await createUrlTagger({ meta, metaRepo: metaRepo(), log: { error: () => {} } }).apply(['A1', 'A2']);
    expect(r).toEqual([{ adId: 'A1', status: 'error', error: 'Meta 100: no existe' }, { adId: 'A2', status: 'already' }]);
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/metaSync.test.js test/urlTagger.test.js`
Expected: FAIL.

- [ ] **Step 4: Implementar `backend/src/sync/meta.js`**

```js
import { parseInsightRow } from '../engine/metaInsights.js';
import { hasAttributionParams } from '../engine/urlTags.js';
import { artDate, addDays, monthRanges } from '../engine/dates.js';

const base = { thumbnail_url: null, url_tags: null, has_attribution_params: false };

export function createMetaSync({ meta, metaRepo, ordersRepo }) {
  return {
    async syncCatalog() {
      const campaigns = await meta.listCampaigns();
      const adsets = await meta.listAdsets();
      const ads = await meta.listAds();
      const rows = [
        ...campaigns.map((c) => ({ ...base, id: c.id, level: 'campaign', name: c.name, status: c.effective_status, parent_id: null, campaign_id: c.id })),
        ...adsets.map((s) => ({ ...base, id: s.id, level: 'adset', name: s.name, status: s.effective_status, parent_id: s.campaign_id, campaign_id: s.campaign_id })),
        ...ads.map((a) => ({
          id: a.id, level: 'ad', name: a.name, status: a.effective_status, parent_id: a.adset_id, campaign_id: a.campaign_id,
          thumbnail_url: a.creative?.thumbnail_url || null,
          url_tags: a.creative?.url_tags || null,
          has_attribution_params: hasAttributionParams(a.creative?.url_tags),
        })),
      ];
      await metaRepo.upsertAds(rows);
      await ordersRepo.resolveMetaIds();
      return rows.length;
    },
    async syncSpend(since, until) {
      const rows = (await meta.getDailyAdInsights(since, until)).map(parseInsightRow);
      await metaRepo.upsertSpend(rows);
      return rows.length;
    },
    async backfillSpend({ days = 365, now = new Date(), onMonthDone = async () => {} } = {}) {
      const to = artDate(now);
      let total = 0;
      for (const { since, until } of monthRanges(addDays(to, -days), to)) {
        const rows = (await meta.getDailyAdInsightsAsync(since, until)).map(parseInsightRow);
        await metaRepo.upsertSpend(rows);
        total += rows.length;
        await onMonthDone(since.slice(0, 7), total);
      }
      return total;
    },
  };
}
```

- [ ] **Step 5: Implementar `backend/src/sync/urlTagger.js`**

```js
import { hasAttributionParams, buildCreativeCopy } from '../engine/urlTags.js';

// Los creativos de Meta son inmutables: para agregar url_tags se crea una copia y se asigna al anuncio.
// Esto manda el anuncio a revisión (el panel lo advierte antes de llamar).
export function createUrlTagger({ meta, metaRepo, log = console }) {
  async function applyOne(adId) {
    const creative = await meta.getCreative(await meta.getAdCreativeId(adId));
    if (hasAttributionParams(creative.url_tags)) {
      await metaRepo.markAdTags(adId, creative.url_tags);
      return { adId, status: 'already' };
    }
    const spec = buildCreativeCopy(creative);
    const { id } = await meta.createCreative(spec);
    await meta.updateAdCreative(adId, id);
    await metaRepo.markAdTags(adId, spec.url_tags);
    return { adId, status: 'applied', creativeId: id };
  }

  return {
    async apply(adIds) {
      const results = [];
      for (const adId of adIds) {
        try {
          results.push(await applyOne(adId));
        } catch (err) {
          log.error(`[url-tags] anuncio ${adId}:`, err);
          results.push({ adId, status: 'error', error: err.message });
        }
      }
      return results;
    },
  };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/metaSync.test.js test/urlTagger.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/sync/meta.js backend/src/sync/urlTagger.js backend/test/metaSync.test.js backend/test/urlTagger.test.js
git commit -m "feat: sincronización de catálogo/gasto de Meta y aplicación de parámetros de URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Reportes (resumen, órdenes, ranking de anuncios, estado)

**Files:**
- Create: `backend/src/repo/reports.js`
- Test: `backend/test/reports.test.js`

**Interfaces:**
- Consumes: `db` (Task 2), `artDate`/`addDays` (Task 4). Tests usan `createOrdersRepo`, `createMetaRepo`, `mapOrder`, `attribute`.
- Produces: `createReportsRepo(db) → {`
  - `summary({ from, to }) → { from, to, revenue, orders, avgTicket, channels: [{ channel, orders, revenue }], meta: { spend, orders, revenue, roas, costPerSale, reported: { purchases, value, roas } }, coverage: { ad, campaign, none } }`
  - `listOrders({ from, to, channel?, q?, cursor?, limit? }) → { items: [{ id, number, created_at, total, status, payment_status, cancelled, customer_name, channel, confidence, ad_id, campaign_id, campaign_name, ad_name }], nextCursor: string|null }`. Todas las órdenes (cualquier estado). Si `q` es numérico busca por número **ignorando el período**. Cursor inválido → `Error` con `.status = 400`.
  - `orderDetail(id) → null | { …columnas de la orden, channel, confidence, ad_id, adset_id, campaign_id, campaign_name, ad_name, adset_name, thumbnail_url, source_raw, items: [...], costEstimate: null | { level, from, to, spend, sales, costPerSale } }`
  - `adsRanking({ from, to, level?, parentId?, sort? }) → { level, rows: [{ id, name, status, thumbnail_url, spend, impressions, clicks, sales, revenue, costPerSale, roas, metaPurchases, metaValue, metaRoas, noSales }], unidentified: { orders, revenue } | null }`. `level ∈ campaign|adset|ad`; `sort ∈ spend|cps|roas`.
  - `adDetail({ id, from, to }) → null | { ad: { id, level, name, status, thumbnail_url, has_attribution_params, url_tags, parent_id, campaign_id }, metrics: rankingRow, orders: [{ id, number, created_at, total, customer_name }] }`
  - `coverageWeekly({ now? }) → [{ week, ad, campaign, none }]` (últimas 8 semanas, solo ventas Meta)
  - `counts() → { orders, adsMissingParams }` `}`
- Reglas: `costPerSale = spend > 0 && sales > 0 ? spend / sales : null`; `roas = spend > 0 ? revenue / spend : null`; `noSales = spend > 0 && sales === 0`.

- [ ] **Step 1: Escribir los tests `backend/test/reports.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const CAMP = '2000001'; const ADSET = '3000001';
const metaAd = (adId) => `https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=${adId}`;
const tn = ({ id, at, total, payment = 'paid', cancelled = null, landing = 'https://altorancho.com/', item = 'Lámpara' }) => ({
  id, number: id, status: 'open', payment_status: payment, cancelled_at: cancelled, created_at: at, total: String(total),
  contact_name: `Cliente ${id}`, products: [{ product_id: 1, variant_id: 1, name: item, quantity: 1, price: String(total) }],
  customer_visit: { landing_page: landing, utm_parameters: {} },
});
const ad = (id, level, parent, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: parent, campaign_id: CAMP, thumbnail_url: null, url_tags: null, has_attribution_params: false, ...extra,
});
const spend = (adId, date, s, extra = {}) => ({
  ad_id: adId, date, campaign_id: CAMP, adset_id: ADSET, spend: s, impressions: 100, clicks: 10, meta_purchases: 0, meta_purchase_value: 0, ...extra,
});

let db; let reports;
beforeAll(async () => {
  db = await createTestDb();
  const orders = createOrdersRepo(db);
  const meta = createMetaRepo(db);
  reports = createReportsRepo(db);
  await meta.upsertAds([
    ad(CAMP, 'campaign', null), ad(ADSET, 'adset', CAMP),
    ad('1000001', 'ad', ADSET), ad('1000002', 'ad', ADSET), ad('1000003', 'ad', ADSET),
  ]);
  await meta.upsertSpend([
    spend('1000001', '2026-10-05', 400, { meta_purchases: 3, meta_purchase_value: 5000 }),
    spend('1000002', '2026-10-05', 600),
    spend('1000001', '2026-10-01', 100),
  ]);
  const seed = [
    tn({ id: 1, at: '2026-10-05T15:00:00+0000', total: 1000, landing: metaAd('1000001') }),
    tn({ id: 2, at: '2026-10-06T01:30:00+0000', total: 3000, landing: metaAd('1000001') }), // 22:30 ART del 05
    tn({ id: 3, at: '2026-10-06T04:00:00+0000', total: 500 }), // orgánica del 06
    tn({ id: 4, at: '2026-10-05T16:00:00+0000', total: 900, payment: 'pending', landing: metaAd('1000001') }),
    tn({ id: 5, at: '2026-10-05T17:00:00+0000', total: 800, cancelled: '2026-10-05T20:00:00+0000', landing: metaAd('1000001') }),
    tn({ id: 6, at: '2026-10-05T18:00:00+0000', total: 2000, landing: metaAd('1000003'), item: 'Silla Nórdica' }),
    tn({ id: 7, at: '2026-10-05T19:00:00+0000', total: 700, landing: 'https://altorancho.com/?fbclid=X' }),
  ];
  for (const o of seed) {
    const m = mapOrder(o);
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
});
afterAll(() => db.close());

const DAY = { from: '2026-10-05', to: '2026-10-05' };

describe('summary', () => {
  it('cuenta solo ventas pagadas no canceladas del día ART', async () => {
    const s = await reports.summary(DAY);
    expect(s).toMatchObject({ orders: 4, revenue: 6700, avgTicket: 1675 });
    expect(s.channels).toEqual([{ channel: 'meta', orders: 4, revenue: 6700 }]);
  });
  it('métricas de Meta: real vs reportado y cobertura', async () => {
    const s = await reports.summary(DAY);
    expect(s.meta).toEqual({
      spend: 1000, orders: 4, revenue: 6700, roas: 6.7, costPerSale: 250,
      reported: { purchases: 3, value: 5000, roas: 5 },
    });
    expect(s.coverage).toEqual({ ad: 3, campaign: 0, none: 1 });
  });
  it('período sin gasto no divide por cero', async () => {
    const s = await reports.summary({ from: '2026-10-06', to: '2026-10-06' });
    expect(s).toMatchObject({ orders: 1, revenue: 500 });
    expect(s.meta).toMatchObject({ spend: 0, roas: null, costPerSale: null });
  });
});

describe('listOrders', () => {
  it('pagina con cursor, más nuevas primero, incluye todos los estados', async () => {
    const p1 = await reports.listOrders({ ...DAY, limit: 4 });
    expect(p1.items.map((o) => o.id)).toEqual(['2', '7', '6', '5']);
    expect(p1.items[3]).toMatchObject({ cancelled: true });
    const p2 = await reports.listOrders({ ...DAY, limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((o) => o.id)).toEqual(['4', '1']);
    expect(p2.nextCursor).toBeNull();
  });
  it('filtra por canal y trae nombres de anuncio/campaña', async () => {
    const r = await reports.listOrders({ ...DAY, channel: 'meta' });
    expect(r.items.find((o) => o.id === '1')).toMatchObject({ channel: 'meta', confidence: 'ad', ad_name: 'ad 1000001', campaign_name: `campaign ${CAMP}` });
    expect((await reports.listOrders({ from: '2026-10-06', to: '2026-10-06', channel: 'organic' })).items.map((o) => o.id)).toEqual(['3']);
  });
  it('búsqueda numérica ignora el período; texto busca cliente y producto', async () => {
    expect((await reports.listOrders({ from: '2020-01-01', to: '2020-01-01', q: '3' })).items.map((o) => o.id)).toEqual(['3']);
    expect((await reports.listOrders({ ...DAY, q: 'nórdica' })).items.map((o) => o.id)).toEqual(['6']);
    expect((await reports.listOrders({ ...DAY, q: 'cliente 7' })).items.map((o) => o.id)).toEqual(['7']);
  });
  it('cursor inválido → error 400', async () => {
    await expect(reports.listOrders({ ...DAY, cursor: 'basura' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('orderDetail', () => {
  it('trae items, origen y costo promedio de los 7 días que terminan el día de la orden', async () => {
    const d = await reports.orderDetail('1');
    expect(d).toMatchObject({ number: 1, channel: 'meta', ad_name: 'ad 1000001', adset_name: `adset ${ADSET}`, campaign_name: `campaign ${CAMP}` });
    expect(d.items).toHaveLength(1);
    expect(d.costEstimate).toEqual({ level: 'ad', from: '2026-09-29', to: '2026-10-05', spend: 500, sales: 2, costPerSale: 250 });
  });
  it('orgánica no tiene costo; inexistente → null', async () => {
    expect((await reports.orderDetail('3')).costEstimate).toBeNull();
    expect(await reports.orderDetail('999')).toBeNull();
  });
});

describe('adsRanking', () => {
  it('nivel anuncio: gasto sin ventas y ventas sin gasto aparecen, sin dividir por cero', async () => {
    const r = await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET });
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId['1000001']).toMatchObject({ spend: 400, sales: 2, revenue: 4000, costPerSale: 200, roas: 10, metaPurchases: 3, metaRoas: 12.5, noSales: false });
    expect(byId['1000002']).toMatchObject({ spend: 600, sales: 0, costPerSale: null, roas: 0, noSales: true });
    expect(byId['1000003']).toMatchObject({ spend: 0, sales: 1, revenue: 2000, costPerSale: null, roas: null, noSales: false });
    expect(r.unidentified).toBeNull();
  });
  it('orden por defecto gasto desc; cps pone primero los que no venden', async () => {
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET, sort: 'cps' })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
    expect((await reports.adsRanking({ ...DAY, level: 'ad', parentId: ADSET, sort: 'roas' })).rows.map((x) => x.id)).toEqual(['1000002', '1000001', '1000003']);
  });
  it('nivel campaña suma todo e informa ventas Meta sin campaña identificada', async () => {
    const r = await reports.adsRanking({ ...DAY, level: 'campaign' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: CAMP, spend: 1000, sales: 3, revenue: 6000 });
    expect(r.unidentified).toEqual({ orders: 1, revenue: 700 });
  });
});

describe('adDetail / estado', () => {
  it('adDetail trae métricas y órdenes del anuncio', async () => {
    const d = await reports.adDetail({ id: '1000001', ...DAY });
    expect(d.ad).toMatchObject({ id: '1000001', level: 'ad' });
    expect(d.metrics).toMatchObject({ spend: 400, sales: 2 });
    expect(d.orders.map((o) => o.id)).toEqual(['2', '1']);
    expect(await reports.adDetail({ id: 'nope', ...DAY })).toBeNull();
  });
  it('coverageWeekly agrupa por semana ART', async () => {
    expect(await reports.coverageWeekly({ now: new Date('2026-10-07T12:00:00Z') }))
      .toEqual([{ week: '2026-10-05', ad: 3, campaign: 0, none: 1 }]);
  });
  it('counts', async () => {
    expect(await reports.counts()).toEqual({ orders: 7, adsMissingParams: 3 });
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/reports.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `backend/src/repo/reports.js`**

```js
import { artDate, addDays } from '../engine/dates.js';

const PAID = "o.payment_status = 'paid' AND o.cancelled_at IS NULL";
// Rango de días ART inclusivo sobre orders.created_at ($a = desde, $b = hasta, 'YYYY-MM-DD')
const RANGE = (a, b) => `o.created_at >= ($${a}::text || 'T00:00:00-03:00')::timestamptz
  AND o.created_at < (($${b}::date + 1)::text || 'T00:00:00-03:00')::timestamptz`;
const KEY = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const PARENT = { adset: 'campaign_id', ad: 'adset_id' };

const ratio = (a, b) => (b > 0 ? a / b : null);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function encodeCursor(row) {
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');
}
function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!ts || !/^\d+$/.test(id || '') || Number.isNaN(Date.parse(ts))) throw badRequest('cursor inválido');
  return [ts, id];
}

function enrich(r) {
  return {
    id: r.id, name: r.name, status: r.status, thumbnail_url: r.thumbnail_url,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, sales: r.sales, revenue: r.revenue,
    costPerSale: r.spend > 0 && r.sales > 0 ? r.spend / r.sales : null,
    roas: ratio(r.revenue, r.spend),
    metaPurchases: r.meta_purchases, metaValue: r.meta_value, metaRoas: ratio(r.meta_value, r.spend),
    noSales: r.spend > 0 && r.sales === 0,
  };
}

const SORTS = {
  spend: (a, b) => b.spend - a.spend,
  // los que gastan sin vender primero, después costo por venta más alto; sin dato al final
  cps: (a, b) => {
    const v = (x) => (x.noSales ? Infinity : x.costPerSale ?? -1);
    return v(b) - v(a);
  },
  roas: (a, b) => (a.roas ?? Infinity) - (b.roas ?? Infinity),
};

export function createReportsRepo(db) {
  async function adsRanking({ from, to, level = 'campaign', parentId = null, sort = 'spend' }) {
    const key = KEY[level];
    if (!key) throw badRequest('level inválido');
    const params = [from, to];
    let spendParent = '';
    let salesParent = '';
    if (parentId && PARENT[level]) {
      params.push(parentId);
      spendParent = `AND ${PARENT[level]} = $3`;
      salesParent = `AND a.${PARENT[level]} = $3`;
    }
    const { rows } = await db.query(
      `WITH sp AS (
         SELECT ${key} AS id, sum(spend) AS s, sum(impressions) AS imp, sum(clicks) AS clk,
                sum(meta_purchases) AS mp, sum(meta_purchase_value) AS mv
           FROM meta_spend_daily
          WHERE date BETWEEN $1::date AND $2::date AND ${key} IS NOT NULL ${spendParent}
          GROUP BY 1),
       sa AS (
         SELECT a.${key} AS id, count(*) AS n, sum(o.total) AS rev
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.${key} IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)} ${salesParent}
          GROUP BY 1)
       SELECT COALESCE(sp.id, sa.id) AS id, m.name, m.status, m.thumbnail_url,
              COALESCE(sp.s, 0)::float8 AS spend, COALESCE(sp.imp, 0)::int AS impressions, COALESCE(sp.clk, 0)::int AS clicks,
              COALESCE(sp.mp, 0)::float8 AS meta_purchases, COALESCE(sp.mv, 0)::float8 AS meta_value,
              COALESCE(sa.n, 0)::int AS sales, COALESCE(sa.rev, 0)::float8 AS revenue
         FROM sp FULL OUTER JOIN sa ON sa.id = sp.id
         LEFT JOIN meta_ads m ON m.id = COALESCE(sp.id, sa.id)`,
      params,
    );
    const out = rows.map(enrich).sort(SORTS[sort] || SORTS.spend);
    let unidentified = null;
    if (level === 'campaign' && !parentId) {
      const { rows: u } = await db.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.campaign_id IS NULL AND ${PAID} AND ${RANGE(1, 2)}`,
        [from, to],
      );
      unidentified = u[0];
    }
    return { level, rows: out, unidentified };
  }

  return {
    async summary({ from, to }) {
      const { rows: [tot] } = await db.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue FROM orders o WHERE ${PAID} AND ${RANGE(1, 2)}`,
        [from, to],
      );
      const { rows: channels } = await db.query(
        `SELECT COALESCE(a.channel, 'unknown') AS channel, count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
           FROM orders o LEFT JOIN order_attribution a ON a.order_id = o.id
          WHERE ${PAID} AND ${RANGE(1, 2)} GROUP BY 1 ORDER BY revenue DESC`,
        [from, to],
      );
      const { rows: [sp] } = await db.query(
        `SELECT COALESCE(sum(spend), 0)::float8 AS spend, COALESCE(sum(meta_purchases), 0)::float8 AS purchases,
                COALESCE(sum(meta_purchase_value), 0)::float8 AS value
           FROM meta_spend_daily WHERE date BETWEEN $1::date AND $2::date`,
        [from, to],
      );
      const { rows: cov } = await db.query(
        `SELECT a.confidence, count(*)::int AS n FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND ${PAID} AND ${RANGE(1, 2)} GROUP BY 1`,
        [from, to],
      );
      const m = channels.find((c) => c.channel === 'meta') || { orders: 0, revenue: 0 };
      const coverage = { ad: 0, campaign: 0, none: 0 };
      for (const c of cov) coverage[c.confidence] = c.n;
      return {
        from, to, revenue: tot.revenue, orders: tot.orders, avgTicket: ratio(tot.revenue, tot.orders), channels,
        meta: {
          spend: sp.spend, orders: m.orders, revenue: m.revenue,
          roas: ratio(m.revenue, sp.spend),
          costPerSale: sp.spend > 0 && m.orders > 0 ? sp.spend / m.orders : null,
          reported: { purchases: sp.purchases, value: sp.value, roas: ratio(sp.value, sp.spend) },
        },
        coverage,
      };
    },

    async listOrders({ from, to, channel, q, cursor, limit = 50 }) {
      const params = [];
      const where = [];
      const term = (q || '').trim();
      if (/^\d+$/.test(term)) {
        params.push(Number(term));
        where.push(`o.number = $${params.length}`);
      } else {
        params.push(from, to);
        where.push(RANGE(1, 2));
        if (term) {
          params.push(`%${term}%`);
          const i = params.length;
          where.push(`(o.customer_name ILIKE $${i} OR o.customer_email ILIKE $${i}
            OR EXISTS (SELECT 1 FROM order_items it WHERE it.order_id = o.id AND it.name ILIKE $${i}))`);
        }
      }
      if (channel) {
        params.push(channel);
        where.push(`COALESCE(a.channel, 'unknown') = $${params.length}`);
      }
      if (cursor) {
        const [ts, id] = decodeCursor(cursor);
        params.push(ts, id);
        where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
      }
      params.push(limit + 1);
      const { rows } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.total::float8 AS total, o.status, o.payment_status,
                o.cancelled_at IS NOT NULL AS cancelled, o.customer_name,
                COALESCE(a.channel, 'unknown') AS channel, a.confidence, a.ad_id, a.campaign_id,
                COALESCE(c.name, a.campaign_name) AS campaign_name, ad.name AS ad_name
           FROM orders o
           LEFT JOIN order_attribution a ON a.order_id = o.id
           LEFT JOIN meta_ads c ON c.id = a.campaign_id
           LEFT JOIN meta_ads ad ON ad.id = a.ad_id
          WHERE ${where.join(' AND ')}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $${params.length}`,
        params,
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
    },

    async orderDetail(id) {
      if (!/^\d+$/.test(String(id))) return null;
      const { rows } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.paid_at, o.cancelled_at, o.status, o.payment_status,
                o.total::float8 AS total, o.subtotal::float8 AS subtotal, o.discount::float8 AS discount,
                o.shipping_cost_customer::float8 AS shipping_cost_customer, o.currency, o.gateway_name, o.storefront,
                o.customer_name, o.customer_email, o.landing_url, o.visit_landing_page, o.visit_created_at,
                COALESCE(a.channel, 'unknown') AS channel, a.confidence, a.ad_id, a.adset_id, a.campaign_id, a.source_raw,
                COALESCE(c.name, a.campaign_name) AS campaign_name, ad.name AS ad_name, ad.thumbnail_url, s.name AS adset_name
           FROM orders o
           LEFT JOIN order_attribution a ON a.order_id = o.id
           LEFT JOIN meta_ads ad ON ad.id = a.ad_id
           LEFT JOIN meta_ads s ON s.id = a.adset_id
           LEFT JOIN meta_ads c ON c.id = a.campaign_id
          WHERE o.id = $1::bigint`,
        [id],
      );
      const order = rows[0];
      if (!order) return null;
      const { rows: items } = await db.query(
        `SELECT product_id::text AS product_id, variant_id::text AS variant_id, sku, name, quantity, price::float8 AS price
           FROM order_items WHERE order_id = $1::bigint`,
        [id],
      );
      let costEstimate = null;
      const level = order.ad_id ? 'ad' : order.campaign_id ? 'campaign' : null;
      if (order.channel === 'meta' && level) {
        const col = KEY[level];
        const key = order[col];
        const to = artDate(order.created_at);
        const from = addDays(to, -6);
        const { rows: [s] } = await db.query(
          `SELECT COALESCE(sum(spend), 0)::float8 AS spend FROM meta_spend_daily WHERE ${col} = $1 AND date BETWEEN $2::date AND $3::date`,
          [key, from, to],
        );
        const { rows: [n] } = await db.query(
          `SELECT count(*)::int AS sales FROM orders o JOIN order_attribution a ON a.order_id = o.id
            WHERE a.${col} = $1 AND ${PAID} AND ${RANGE(2, 3)}`,
          [key, from, to],
        );
        costEstimate = { level, from, to, spend: s.spend, sales: n.sales, costPerSale: s.spend > 0 && n.sales > 0 ? s.spend / n.sales : null };
      }
      return { ...order, items, costEstimate };
    },

    adsRanking,

    async adDetail({ id, from, to }) {
      const { rows } = await db.query(
        `SELECT id, level, name, status, thumbnail_url, has_attribution_params, url_tags, parent_id, campaign_id
           FROM meta_ads WHERE id = $1`,
        [id],
      );
      const ad = rows[0];
      if (!ad) return null;
      const parentId = ad.level === 'campaign' ? null : ad.parent_id;
      const ranking = await adsRanking({ from, to, level: ad.level, parentId });
      const metrics = ranking.rows.find((r) => r.id === id)
        || enrich({ id, name: ad.name, status: ad.status, thumbnail_url: ad.thumbnail_url, spend: 0, impressions: 0, clicks: 0, sales: 0, revenue: 0, meta_purchases: 0, meta_value: 0 });
      const col = KEY[ad.level];
      const { rows: orders } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.total::float8 AS total, o.customer_name
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.${col} = $1 AND ${PAID} AND ${RANGE(2, 3)}
          ORDER BY o.created_at DESC LIMIT 100`,
        [id, from, to],
      );
      return { ad, metrics, orders };
    },

    async coverageWeekly({ now = new Date() } = {}) {
      const since = new Date(new Date(now).getTime() - 56 * 86400000).toISOString();
      const { rows } = await db.query(
        `SELECT to_char(date_trunc('week', (o.created_at AT TIME ZONE 'UTC') - interval '3 hours'), 'YYYY-MM-DD') AS week,
                (count(*) FILTER (WHERE a.confidence = 'ad'))::int AS ad,
                (count(*) FILTER (WHERE a.confidence = 'campaign'))::int AS campaign,
                (count(*) FILTER (WHERE a.confidence = 'none'))::int AS "none"
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND ${PAID} AND o.created_at >= $1::timestamptz
          GROUP BY 1 ORDER BY 1`,
        [since],
      );
      return rows;
    },

    async counts() {
      const { rows: [o] } = await db.query('SELECT count(*)::int AS n FROM orders');
      const { rows: [a] } = await db.query(
        "SELECT count(*)::int AS n FROM meta_ads WHERE level = 'ad' AND status = 'ACTIVE' AND NOT has_attribution_params",
      );
      return { orders: o.n, adsMissingParams: a.n };
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/reports.test.js`
Expected: PASS. Si algún número no coincide, revisar primero el borde de día ART (orden #2 es del 05) antes de tocar los tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/reports.js backend/test/reports.test.js
git commit -m "feat: reportes de ventas, atribución, ranking de anuncios y cobertura

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: API, webhooks y app (estáticos + health)

**Files:**
- Create: `backend/src/routes/api.js`
- Modify: `backend/src/routes/webhooks.js` (eventos), `backend/src/app.js` (estáticos, fallback SPA, health)
- Test: `backend/test/api.test.js`, modificar `backend/test/webhook.test.js`, `backend/test/app.test.js`

**Interfaces:**
- Consumes: `createReportsRepo` (Task 10), `createSyncRunsRepo`/`createMetaRepo` (Task 5), `createJobRunner` (Task 7), `createUrlTagger` (Task 9), `isYmd` (Task 4), `createAuthMiddleware` (existente).
- Produces:
  - `createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog })` donde `jobCatalog: Record<string, { source: string, fn: (ctx) => Promise<number> }>` (claves = nombre en la URL, ej. `'tn-backfill'`).
  - Endpoints: `GET /summary`, `GET /orders`, `GET /orders/:id`, `GET /ads`, `GET /ads/missing-params`, `GET /ads/:id`, `GET /status`, `POST /meta/apply-url-tags`, `POST /sync/:job`.
  - `createApp({ webhookRouter?, apiRouter?, corsOrigin?, staticDir?, health? })`; `health: () => Promise<object>` se mezcla en la respuesta de `/health` (503 si lanza).
  - Webhooks aceptados: `order/created`, `order/updated`, `order/paid`, `order/cancelled`.

- [ ] **Step 1: Tests de la API `backend/test/api.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createApiRouter } from '../src/routes/api.js';
import { createAuthMiddleware } from '../src/routes/authMiddleware.js';

function setup(overrides = {}) {
  const deps = {
    reports: {
      summary: vi.fn().mockResolvedValue({ orders: 1 }),
      listOrders: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      orderDetail: vi.fn().mockResolvedValue(null),
      adsRanking: vi.fn().mockResolvedValue({ level: 'campaign', rows: [], unidentified: null }),
      adDetail: vi.fn().mockResolvedValue({ ad: { id: '1' } }),
      coverageWeekly: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ orders: 0, adsMissingParams: 0 }),
    },
    syncRuns: {
      latestBySource: vi.fn().mockResolvedValue([]),
      lastSuccessBySource: vi.fn().mockResolvedValue([]),
      recentErrors: vi.fn().mockResolvedValue([]),
    },
    metaRepo: { listAdsMissingParams: vi.fn().mockResolvedValue([{ id: '1' }]) },
    urlTagger: { apply: vi.fn().mockResolvedValue([{ adId: '123', status: 'applied' }]) },
    jobs: {
      run: vi.fn(async (_s, fn) => ({ ok: true, rows: await fn({ progress: async () => {} }) })),
      runInBackground: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(false),
    },
    jobCatalog: { 'tn-backfill': { source: 'tn_backfill', fn: vi.fn() } },
    ...overrides,
  };
  const app = createApp({ apiRouter: [createAuthMiddleware({ password: 'pw' }), createApiRouter(deps)] });
  const get = (url) => request(app).get(url).set('authorization', 'Bearer pw');
  const post = (url, body) => request(app).post(url).set('authorization', 'Bearer pw').send(body);
  return { app, deps, get, post };
}

describe('api', () => {
  it('sin contraseña → 401', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/summary?from=2026-10-01&to=2026-10-05')).status).toBe(401);
  });
  it('summary valida el período', async () => {
    const { get, deps } = setup();
    expect((await get('/api/summary?from=2026-10-05&to=2026-10-01')).status).toBe(400);
    expect((await get('/api/summary?from=ayer&to=2026-10-01')).status).toBe(400);
    expect((await get('/api/summary?from=2024-01-01&to=2026-10-01')).status).toBe(400); // > 366 días
    const ok = await get('/api/summary?from=2026-10-01&to=2026-10-05');
    expect(ok.status).toBe(200);
    expect(deps.reports.summary).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05' });
  });
  it('orders pasa filtros y valida canal', async () => {
    const { get, deps } = setup();
    await get('/api/orders?from=2026-10-01&to=2026-10-05&channel=meta&q=silla&cursor=abc');
    expect(deps.reports.listOrders).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05', channel: 'meta', q: 'silla', cursor: 'abc', limit: 50 });
    expect((await get('/api/orders?from=2026-10-01&to=2026-10-05&channel=tiktok')).status).toBe(400);
  });
  it('error con status 400 del repo se devuelve como 400', async () => {
    const err = Object.assign(new Error('cursor inválido'), { status: 400 });
    const { get } = setup({ reports: { ...setup().deps.reports, listOrders: vi.fn().mockRejectedValue(err) } });
    const res = await get('/api/orders?from=2026-10-01&to=2026-10-05&cursor=x');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cursor inválido' });
  });
  it('orden inexistente → 404', async () => {
    const { get } = setup();
    expect((await get('/api/orders/123')).status).toBe(404);
  });
  it('ads valida level y sort; missing-params no choca con /ads/:id', async () => {
    const { get, deps } = setup();
    expect((await get('/api/ads?from=2026-10-01&to=2026-10-05&level=foo')).status).toBe(400);
    await get('/api/ads?from=2026-10-01&to=2026-10-05&level=ad&parent=55&sort=cps');
    expect(deps.reports.adsRanking).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05', level: 'ad', parentId: '55', sort: 'cps' });
    const mp = await get('/api/ads/missing-params');
    expect(mp.body).toEqual([{ id: '1' }]);
    expect(deps.reports.adDetail).not.toHaveBeenCalled();
  });
  it('status junta corridas, errores, cobertura y conteos', async () => {
    const { get } = setup();
    const res = await get('/api/status');
    expect(res.body).toMatchObject({ runs: [], lastSuccess: [], errors: [], coverage: [], counts: { orders: 0 }, running: [] });
  });
  it('apply-url-tags valida ids y devuelve resultados', async () => {
    const { post, deps } = setup();
    expect((await post('/api/meta/apply-url-tags', { adIds: [] })).status).toBe(400);
    expect((await post('/api/meta/apply-url-tags', { adIds: ['abc'] })).status).toBe(400);
    expect((await post('/api/meta/apply-url-tags', { adIds: Array(51).fill('1') })).status).toBe(400);
    const res = await post('/api/meta/apply-url-tags', { adIds: ['123'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ adId: '123', status: 'applied' }] });
    expect(deps.jobs.run.mock.calls[0][0]).toBe('meta_url_tags');
  });
  it('apply-url-tags en curso → 409', async () => {
    const { post } = setup({ jobs: { run: vi.fn().mockResolvedValue({ skipped: true }), runInBackground: vi.fn(), isRunning: vi.fn() } });
    expect((await post('/api/meta/apply-url-tags', { adIds: ['123'] })).status).toBe(409);
  });
  it('sync/:job dispara en segundo plano; desconocido 404; en curso 409', async () => {
    const { post, deps } = setup();
    const res = await post('/api/sync/tn-backfill');
    expect(res.status).toBe(202);
    expect(deps.jobs.runInBackground).toHaveBeenCalledWith('tn_backfill', deps.jobCatalog['tn-backfill'].fn);
    expect((await post('/api/sync/nada')).status).toBe(404);
    deps.jobs.runInBackground.mockReturnValue(false);
    expect((await post('/api/sync/tn-backfill')).status).toBe(409);
  });
});
```

- [ ] **Step 2: Agregar a `backend/test/webhook.test.js` (dentro del `describe`)**

```js
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
```

- [ ] **Step 3: Reemplazar `backend/test/app.test.js`**

```js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createApp } from '../src/app.js';

describe('app', () => {
  it('responde /health', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it('/health mezcla datos de health() y devuelve 503 si falla', async () => {
    expect((await request(createApp({ health: async () => ({ db: true }) })).get('/health')).body).toEqual({ ok: true, db: true });
    const res = await request(createApp({ health: async () => { throw new Error('db caída'); } })).get('/health');
    expect(res.status).toBe(503);
  });
  it('sirve el frontend y hace fallback SPA, sin tapar /api', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    const api = express.Router();
    api.get('/ping', (_req, res) => res.json({ pong: true }));
    const app = createApp({ staticDir: dir, apiRouter: api });
    expect((await request(app).get('/app.js')).text).toBe('console.log(1)');
    const spa = await request(app).get('/anuncios/123');
    expect(spa.text).toBe('<html>app</html>');
    expect(spa.headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/api/ping')).body).toEqual({ pong: true });
    expect((await request(app).get('/api/nada')).status).toBe(404);
  });
});
```

- [ ] **Step 4: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/api.test.js test/webhook.test.js test/app.test.js`
Expected: FAIL.

- [ ] **Step 5: Modificar `backend/src/routes/webhooks.js` (solo el set de eventos)**

```js
const ORDER_EVENTS = new Set(['order/created', 'order/updated', 'order/paid', 'order/cancelled']);
```

- [ ] **Step 6: Reescribir `backend/src/app.js`**

```js
import path from 'node:path';
import express from 'express';
import cors from 'cors';

export function createApp({ webhookRouter, apiRouter, corsOrigin, staticDir, health } = {}) {
  const app = express();
  if (corsOrigin) app.use(cors({ origin: corsOrigin }));
  // webhooks van ANTES de express.json(): la verificación HMAC necesita el raw body
  if (webhookRouter) app.use('/webhooks', webhookRouter);
  app.use(express.json());
  app.get('/health', async (_req, res) => {
    if (!health) return res.json({ ok: true });
    try {
      res.json({ ok: true, ...(await health()) });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });
  if (apiRouter) app.use('/api', ...[].concat(apiRouter));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'no encontrado' }));
  if (staticDir) {
    const noCache = (res) => res.set('Cache-Control', 'no-cache');
    app.use(express.static(staticDir, {
      index: false,
      setHeaders: (res, file) => {
        if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) noCache(res);
      },
    }));
    app.get(/^\/(?!api\/|webhooks\/).*/, (_req, res) => {
      noCache(res);
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  return app;
}
```

- [ ] **Step 7: Implementar `backend/src/routes/api.js`**

```js
import express from 'express';
import { isYmd } from '../engine/dates.js';

const CHANNELS = new Set(['meta', 'google', 'organic', 'email', 'social_organic', 'other', 'unknown']);
const LEVELS = new Set(['campaign', 'adset', 'ad']);
const SORTS = new Set(['spend', 'cps', 'roas']);
const SOURCES = ['tn_backfill', 'tn_incremental', 'tn_webhook', 'meta_catalog', 'meta_spend', 'meta_backfill', 'meta_url_tags', 'reattribute'];
const MAX_DAYS = 366;

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function period(req) {
  const { from, to } = req.query;
  if (!isYmd(from) || !isYmd(to)) throw badRequest('from y to tienen que ser fechas YYYY-MM-DD');
  if (from > to) throw badRequest('from no puede ser posterior a to');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) throw badRequest(`el período no puede superar ${MAX_DAYS} días`);
  return { from, to };
}

export function createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }) {
  const router = express.Router();

  router.get('/summary', wrap(async (req, res) => res.json(await reports.summary(period(req)))));

  router.get('/orders', wrap(async (req, res) => {
    const { channel, q, cursor } = req.query;
    if (channel && !CHANNELS.has(channel)) throw badRequest('canal inválido');
    res.json(await reports.listOrders({ ...period(req), channel: channel || undefined, q: q || undefined, cursor: cursor || undefined, limit: 50 }));
  }));

  router.get('/orders/:id', wrap(async (req, res) => {
    const order = await reports.orderDetail(req.params.id);
    if (!order) return res.status(404).json({ error: 'orden no encontrada' });
    res.json(order);
  }));

  router.get('/ads/missing-params', wrap(async (_req, res) => res.json(await metaRepo.listAdsMissingParams())));

  router.get('/ads', wrap(async (req, res) => {
    const level = req.query.level || 'campaign';
    const sort = req.query.sort || 'spend';
    if (!LEVELS.has(level)) throw badRequest('level inválido');
    if (!SORTS.has(sort)) throw badRequest('sort inválido');
    res.json(await reports.adsRanking({ ...period(req), level, parentId: req.query.parent || null, sort }));
  }));

  router.get('/ads/:id', wrap(async (req, res) => {
    const detail = await reports.adDetail({ id: req.params.id, ...period(req) });
    if (!detail) return res.status(404).json({ error: 'no encontrado' });
    res.json(detail);
  }));

  router.get('/status', wrap(async (_req, res) => {
    res.json({
      runs: await syncRuns.latestBySource(),
      lastSuccess: await syncRuns.lastSuccessBySource(),
      errors: await syncRuns.recentErrors(10),
      coverage: await reports.coverageWeekly(),
      counts: await reports.counts(),
      running: SOURCES.filter((s) => jobs.isRunning(s)),
    });
  }));

  router.post('/meta/apply-url-tags', wrap(async (req, res) => {
    const { adIds } = req.body || {};
    if (!Array.isArray(adIds) || adIds.length === 0 || adIds.length > 50 || !adIds.every((id) => /^\d+$/.test(String(id)))) {
      throw badRequest('adIds tiene que ser una lista de 1 a 50 IDs de anuncio');
    }
    let results = [];
    const run = await jobs.run('meta_url_tags', async () => {
      results = await urlTagger.apply(adIds.map(String));
      return results.filter((r) => r.status !== 'error').length;
    });
    if (run.skipped) return res.status(409).json({ error: 'ya se están aplicando parámetros, probá en un rato' });
    res.json({ results });
  }));

  router.post('/sync/:job', wrap(async (req, res) => {
    const job = jobCatalog[req.params.job];
    if (!job) return res.status(404).json({ error: 'job desconocido' });
    if (!jobs.runInBackground(job.source, job.fn)) return res.status(409).json({ error: 'ya está corriendo' });
    res.status(202).json({ started: job.source });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[api]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return router;
}
```

- [ ] **Step 8: Correr tests**

Run: `cd backend && npx vitest run`
Expected: PASS (toda la suite del backend).

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes backend/src/app.js backend/test/api.test.js backend/test/webhook.test.js backend/test/app.test.js
git commit -m "feat: API de ventas/anuncios/estado, webhooks de órdenes y servido del frontend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Wiring de producción, crons, jobs admin y config de deploy

**Files:**
- Modify (reescribir): `backend/src/index.js`
- Create: `backend/src/jobsCatalog.js`, `backend/scripts/registerWebhooks.js`, `package.json` (raíz), `railway.json` (raíz)
- Test: `backend/test/jobsCatalog.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `createJobCatalog({ orderSync, metaSync, ordersRepo, syncRuns, now? }) → jobCatalog` con claves `tn-backfill`, `tn-incremental`, `meta-catalog`, `meta-spend`, `meta-backfill`, `reattribute` (sources `tn_backfill`, `tn_incremental`, `meta_catalog`, `meta_spend`, `meta_backfill`, `reattribute`).
  - Proceso de producción: migra al arrancar, marca corridas colgadas, crons horarios/diarios, sirve `frontend/dist`.

- [ ] **Step 1: Tests `backend/test/jobsCatalog.test.js`**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createJobCatalog } from '../src/jobsCatalog.js';
import { mapOrder } from '../src/engine/mapOrder.js';

const ctx = () => ({ progress: vi.fn().mockResolvedValue() });
const NOW = new Date('2026-10-06T15:00:00Z');

describe('jobCatalog', () => {
  it('tn-backfill retoma después del último mes hecho si no estaba completo', async () => {
    const orderSync = { backfill: vi.fn(async ({ onMonthDone }) => { await onMonthDone('2026-10', 5); return 5; }) };
    const syncRuns = { lastCursor: vi.fn().mockResolvedValue({ done: '2026-03', complete: false }) };
    const cat = createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns, now: () => NOW });
    const c = ctx();
    expect(await cat['tn-backfill'].fn(c)).toBe(5);
    expect(orderSync.backfill.mock.calls[0][0]).toMatchObject({ resumeAfter: '2026-03' });
    expect(c.progress).toHaveBeenLastCalledWith(5, { done: '2026-10', complete: true });
  });
  it('tn-backfill después de uno completo arranca de cero', async () => {
    const orderSync = { backfill: vi.fn().mockResolvedValue(0) };
    const syncRuns = { lastCursor: vi.fn().mockResolvedValue({ done: '2026-10', complete: true }) };
    await createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns, now: () => NOW })['tn-backfill'].fn(ctx());
    expect(orderSync.backfill.mock.calls[0][0]).toMatchObject({ resumeAfter: null });
  });
  it('tn-incremental pide lo actualizado en las últimas 2 horas', async () => {
    const orderSync = { syncUpdatedSince: vi.fn().mockResolvedValue(3) };
    await createJobCatalog({ orderSync, metaSync: {}, ordersRepo: {}, syncRuns: {}, now: () => NOW })['tn-incremental'].fn(ctx());
    expect(orderSync.syncUpdatedSince).toHaveBeenCalledWith('2026-10-06T13:00:00.000Z');
  });
  it('meta-spend sincroniza los últimos 7 días ART', async () => {
    const metaSync = { syncSpend: vi.fn().mockResolvedValue(10) };
    await createJobCatalog({ orderSync: {}, metaSync, ordersRepo: {}, syncRuns: {}, now: () => NOW })['meta-spend'].fn(ctx());
    expect(metaSync.syncSpend).toHaveBeenCalledWith('2026-09-29', '2026-10-06');
  });
  describe('reattribute (con DB)', () => {
    let db;
    beforeEach(async () => { db = await createTestDb(); });
    afterEach(() => db.close());
    it('recalcula la atribución de todas las órdenes desde lo guardado', async () => {
      const ordersRepo = createOrdersRepo(db);
      for (const id of [1, 2]) {
        const m = mapOrder({ id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: '1', products: [],
          customer_visit: { landing_page: 'https://altorancho.com/?gclid=x', utm_parameters: {} } });
        await ordersRepo.upsert({ ...m, attribution: { channel: 'organic', confidence: 'none', source_raw: {}, rules_version: 0 } });
      }
      const c = ctx();
      const n = await createJobCatalog({ orderSync: {}, metaSync: {}, ordersRepo, syncRuns: {}, now: () => NOW }).reattribute.fn(c);
      expect(n).toBe(2);
      const { rows } = await db.query('SELECT channel, rules_version FROM order_attribution ORDER BY order_id');
      expect(rows).toEqual([{ channel: 'google', rules_version: 1 }, { channel: 'google', rules_version: 1 }]);
    });
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/jobsCatalog.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar `backend/src/jobsCatalog.js`**

```js
import { attribute } from './engine/attribution.js';
import { artDate, addDays } from './engine/dates.js';

// Jobs disparables por cron o por POST /api/sync/:job. Cada fn(ctx) devuelve la cantidad de filas.
export function createJobCatalog({ orderSync, metaSync, ordersRepo, syncRuns, now = () => new Date() }) {
  return {
    'tn-backfill': {
      source: 'tn_backfill',
      async fn(ctx) {
        const last = await syncRuns.lastCursor('tn_backfill');
        const resumeAfter = last && !last.complete ? last.done : null;
        const rows = await orderSync.backfill({
          to: artDate(now()),
          resumeAfter,
          onMonthDone: (month, total) => ctx.progress(total, { done: month, complete: false }),
        });
        await ctx.progress(rows, { done: artDate(now()).slice(0, 7), complete: true });
        return rows;
      },
    },
    'tn-incremental': {
      source: 'tn_incremental',
      fn: () => orderSync.syncUpdatedSince(new Date(now().getTime() - 2 * 3600 * 1000).toISOString()),
    },
    'meta-catalog': { source: 'meta_catalog', fn: () => metaSync.syncCatalog() },
    'meta-spend': {
      source: 'meta_spend',
      fn: () => {
        const today = artDate(now());
        return metaSync.syncSpend(addDays(today, -7), today);
      },
    },
    'meta-backfill': {
      source: 'meta_backfill',
      fn: (ctx) => metaSync.backfillSpend({ now: now(), onMonthDone: (month, total) => ctx.progress(total, { done: month }) }),
    },
    reattribute: {
      source: 'reattribute',
      async fn(ctx) {
        let after = '0';
        let n = 0;
        for (;;) {
          const batch = await ordersRepo.listForReattribution(after, 1000);
          if (batch.length === 0) break;
          for (const o of batch) {
            await ordersRepo.setAttribution(o.id, attribute({ landingUrl: o.landing_url, visitLandingPage: o.visit_landing_page, visitUtm: o.visit_utm }));
          }
          n += batch.length;
          after = batch[batch.length - 1].id;
          await ctx.progress(n);
        }
        await ordersRepo.resolveMetaIds();
        return n;
      },
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/jobsCatalog.test.js`
Expected: PASS.

- [ ] **Step 5: Reescribir `backend/src/index.js`**

```js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createOrdersRepo } from './repo/orders.js';
import { createMetaRepo } from './repo/meta.js';
import { createSyncRunsRepo } from './repo/syncRuns.js';
import { createReportsRepo } from './repo/reports.js';
import { createTiendanubeClient } from './services/tiendanube.js';
import { createMetaClient } from './services/meta.js';
import { createOrderSync } from './sync/orders.js';
import { createMetaSync } from './sync/meta.js';
import { createUrlTagger } from './sync/urlTagger.js';
import { createJobRunner } from './sync/jobs.js';
import { createJobCatalog } from './jobsCatalog.js';
import { artDate, addDays } from './engine/dates.js';
import { createApp } from './app.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createApiRouter } from './routes/api.js';
import { createAuthMiddleware } from './routes/authMiddleware.js';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta env var: ${k}`);
  return v;
};

const db = createPgDb(env('DATABASE_URL'));
const applied = await migrate(db);
if (applied.length) console.log('[db] migraciones aplicadas:', applied.join(', '));

const syncRuns = createSyncRunsRepo(db);
await syncRuns.markStaleRunning();
const ordersRepo = createOrdersRepo(db);
const metaRepo = createMetaRepo(db);
const reports = createReportsRepo(db);

const tn = createTiendanubeClient({ storeId: env('TIENDANUBE_STORE_ID'), token: env('TIENDANUBE_TOKEN') });
const meta = createMetaClient({ accessToken: env('META_ACCESS_TOKEN'), accountId: env('META_ACCOUNT_ID') });
const orderSync = createOrderSync({ tn, ordersRepo });
const metaSync = createMetaSync({ meta, metaRepo, ordersRepo });
const urlTagger = createUrlTagger({ meta, metaRepo });
const jobs = createJobRunner({ syncRuns });
const jobCatalog = createJobCatalog({ orderSync, metaSync, ordersRepo, syncRuns });
const runJob = (name) => jobs.run(jobCatalog[name].source, jobCatalog[name].fn);

async function onOrderEvent(event) {
  try {
    await orderSync.syncOrder(event.id);
  } catch (err) {
    console.error(`[webhook] orden ${event.id}:`, err);
    const id = await syncRuns.start('tn_webhook');
    await syncRuns.finish(id, { status: 'error', error: `orden ${event.id}: ${err.message}` });
  }
}

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
const app = createApp({
  webhookRouter: createWebhookRouter({ secret: process.env.TIENDANUBE_WEBHOOK_SECRET, onOrderEvent }),
  apiRouter: [
    createAuthMiddleware({ password: env('DASHBOARD_PASSWORD') }),
    createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }),
  ],
  staticDir: fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined,
  health: async () => {
    await db.query('SELECT 1');
    return { db: true };
  },
});

const TZ = { timezone: 'America/Argentina/Buenos_Aires' };
// Red de seguridad de órdenes (webhooks perdidos) — cada hora
cron.schedule('5 * * * *', () => runJob('tn-incremental'), TZ);
// Catálogo + gasto de hoy/ayer — cada hora
cron.schedule('15 * * * *', async () => {
  await runJob('meta-catalog');
  await jobs.run('meta_spend', () => {
    const today = artDate();
    return metaSync.syncSpend(addDays(today, -1), today);
  });
}, TZ);
// Correcciones tardías de Meta — últimos 7 días, 05:00 ART
cron.schedule('0 5 * * *', () => runJob('meta-spend'), TZ);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`altorancho-backend escuchando en :${port}`));
```

- [ ] **Step 6: `backend/scripts/registerWebhooks.js`**

```js
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
```

- [ ] **Step 7: `package.json` y `railway.json` en la raíz**

```json
{
  "name": "altorancho-ventas",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm --prefix frontend ci --include=dev && npm --prefix frontend run build && npm --prefix backend ci --omit=dev",
    "start": "npm --prefix backend start"
  }
}
```

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "npm run build" },
  "deploy": { "startCommand": "npm start", "healthcheckPath": "/health", "restartPolicyType": "ON_FAILURE" }
}
```

- [ ] **Step 8: Reescribir `README.md`**

```markdown
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
```

- [ ] **Step 9: Verificar que el módulo de entrada parsea y la suite pasa**

Run: `cd backend && node --check src/index.js && npx vitest run`
Expected: sin errores de sintaxis; PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/index.js backend/src/jobsCatalog.js backend/test/jobsCatalog.test.js backend/scripts/registerWebhooks.js package.json railway.json README.md
git commit -m "feat: wiring de producción, crons, jobs admin y config de deploy en Railway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Base del frontend — limpieza, PWA, estilo, layout, login y utilidades

**Files:**
- Delete: `frontend/src/pages/*` (todas las de Gineza), `frontend/test/aprobaciones.test.jsx`, `frontend/test/chat.test.jsx`, `frontend/test/creativos.test.jsx`, `frontend/test/productos.test.jsx`, `frontend/public/.htaccess`, `frontend/.env.production`
- Modify: `frontend/package.json`, `frontend/vite.config.js`, `frontend/index.html`, `frontend/.env.example`, `frontend/src/App.jsx`, `frontend/src/styles.css`, `frontend/src/components/Layout.jsx`, `frontend/src/components/Login.jsx`
- Create: `frontend/public/logo.svg`, `frontend/pwa-assets.config.js`, `frontend/src/lib/format.js`, `frontend/src/lib/period.js`, `frontend/src/components/ChannelTag.jsx`, `frontend/src/components/PeriodPicker.jsx`, páginas placeholder `frontend/src/pages/{Ventas,OrderDetail,Anuncios,AdDetail,Estado}.jsx`
- Test: `frontend/test/format.test.js`, `frontend/test/period.test.js`, `frontend/test/layout.test.jsx`, `frontend/test/login.test.jsx`

**Interfaces:**
- Consumes: API de Task 11 (`GET /api/status` para validar login y para el indicador de sincronización).
- Produces:
  - `lib/format.js`: `fmtMoney(n)`, `fmtNumber(n)`, `fmtRoas(n)`, `fmtPct(part, total)`, `fmtDateTime(iso)`, `fmtDate(ymd)`, `fmtRelative(iso, now?)`, `shortName(name)`. Todos devuelven `'—'` para `null`/`undefined` (salvo `fmtPct`).
  - `lib/period.js`: `artToday(now?)`, `addDays(ymd, n)`, `PRESETS: [{ id, label }]`, `presetRange(id, now?) → { from, to } | null`, `periodQuery({ from, to }) → 'from=…&to=…'`, `loadPeriod(now?)`, `savePeriod(period)`. Un período es `{ preset, from, to }`.
  - `<ChannelTag channel />` y `CHANNELS: Record<channel, { label, color }>`.
  - `<PeriodPicker period onChange />`.
  - `<Layout api onLogout>` con barra inferior (Ventas `/`, Anuncios `/anuncios`, Estado `/estado`) e indicador "Actualizado hace X".
  - Rutas: `/` Ventas, `/orden/:id` OrderDetail, `/anuncios` Anuncios, `/anuncios/:id` AdDetail, `/estado` Estado. Cada página recibe `{ api, period, setPeriod }`.
  - Clave de localStorage de la contraseña: `ar_pw`; del período: `ar_period`.

- [ ] **Step 1: Limpiar y actualizar dependencias**

```bash
cd frontend
git rm -q -r src/pages test/aprobaciones.test.jsx test/chat.test.jsx test/creativos.test.jsx test/productos.test.jsx public/.htaccess .env.production
npm install -D vite-plugin-pwa@^0.20.5 @vite-pwa/assets-generator@^0.2.6
npm pkg set name=altorancho-frontend
npm pkg set scripts.generate-pwa-assets="pwa-assets-generator"
```

- [ ] **Step 2: Ícono y config de assets PWA**

`frontend/public/logo.svg` (provisorio; reemplazar por el logo real de Altorancho cuando esté):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#353434"/>
  <text x="256" y="322" font-family="Helvetica, Arial, sans-serif" font-size="220" font-weight="700" fill="#FFFFFF" text-anchor="middle">AR</text>
</svg>
```

`frontend/pwa-assets.config.js`:

```js
import { defineConfig, minimal2023Preset as preset } from '@vite-pwa/assets-generator/config';

export default defineConfig({ preset, images: ['public/logo.svg'] });
```

Run: `cd frontend && npm run generate-pwa-assets`
Expected: crea en `public/` `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`, `favicon.ico`.

- [ ] **Step 3: `frontend/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg'],
      manifest: {
        name: 'Altorancho Ventas',
        short_name: 'Ventas',
        description: 'Ventas web de Altorancho con su origen y costo de publicidad',
        lang: 'es-AR',
        start_url: '/',
        display: 'standalone',
        theme_color: '#353434',
        background_color: '#FFFFFF',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Solo se cachea el shell; los datos de /api siempre van a la red
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/webhooks\//, /^\/health/],
        runtimeCaching: [],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.js',
    globals: true,
  },
});
```

- [ ] **Step 4: `frontend/index.html` y `frontend/.env.example`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="#353434" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <link rel="icon" href="/favicon.ico" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />
    <title>Altorancho Ventas</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

```
# Solo hace falta si el frontend NO lo sirve el mismo backend (por defecto usa /api del mismo dominio)
VITE_API_URL=
```

- [ ] **Step 5: Tests de utilidades `frontend/test/format.test.js` y `frontend/test/period.test.js`**

```js
// frontend/test/format.test.js
import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtRoas, fmtPct, fmtRelative, shortName, fmtNumber, fmtDate } from '../src/lib/format.js';

describe('format', () => {
  it('plata en ARS sin decimales', () => {
    expect(fmtMoney(40497.12)).toMatch(/^\$\s?40\.497$/);
    expect(fmtMoney(null)).toBe('—');
  });
  it('roas, porcentajes y números', () => {
    expect(fmtRoas(6.73)).toBe('6,7x');
    expect(fmtRoas(null)).toBe('—');
    expect(fmtPct(1, 3)).toBe('33%');
    expect(fmtPct(1, 0)).toBe('0%');
    expect(fmtNumber(54463)).toBe('54.463');
  });
  it('tiempo relativo', () => {
    const now = new Date('2026-10-06T15:00:00Z');
    expect(fmtRelative('2026-10-06T14:59:40Z', now)).toBe('recién');
    expect(fmtRelative('2026-10-06T14:48:00Z', now)).toBe('hace 12 min');
    expect(fmtRelative('2026-10-06T12:00:00Z', now)).toBe('hace 3 h');
    expect(fmtRelative('2026-10-04T12:00:00Z', now)).toBe('04/10 09:00');
  });
  it('nombre corto y fecha', () => {
    expect(shortName('Mariana Francia')).toBe('Mariana F.');
    expect(shortName('Julieta')).toBe('Julieta');
    expect(shortName(null)).toBe('Sin nombre');
    expect(fmtDate('2026-09-29')).toBe('29/09');
  });
});
```

```js
// frontend/test/period.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { artToday, presetRange, periodQuery, loadPeriod, savePeriod } from '../src/lib/period.js';

const NOW = new Date('2026-10-06T02:00:00Z'); // 23:00 del 05 en Argentina

describe('period', () => {
  beforeEach(() => localStorage.clear());
  it('hoy en ART', () => {
    expect(artToday(NOW)).toBe('2026-10-05');
  });
  it('presets', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-10-04', to: '2026-10-04' });
    expect(presetRange('7d', NOW)).toEqual({ from: '2026-09-29', to: '2026-10-05' });
    expect(presetRange('30d', NOW)).toEqual({ from: '2026-09-06', to: '2026-10-05' });
    expect(presetRange('month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(presetRange('custom', NOW)).toBeNull();
  });
  it('periodQuery', () => {
    expect(periodQuery({ from: '2026-10-01', to: '2026-10-05' })).toBe('from=2026-10-01&to=2026-10-05');
  });
  it('load/save: un preset se recalcula al cargar, custom conserva fechas, default 7 días', () => {
    expect(loadPeriod(NOW)).toEqual({ preset: '7d', from: '2026-09-29', to: '2026-10-05' });
    savePeriod({ preset: 'today', from: '2020-01-01', to: '2020-01-01' });
    expect(loadPeriod(NOW)).toEqual({ preset: 'today', from: '2026-10-05', to: '2026-10-05' });
    savePeriod({ preset: 'custom', from: '2026-08-01', to: '2026-08-31' });
    expect(loadPeriod(NOW)).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-31' });
  });
});
```

- [ ] **Step 6: Correr para verificar que fallan**

Run: `cd frontend && npx vitest run test/format.test.js test/period.test.js`
Expected: FAIL.

- [ ] **Step 7: Implementar `frontend/src/lib/format.js`**

```js
const TZ = 'America/Argentina/Buenos_Aires';
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const number = new Intl.NumberFormat('es-AR');

const empty = (n) => n === null || n === undefined;
export const fmtMoney = (n) => (empty(n) ? '—' : money.format(n));
export const fmtNumber = (n) => (empty(n) ? '—' : number.format(n));
export const fmtRoas = (n) => (empty(n) ? '—' : `${n.toFixed(1).replace('.', ',')}x`);
export const fmtPct = (part, total) => (total ? `${Math.round((part * 100) / total)}%` : '0%');
export const fmtDate = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : '—');

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

export function fmtRelative(iso, now = new Date()) {
  if (!iso) return '—';
  const minutes = (now.getTime() - new Date(iso).getTime()) / 60000;
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${Math.floor(minutes)} min`;
  if (minutes < 24 * 60) return `hace ${Math.floor(minutes / 60)} h`;
  return fmtDateTime(iso);
}

export function shortName(name) {
  if (!name || !name.trim()) return 'Sin nombre';
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}
```

- [ ] **Step 8: Implementar `frontend/src/lib/period.js`**

```js
const OFFSET_MS = 3 * 3600 * 1000; // Argentina UTC-3 fijo
const KEY = 'ar_period';

export const artToday = (now = new Date()) => new Date(now.getTime() - OFFSET_MS).toISOString().slice(0, 10);

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const PRESETS = [
  { id: 'today', label: 'Hoy' },
  { id: 'yesterday', label: 'Ayer' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'month', label: 'Mes' },
  { id: 'custom', label: 'Elegir' },
];

export function presetRange(id, now = new Date()) {
  const t = artToday(now);
  switch (id) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case '7d': return { from: addDays(t, -6), to: t };
    case '30d': return { from: addDays(t, -29), to: t };
    case 'month': return { from: `${t.slice(0, 8)}01`, to: t };
    default: return null;
  }
}

export const periodQuery = ({ from, to }) => `from=${from}&to=${to}`;

export function loadPeriod(now = new Date()) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignorar */ }
  if (saved?.preset === 'custom' && saved.from && saved.to) return saved;
  const preset = saved?.preset && presetRange(saved.preset, now) ? saved.preset : '7d';
  return { preset, ...presetRange(preset, now) };
}

export function savePeriod(period) {
  try { localStorage.setItem(KEY, JSON.stringify(period)); } catch { /* ignorar */ }
}
```

- [ ] **Step 9: Correr tests**

Run: `cd frontend && npx vitest run test/format.test.js test/period.test.js`
Expected: PASS.

- [ ] **Step 10: Tests de Layout y Login `frontend/test/layout.test.jsx` y `frontend/test/login.test.jsx`**

```jsx
// frontend/test/layout.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from '../src/components/Layout.jsx';

const status = (minutesAgo, status = 'ok') => ({
  runs: [{ source: 'tn_incremental', status }],
  lastSuccess: [{ source: 'tn_incremental', finished_at: new Date(Date.now() - minutesAgo * 60000).toISOString() },
    { source: 'meta_spend', finished_at: new Date(Date.now() - minutesAgo * 60000).toISOString() }],
});

describe('Layout', () => {
  it('muestra navegación inferior y última actualización', async () => {
    const api = { get: vi.fn().mockResolvedValue(status(12)) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p>contenido</p></Layout></MemoryRouter>);
    expect(screen.getByRole('link', { name: /ventas/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /anuncios/i })).toHaveAttribute('href', '/anuncios');
    expect(screen.getByRole('link', { name: /estado/i })).toHaveAttribute('href', '/estado');
    await waitFor(() => expect(screen.getByText(/actualizado hace 12 min/i)).toBeInTheDocument());
  });
  it('avisa si los datos tienen más de 2 horas o la última corrida falló', async () => {
    const api = { get: vi.fn().mockResolvedValue(status(200)) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p /></Layout></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/datos desactualizados/i)).toBeInTheDocument());
  });
});
```

```jsx
// frontend/test/login.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from '../src/components/Login.jsx';

afterEach(() => vi.unstubAllGlobals());

describe('Login', () => {
  it('valida contra /status y entra', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} apiUrl="/api" />);
    await userEvent.type(screen.getByPlaceholderText(/contraseña/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('pw'));
    expect(fetchMock).toHaveBeenCalledWith('/api/status', { headers: { Authorization: 'Bearer pw' } });
  });
  it('contraseña incorrecta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));
    render(<Login onLogin={vi.fn()} apiUrl="/api" />);
    await userEvent.type(screen.getByPlaceholderText(/contraseña/i), 'mal');
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByText(/contraseña incorrecta/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 11: Implementar componentes compartidos**

`frontend/src/components/ChannelTag.jsx`:

```jsx
export const CHANNELS = {
  meta: { label: 'Meta', color: '#1877F2' },
  google: { label: 'Google', color: '#F29900' },
  organic: { label: 'Orgánica', color: '#1E9E5A' },
  email: { label: 'Email', color: '#7B5CD6' },
  social_organic: { label: 'Redes', color: '#D6457A' },
  other: { label: 'Otros', color: '#8A8A8A' },
  unknown: { label: 'Sin datos', color: '#8A8A8A' },
};

export default function ChannelTag({ channel }) {
  const c = CHANNELS[channel] || CHANNELS.unknown;
  return <span className="tag" style={{ '--tag': c.color }}>{c.label}</span>;
}
```

`frontend/src/components/PeriodPicker.jsx`:

```jsx
import { PRESETS, presetRange } from '../lib/period.js';

export default function PeriodPicker({ period, onChange }) {
  return (
    <div className="period">
      <div className="chips" role="tablist" aria-label="Período">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={period.preset === p.id}
            className={period.preset === p.id ? 'chip active' : 'chip'}
            onClick={() => onChange(p.id === 'custom' ? { ...period, preset: 'custom' } : { preset: p.id, ...presetRange(p.id) })}
          >
            {p.label}
          </button>
        ))}
      </div>
      {period.preset === 'custom' && (
        <div className="custom-range">
          <label>Desde <input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && onChange({ ...period, from: e.target.value })} /></label>
          <label>Hasta <input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && onChange({ ...period, to: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}
```

`frontend/src/components/Layout.jsx`:

```jsx
import { NavLink } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling.js';
import { fmtRelative } from '../lib/format.js';

const NAV = [
  { to: '/', label: 'Ventas', icon: '◫' },
  { to: '/anuncios', label: 'Anuncios', icon: '◎' },
  { to: '/estado', label: 'Estado', icon: '↻' },
];
const STALE_MS = 2 * 3600 * 1000;
const KEY_SOURCES = ['tn_incremental', 'meta_spend'];

function syncInfo(status) {
  if (!status) return null;
  const times = KEY_SOURCES.map((s) => status.lastSuccess.find((r) => r.source === s)?.finished_at).filter(Boolean);
  if (times.length === 0) return { text: 'Sin sincronizar todavía', stale: true };
  const oldest = times.sort()[0];
  const failed = status.runs.some((r) => KEY_SOURCES.includes(r.source) && r.status === 'error');
  const stale = failed || times.length < KEY_SOURCES.length || Date.now() - new Date(oldest).getTime() > STALE_MS;
  return { text: stale ? `Datos desactualizados · ${fmtRelative(oldest)}` : `Actualizado ${fmtRelative(oldest)}`, stale };
}

export default function Layout({ api, onLogout, children }) {
  const { data } = usePolling(() => api.get('/status'), [api], 5 * 60_000);
  const info = syncInfo(data);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">ALTORANCHO <span>Ventas</span></div>
        <button className="link-btn" onClick={onLogout}>Salir</button>
      </header>
      {info && <div className={info.stale ? 'sync-line stale' : 'sync-line'}>{info.text}</div>}
      <main className="content">{children}</main>
      <nav className="bottom-nav">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
```

`frontend/src/components/Login.jsx`:

```jsx
import { useState } from 'react';

export default function Login({ onLogin, apiUrl }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiUrl}/status`, { headers: { Authorization: `Bearer ${pw}` } });
      if (res.status === 401) {
        setError('Contraseña incorrecta');
        return;
      }
      if (!res.ok) throw new Error(`Error ${res.status}`);
      onLogin(pw);
    } catch {
      setError('No se pudo conectar con el servidor');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">ALTORANCHO <span>Ventas</span></div>
        <input type="password" placeholder="Contraseña" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={loading || !pw}>{loading ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 12: `frontend/src/App.jsx` y páginas placeholder**

```jsx
import { useState, useMemo, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { createApi } from './api.js';
import { loadPeriod, savePeriod } from './lib/period.js';
import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Ventas from './pages/Ventas.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Anuncios from './pages/Anuncios.jsx';
import AdDetail from './pages/AdDetail.jsx';
import Estado from './pages/Estado.jsx';

const API_URL = import.meta.env.VITE_API_URL || '/api';
const PW_KEY = 'ar_pw';

export default function App() {
  const [password, setPassword] = useState(() => localStorage.getItem(PW_KEY) || '');
  const [period, setPeriodState] = useState(() => loadPeriod());
  const setPeriod = useCallback((p) => { savePeriod(p); setPeriodState(p); }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(PW_KEY);
    setPassword('');
  }, []);

  const api = useMemo(() => (password
    ? createApi({ baseUrl: API_URL, getToken: async () => password, onAuthError: logout })
    : null), [password, logout]);

  if (!api) {
    return <Login apiUrl={API_URL} onLogin={(pw) => { localStorage.setItem(PW_KEY, pw); setPassword(pw); }} />;
  }

  const props = { api, period, setPeriod };
  return (
    <Layout api={api} onLogout={logout}>
      <Routes>
        <Route path="/" element={<Ventas {...props} />} />
        <Route path="/orden/:id" element={<OrderDetail {...props} />} />
        <Route path="/anuncios" element={<Anuncios {...props} />} />
        <Route path="/anuncios/:id" element={<AdDetail {...props} />} />
        <Route path="/estado" element={<Estado {...props} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
```

Placeholder para cada una de `Ventas.jsx`, `OrderDetail.jsx`, `Anuncios.jsx`, `AdDetail.jsx`, `Estado.jsx` (se reemplazan en Tasks 14–16), cambiando el nombre del componente:

```jsx
export default function Ventas() {
  return <p className="muted">Próximamente</p>;
}
```

- [ ] **Step 13: Reescribir `frontend/src/styles.css`**

```css
/* ─── Altorancho Ventas — blanco + #353434, mobile first ─── */
:root {
  --bg: #ffffff;
  --text: #353434;
  --muted: #8a8a8a;
  --line: #ececec;
  --soft: #f6f6f5;
  --warn: #c0392b;
  --warn-bg: #fdf1ef;
  --font: 'Poppins', system-ui, sans-serif;
  --nav-h: 64px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 15px; line-height: 1.45; -webkit-tap-highlight-color: transparent; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
input { font: inherit; color: inherit; }

.shell { min-height: 100vh; padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom)); }
.topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; padding-top: calc(14px + env(safe-area-inset-top)); background: var(--bg); border-bottom: 1px solid var(--line); }
.brand { font-weight: 600; letter-spacing: 2px; font-size: 15px; }
.brand span { font-weight: 400; letter-spacing: 0; color: var(--muted); margin-left: 4px; }
.link-btn { background: none; border: 0; color: var(--muted); font-size: 13px; }
.sync-line { font-size: 12px; color: var(--muted); padding: 6px 16px; }
.sync-line.stale { color: var(--warn); background: var(--warn-bg); }
.content { max-width: 720px; margin: 0 auto; padding: 16px; }
.muted { color: var(--muted); }
.error { color: var(--warn); font-size: 13px; }

.bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 5; height: calc(var(--nav-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); display: flex; background: var(--bg); border-top: 1px solid var(--line); }
.bottom-nav a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 12px; color: var(--muted); }
.bottom-nav a.active { color: var(--text); font-weight: 600; }
.nav-icon { font-size: 18px; line-height: 1; }

.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login-card { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 14px; }
.login-card input, .search { width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.btn { padding: 12px 16px; border: 0; border-radius: 10px; background: var(--text); color: #fff; font-weight: 500; }
.btn:disabled { opacity: .4; }
.btn.secondary { background: var(--soft); color: var(--text); }
.btn.danger { background: var(--warn); }

.period { margin-bottom: 16px; }
.chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.chip { flex: none; padding: 7px 13px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); font-size: 13px; }
.chip.active { background: var(--text); border-color: var(--text); color: #fff; }
.custom-range { display: flex; gap: 10px; margin-top: 10px; font-size: 13px; color: var(--muted); }
.custom-range input { display: block; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }

.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
.card { padding: 14px; border: 1px solid var(--line); border-radius: 14px; }
.card.wide { grid-column: span 2; }
.card-label { font-size: 12px; color: var(--muted); }
.card-value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.card-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }

.section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 22px 0 10px; }
.bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--soft); }
.bar span { display: block; height: 100%; background: var(--tag); }
.legend { list-style: none; margin-top: 10px; }
.legend li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 14px; }
.legend button { background: none; border: 0; display: flex; align-items: center; gap: 8px; padding: 0; }
.note { font-size: 12px; color: var(--muted); margin-top: 8px; }

.tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--tag); background: color-mix(in srgb, var(--tag) 12%, white); white-space: nowrap; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: var(--soft); color: var(--muted); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }

.list { list-style: none; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.row-main { min-width: 0; flex: 1; }
.row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 3px; display: flex; gap: 6px; align-items: center; }
.row-side { text-align: right; flex: none; }
.row-amount { font-weight: 600; }
.row.no-sales { background: var(--warn-bg); margin: 0 -16px; padding-left: 16px; padding-right: 16px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
.filters { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 10px; }
.more { width: 100%; margin-top: 14px; }

.detail-head { margin-bottom: 16px; }
.detail-head h1 { font-size: 22px; font-weight: 600; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 14px; }
.kv dt { color: var(--muted); }
.kv dd { text-align: right; overflow-wrap: anywhere; }
.origin { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border: 1px solid var(--line); border-radius: 14px; }
.thumb { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; background: var(--soft); flex: none; }
.back { display: inline-block; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
.crumbs { display: flex; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
.crumbs button { background: none; border: 0; color: var(--text); text-decoration: underline; }
.panel { padding: 14px; border-radius: 14px; background: var(--soft); margin-top: 12px; }
.panel label { display: flex; gap: 8px; align-items: center; padding: 6px 0; font-size: 14px; }
.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
table.simple { width: 100%; border-collapse: collapse; font-size: 13px; }
table.simple th, table.simple td { text-align: right; padding: 7px 4px; border-bottom: 1px solid var(--line); }
table.simple th:first-child, table.simple td:first-child { text-align: left; }

@media (min-width: 900px) {
  .cards { grid-template-columns: repeat(4, 1fr); }
  .card.wide { grid-column: span 2; }
}
```

- [ ] **Step 14: Correr tests y build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS; build genera `dist/` con `manifest.webmanifest` y `sw.js`.

- [ ] **Step 15: Commit**

```bash
git add -A frontend
git commit -m "feat: base del frontend de Altorancho — PWA, estilo, layout, login y utilidades

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Pantalla Ventas y detalle de orden

**Files:**
- Modify (reemplazar placeholder): `frontend/src/pages/Ventas.jsx`, `frontend/src/pages/OrderDetail.jsx`
- Test: `frontend/test/ventas.test.jsx`, `frontend/test/orderDetail.test.jsx`

**Interfaces:**
- Consumes: `GET /api/summary`, `GET /api/orders`, `GET /api/orders/:id` (Task 11; formas en Task 10), `PeriodPicker`, `ChannelTag`/`CHANNELS`, `usePolling`, `lib/format.js`, `lib/period.js` (Task 13).
- Produces: `originText(order) → string|null` (exportada desde `Ventas.jsx`, la reusa `AdDetail` no; solo Ventas).

- [ ] **Step 1: Tests `frontend/test/ventas.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Ventas from '../src/pages/Ventas.jsx';

const PERIOD = { preset: '7d', from: '2026-09-29', to: '2026-10-05' };
const SUMMARY = {
  revenue: 6700, orders: 4, avgTicket: 1675,
  channels: [{ channel: 'meta', orders: 3, revenue: 6000 }, { channel: 'organic', orders: 1, revenue: 700 }],
  meta: { spend: 1000, orders: 3, revenue: 6000, roas: 6, costPerSale: 333.33, reported: { purchases: 5, value: 9000, roas: 9 } },
  coverage: { ad: 2, campaign: 0, none: 1 },
};
const order = (id, extra = {}) => ({
  id: String(id), number: 59000 + id, created_at: new Date().toISOString(), total: 1000, status: 'open', payment_status: 'paid',
  cancelled: false, customer_name: 'Mariana Francia', channel: 'meta', confidence: 'ad', ad_name: `Anuncio ${id}`, campaign_name: 'Camp', campaign_id: '1', ...extra,
});
const PAGE1 = { items: [order(1), order(2, { payment_status: 'pending', channel: 'google', ad_name: null, campaign_id: '11472612872' })], nextCursor: 'C1' };
const PAGE2 = { items: [order(3, { channel: 'organic', ad_name: null })], nextCursor: null };

function setup() {
  const api = {
    get: vi.fn(async (path) => {
      if (path.startsWith('/summary')) return SUMMARY;
      if (path.includes('cursor=C1')) return PAGE2;
      return PAGE1;
    }),
  };
  render(<MemoryRouter><Ventas api={api} period={PERIOD} setPeriod={vi.fn()} /></MemoryRouter>);
  return api;
}

describe('Ventas', () => {
  it('muestra tarjetas del período y lo real vs lo que dice Meta', async () => {
    const api = setup();
    expect(await screen.findByText(/6\.700/)).toBeInTheDocument();
    expect(screen.getByText('6,0x')).toBeInTheDocument();
    expect(screen.getByText(/meta dice 9,0x/i)).toBeInTheDocument();
    expect(screen.getByText(/de 3 ventas de meta: 2 con anuncio, 0 solo campaña, 1 sin identificar/i)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/summary?from=2026-09-29&to=2026-10-05');
  });
  it('lista órdenes con origen, link al detalle y estado no pagado', async () => {
    setup();
    const link = await screen.findByRole('link', { name: /#59001/ });
    expect(link).toHaveAttribute('href', '/orden/1');
    expect(within(link).getByText('Anuncio 1')).toBeInTheDocument();
    expect(within(link).getByText('Mariana F.', { exact: false })).toBeInTheDocument();
    const second = screen.getByRole('link', { name: /#59002/ });
    expect(within(second).getByText('Pendiente')).toBeInTheDocument();
    expect(within(second).getByText('Campaña 11472612872')).toBeInTheDocument();
  });
  it('"Ver más" trae la página siguiente', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /ver más/i }));
    expect(await screen.findByRole('link', { name: /#59003/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ver más/i })).not.toBeInTheDocument();
  });
  it('tocar un canal de la leyenda filtra la lista', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /orgánica/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/orders?from=2026-09-29&to=2026-10-05&channel=organic'));
  });
  it('buscar manda q (con debounce)', async () => {
    const api = setup();
    await userEvent.type(await screen.findByPlaceholderText(/buscar/i), '59001');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/orders?from=2026-09-29&to=2026-10-05&q=59001'));
  });
});
```

- [ ] **Step 2: Tests `frontend/test/orderDetail.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import OrderDetail from '../src/pages/OrderDetail.jsx';

const ORDER = {
  id: '1', number: 59461, created_at: '2026-10-05T15:00:00.000Z', total: 40497, subtotal: 39990, discount: 0, shipping_cost_customer: 507,
  payment_status: 'paid', status: 'open', cancelled_at: null, gateway_name: 'Pago Nube', storefront: 'mobile', customer_name: 'Mariana Francia',
  channel: 'meta', confidence: 'ad', ad_name: 'Lámpara Fungi video', adset_name: 'Broad 25-55', campaign_name: 'altorancho_dpa', thumbnail_url: 'https://t/1.jpg',
  visit_landing_page: 'https://altorancho.com/productos/x?utm_source=meta',
  items: [{ name: 'Lampara Baby Fungi', sku: 'IME040PR', quantity: 1, price: 39990 }],
  costEstimate: { level: 'ad', from: '2026-09-29', to: '2026-10-05', spend: 500, sales: 2, costPerSale: 250 },
};

const renderAt = (api) => render(
  <MemoryRouter initialEntries={['/orden/1']}>
    <Routes><Route path="/orden/:id" element={<OrderDetail api={api} />} /></Routes>
  </MemoryRouter>,
);

describe('OrderDetail', () => {
  it('muestra origen completo, costo promedio y productos', async () => {
    const api = { get: vi.fn().mockResolvedValue(ORDER) };
    renderAt(api);
    expect(await screen.findByText(/#59461/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/orders/1');
    expect(screen.getByText('Lámpara Fungi video')).toBeInTheDocument();
    expect(screen.getByText('Broad 25-55')).toBeInTheDocument();
    expect(screen.getByText('altorancho_dpa')).toBeInTheDocument();
    expect(screen.getByText(/atribuida al anuncio exacto/i)).toBeInTheDocument();
    expect(screen.getByText(/del 29\/09 al 05\/10: gastó \$\s?500 y trajo 2 ventas/i)).toBeInTheDocument();
    expect(screen.getByText('Lampara Baby Fungi')).toBeInTheDocument();
    expect(screen.getByText(ORDER.visit_landing_page)).toBeInTheDocument();
  });
  it('orgánica sin costo ni bloque de anuncio', async () => {
    const api = { get: vi.fn().mockResolvedValue({ ...ORDER, channel: 'organic', confidence: 'none', ad_name: null, adset_name: null, campaign_name: null, thumbnail_url: null, costEstimate: null }) };
    renderAt(api);
    expect(await screen.findByText('Orgánica')).toBeInTheDocument();
    expect(screen.queryByText(/costo de publicidad/i)).not.toBeInTheDocument();
  });
  it('error de la API', async () => {
    renderAt({ get: vi.fn().mockRejectedValue(new Error('orden no encontrada')) });
    expect(await screen.findByText(/orden no encontrada/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd frontend && npx vitest run test/ventas.test.jsx test/orderDetail.test.jsx`
Expected: FAIL (placeholders).

- [ ] **Step 4: Implementar `frontend/src/pages/Ventas.jsx`**

```jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import PeriodPicker from '../components/PeriodPicker.jsx';
import ChannelTag, { CHANNELS } from '../components/ChannelTag.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas, fmtPct, fmtRelative, shortName } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

export const PAYMENT_LABEL = {
  pending: 'Pendiente', authorized: 'Autorizada', voided: 'Anulada', refunded: 'Reembolsada', abandoned: 'Abandonada',
  expired: 'Vencida', partially_paid: 'Pago parcial', partially_refunded: 'Reembolso parcial', chargeback: 'Contracargo',
};

export function originText(o) {
  if (o.channel === 'meta') return o.ad_name || o.campaign_name || 'Meta sin identificar';
  if (o.channel === 'google') return o.campaign_id ? `Campaña ${o.campaign_id}` : 'Google sin identificar';
  if (o.channel === 'email') return o.campaign_name || null;
  return null;
}

function Summary({ s, channel, onChannel }) {
  const { meta, coverage } = s;
  return (
    <>
      <div className="cards">
        <div className="card wide">
          <div className="card-label">Facturación</div>
          <div className="card-value">{fmtMoney(s.revenue)}</div>
          <div className="card-sub">{fmtNumber(s.orders)} ventas · ticket {fmtMoney(s.avgTicket)}</div>
        </div>
        <div className="card">
          <div className="card-label">Gasto Meta</div>
          <div className="card-value">{fmtMoney(meta.spend)}</div>
          <div className="card-sub">{fmtMoney(meta.costPerSale)} por venta</div>
        </div>
        <div className="card">
          <div className="card-label">ROAS real Meta</div>
          <div className="card-value">{fmtRoas(meta.roas)}</div>
          <div className="card-sub">Meta dice {fmtRoas(meta.reported.roas)}</div>
        </div>
        <div className="card wide">
          <div className="card-label">Ventas de Meta</div>
          <div className="card-value">{fmtNumber(meta.orders)}</div>
          <div className="card-sub">Meta dice {fmtNumber(meta.reported.purchases)} · facturaron {fmtMoney(meta.revenue)}</div>
        </div>
      </div>

      <h2 className="section-title">Origen de las ventas</h2>
      <div className="bar" aria-hidden="true">
        {s.channels.map((c) => (
          <span key={c.channel} style={{ width: fmtPct(c.revenue, s.revenue), '--tag': (CHANNELS[c.channel] || CHANNELS.unknown).color }} />
        ))}
      </div>
      <ul className="legend">
        {s.channels.map((c) => (
          <li key={c.channel}>
            <button type="button" onClick={() => onChannel(channel === c.channel ? '' : c.channel)} aria-pressed={channel === c.channel}>
              <ChannelTag channel={c.channel} />
              <span className="muted">{fmtNumber(c.orders)} ventas</span>
            </button>
            <span>{fmtMoney(c.revenue)} <span className="muted">{fmtPct(c.revenue, s.revenue)}</span></span>
          </li>
        ))}
      </ul>
      {meta.orders > 0 && (
        <p className="note">
          De {meta.orders} ventas de Meta: {coverage.ad} con anuncio, {coverage.campaign} solo campaña, {coverage.none} sin identificar.
        </p>
      )}
    </>
  );
}

function OrderRow({ o }) {
  const origin = originText(o);
  const status = o.cancelled ? 'Cancelada' : o.payment_status !== 'paid' ? PAYMENT_LABEL[o.payment_status] || o.payment_status : null;
  return (
    <li>
      <Link className="row" to={`/orden/${o.id}`}>
        <div className="row-main">
          <div className="row-title">#{o.number} · {shortName(o.customer_name)}</div>
          <div className="row-sub">
            <ChannelTag channel={o.channel} />
            {origin && <span>{origin}</span>}
          </div>
        </div>
        <div className="row-side">
          <div className="row-amount">{fmtMoney(o.total)}</div>
          <div className="row-sub">{status ? <span className="badge warn">{status}</span> : fmtRelative(o.created_at)}</div>
        </div>
      </Link>
    </li>
  );
}

export default function Ventas({ api, period, setPeriod }) {
  const q = periodQuery(period);
  const { data: summary, error: summaryError } = usePolling(() => api.get(`/summary?${q}`), [api, q], 60_000);
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [list, setList] = useState({ items: [], nextCursor: null, loading: true, error: null });

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const base = `/orders?${q}${channel ? `&channel=${channel}` : ''}${term ? `&q=${encodeURIComponent(term)}` : ''}`;

  useEffect(() => {
    let alive = true;
    setList({ items: [], nextCursor: null, loading: true, error: null });
    api.get(base)
      .then((r) => alive && setList({ items: r.items, nextCursor: r.nextCursor, loading: false, error: null }))
      .catch((e) => alive && setList((l) => ({ ...l, loading: false, error: e.message })));
    return () => { alive = false; };
  }, [api, base]);

  const loadMore = useCallback(() => {
    if (!list.nextCursor || list.loading) return;
    setList((l) => ({ ...l, loading: true }));
    api.get(`${base}&cursor=${encodeURIComponent(list.nextCursor)}`)
      .then((r) => setList((l) => ({ items: [...l.items, ...r.items], nextCursor: r.nextCursor, loading: false, error: null })))
      .catch((e) => setList((l) => ({ ...l, loading: false, error: e.message })));
  }, [api, base, list.nextCursor, list.loading]);

  const sentinel = useRef(null);
  useEffect(() => {
    if (!sentinel.current || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <>
      <PeriodPicker period={period} onChange={setPeriod} />
      {summaryError && <p className="error">{summaryError}</p>}
      {summary ? <Summary s={summary} channel={channel} onChannel={setChannel} /> : !summaryError && <p className="muted">Cargando…</p>}

      <h2 className="section-title">Órdenes</h2>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Buscar por número, cliente o producto" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {channel && (
        <div className="filters">
          <button type="button" className="chip active" onClick={() => setChannel('')}>{CHANNELS[channel]?.label} ✕</button>
        </div>
      )}
      <ul className="list">
        {list.items.map((o) => <OrderRow key={o.id} o={o} />)}
      </ul>
      {list.error && <p className="error">{list.error}</p>}
      {!list.loading && list.items.length === 0 && !list.error && <p className="muted">No hay órdenes en este período.</p>}
      {list.nextCursor && (
        <button ref={sentinel} type="button" className="btn secondary more" onClick={loadMore} disabled={list.loading}>
          {list.loading ? 'Cargando…' : 'Ver más'}
        </button>
      )}
    </>
  );
}
```

- [ ] **Step 5: Implementar `frontend/src/pages/OrderDetail.jsx`**

```jsx
import { Link, useParams } from 'react-router-dom';
import ChannelTag from '../components/ChannelTag.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtDateTime, fmtDate } from '../lib/format.js';
import { PAYMENT_LABEL } from './Ventas.jsx';

const CONFIDENCE_TEXT = {
  ad: 'Atribuida al anuncio exacto.',
  campaign: 'Atribuida a la campaña (el link no traía el anuncio).',
  none: 'No se pudo identificar la campaña.',
};

export default function OrderDetail({ api }) {
  const { id } = useParams();
  const { data: o, error } = usePolling(() => api.get(`/orders/${id}`), [api, id], 120_000);
  if (error) return <p className="error">{error}</p>;
  if (!o) return <p className="muted">Cargando…</p>;

  const paid = o.payment_status === 'paid' && !o.cancelled_at;
  const status = o.cancelled_at ? 'Cancelada' : paid ? 'Pagada' : PAYMENT_LABEL[o.payment_status] || o.payment_status;
  const paidChannel = o.channel === 'meta' || o.channel === 'google';

  return (
    <>
      <Link className="back" to="/">← Ventas</Link>
      <div className="detail-head">
        <h1>#{o.number} · {fmtMoney(o.total)}</h1>
        <p className="muted">{fmtDateTime(o.created_at)} · {o.customer_name || 'Sin nombre'}</p>
        <span className={paid ? 'badge' : 'badge warn'}>{status}</span>
      </div>

      <h2 className="section-title">Origen</h2>
      <div className="origin">
        {o.thumbnail_url && <img className="thumb" src={o.thumbnail_url} alt="" />}
        <div className="row-main">
          <ChannelTag channel={o.channel} />
          {o.channel === 'meta' && (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Anuncio</dt><dd>{o.ad_name || '—'}</dd>
              <dt>Conjunto</dt><dd>{o.adset_name || '—'}</dd>
              <dt>Campaña</dt><dd>{o.campaign_name || '—'}</dd>
            </dl>
          )}
          {o.channel === 'google' && <p style={{ marginTop: 8 }}>Campaña de Google {o.campaign_id || 'sin identificar'}</p>}
          {o.channel === 'email' && o.campaign_name && <p style={{ marginTop: 8 }}>{o.campaign_name}</p>}
          {paidChannel && <p className="note">{CONFIDENCE_TEXT[o.confidence]}</p>}
        </div>
      </div>

      {o.costEstimate && (
        <div className="panel">
          <div className="card-label">Costo de publicidad de esta venta (promedio)</div>
          <div className="card-value">{fmtMoney(o.costEstimate.costPerSale)}</div>
          <div className="card-sub">
            {o.costEstimate.level === 'ad' ? 'El anuncio' : 'La campaña'} del {fmtDate(o.costEstimate.from)} al {fmtDate(o.costEstimate.to)}: gastó {fmtMoney(o.costEstimate.spend)} y trajo {o.costEstimate.sales} ventas.
          </div>
        </div>
      )}

      <h2 className="section-title">Productos</h2>
      <ul className="list">
        {o.items.map((it, i) => (
          <li key={i} className="row">
            <div className="row-main">
              <div className="row-title">{it.name}</div>
              <div className="row-sub">{it.sku || 'sin SKU'} · {it.quantity} u.</div>
            </div>
            <div className="row-side row-amount">{fmtMoney(it.price * it.quantity)}</div>
          </li>
        ))}
      </ul>

      <h2 className="section-title">Pago y envío</h2>
      <dl className="kv">
        <dt>Medio de pago</dt><dd>{o.gateway_name || '—'}</dd>
        <dt>Subtotal</dt><dd>{fmtMoney(o.subtotal)}</dd>
        <dt>Descuento</dt><dd>{fmtMoney(o.discount)}</dd>
        <dt>Envío</dt><dd>{fmtMoney(o.shipping_cost_customer)}</dd>
        <dt>Total</dt><dd>{fmtMoney(o.total)}</dd>
        <dt>Dispositivo</dt><dd>{o.storefront || '—'}</dd>
      </dl>

      <h2 className="section-title">Entró por</h2>
      <p className="note" style={{ overflowWrap: 'anywhere' }}>{o.visit_landing_page || o.landing_url || 'Sin datos de la visita'}</p>
    </>
  );
}
```

- [ ] **Step 6: Correr tests**

Run: `cd frontend && npx vitest run test/ventas.test.jsx test/orderDetail.test.jsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Ventas.jsx frontend/src/pages/OrderDetail.jsx frontend/test/ventas.test.jsx frontend/test/orderDetail.test.jsx
git commit -m "feat: pantalla Ventas (resumen, origen, órdenes) y detalle de orden

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Pantalla Anuncios (ranking, drill-down, parámetros de URL) y detalle de anuncio

**Files:**
- Modify (reemplazar placeholder): `frontend/src/pages/Anuncios.jsx`, `frontend/src/pages/AdDetail.jsx`
- Modify: `frontend/src/styles.css` (agregar `.row-btn`)
- Test: `frontend/test/anuncios.test.jsx`, `frontend/test/adDetail.test.jsx`

**Interfaces:**
- Consumes: `GET /api/ads`, `GET /api/ads/missing-params`, `GET /api/ads/:id`, `POST /api/meta/apply-url-tags` (Task 11; formas en Task 10 y Task 9), `api.post` (existente en `src/api.js`), `PeriodPicker`, `usePolling`, `lib/format.js`, `lib/period.js`.
- Produces: pantallas `/anuncios` y `/anuncios/:id`.

- [ ] **Step 1: Tests `frontend/test/anuncios.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Anuncios from '../src/pages/Anuncios.jsx';

const PERIOD = { preset: '7d', from: '2026-09-29', to: '2026-10-05' };
const row = (id, extra = {}) => ({
  id, name: `Nombre ${id}`, status: 'ACTIVE', thumbnail_url: null, spend: 1000, impressions: 1, clicks: 1, sales: 4, revenue: 8000,
  costPerSale: 250, roas: 8, metaPurchases: 6, metaValue: 9000, metaRoas: 9, noSales: false, ...extra,
});

function setup({ missing = [{ id: '111', name: 'Ad sin params', status: 'ACTIVE', campaign_name: 'Camp' }] } = {}) {
  const api = {
    get: vi.fn(async (path) => {
      if (path === '/ads/missing-params') return missing;
      if (path.includes('level=campaign')) return { level: 'campaign', rows: [row('C1'), row('C2', { sales: 0, revenue: 0, costPerSale: null, roas: 0, noSales: true })], unidentified: { orders: 2, revenue: 1500 } };
      if (path.includes('level=adset')) return { level: 'adset', rows: [row('S1')], unidentified: null };
      return { level: 'ad', rows: [row('A1')], unidentified: null };
    }),
    post: vi.fn().mockResolvedValue({ results: [{ adId: '111', status: 'applied', creativeId: 'CR9' }] }),
  };
  render(
    <MemoryRouter initialEntries={['/anuncios']}>
      <Routes>
        <Route path="/anuncios" element={<Anuncios api={api} period={PERIOD} setPeriod={vi.fn()} />} />
        <Route path="/anuncios/:id" element={<p>detalle anuncio</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return api;
}

describe('Anuncios', () => {
  it('ranking de campañas con ventas reales vs Meta y gasto sin ventas marcado', async () => {
    const api = setup();
    const c1 = await screen.findByRole('button', { name: /nombre c1/i });
    expect(within(c1).getByText(/4 ventas · meta dice 6/i)).toBeInTheDocument();
    const c2 = screen.getByRole('button', { name: /nombre c2/i });
    expect(within(c2).getByText(/gastó sin ventas/i)).toBeInTheDocument();
    expect(screen.getByText(/2 ventas de meta .* no se pudieron asignar/i)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=campaign&sort=spend');
  });
  it('drill-down campaña → conjunto → anuncio → detalle, con migas para volver', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /nombre c1/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=adset&sort=spend&parent=C1'));
    await userEvent.click(await screen.findByRole('button', { name: /nombre s1/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=ad&sort=spend&parent=S1'));
    await userEvent.click(await screen.findByRole('button', { name: /nombre a1/i }));
    expect(await screen.findByText('detalle anuncio')).toBeInTheDocument();
  });
  it('volver con las migas', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /nombre c1/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^campañas$/i }));
    expect(await screen.findByRole('button', { name: /nombre c2/i })).toBeInTheDocument();
  });
  it('cambiar el orden', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /costo por venta/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=campaign&sort=cps'));
  });
  it('aplicar parámetros de URL pide confirmación y muestra resultados', async () => {
    const api = setup();
    expect(await screen.findByText(/1 anuncios activos no tienen los parámetros/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revisar/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /ad sin params/i }));
    await userEvent.click(screen.getByRole('button', { name: /aplicar a 1 anuncios/i }));
    expect(screen.getByText(/puede reiniciar el aprendizaje/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /sí, aplicar/i }));
    expect(api.post).toHaveBeenCalledWith('/meta/apply-url-tags', { adIds: ['111'] });
    expect(await screen.findByText(/aplicado/i)).toBeInTheDocument();
  });
  it('sin anuncios pendientes muestra OK', async () => {
    setup({ missing: [] });
    expect(await screen.findByText(/todos los anuncios activos tienen los parámetros/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Tests `frontend/test/adDetail.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdDetail from '../src/pages/AdDetail.jsx';

const PERIOD = { preset: '7d', from: '2026-09-29', to: '2026-10-05' };
const DETAIL = {
  ad: { id: 'A1', level: 'ad', name: 'Video lámparas', status: 'ACTIVE', thumbnail_url: 'https://t/a.jpg', has_attribution_params: false },
  metrics: { spend: 400, sales: 2, revenue: 4000, costPerSale: 200, roas: 10, metaPurchases: 3, metaRoas: 12.5, noSales: false },
  orders: [{ id: '2', number: 59002, created_at: '2026-10-05T12:00:00Z', total: 3000, customer_name: 'Ana Pérez' }],
};

describe('AdDetail', () => {
  it('muestra métricas reales vs Meta, aviso de parámetros y órdenes', async () => {
    const api = { get: vi.fn().mockResolvedValue(DETAIL) };
    render(
      <MemoryRouter initialEntries={['/anuncios/A1']}>
        <Routes><Route path="/anuncios/:id" element={<AdDetail api={api} period={PERIOD} />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Video lámparas')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/ads/A1?from=2026-09-29&to=2026-10-05');
    expect(screen.getByText(/sin parámetros de url/i)).toBeInTheDocument();
    expect(screen.getByText('10,0x')).toBeInTheDocument();
    expect(screen.getByText(/meta dice 12,5x/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#59002/ })).toHaveAttribute('href', '/orden/2');
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd frontend && npx vitest run test/anuncios.test.jsx test/adDetail.test.jsx`
Expected: FAIL.

- [ ] **Step 4: Agregar a `frontend/src/styles.css`**

```css
.row-btn { width: 100%; background: none; border: 0; border-bottom: 1px solid var(--line); text-align: left; }
```

- [ ] **Step 5: Implementar `frontend/src/pages/Anuncios.jsx`**

```jsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import PeriodPicker from '../components/PeriodPicker.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

const SORTS = [
  { id: 'spend', label: 'Gasto' },
  { id: 'cps', label: 'Costo por venta' },
  { id: 'roas', label: 'ROAS' },
];
const NEXT = { campaign: 'adset', adset: 'ad' };
const RESULT_LABEL = { applied: 'Aplicado', already: 'Ya tenía', error: 'Error' };

function UrlParams({ api }) {
  const [missing, setMissing] = useState(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/ads/missing-params').then(setMissing).catch((e) => setError(e.message)), [api]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/meta/apply-url-tags', { adIds: [...selected] });
      setResults(r.results);
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!missing) return error ? <p className="error">{error}</p> : null;
  return (
    <section>
      <h2 className="section-title">Parámetros de URL</h2>
      {missing.length === 0 ? (
        <p className="note">Todos los anuncios activos tienen los parámetros de atribución.</p>
      ) : (
        <>
          <p className="note">{missing.length} anuncios activos no tienen los parámetros de URL: sus ventas no se pueden atribuir al anuncio exacto.</p>
          {!open && <div className="actions"><button type="button" className="btn secondary" onClick={() => setOpen(true)}>Revisar</button></div>}
          {open && (
            <div className="panel">
              {missing.slice(0, 50).map((a) => (
                <label key={a.id}>
                  <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.name} <span className="muted">· {a.campaign_name || 'sin campaña'}</span></span>
                </label>
              ))}
              {!confirming ? (
                <div className="actions">
                  <button type="button" className="btn" disabled={selected.size === 0} onClick={() => setConfirming(true)}>Aplicar a {selected.size} anuncios</button>
                  <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cerrar</button>
                </div>
              ) : (
                <>
                  <p className="error" style={{ marginTop: 10 }}>
                    Ojo: cada anuncio se copia con un creativo nuevo que incluye los parámetros. Meta lo vuelve a revisar y puede
                    reiniciar el aprendizaje. Conviene hacerlo en anuncios nuevos o que no estén rindiendo.
                  </p>
                  <div className="actions">
                    <button type="button" className="btn danger" disabled={busy} onClick={apply}>{busy ? 'Aplicando…' : 'Sí, aplicar'}</button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      {results && (
        <ul className="list">
          {results.map((r) => (
            <li key={r.adId} className="row">
              <span>{r.adId}</span>
              <span className={r.status === 'error' ? 'badge warn' : 'badge'}>{RESULT_LABEL[r.status]}{r.error ? `: ${r.error}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default function Anuncios({ api, period, setPeriod }) {
  const navigate = useNavigate();
  const [stack, setStack] = useState([{ level: 'campaign', parentId: null, name: 'Campañas' }]);
  const [sort, setSort] = useState('spend');
  const cur = stack[stack.length - 1];
  const q = `${periodQuery(period)}&level=${cur.level}&sort=${sort}${cur.parentId ? `&parent=${cur.parentId}` : ''}`;
  const { data, error } = usePolling(() => api.get(`/ads?${q}`), [api, q], 120_000);

  const open = (r) => {
    if (cur.level === 'ad') navigate(`/anuncios/${r.id}`);
    else setStack([...stack, { level: NEXT[cur.level], parentId: r.id, name: r.name || r.id }]);
  };

  return (
    <>
      <PeriodPicker period={period} onChange={setPeriod} />
      <div className="crumbs">
        {stack.map((s, i) => (i < stack.length - 1
          ? <span key={s.name + i}><button type="button" onClick={() => setStack(stack.slice(0, i + 1))}>{s.name}</button> ›</span>
          : <strong key={s.name + i}>{s.name}</strong>))}
      </div>
      <div className="chips" role="tablist" aria-label="Ordenar por" style={{ marginBottom: 10 }}>
        {SORTS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={sort === s.id} className={sort === s.id ? 'chip active' : 'chip'} onClick={() => setSort(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && (
        <>
          <ul className="list">
            {data.rows.map((r) => (
              <li key={r.id}>
                <button type="button" className={`row row-btn${r.noSales ? ' no-sales' : ''}`} onClick={() => open(r)}>
                  <div className="row-main">
                    <div className="row-title">{r.name || `ID ${r.id}`}</div>
                    <div className="row-sub">
                      <span>{fmtNumber(r.sales)} ventas · Meta dice {fmtNumber(r.metaPurchases)}</span>
                      {r.noSales && <span className="badge warn">Gastó sin ventas</span>}
                    </div>
                  </div>
                  <div className="row-side">
                    <div className="row-amount">{fmtMoney(r.spend)}</div>
                    <div className="row-sub">{fmtMoney(r.costPerSale)} c/u · ROAS {fmtRoas(r.roas)}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {data.rows.length === 0 && <p className="muted">Sin gasto ni ventas en este período.</p>}
          {data.unidentified?.orders > 0 && (
            <p className="note">
              Además hubo {data.unidentified.orders} ventas de Meta ({fmtMoney(data.unidentified.revenue)}) que no se pudieron asignar a una campaña.
            </p>
          )}
        </>
      )}
      <UrlParams api={api} />
    </>
  );
}
```

- [ ] **Step 6: Implementar `frontend/src/pages/AdDetail.jsx`**

```jsx
import { Link, useParams } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber, fmtRoas, fmtRelative, shortName } from '../lib/format.js';
import { periodQuery } from '../lib/period.js';

const LEVEL_LABEL = { campaign: 'Campaña', adset: 'Conjunto', ad: 'Anuncio' };

export default function AdDetail({ api, period }) {
  const { id } = useParams();
  const q = periodQuery(period);
  const { data, error } = usePolling(() => api.get(`/ads/${id}?${q}`), [api, id, q], 120_000);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;
  const { ad, metrics: m, orders } = data;

  return (
    <>
      <Link className="back" to="/anuncios">← Anuncios</Link>
      <div className="origin" style={{ marginBottom: 16 }}>
        {ad.thumbnail_url && <img className="thumb" src={ad.thumbnail_url} alt="" />}
        <div className="row-main">
          <div className="card-label">{LEVEL_LABEL[ad.level]} · {ad.status}</div>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>{ad.name}</h1>
          {ad.level === 'ad' && (
            <span className={ad.has_attribution_params ? 'badge' : 'badge warn'}>
              {ad.has_attribution_params ? 'Con parámetros de URL' : 'Sin parámetros de URL'}
            </span>
          )}
        </div>
      </div>
      <div className="cards">
        <div className="card">
          <div className="card-label">Gasto</div>
          <div className="card-value">{fmtMoney(m.spend)}</div>
        </div>
        <div className="card">
          <div className="card-label">Ventas reales</div>
          <div className="card-value">{fmtNumber(m.sales)}</div>
          <div className="card-sub">Meta dice {fmtNumber(m.metaPurchases)}</div>
        </div>
        <div className="card">
          <div className="card-label">Costo por venta</div>
          <div className="card-value">{fmtMoney(m.costPerSale)}</div>
        </div>
        <div className="card">
          <div className="card-label">ROAS real</div>
          <div className="card-value">{fmtRoas(m.roas)}</div>
          <div className="card-sub">Meta dice {fmtRoas(m.metaRoas)}</div>
        </div>
      </div>
      <h2 className="section-title">Ventas que trajo</h2>
      <ul className="list">
        {orders.map((o) => (
          <li key={o.id}>
            <Link className="row" to={`/orden/${o.id}`}>
              <div className="row-main">
                <div className="row-title">#{o.number} · {shortName(o.customer_name)}</div>
                <div className="row-sub">{fmtRelative(o.created_at)}</div>
              </div>
              <div className="row-side row-amount">{fmtMoney(o.total)}</div>
            </Link>
          </li>
        ))}
      </ul>
      {orders.length === 0 && <p className="muted">Sin ventas atribuidas en este período.</p>}
    </>
  );
}
```

- [ ] **Step 7: Correr tests**

Run: `cd frontend && npx vitest run test/anuncios.test.jsx test/adDetail.test.jsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Anuncios.jsx frontend/src/pages/AdDetail.jsx frontend/src/styles.css frontend/test/anuncios.test.jsx frontend/test/adDetail.test.jsx
git commit -m "feat: pantalla Anuncios (ranking real vs Meta, drill-down, parámetros de URL) y detalle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Pantalla Estado

**Files:**
- Modify (reemplazar placeholder): `frontend/src/pages/Estado.jsx`
- Test: `frontend/test/estado.test.jsx`

**Interfaces:**
- Consumes: `GET /api/status` → `{ runs: [{ source, started_at, finished_at, status, rows, error }], lastSuccess: [{ source, finished_at }], errors: [{ source, started_at, error }], coverage: [{ week, ad, campaign, none }], counts: { orders, adsMissingParams }, running: string[] }` (Task 11).

- [ ] **Step 1: Test `frontend/test/estado.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Estado from '../src/pages/Estado.jsx';

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const STATUS = {
  runs: [
    { source: 'tn_incremental', started_at: ago(10), finished_at: ago(9), status: 'ok', rows: 12, error: null },
    { source: 'meta_spend', started_at: ago(20), finished_at: ago(19), status: 'error', rows: 0, error: 'Meta 190: token vencido' },
  ],
  lastSuccess: [{ source: 'tn_incremental', finished_at: ago(9) }, { source: 'meta_spend', finished_at: ago(80) }],
  errors: [{ source: 'meta_spend', started_at: ago(20), error: 'Meta 190: token vencido' }],
  coverage: [{ week: '2026-09-28', ad: 1, campaign: 6, none: 3 }, { week: '2026-10-05', ad: 8, campaign: 1, none: 1 }],
  counts: { orders: 54463, adsMissingParams: 7 },
  running: ['tn_backfill'],
};

describe('Estado', () => {
  it('muestra sincronizaciones, errores, cobertura y conteos', async () => {
    render(<MemoryRouter><Estado api={{ get: vi.fn().mockResolvedValue(STATUS) }} /></MemoryRouter>);
    const tn = await screen.findByText('Tienda Nube (cada hora)');
    expect(within(tn.closest('li')).getByText('OK')).toBeInTheDocument();
    expect(within(tn.closest('li')).getByText(/hace 9 min/)).toBeInTheDocument();
    const meta = screen.getByText('Meta — gasto').closest('li');
    expect(within(meta).getByText('Error')).toBeInTheDocument();
    expect(within(meta).getByText(/token vencido/)).toBeInTheDocument();
    expect(within(screen.getByText('Tienda Nube (histórico)').closest('li')).getByText('Corriendo')).toBeInTheDocument();
    expect(screen.getByText('54.463')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    const row = screen.getByText('05/10').closest('tr');
    expect(within(row).getByText('80%')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd frontend && npx vitest run test/estado.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implementar `frontend/src/pages/Estado.jsx`**

```jsx
import { usePolling } from '../hooks/usePolling.js';
import { fmtNumber, fmtPct, fmtRelative, fmtDate, fmtDateTime } from '../lib/format.js';

const SOURCES = [
  ['tn_incremental', 'Tienda Nube (cada hora)'],
  ['tn_webhook', 'Tienda Nube (webhooks)'],
  ['tn_backfill', 'Tienda Nube (histórico)'],
  ['meta_catalog', 'Meta — catálogo'],
  ['meta_spend', 'Meta — gasto'],
  ['meta_backfill', 'Meta — histórico'],
  ['meta_url_tags', 'Parámetros de URL'],
  ['reattribute', 'Re-atribución'],
];
const LABEL = Object.fromEntries(SOURCES);

export default function Estado({ api }) {
  const { data, error } = usePolling(() => api.get('/status'), [api], 30_000);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;

  const last = Object.fromEntries(data.runs.map((r) => [r.source, r]));
  const ok = Object.fromEntries(data.lastSuccess.map((r) => [r.source, r.finished_at]));
  const visible = SOURCES.filter(([s]) => last[s] || data.running.includes(s));

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 0 }}>Sincronización</h2>
      <ul className="list">
        {visible.map(([source, label]) => {
          const run = last[source];
          const running = data.running.includes(source);
          const badge = running ? <span className="badge">Corriendo</span>
            : run?.status === 'error' ? <span className="badge warn">Error</span>
              : <span className="badge">OK</span>;
          return (
            <li key={source} className="row">
              <div className="row-main">
                <div className="row-title">{label}</div>
                <div className="row-sub">Último OK: {ok[source] ? fmtRelative(ok[source]) : 'nunca'}{run ? ` · ${fmtNumber(run.rows)} filas` : ''}</div>
                {run?.status === 'error' && !running && <div className="error">{run.error}</div>}
              </div>
              <div className="row-side">{badge}</div>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && <p className="muted">Todavía no corrió ninguna sincronización.</p>}

      <h2 className="section-title">Datos</h2>
      <dl className="kv">
        <dt>Órdenes guardadas</dt><dd>{fmtNumber(data.counts.orders)}</dd>
        <dt>Anuncios activos sin parámetros de URL</dt><dd>{fmtNumber(data.counts.adsMissingParams)}</dd>
      </dl>

      <h2 className="section-title">Atribución de ventas Meta por semana</h2>
      {data.coverage.length === 0 ? <p className="muted">Sin ventas de Meta en las últimas 8 semanas.</p> : (
        <table className="simple">
          <thead><tr><th>Semana</th><th>Anuncio</th><th>Campaña</th><th>Sin identificar</th></tr></thead>
          <tbody>
            {data.coverage.map((w) => {
              const total = w.ad + w.campaign + w.none;
              return (
                <tr key={w.week}>
                  <td>{fmtDate(w.week)}</td>
                  <td>{fmtPct(w.ad, total)}</td>
                  <td>{fmtPct(w.campaign, total)}</td>
                  <td>{fmtPct(w.none, total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note">El % "Anuncio" debería subir a medida que los anuncios tengan los parámetros de URL.</p>

      {data.errors.length > 0 && (
        <>
          <h2 className="section-title">Errores recientes</h2>
          <ul className="list">
            {data.errors.map((e, i) => (
              <li key={i} className="row">
                <div className="row-main">
                  <div className="row-title">{LABEL[e.source] || e.source}</div>
                  <div className="row-sub">{fmtDateTime(e.started_at)}</div>
                  <div className="error">{e.error}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 4: Correr toda la suite del frontend y el build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS y build OK.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Estado.jsx frontend/test/estado.test.jsx
git commit -m "feat: pantalla Estado (sincronización, errores y cobertura de atribución)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Deploy en Railway y verificación con datos reales

Esta tarea es operativa: necesita credenciales que da el usuario y cada paso se verifica contra los sistemas reales. **No avanzar al paso siguiente si uno falla**: frenar, diagnosticar y avisar.

**Files:** ninguno nuevo (salvo arreglos que surjan, cada uno con su test y commit).

**Interfaces:**
- Consumes: todo el sistema; Railway CLI logueado (`railway whoami` → jdilernia99@gmail.com).

- [ ] **Step 1: Pedir al usuario las credenciales que faltan**

Pedir (para cargarlas directo como variables de Railway, sin escribirlas en archivos del repo):
- `META_ACCESS_TOKEN`: system user token de la app `1344904590300546` con `ads_read` + `ads_management` y la cuenta publicitaria de Altorancho asignada.
- `META_ACCOUNT_ID`: `act_…` de Altorancho.
- `TIENDANUBE_WEBHOOK_SECRET`: client secret de la app de Tienda Nube.
- `DASHBOARD_PASSWORD`: la contraseña que va a usar el dueño.

Verificar el token de Meta antes de seguir:

Run: `curl -s "https://graph.facebook.com/v23.0/<META_ACCOUNT_ID>?fields=name,currency,timezone_name&access_token=<TOKEN>"`
Expected: JSON con `name` de Altorancho, `currency: "ARS"`. Anotar `timezone_name`; si NO es `America/Argentina/Buenos_Aires`, avisar al usuario (los días de gasto de Meta quedarían corridos respecto de las ventas).

- [ ] **Step 2: Crear proyecto, Postgres y servicio**

```bash
railway init --name altorancho-ventas
railway add --database postgres
railway add --service web
railway service web
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --set TIENDANUBE_STORE_ID=2547699 --set TIENDANUBE_TOKEN=<token TN> --set TIENDANUBE_WEBHOOK_SECRET=<secret> \
  --set META_ACCESS_TOKEN=<token> --set META_ACCOUNT_ID=<act_…> --set DASHBOARD_PASSWORD=<pw>
railway up --detach
railway domain
```

Expected: build OK (front + back), deploy healthy. Anotar el dominio `https://<app>.up.railway.app`.

- [ ] **Step 3: Verificar health y login**

Run: `curl -s https://<app>/health` → `{"ok":true,"db":true}`
Run: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <pw>" https://<app>/api/status` → `200`
Abrir `https://<app>/` en el navegador: debe pedir contraseña y mostrar la app vacía.

- [ ] **Step 4: Backfills**

```bash
PW=<pw>; APP=https://<app>
curl -s -X POST -H "Authorization: Bearer $PW" $APP/api/sync/meta-catalog
curl -s -X POST -H "Authorization: Bearer $PW" $APP/api/sync/tn-backfill
curl -s -X POST -H "Authorization: Bearer $PW" $APP/api/sync/meta-backfill
```

Expected: cada uno `{"started":"…"}` (202). Seguir el avance en la pestaña Estado (filas creciendo) o con `railway logs`. Si `tn-backfill` termina en error, leer el error en Estado: si es por órdenes puntuales, anotar los ids y revisarlos con la API; si es de red, volver a dispararlo (retoma desde el último mes completo).

- [ ] **Step 5: Verificar que el histórico está completo y coincide con Tienda Nube**

1. Total: comparar `counts.orders` de `/api/status` con el header `x-total-count` de
   `curl -sI -H "Authentication: bearer <token>" -H "User-Agent: altorancho-ventas (jdilernia99@gmail.com)" "https://api.tiendanube.com/v1/2547699/orders?per_page=1&status=any"`.
   Deben coincidir (± órdenes entrantes durante la carga). Si la API devuelve menos órdenes con `status=any` que sin el parámetro, corregir `listOrders` en `services/tiendanube.js` (con test) y re-correr el backfill.
2. Un mes cerrado: en el admin de Tienda Nube (Estadísticas o listado de ventas filtrado por pagadas) tomar cantidad y facturación de septiembre 2026 y comparar con `GET /api/summary?from=2026-09-01&to=2026-09-30`. Diferencias > 1% → investigar (estados de pago, cancelaciones, zona horaria) antes de seguir.
3. Atribución: en Ventas → período 30 días, revisar que el reparto por canal se parezca a la muestra (Google ~1/3, Meta ~15%, orgánica ~40%). Abrir 3 órdenes de Meta y confirmar que la landing coincide con el origen mostrado.
4. Gasto: comparar el gasto de Meta de ayer en el panel con el de Ads Manager (debe coincidir al peso, salvo correcciones de las últimas horas).

- [ ] **Step 6: Webhooks en tiempo real**

Run: `cd backend && TIENDANUBE_STORE_ID=2547699 TIENDANUBE_TOKEN=<token> BACKEND_URL=https://<app> node scripts/registerWebhooks.js`
Expected: 4 líneas `creado`. Esperar la próxima venta real (o pedir una de prueba) y verificar que aparece en Ventas en menos de 1 minuto. Si no aparece: `railway logs` buscando `[webhook]` / 401 (secret incorrecto).

- [ ] **Step 7: Crons**

Esperar a pasar el minuto :15 de la hora siguiente y verificar en Estado que `Tienda Nube (cada hora)`, `Meta — catálogo` y `Meta — gasto` tienen "Último OK" reciente y el indicador superior dice "Actualizado hace X min".

- [ ] **Step 8: PWA en el celular**

Abrir el dominio en el celular (Chrome Android / Safari iOS) → "Agregar a pantalla de inicio". Verificar: abre a pantalla completa con el ícono, login recordado, las 3 pestañas funcionan, la lista de órdenes hace scroll infinito.

- [ ] **Step 9: Cierre**

- Recordar al usuario rotar el token de Tienda Nube compartido en el chat y actualizar `TIENDANUBE_TOKEN` en Railway (`railway variables --set TIENDANUBE_TOKEN=<nuevo>`).
- Pasarle al usuario el link, la contraseña elegida y la recomendación sobre parámetros de URL (cargar la plantilla como estándar en anuncios nuevos desde Ads Manager; usar el botón del panel solo en anuncios donde no importe reiniciar el aprendizaje).
- Commit de cualquier ajuste hecho durante la verificación.
