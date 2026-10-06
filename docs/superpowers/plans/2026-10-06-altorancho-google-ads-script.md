# Altorancho Google Ads Script — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gasto diario por campaña de Google Ads (vía Google Ads Script) cruzado con las ventas reales de Google, visible en Ventas, Anuncios (selector Meta/Google), detalle de orden y Estado.

**Architecture:** El script de la cuenta hace POST a `/ingest/google` (token propio); el backend valida y guarda en `google_campaigns` / `google_spend_daily`; los reportes existentes suman un bloque y un ranking de Google. La futura API oficial escribirá las mismas tablas.

**Tech Stack:** igual que Proyectos A/B (Node/Express/Postgres/PGlite/React). Google Ads Scripts (JS V8, `AdsApp.search`, `UrlFetchApp`).

**Spec:** `docs/superpowers/specs/2026-10-06-altorancho-google-ads-script-design.md`

## Global Constraints
- Rama `altorancho-google` (sale de `altorancho-agente`). Mismas convenciones SQL (ids `::text`, montos `::float8`, conteos `::int`, fechas ART con `RANGE`).
- `spend = cost_micros / 1e6` redondeado a centavos. Ids de campaña de Google como `text`.
- `/ingest/google` va **fuera** de `/api` (no usa la contraseña del panel) y **antes** del `express.json()` global (payloads grandes).
- Commits con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Token ausente/incorrecto o payload malformado → 401/400 sin guardar nada. Test en Task 1.
2. Mismo período enviado dos veces (cada hora reenvía 3 días) → sin duplicados, último valor gana. Test en Task 1.
3. Ventas de Google con campaña sin gasto cargado (o gasto sin ventas) → ambas aparecen, sin dividir por cero. Test en Task 2.

---

### Task 1: Tablas, validación e ingreso de Google

**Files:**
- Create: `backend/src/db/migrations/003_google.sql`, `backend/src/engine/googleIngest.js`, `backend/src/repo/google.js`, `backend/src/routes/ingest.js`
- Modify: `backend/src/app.js` (opción `ingestRouter`), `backend/test/db.test.js`
- Test: `backend/test/googleIngest.test.js`

**Interfaces:**
- Produces: `parseGooglePayload(body) → { campaigns: [{ id, name, status, channel_type }], spend: [{ campaign_id, date, spend, impressions, clicks, conversions, conversions_value }] }` (lanza `.status = 400`); `createGoogleRepo(db) → { upsertCampaigns(rows), upsertSpend(rows) }`; `createIngestRouter({ token, googleRepo, syncRuns })` con `POST /google`; `createApp({ ..., ingestRouter })` lo monta en `/ingest`.

- [ ] **Step 1: Tests**

En `backend/test/db.test.js` la lista de tablas pasa a:

```js
    expect(rows.map((r) => r.t)).toEqual([
      'agent_config', 'agent_runs', 'google_campaigns', 'google_spend_daily', 'learnings', 'meta_ads', 'meta_spend_daily',
      'order_attribution', 'order_items', 'orders', 'recommendations', 'schema_migrations', 'sync_runs',
    ]);
```

`backend/test/googleIngest.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { createIngestRouter } from '../src/routes/ingest.js';
import { createGoogleRepo } from '../src/repo/google.js';
import { createSyncRunsRepo } from '../src/repo/syncRuns.js';
import { parseGooglePayload } from '../src/engine/googleIngest.js';

const payload = (o = {}) => ({
  campaigns: [{ id: '11472612872', name: 'Search Marca', status: 'ENABLED', channel_type: 'SEARCH' }],
  rows: [{ campaign_id: '11472612872', date: '2026-10-05', cost_micros: 1234567890, impressions: 1000, clicks: 50, conversions: 3.5, conversions_value: 210000 }],
  ...o,
});

describe('parseGooglePayload', () => {
  it('convierte micros a pesos con centavos', () => {
    expect(parseGooglePayload(payload()).spend[0]).toEqual({
      campaign_id: '11472612872', date: '2026-10-05', spend: 1234.57, impressions: 1000, clicks: 50, conversions: 3.5, conversions_value: 210000,
    });
  });
  it('rechaza ids, fechas o números inválidos', () => {
    expect(() => parseGooglePayload({})).toThrow(/payload/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], campaign_id: 'x' }] }))).toThrow(/campaign_id/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], date: '05/10/2026' }] }))).toThrow(/fecha/);
    expect(() => parseGooglePayload(payload({ rows: [{ ...payload().rows[0], cost_micros: -1 }] }))).toThrow(/cost_micros/);
  });
});

describe('POST /ingest/google', () => {
  let db; let app;
  beforeEach(async () => {
    db = await createTestDb();
    app = createApp({ ingestRouter: createIngestRouter({ token: 'secreto', googleRepo: createGoogleRepo(db), syncRuns: createSyncRunsRepo(db) }) });
  });
  afterEach(() => db.close());
  const post = (body, token = 'secreto') => request(app).post('/ingest/google').set('x-ingest-token', token).send(body);

  it('sin token o token incorrecto → 401', async () => {
    expect((await request(app).post('/ingest/google').send(payload())).status).toBe(401);
    expect((await post(payload(), 'otro')).status).toBe(401);
  });
  it('payload inválido → 400 y no guarda nada', async () => {
    expect((await post({ rows: 'x' })).status).toBe(400);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM google_spend_daily');
    expect(rows[0].n).toBe(0);
  });
  it('guarda campañas y gasto; reenviar el mismo día actualiza sin duplicar', async () => {
    expect((await post(payload())).body).toEqual({ ok: true, rows: 1 });
    const again = payload({ rows: [{ ...payload().rows[0], cost_micros: 2000000000 }] });
    await post(again);
    const { rows } = await db.query('SELECT campaign_id, date::text AS date, spend::float8 AS spend FROM google_spend_daily');
    expect(rows).toEqual([{ campaign_id: '11472612872', date: '2026-10-05', spend: 2000 }]);
    const { rows: c } = await db.query('SELECT name, channel_type FROM google_campaigns');
    expect(c).toEqual([{ name: 'Search Marca', channel_type: 'SEARCH' }]);
    const { rows: runs } = await db.query("SELECT status, rows FROM sync_runs WHERE source = 'google_ingest' ORDER BY id");
    expect(runs).toEqual([{ status: 'ok', rows: 1 }, { status: 'ok', rows: 1 }]);
  });
  it('acepta payloads grandes (más de 100 KB)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ ...payload().rows[0], date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, campaign_id: String(1000000 + i) }));
    expect((await post(payload({ rows }))).status).toBe(200);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/googleIngest.test.js test/db.test.js`
Expected: FAIL.

- [ ] **Step 3: `backend/src/db/migrations/003_google.sql`**

```sql
CREATE TABLE google_campaigns (
  id text PRIMARY KEY,
  name text,
  status text,
  channel_type text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE google_spend_daily (
  campaign_id text NOT NULL,
  date date NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  conversions numeric(12,2) NOT NULL DEFAULT 0,
  conversions_value numeric(14,2) NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX google_spend_date_idx ON google_spend_daily (date);
```

- [ ] **Step 4: `backend/src/engine/googleIngest.js`**

```js
import { isYmd } from './dates.js';

const MAX_ROWS = 20000;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (v) => /^\d+$/.test(String(v ?? ''));
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} inválido`);
  return n;
};
const text = (v, max = 300) => (v === null || v === undefined ? null : String(v).slice(0, max));

export function parseGooglePayload(body) {
  if (!body || !Array.isArray(body.rows) || !Array.isArray(body.campaigns)) throw bad('payload inválido: faltan rows/campaigns');
  if (body.rows.length > MAX_ROWS) throw bad(`demasiadas filas (máx. ${MAX_ROWS})`);
  const campaigns = body.campaigns.map((c) => {
    if (!isId(c?.id)) throw bad('campaign id inválido');
    return { id: String(c.id), name: text(c.name), status: text(c.status, 40), channel_type: text(c.channel_type, 40) };
  });
  const spend = body.rows.map((r) => {
    if (!isId(r?.campaign_id)) throw bad('campaign_id inválido');
    if (!isYmd(r.date)) throw bad(`fecha inválida: ${r.date}`);
    return {
      campaign_id: String(r.campaign_id),
      date: r.date,
      spend: Math.round(num(r.cost_micros, 'cost_micros') / 1e4) / 100,
      impressions: Math.round(num(r.impressions, 'impressions')),
      clicks: Math.round(num(r.clicks, 'clicks')),
      conversions: num(r.conversions, 'conversions'),
      conversions_value: num(r.conversions_value, 'conversions_value'),
    };
  });
  return { campaigns, spend };
}
```

- [ ] **Step 5: `backend/src/repo/google.js`**

```js
import { bulkUpsert } from './bulk.js';

export function createGoogleRepo(db) {
  return {
    upsertCampaigns: (rows) => bulkUpsert(db, {
      table: 'google_campaigns', columns: ['id', 'name', 'status', 'channel_type'], conflict: ['id'], rows, extraSet: ['updated_at = now()'],
    }),
    upsertSpend: (rows) => bulkUpsert(db, {
      table: 'google_spend_daily',
      columns: ['campaign_id', 'date', 'spend', 'impressions', 'clicks', 'conversions', 'conversions_value'],
      conflict: ['campaign_id', 'date'], rows, extraSet: ['synced_at = now()'],
    }),
  };
}
```

- [ ] **Step 6: `backend/src/routes/ingest.js`**

```js
import crypto from 'node:crypto';
import express from 'express';
import { parseGooglePayload } from '../engine/googleIngest.js';

// Ingreso de datos de plataformas externas (hoy: script de Google Ads). Auth por token propio.
export function createIngestRouter({ token, googleRepo, syncRuns, log = console }) {
  const router = express.Router();
  const expected = token ? Buffer.from(token) : null;
  const authorized = (req) => {
    const got = Buffer.from(req.get('x-ingest-token') || '');
    return Boolean(expected) && got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  router.post('/google', express.json({ limit: '10mb' }), async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'token inválido' });
    let parsed;
    try {
      parsed = parseGooglePayload(req.body);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    const runId = await syncRuns.start('google_ingest');
    try {
      await googleRepo.upsertCampaigns(parsed.campaigns);
      await googleRepo.upsertSpend(parsed.spend);
      await syncRuns.finish(runId, { status: 'ok', rows: parsed.spend.length });
      res.json({ ok: true, rows: parsed.spend.length });
    } catch (err) {
      log.error('[ingest google]', err);
      await syncRuns.finish(runId, { status: 'error', error: err.message });
      res.status(500).json({ error: 'no se pudo guardar' });
    }
  });
  return router;
}
```

- [ ] **Step 7: `backend/src/app.js`**

Agregar `ingestRouter` a los parámetros de `createApp` y, justo después de la línea de `webhookRouter`:

```js
  // ingreso de datos externos: antes de express.json() global (usa su propio límite de tamaño)
  if (ingestRouter) app.use('/ingest', ingestRouter);
```

y en el fallback SPA cambiar la regex a `/^\/(?!api\/|webhooks\/|ingest\/).*/`.

- [ ] **Step 8: Correr tests y commit**

Run: `cd backend && npx vitest run`
Expected: PASS.

```bash
git add backend
git commit -m "feat: ingreso de gasto de Google Ads (tablas, validación y endpoint con token)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Reportes y API con Google

**Files:**
- Modify: `backend/src/repo/reports.js`, `backend/src/routes/api.js`, `backend/src/index.js`, `backend/.env.example`
- Test: `backend/test/reportsGoogle.test.js`, `backend/test/api.test.js`

**Interfaces:**
- Produces: `summary()` agrega `google: { spend, orders, revenue, roas, costPerSale, reported: { conversions, value, roas }, coverage: { campaign, none } }`; `adsRanking({ from, to, platform: 'google', sort })` → `{ level: 'campaign', platform: 'google', rows, unidentified }` (en filas, `metaPurchases`/`metaValue`/`metaRoas` = lo que reporta Google); `listOrders`/`orderDetail` con nombre de campaña de Google; `GET /api/ads?platform=meta|google`.

- [ ] **Step 1: Tests `backend/test/reportsGoogle.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createGoogleRepo } from '../src/repo/google.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

let db; let reports;
const DAY = { from: '2026-10-05', to: '2026-10-05' };
beforeAll(async () => {
  db = await createTestDb();
  const google = createGoogleRepo(db);
  await google.upsertCampaigns([{ id: '111111', name: 'Search Marca', status: 'ENABLED', channel_type: 'SEARCH' }, { id: '222222', name: 'PMax', status: 'ENABLED', channel_type: 'PERFORMANCE_MAX' }]);
  await google.upsertSpend([
    { campaign_id: '111111', date: '2026-10-05', spend: 1000, impressions: 1, clicks: 1, conversions: 4, conversions_value: 9000 },
    { campaign_id: '222222', date: '2026-10-05', spend: 500, impressions: 1, clicks: 1, conversions: 1, conversions_value: 1000 },
  ]);
  const orders = createOrdersRepo(db);
  const seed = [
    [1, 'https://altorancho.com/?gad_source=1&gad_campaignid=111111&gclid=x', 3000],
    [2, 'https://altorancho.com/?gad_source=1&gad_campaignid=333333&gclid=y', 2000], // campaña sin gasto cargado
    [3, 'https://altorancho.com/?gclid=z', 700], // Google sin campaña
  ];
  for (const [id, landing, total] of seed) {
    const m = mapOrder({ id, number: id, status: 'open', payment_status: 'paid', created_at: '2026-10-05T15:00:00+0000', total: String(total), products: [], customer_visit: { landing_page: landing, utm_parameters: {} } });
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  reports = createReportsRepo(db);
});
afterAll(() => db.close());

describe('reportes con Google', () => {
  it('summary incluye el bloque de Google', async () => {
    const s = await reports.summary(DAY);
    expect(s.google).toEqual({
      spend: 1500, orders: 3, revenue: 5700, roas: 3.8, costPerSale: 500,
      reported: { conversions: 5, value: 10000, roas: 10000 / 1500 }, coverage: { campaign: 2, none: 1 },
    });
  });
  it('ranking de Google por campaña: gasto sin ventas y ventas sin gasto aparecen', async () => {
    const r = await reports.adsRanking({ ...DAY, platform: 'google' });
    expect(r).toMatchObject({ level: 'campaign', platform: 'google', unidentified: { orders: 1, revenue: 700 } });
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId['111111']).toMatchObject({ name: 'Search Marca', spend: 1000, sales: 1, revenue: 3000, roas: 3, metaPurchases: 4 });
    expect(byId['222222']).toMatchObject({ spend: 500, sales: 0, noSales: true });
    expect(byId['333333']).toMatchObject({ spend: 0, sales: 1, roas: null, costPerSale: null });
  });
  it('órdenes muestran el nombre de la campaña de Google', async () => {
    const { items } = await reports.listOrders({ ...DAY, channel: 'google' });
    expect(items.find((o) => o.id === '1').campaign_name).toBe('Search Marca');
    expect((await reports.orderDetail('1')).campaign_name).toBe('Search Marca');
  });
});
```

En `backend/test/api.test.js`, en el test `'ads valida level y sort; …'`, cambiar la expectativa de `adsRanking` a
`{ from: '2026-10-01', to: '2026-10-05', level: 'ad', parentId: '55', sort: 'cps', platform: 'meta' }` y agregar:

```js
    await get('/api/ads?from=2026-10-01&to=2026-10-05&platform=google');
    expect(deps.reports.adsRanking).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-05', level: 'campaign', parentId: null, sort: 'spend', platform: 'google' });
    expect((await get('/api/ads?from=2026-10-01&to=2026-10-05&platform=tiktok')).status).toBe(400);
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/reportsGoogle.test.js test/api.test.js`
Expected: FAIL.

- [ ] **Step 3: `backend/src/repo/reports.js`**

En `summary`, antes del `return`, agregar las consultas de Google y el bloque en el resultado:

```js
      const { rows: [gs] } = await db.query(
        `SELECT COALESCE(sum(spend), 0)::float8 AS spend, COALESCE(sum(conversions), 0)::float8 AS conversions,
                COALESCE(sum(conversions_value), 0)::float8 AS value
           FROM google_spend_daily WHERE date BETWEEN $1::date AND $2::date`,
        [from, to],
      );
      const { rows: gcov } = await db.query(
        `SELECT a.confidence, count(*)::int AS n FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'google' AND ${PAID} AND ${RANGE(1, 2)} GROUP BY 1`,
        [from, to],
      );
      const g = channels.find((c) => c.channel === 'google') || { orders: 0, revenue: 0 };
      const googleCoverage = { campaign: 0, none: 0 };
      for (const c of gcov) googleCoverage[c.confidence] = c.n;
      const google = {
        spend: gs.spend, orders: g.orders, revenue: g.revenue,
        roas: ratio(g.revenue, gs.spend),
        costPerSale: gs.spend > 0 && g.orders > 0 ? gs.spend / g.orders : null,
        reported: { conversions: gs.conversions, value: gs.value, roas: ratio(gs.value, gs.spend) },
        coverage: googleCoverage,
      };
```

y agregar `google,` en el objeto devuelto (después de `coverage,`).

Agregar dentro de `createReportsRepo`, antes de `async function adsRanking`:

```js
  async function googleRanking({ from, to, sort = 'spend' }) {
    const { rows } = await db.query(
      `WITH sp AS (
         SELECT campaign_id AS id, sum(spend) AS s, sum(impressions) AS imp, sum(clicks) AS clk,
                sum(conversions) AS mp, sum(conversions_value) AS mv
           FROM google_spend_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY 1),
       sa AS (
         SELECT a.campaign_id AS id, count(*) AS n, sum(o.total) AS rev
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'google' AND a.campaign_id IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)}
          GROUP BY 1)
       SELECT COALESCE(sp.id, sa.id) AS id, g.name, g.status, NULL AS thumbnail_url,
              COALESCE(sp.s, 0)::float8 AS spend, COALESCE(sp.imp, 0)::int AS impressions, COALESCE(sp.clk, 0)::int AS clicks,
              COALESCE(sp.mp, 0)::float8 AS meta_purchases, COALESCE(sp.mv, 0)::float8 AS meta_value,
              COALESCE(sa.n, 0)::int AS sales, COALESCE(sa.rev, 0)::float8 AS revenue
         FROM sp FULL OUTER JOIN sa ON sa.id = sp.id
         LEFT JOIN google_campaigns g ON g.id = COALESCE(sp.id, sa.id)`,
      [from, to],
    );
    const { rows: [u] } = await db.query(
      `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
         FROM orders o JOIN order_attribution a ON a.order_id = o.id
        WHERE a.channel = 'google' AND a.campaign_id IS NULL AND ${PAID} AND ${RANGE(1, 2)}`,
      [from, to],
    );
    return { level: 'campaign', platform: 'google', rows: rows.map(enrich).sort(SORTS[sort] || SORTS.spend), unidentified: u };
  }
```

Cambiar la firma de `adsRanking` a `async function adsRanking({ from, to, level = 'campaign', parentId = null, sort = 'spend', platform = 'meta' })` y como primera línea del cuerpo:

```js
    if (platform === 'google') return googleRanking({ from, to, sort });
```

En `listOrders` y `orderDetail`: agregar el join `LEFT JOIN google_campaigns gc ON gc.id = a.campaign_id AND a.channel = 'google'` (después del join de `meta_ads c`) y cambiar `COALESCE(c.name, a.campaign_name) AS campaign_name` por `COALESCE(c.name, gc.name, a.campaign_name) AS campaign_name`.

- [ ] **Step 4: `backend/src/routes/api.js`** — en `GET /ads`:

```js
    const platform = req.query.platform || 'meta';
    if (!['meta', 'google'].includes(platform)) throw badRequest('platform inválido');
    const level = platform === 'google' ? 'campaign' : req.query.level || 'campaign';
```

(reemplaza la línea `const level = …`), y pasar `platform` y `parentId: platform === 'google' ? null : req.query.parent || null` a `reports.adsRanking`. Agregar `'google_ingest'` al array `SOURCES`.

- [ ] **Step 5: Wiring `backend/src/index.js`** — imports `createGoogleRepo`, `createIngestRouter`; en `createApp`:

```js
  ingestRouter: createIngestRouter({ token: process.env.GOOGLE_INGEST_TOKEN, googleRepo: createGoogleRepo(db), syncRuns }),
```

En `backend/.env.example`: `GOOGLE_INGEST_TOKEN=` con el comentario `# Token que usa el script de Google Ads para enviar el gasto`.

- [ ] **Step 6: Correr tests y commit**

Run: `cd backend && node --check src/index.js && npx vitest run`
Expected: PASS.

```bash
git add backend
git commit -m "feat: reportes, ranking y API con gasto de Google Ads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — selector Meta/Google, tarjetas y nombres

**Files:**
- Modify: `frontend/src/pages/Anuncios.jsx`, `frontend/src/pages/Ventas.jsx`, `frontend/src/pages/OrderDetail.jsx`, `frontend/src/pages/Estado.jsx`
- Test: `frontend/test/anuncios.test.jsx`, `frontend/test/ventas.test.jsx`

- [ ] **Step 1: Tests**

En `frontend/test/anuncios.test.jsx` agregar:

```jsx
  it('selector Google: pide platform=google, muestra "Google dice" y no tiene drill-down ni parámetros', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /^google$/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=campaign&sort=spend&platform=google'));
    expect(await screen.findAllByText(/google dice/i)).not.toHaveLength(0);
    expect(screen.queryByText(/parámetros de url/i)).not.toBeInTheDocument();
  });
```

En `frontend/test/ventas.test.jsx`, agregar a `SUMMARY`: `google: { spend: 2000, orders: 2, revenue: 9000, roas: 4.5, costPerSale: 1000, reported: { conversions: 6, value: 30000, roas: 15 }, coverage: { campaign: 2, none: 0 } },` y el test:

```jsx
  it('tarjetas de Google con lo real vs lo que dice Google', async () => {
    setup();
    expect(await screen.findByText('Gasto Google')).toBeInTheDocument();
    expect(screen.getByText('4,5x')).toBeInTheDocument();
    expect(screen.getByText(/google dice 15,0x/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Correr para verificar que fallan**

Run: `cd frontend && npx vitest run test/anuncios.test.jsx test/ventas.test.jsx`
Expected: FAIL.

- [ ] **Step 3: `Anuncios.jsx`**

Agregar estado `const [platform, setPlatform] = useState('meta');`, y la query:

```jsx
  const q = platform === 'google'
    ? `${periodQuery(period)}&level=campaign&sort=${sort}&platform=google`
    : `${periodQuery(period)}&level=${cur.level}&sort=${sort}${cur.parentId ? `&parent=${cur.parentId}` : ''}`;
  const reportedLabel = platform === 'google' ? 'Google dice' : 'Meta dice';
```

Antes de las migas, el selector:

```jsx
      <div className="chips" style={{ marginBottom: 10 }}>
        {[['meta', 'Meta'], ['google', 'Google']].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={platform === id} className={platform === id ? 'chip active' : 'chip'}
            onClick={() => { setPlatform(id); setStack([{ level: 'campaign', parentId: null, name: 'Campañas' }]); }}>{label}</button>
        ))}
      </div>
```

Las migas solo se muestran si `platform === 'meta'`; en `open(r)` agregar al principio `if (platform === 'google') return;`; reemplazar el texto `Meta dice` de la fila por `{reportedLabel}`; el texto de ventas sin campaña pasa a `ventas de {platform === 'google' ? 'Google' : 'Meta'}`; `<UrlParams api={api} />` solo si `platform === 'meta'`.

- [ ] **Step 4: `Ventas.jsx`** — en `Summary`, después de la tarjeta "Ventas de Meta":

```jsx
        {s.google && (
          <>
            <div className="card">
              <div className="card-label">Gasto Google</div>
              <div className="card-value">{fmtMoney(s.google.spend)}</div>
              <div className="card-sub">{fmtMoney(s.google.costPerSale)} por venta</div>
            </div>
            <div className="card">
              <div className="card-label">ROAS real Google</div>
              <div className="card-value">{fmtRoas(s.google.roas)}</div>
              <div className="card-sub">Google dice {fmtRoas(s.google.reported.roas)}</div>
            </div>
          </>
        )}
```

- [ ] **Step 5: `OrderDetail.jsx`** — la línea de Google pasa a
`<p style={{ marginTop: 8 }}>Campaña de Google: {o.campaign_name || o.campaign_id || 'sin identificar'}</p>`.
**`Estado.jsx`** — agregar `['google_ingest', 'Google — gasto'],` a `SOURCES`.

- [ ] **Step 6: Tests, build y commit**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS.

```bash
git add frontend/src frontend/test
git commit -m "feat: selector Meta/Google en Anuncios, tarjetas de Google en Ventas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Script de Google Ads, deploy y verificación

**Files:**
- Create: `google-ads-script/altorancho-gasto.js`

- [ ] **Step 1: `google-ads-script/altorancho-gasto.js`** (en el repo con `TOKEN = 'PEGAR_TOKEN'`)

```js
// Altorancho — envía el gasto diario por campaña de Google Ads al panel de ventas.
// Google Ads → Herramientas → Acciones masivas → Scripts → (+) → pegar → Autorizar → programar "Cada hora".
// Para cargar el histórico: poner HISTORICO = true, Ejecutar una vez y volver a false.
var ENDPOINT = 'https://web-production-71431.up.railway.app/ingest/google';
var TOKEN = 'PEGAR_TOKEN';
var HISTORICO = false;
var MESES_HISTORICO = 12;

function main() {
  var tz = AdsApp.currentAccount().getTimeZone();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var hoy = new Date();
  if (!HISTORICO) {
    var desde = new Date(hoy.getTime() - 3 * 86400000);
    enviar(fmt(desde), fmt(hoy));
    return;
  }
  for (var m = MESES_HISTORICO; m >= 0; m--) {
    var inicio = new Date(hoy.getFullYear(), hoy.getMonth() - m, 1);
    var fin = new Date(hoy.getFullYear(), hoy.getMonth() - m + 1, 0);
    if (fin > hoy) fin = hoy;
    enviar(fmt(inicio), fmt(fin));
  }
}

function enviar(desde, hasta) {
  var query = 'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, '
    + 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value '
    + 'FROM campaign WHERE segments.date BETWEEN \'' + desde + '\' AND \'' + hasta + '\'';
  var it = AdsApp.search(query);
  var campanias = {};
  var filas = [];
  while (it.hasNext()) {
    var r = it.next();
    var id = String(r.campaign.id);
    campanias[id] = { id: id, name: r.campaign.name, status: r.campaign.status, channel_type: r.campaign.advertisingChannelType };
    filas.push({
      campaign_id: id, date: r.segments.date, cost_micros: Number(r.metrics.costMicros || 0),
      impressions: Number(r.metrics.impressions || 0), clicks: Number(r.metrics.clicks || 0),
      conversions: Number(r.metrics.conversions || 0), conversions_value: Number(r.metrics.conversionsValue || 0),
    });
  }
  var resp = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post', contentType: 'application/json', headers: { 'X-Ingest-Token': TOKEN }, muteHttpExceptions: true,
    payload: JSON.stringify({ campaigns: Object.keys(campanias).map(function (k) { return campanias[k]; }), rows: filas }),
  });
  Logger.log(desde + ' a ' + hasta + ': ' + filas.length + ' filas → HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  if (resp.getResponseCode() >= 300) throw new Error('Falló el envío al panel');
}
```

- [ ] **Step 2: Token y deploy**

Generar un token aleatorio (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`), cargarlo en Railway como `GOOGLE_INGEST_TOKEN` sin imprimirlo en logs compartidos, `railway up`, verificar `/health`. Probar el endpoint con `curl` y un payload mínimo → `{ ok: true, rows: 1 }`; borrar esa fila de prueba no hace falta si se usa una campaña real (la sobrescribe el script).

- [ ] **Step 3: Instalación con el usuario**

Entregar al usuario la versión del script con el token (archivo local fuera del repo). El usuario lo pega, autoriza, corre con `HISTORICO = true` una vez, vuelve a `false` y programa cada hora.

- [ ] **Step 4: Verificación**

Comparar el gasto de Google de septiembre en `GET /api/summary?from=2026-09-01&to=2026-09-30` contra Google Ads (Campañas, mismo período): deben coincidir. Revisar el ranking de Google en el panel.

- [ ] **Step 5: Frontend y cierre**

Rearmar el zip del frontend para Hostinger; commit del script; push.
