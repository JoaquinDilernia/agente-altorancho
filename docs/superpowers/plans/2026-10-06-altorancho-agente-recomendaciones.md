# Altorancho Agente de Recomendaciones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agente diario que detecta candidatos en Meta Ads con ventas reales de Tienda Nube, le pide a Claude recomendaciones (pausar, reactivar, presupuesto, reasignar, ideas) y las ejecuta en Meta solo al aprobarlas desde el panel; mide resultados y aprende.

**Architecture:** Sobre el Proyecto A (Postgres + sync TN/Meta + reportes). Un dataset por objeto (7d / 7d previos / 30d) alimenta una detección de candidatos pura; el runner llama a Claude (Messages API, loop manual de tool use) que solo crea registros; un executor aplica las aprobaciones por Graph API con pre-chequeo, reversión y deshacer; un medidor calcula veredictos a 3 y 7 días. Nueva pestaña "Agente" en la PWA.

**Tech Stack:** Node ≥20 ESM, Express, `pg`, `@anthropic-ai/sdk`, Vitest + PGlite, React/Vite.

**Spec:** `docs/superpowers/specs/2026-10-06-altorancho-agente-recomendaciones-design.md` (depende de `docs/superpowers/specs/2026-10-06-altorancho-ventas-atribucion-design.md`)

## Global Constraints

- Rama `altorancho-agente` (sale de `altorancho-ventas`). Mismas convenciones del Proyecto A: interfaz `db = { query, exec, tx, close }`; SQL de lectura con ids `::text`, montos `::float8`, conteos `::int`, fechas `::text`; días ART con `artDate`/`addDays`/`RANGE` (UTC−3 fijo).
- Modelo por defecto `claude-opus-5-5`, effort `medium` (`output_config: { effort }`). **No** enviar `thinking` (en Opus 5.5 está siempre activo; `disabled` da 400). **No** forzar `tool_choice` (400 en Opus 5.5): `auto` + `strict: true` + instrucción en el prompt. Llamada por `client.beta.messages.create` con `betas: ['server-side-fallback-2026-07-01']` y `fallbacks: 'default'`. Chequear `stop_reason === 'refusal'` antes de leer `content`. Devolver siempre `response.content` completo al historial (append-only; incluye bloques de thinking).
- Precios por millón de tokens (config): `claude-opus-5-5` in 4 / out 20; `claude-sonnet-5-5` in 2 / out 10.
- `daily_budget` de Meta viene en centavos (ARS, offset 100): en DB y UI siempre **pesos** (`/100`); al escribir en Meta `Math.round(pesos * 100)`.
- Objetivos de ventas: `OUTCOME_SALES`, `CONVERSIONS`, `PRODUCT_CATALOG_SALES`.
- Estados de recomendación: `pending | approved | executed | failed | rejected | expired | stale | undone | seen`.
- Copy de UI en español rioplatense; estilo Poppins/blanco/`#353434` del Proyecto A.
- El agente **nunca** ejecuta: solo crea registros. Ejecución solo por `approve` y solo si `executionEnabled` (default `false`).
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Doble aprobación / doble clic** en "Aprobar" o aprobar algo ya vencido → se ejecuta una sola vez (transición atómica `pending→approved`). Test en Task 8.
2. **Cambio manual en Ads Manager entre recomendación y aprobación** → `stale`, no se toca Meta. Test en Task 8.
3. **Reasignación donde falla la segunda escritura** → se revierte la primera y queda `failed`. Test en Task 8.
4. **Claude devuelve tool calls inválidos** (candidato inexistente, presupuesto fuera de tope, acción incoherente con la señal, lección con < 3 evidencias) → error en el `tool_result`, nada se guarda, el loop sigue. Test en Task 6.
5. **Costo fuera de control** (botón apretado muchas veces, tope mensual alcanzado, loop que no termina) → cupo manual diario, tope mensual y `maxTurns` cortan. Test en Task 7.

---

## File Structure

**Backend (`backend/`)**
- `src/db/migrations/002_agent.sql` — columnas nuevas en `meta_ads` y tablas del agente.
- `src/services/meta.js` — campos extra del catálogo + escrituras (`getObject`, `setStatus`, `setDailyBudget`).
- `src/sync/meta.js` — guarda objetivo, presupuesto, aprendizaje, fechas.
- `src/repo/agentConfig.js` — config con defaults y validación.
- `src/repo/agentMetrics.js` — métricas por objeto y ventana; cobertura por campaña; línea de base.
- `src/repo/recommendations.js` — recomendaciones, corridas del agente, lecciones.
- `src/agent/dataset.js` — arma objetos + métricas para el día.
- `src/agent/candidates.js` — detección pura de candidatos.
- `src/agent/tools.js` — definiciones de tools y handler con validación.
- `src/agent/prompt.js` — system prompt y mensaje de entrada.
- `src/agent/runner.js` — corrida (cupos, topes, loop con Claude, costo).
- `src/agent/executor.js` — aprobar / rechazar / deshacer / vencer.
- `src/agent/outcomes.js` — medición a 3 y 7 días.
- `src/routes/agent.js` — API del agente.
- `src/index.js` — wiring + crons.

**Frontend (`frontend/`)**
- `src/pages/Agente.jsx` — pestañas internas Pendientes / Historial / Aprendizaje / Configuración.
- `src/components/RecommendationCard.jsx` — tarjeta de recomendación.
- `src/components/Layout.jsx` — 4ª pestaña con globito.
- `src/pages/Anuncios.jsx` — punto en filas con recomendación pendiente.
- `src/App.jsx` — ruta `/agente`.

---

### Task 1: Esquema del agente y datos extra del catálogo de Meta

**Files:**
- Create: `backend/src/db/migrations/002_agent.sql`
- Modify: `backend/src/services/meta.js` (campos de `listCampaigns`/`listAdsets`/`listAds`)
- Modify: `backend/src/repo/meta.js` (`AD_COLS`)
- Modify: `backend/src/sync/meta.js` (`syncCatalog`)
- Test: `backend/test/db.test.js`, `backend/test/meta.test.js`, `backend/test/metaSync.test.js`

**Interfaces:**
- Consumes: Proyecto A (`migrate`, `getCatalog`, `bulkUpsert`, `syncCatalog`).
- Produces: tablas `agent_runs`, `recommendations`, `learnings`, `agent_config`; columnas `meta_ads.objective`, `daily_budget` (pesos), `is_cbo`, `created_time`, `learning_status`, `status_updated_at`. Fila de ad del catálogo pasa a tener esas 6 claves (null cuando no aplica).

- [ ] **Step 1: Tests que fallan**

En `backend/test/db.test.js`, reemplazar la lista esperada del primer test por:

```js
    expect(rows.map((r) => r.t)).toEqual([
      'agent_config', 'agent_runs', 'learnings', 'meta_ads', 'meta_spend_daily', 'order_attribution', 'order_items',
      'orders', 'recommendations', 'schema_migrations', 'sync_runs',
    ]);
```

En `backend/test/meta.test.js`, reemplazar el test `'listAds pide el creativo con thumbnail y url_tags'` por:

```js
  it('el catálogo pide objetivo, presupuesto, fechas y aprendizaje', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: [] }));
    const meta = make(fetchFn);
    await meta.listCampaigns();
    await meta.listAdsets();
    await meta.listAds();
    const fields = fetchFn.mock.calls.map((c) => new URL(c[0]).searchParams.get('fields'));
    expect(fields).toContain('id,name,effective_status,objective,daily_budget,created_time,updated_time');
    expect(fields).toContain('id,name,effective_status,campaign_id,daily_budget,created_time,updated_time,learning_stage_info');
    expect(fields).toContain('id,name,effective_status,adset_id,campaign_id,created_time,updated_time,creative{id,thumbnail_url,url_tags}');
  });
```

En `backend/test/metaSync.test.js`, dentro de `fakeMeta()` reemplazar `listCampaigns` y `listAdsets` por:

```js
  listCampaigns: vi.fn().mockResolvedValue([{ id: 'C1', name: 'altorancho_dpa', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '6000000', created_time: '2026-09-01T10:00:00-0300', updated_time: '2026-09-02T10:00:00-0300' }]),
  listAdsets: vi.fn().mockResolvedValue([{ id: 'S1', name: 'Conjunto', effective_status: 'ACTIVE', campaign_id: 'C1', created_time: '2026-09-01T10:05:00-0300', updated_time: '2026-09-03T10:00:00-0300', learning_stage_info: { status: 'LEARNING' } }]),
```

y agregar el test:

```js
  it('syncCatalog guarda objetivo, presupuesto en pesos, CBO y aprendizaje', async () => {
    await createMetaSync({ meta: fakeMeta(), metaRepo, ordersRepo }).syncCatalog();
    const { rows } = await db.query(
      `SELECT id, objective, daily_budget::float8 AS daily_budget, is_cbo, learning_status, created_time IS NOT NULL AS has_created
         FROM meta_ads WHERE id IN ('C1','S1') ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'C1', objective: 'OUTCOME_SALES', daily_budget: 60000, is_cbo: true, learning_status: null, has_created: true },
      { id: 'S1', objective: null, daily_budget: null, is_cbo: false, learning_status: 'LEARNING', has_created: true },
    ]);
  });
```

- [ ] **Step 2: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/db.test.js test/meta.test.js test/metaSync.test.js`
Expected: FAIL (tablas y columnas inexistentes, campos viejos).

- [ ] **Step 3: `backend/src/db/migrations/002_agent.sql`**

```sql
ALTER TABLE meta_ads
  ADD COLUMN objective text,
  ADD COLUMN daily_budget numeric(14,2),
  ADD COLUMN is_cbo boolean NOT NULL DEFAULT false,
  ADD COLUMN created_time timestamptz,
  ADD COLUMN learning_status text,
  ADD COLUMN status_updated_at timestamptz;

CREATE TABLE agent_runs (
  id serial PRIMARY KEY,
  trigger text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  baseline jsonb,
  candidates jsonb,
  skipped jsonb,
  model text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX agent_runs_started_idx ON agent_runs (started_at DESC);

CREATE TABLE recommendations (
  id serial PRIMARY KEY,
  run_id int REFERENCES agent_runs(id),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  level text,
  object_id text,
  target_id text,
  title text NOT NULL,
  reasoning text NOT NULL,
  expected_impact text,
  confidence text NOT NULL,
  dudoso_atribucion boolean NOT NULL DEFAULT false,
  signal text,
  current_value jsonb,
  proposed_value jsonb,
  snapshot jsonb,
  decided_at timestamptz,
  reject_reason text,
  executed_at timestamptz,
  execution_result jsonb,
  previous_value jsonb,
  undo_until timestamptz,
  undone_at timestamptz,
  outcome jsonb,
  verdict text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_status_idx ON recommendations (status, created_at DESC);
CREATE INDEX recommendations_object_idx ON recommendations (object_id);

CREATE TABLE learnings (
  id serial PRIMARY KEY,
  text text NOT NULL,
  evidence_ids int[] NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Campos del catálogo en `backend/src/services/meta.js`**

Reemplazar las tres líneas `listCampaigns` / `listAdsets` / `listAds` del objeto devuelto por:

```js
    listCampaigns: () => getCatalog(`${accountId}/campaigns`, 'id,name,effective_status,objective,daily_budget,created_time,updated_time'),
    listAdsets: () => getCatalog(`${accountId}/adsets`, 'id,name,effective_status,campaign_id,daily_budget,created_time,updated_time,learning_stage_info'),
    listAds: () => getCatalog(`${accountId}/ads`, 'id,name,effective_status,adset_id,campaign_id,created_time,updated_time,creative{id,thumbnail_url,url_tags}', '100'),
```

- [ ] **Step 5: `AD_COLS` en `backend/src/repo/meta.js`**

```js
const AD_COLS = ['id', 'level', 'name', 'status', 'parent_id', 'campaign_id', 'thumbnail_url', 'url_tags', 'has_attribution_params',
  'objective', 'daily_budget', 'is_cbo', 'created_time', 'learning_status', 'status_updated_at'];
```

- [ ] **Step 6: `syncCatalog` en `backend/src/sync/meta.js`**

Reemplazar `const base = …` y el armado de `rows` por:

```js
const base = {
  thumbnail_url: null, url_tags: null, has_attribution_params: false,
  objective: null, daily_budget: null, is_cbo: false, created_time: null, learning_status: null, status_updated_at: null,
};
// Meta devuelve daily_budget en centavos (ARS, offset 100)
const pesos = (v) => (v === undefined || v === null || v === '' ? null : Number(v) / 100);
```

```js
      const rows = [
        ...campaigns.map((c) => ({
          ...base, id: c.id, level: 'campaign', name: c.name, status: c.effective_status, parent_id: null, campaign_id: c.id,
          objective: c.objective || null, daily_budget: pesos(c.daily_budget), is_cbo: Boolean(c.daily_budget),
          created_time: c.created_time || null, status_updated_at: c.updated_time || null,
        })),
        ...adsets.map((s) => ({
          ...base, id: s.id, level: 'adset', name: s.name, status: s.effective_status, parent_id: s.campaign_id, campaign_id: s.campaign_id,
          daily_budget: pesos(s.daily_budget), created_time: s.created_time || null,
          learning_status: s.learning_stage_info?.status || null, status_updated_at: s.updated_time || null,
        })),
        ...ads.map((a) => ({
          ...base, id: a.id, level: 'ad', name: a.name, status: a.effective_status, parent_id: a.adset_id, campaign_id: a.campaign_id,
          thumbnail_url: a.creative?.thumbnail_url || null,
          url_tags: a.creative?.url_tags || null,
          has_attribution_params: hasAttributionParams(a.creative?.url_tags),
          created_time: a.created_time || null, status_updated_at: a.updated_time || null,
        })),
      ];
```

(Las fechas de Meta vienen como `2026-09-01T10:00:00-0300`; Postgres acepta el offset `-0300`.)

- [ ] **Step 7: Correr tests**

Run: `cd backend && npx vitest run`
Expected: PASS (toda la suite).

- [ ] **Step 8: Commit**

```bash
git add backend/src/db/migrations/002_agent.sql backend/src/services/meta.js backend/src/repo/meta.js backend/src/sync/meta.js backend/test
git commit -m "feat: esquema del agente y catálogo de Meta con objetivo, presupuesto y aprendizaje

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Configuración del agente

**Files:**
- Create: `backend/src/repo/agentConfig.js`
- Test: `backend/test/agentConfig.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_CONFIG` (objeto, ver código).
  - `createAgentConfigRepo(db) → { get() → config, update(patch) → config }`. `get` mezcla lo guardado sobre los defaults (2 niveles). `update` valida y lanza `Error` con `.status = 400` si algo es inválido.

- [ ] **Step 1: Tests `backend/test/agentConfig.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo, DEFAULT_CONFIG } from '../src/repo/agentConfig.js';

let db; let repo;
beforeEach(async () => { db = await createTestDb(); repo = createAgentConfigRepo(db); });
afterEach(() => db.close());

describe('agentConfig', () => {
  it('sin nada guardado devuelve los defaults (ejecución apagada, Opus 5.5)', async () => {
    const c = await repo.get();
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.executionEnabled).toBe(false);
    expect(c.model).toBe('claude-opus-5-5');
  });
  it('update mezcla parcial en 2 niveles y persiste', async () => {
    await repo.update({ executionEnabled: true, thresholds: { winnerMinSales: 5 } });
    const c = await repo.get();
    expect(c.executionEnabled).toBe(true);
    expect(c.thresholds.winnerMinSales).toBe(5);
    expect(c.thresholds.noSalesSpendMultiple).toBe(DEFAULT_CONFIG.thresholds.noSalesSpendMultiple);
  });
  it('rechaza valores inválidos con status 400', async () => {
    await expect(repo.update({ budget: { maxChangePct: 80 } })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ model: 'gpt-5' })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ monthlyBudgetUsd: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ manualRunsPerDay: 1.5 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ inventado: true })).rejects.toMatchObject({ status: 400 });
    expect(await repo.get()).toEqual(DEFAULT_CONFIG);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/agentConfig.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/repo/agentConfig.js`**

```js
export const DEFAULT_CONFIG = {
  agentEnabled: true,
  executionEnabled: false,
  autoByType: { pause: false, reactivate: false, budget: false, shift: false },
  model: 'claude-opus-5-5',
  effort: 'medium',
  prices: { 'claude-opus-5-5': { input: 4, output: 20 }, 'claude-sonnet-5-5': { input: 2, output: 10 } },
  monthlyBudgetUsd: 20,
  manualRunsPerDay: 2,
  maxTurns: 8,
  maxOutputTokens: 16000,
  thresholds: {
    noSalesSpendMultiple: 2,
    noSalesForceMultiple: 4,
    expensiveRoasRatio: 0.5,
    expensiveSpendMultiple: 3,
    winnerRoasRatio: 1.5,
    winnerMinSales: 3,
    winnerTrendRatio: 0.8,
    fatigueCtrDrop: 0.3,
    fatigueMinImpressions: 5000,
    reactivateMinSales: 3,
    minAgeDays: 3,
    adLevelCoverage: 0.6,
    doubtfulMetaPurchases: 2,
    worsenRatio: 0.3,
    maxCandidates: 40,
  },
  budget: { maxChangePct: 20, minDaily: 1000, maxDaily: 5000000 },
  expireHours: 48,
  undoHours: 24,
  rejectCooldownDays: 7,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}

function validate(patch, merged) {
  const unknown = (obj, ref, path) => {
    for (const k of Object.keys(obj || {})) {
      if (!(k in ref)) throw badRequest(`campo desconocido: ${path}${k}`);
      if (isObj(obj[k]) && isObj(ref[k]) && k !== 'prices') unknown(obj[k], ref[k], `${path}${k}.`);
    }
  };
  unknown(patch, DEFAULT_CONFIG, '');
  const positive = (v, name) => { if (typeof v !== 'number' || !(v >= 0)) throw badRequest(`${name} tiene que ser un número ≥ 0`); };
  const intPositive = (v, name) => { if (!Number.isInteger(v) || v < 0) throw badRequest(`${name} tiene que ser un entero ≥ 0`); };
  for (const k of ['agentEnabled', 'executionEnabled']) if (typeof merged[k] !== 'boolean') throw badRequest(`${k} tiene que ser true/false`);
  for (const [k, v] of Object.entries(merged.autoByType)) if (typeof v !== 'boolean') throw badRequest(`autoByType.${k} inválido`);
  if (!merged.prices[merged.model]) throw badRequest(`modelo sin precio configurado: ${merged.model}`);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.effort)) throw badRequest('effort inválido');
  positive(merged.monthlyBudgetUsd, 'monthlyBudgetUsd');
  intPositive(merged.manualRunsPerDay, 'manualRunsPerDay');
  intPositive(merged.maxTurns, 'maxTurns');
  intPositive(merged.maxOutputTokens, 'maxOutputTokens');
  for (const [k, v] of Object.entries(merged.thresholds)) positive(v, `thresholds.${k}`);
  positive(merged.budget.minDaily, 'budget.minDaily');
  positive(merged.budget.maxDaily, 'budget.maxDaily');
  if (!(merged.budget.maxChangePct > 0 && merged.budget.maxChangePct <= 50)) throw badRequest('budget.maxChangePct tiene que estar entre 1 y 50');
  for (const k of ['expireHours', 'undoHours', 'rejectCooldownDays']) intPositive(merged[k], k);
}

export function createAgentConfigRepo(db) {
  async function get() {
    const { rows } = await db.query('SELECT value FROM agent_config WHERE id = 1');
    return merge(DEFAULT_CONFIG, rows[0]?.value || {});
  }
  return {
    get,
    async update(patch) {
      if (!isObj(patch)) throw badRequest('config inválida');
      const merged = merge(await get(), patch);
      validate(patch, merged);
      await db.query(
        `INSERT INTO agent_config (id, value, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(merged)],
      );
      return merged;
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/agentConfig.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/agentConfig.js backend/test/agentConfig.test.js
git commit -m "feat: configuración del agente con defaults y validación

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Métricas por objeto y dataset diario

**Files:**
- Modify: `backend/src/repo/reports.js` (exportar `PAID` y `RANGE`)
- Create: `backend/src/repo/agentMetrics.js`, `backend/src/agent/dataset.js`
- Test: `backend/test/agentMetrics.test.js`

**Interfaces:**
- Consumes: `createReportsRepo(db).adsRanking({ from, to, level })` (Proyecto A), `addDays` (`engine/dates.js`).
- Produces:
  - `SALES_OBJECTIVES: string[]`.
  - `createAgentMetrics({ db, reports }) → {`
    - `byLevel({ level, from, to }) → Map<id, rawMetrics>` con `rawMetrics = { spend, impressions, clicks, sales, revenue, metaPurchases, metaValue }`
    - `coverageByCampaign({ from, to }) → Map<campaignId, number 0..1>` (ventas Meta con confianza `ad` / total)
    - `objectWindow({ level, id, from, to }) → { spend, sales, revenue }`
    - `salesWindow({ from, to }) → { spend, sales, revenue }` (solo campañas con objetivo de ventas)
    - `baseline({ from, to }) → { spend, sales, revenue, roas, cpa }` `}`
  - `withRatios(raw) → raw + { roas, cpa, ctr }` (null cuando el divisor es 0).
  - `buildDataset({ db, metrics, today }) → { today, windows: { w7, wp, w30 }, baseline, objects: DatasetObject[] }` con
    `DatasetObject = { id, level, name, status, campaignId, parentId, objective, isSales, ageDays, learning, statusUpdatedAt, budgetOwner: { id, level, daily } | null, coverage: number | null, m7, mPrev, m30 }` (cada `m*` pasa por `withRatios`).
  - Ventanas: `w7 = [hoy−7, hoy−1]`, `wp = [hoy−14, hoy−8]`, `w30 = [hoy−30, hoy−1]` (días ART, hoy excluido).
  - `budgetOwner`: campaña con `is_cbo` → la campaña; conjunto de campaña sin CBO con `daily_budget` → el conjunto; anuncios → `null`.

- [ ] **Step 1: Exportar helpers en `backend/src/repo/reports.js`**

Cambiar las declaraciones `const PAID = …` y `const RANGE = …` por `export const PAID = …` y `export const RANGE = …` (sin otro cambio).

- [ ] **Step 2: Tests `backend/test/agentMetrics.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { createAgentMetrics, withRatios } from '../src/repo/agentMetrics.js';
import { buildDataset } from '../src/agent/dataset.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const row = (id, level, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null,
  has_attribution_params: false, objective: null, daily_budget: null, is_cbo: false, created_time: '2026-09-01T00:00:00Z',
  learning_status: null, status_updated_at: null, ...extra,
});
const spend = (ad, adset, camp, date, s, extra = {}) => ({
  ad_id: ad, adset_id: adset, campaign_id: camp, date, spend: s, impressions: 1000, clicks: 20, meta_purchases: 0, meta_purchase_value: 0, ...extra,
});
const order = (id, at, total, landing) => ({
  id, number: id, status: 'open', payment_status: 'paid', created_at: at, total: String(total), products: [],
  customer_visit: { landing_page: landing, utm_parameters: {} },
});
const metaAd = (ad) => `https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=${ad}`;

let db; let metrics;
beforeAll(async () => {
  db = await createTestDb();
  const meta = createMetaRepo(db);
  await meta.upsertAds([
    row('2000001', 'campaign', { campaign_id: '2000001', objective: 'OUTCOME_SALES', is_cbo: true, daily_budget: 50000 }),
    row('2000009', 'campaign', { campaign_id: '2000009', objective: 'OUTCOME_ENGAGEMENT', is_cbo: true, daily_budget: 10000 }),
    row('2000002', 'campaign', { campaign_id: '2000002', objective: 'OUTCOME_SALES', is_cbo: false }),
    row('3000001', 'adset', { parent_id: '2000001', campaign_id: '2000001' }),
    row('3000002', 'adset', { parent_id: '2000002', campaign_id: '2000002', daily_budget: 20000, learning_status: 'LEARNING' }),
    row('1000001', 'ad', { parent_id: '3000001', campaign_id: '2000001' }),
    row('1000002', 'ad', { parent_id: '3000002', campaign_id: '2000002', created_time: '2026-10-04T12:00:00Z' }),
    row('1000009', 'ad', { parent_id: '3000009', campaign_id: '2000009' }),
  ]);
  await meta.upsertSpend([
    spend('1000001', '3000001', '2000001', '2026-10-01', 1000, { meta_purchases: 3, meta_purchase_value: 9000 }),
    spend('1000001', '3000001', '2000001', '2026-09-25', 500),
    spend('1000002', '3000002', '2000002', '2026-10-02', 300),
    spend('1000009', '3000009', '2000009', '2026-10-02', 700),
  ]);
  const orders = createOrdersRepo(db);
  for (const o of [
    order(1, '2026-10-01T15:00:00+0000', 4000, metaAd('1000001')),
    order(2, '2026-10-02T15:00:00+0000', 2000, 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=campaign 2000001'),
  ]) {
    const m = mapOrder(o);
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  metrics = createAgentMetrics({ db, reports: createReportsRepo(db) });
});
afterAll(() => db.close());

const W7 = { from: '2026-09-29', to: '2026-10-05' };

describe('agentMetrics', () => {
  it('byLevel devuelve métricas crudas por objeto', async () => {
    const m = await metrics.byLevel({ level: 'campaign', ...W7 });
    expect(m.get('2000001')).toMatchObject({ spend: 1000, sales: 2, revenue: 6000, metaPurchases: 3, impressions: 1000, clicks: 20 });
    expect(m.get('2000009')).toMatchObject({ spend: 700, sales: 0 });
  });
  it('coverageByCampaign: proporción de ventas atribuidas al anuncio', async () => {
    expect((await metrics.coverageByCampaign(W7)).get('2000001')).toBe(0.5);
  });
  it('objectWindow y salesWindow excluyen campañas que no son de ventas', async () => {
    expect(await metrics.objectWindow({ level: 'ad', id: '1000001', ...W7 })).toEqual({ spend: 1000, sales: 1, revenue: 4000 });
    expect(await metrics.salesWindow(W7)).toEqual({ spend: 1300, sales: 2, revenue: 6000 });
  });
  it('baseline calcula ROAS y costo por venta', async () => {
    expect(await metrics.baseline(W7)).toEqual({ spend: 1300, sales: 2, revenue: 6000, roas: 6000 / 1300, cpa: 650 });
  });
  it('withRatios no divide por cero', () => {
    expect(withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 0, clicks: 0, metaPurchases: 0, metaValue: 0 }))
      .toMatchObject({ roas: null, cpa: null, ctr: null });
  });
});

describe('buildDataset', () => {
  it('arma objetos con ventanas, dueño del presupuesto, edad, aprendizaje y cobertura', async () => {
    const ds = await buildDataset({ db, metrics, today: '2026-10-06' });
    expect(ds.windows).toEqual({
      w7: { from: '2026-09-29', to: '2026-10-05' }, wp: { from: '2026-09-22', to: '2026-09-28' }, w30: { from: '2026-09-06', to: '2026-10-05' },
    });
    const byId = Object.fromEntries(ds.objects.map((o) => [o.id, o]));
    expect(byId['2000001']).toMatchObject({ level: 'campaign', isSales: true, budgetOwner: { id: '2000001', level: 'campaign', daily: 50000 }, coverage: 0.5 });
    expect(byId['2000001'].m7).toMatchObject({ spend: 1000, sales: 2, roas: 6 });
    expect(byId['2000001'].mPrev).toMatchObject({ spend: 500, sales: 0 });
    expect(byId['3000001'].budgetOwner).toBeNull(); // su campaña es CBO
    expect(byId['3000002']).toMatchObject({ budgetOwner: { id: '3000002', level: 'adset', daily: 20000 }, learning: true });
    expect(byId['1000002']).toMatchObject({ learning: true, ageDays: 1, budgetOwner: null });
    expect(byId['1000009'].isSales).toBe(false);
    expect(ds.baseline).toMatchObject({ spend: 1800, sales: 2 }); // w30 incluye el gasto del 25/09
  });
});
```

- [ ] **Step 3: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/agentMetrics.test.js`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 4: `backend/src/repo/agentMetrics.js`**

```js
import { PAID, RANGE } from './reports.js';

export const SALES_OBJECTIVES = ['OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES'];
const KEY = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const ratio = (a, b) => (b > 0 ? a / b : null);

export function withRatios(m) {
  return { ...m, roas: ratio(m.revenue, m.spend), cpa: m.sales > 0 ? m.spend / m.sales : null, ctr: ratio(m.clicks, m.impressions) };
}

export function createAgentMetrics({ db, reports }) {
  return {
    async byLevel({ level, from, to }) {
      const { rows } = await reports.adsRanking({ from, to, level });
      return new Map(rows.map((r) => [r.id, {
        spend: r.spend, impressions: r.impressions, clicks: r.clicks, sales: r.sales, revenue: r.revenue,
        metaPurchases: r.metaPurchases, metaValue: r.metaValue,
      }]));
    },
    async coverageByCampaign({ from, to }) {
      const { rows } = await db.query(
        `SELECT a.campaign_id AS id, (count(*) FILTER (WHERE a.confidence = 'ad'))::int AS ad, count(*)::int AS total
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.campaign_id IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)}
          GROUP BY 1`,
        [from, to],
      );
      return new Map(rows.map((r) => [r.id, r.ad / r.total]));
    },
    async objectWindow({ level, id, from, to }) {
      const key = KEY[level];
      if (!key) throw new Error(`level inválido: ${level}`);
      const { rows: [r] } = await db.query(
        `SELECT
           (SELECT COALESCE(sum(spend), 0) FROM meta_spend_daily WHERE ${key} = $1 AND date BETWEEN $2::date AND $3::date)::float8 AS spend,
           (SELECT count(*) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.${key} = $1 AND ${PAID} AND ${RANGE(2, 3)})::int AS sales,
           (SELECT COALESCE(sum(o.total), 0) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.${key} = $1 AND ${PAID} AND ${RANGE(2, 3)})::float8 AS revenue`,
        [id, from, to],
      );
      return r;
    },
    async salesWindow({ from, to }) {
      const { rows: [r] } = await db.query(
        `WITH c AS (SELECT id FROM meta_ads WHERE level = 'campaign' AND objective = ANY($3::text[]))
         SELECT
           (SELECT COALESCE(sum(spend), 0) FROM meta_spend_daily
             WHERE date BETWEEN $1::date AND $2::date AND campaign_id IN (SELECT id FROM c))::float8 AS spend,
           (SELECT count(*) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.channel = 'meta' AND a.campaign_id IN (SELECT id FROM c) AND ${PAID} AND ${RANGE(1, 2)})::int AS sales,
           (SELECT COALESCE(sum(o.total), 0) FROM orders o JOIN order_attribution a ON a.order_id = o.id
             WHERE a.channel = 'meta' AND a.campaign_id IN (SELECT id FROM c) AND ${PAID} AND ${RANGE(1, 2)})::float8 AS revenue`,
        [from, to, SALES_OBJECTIVES],
      );
      return r;
    },
    async baseline(window) {
      const w = await this.salesWindow(window);
      return { ...w, roas: ratio(w.revenue, w.spend), cpa: w.sales > 0 ? w.spend / w.sales : null };
    },
  };
}
```

- [ ] **Step 5: `backend/src/agent/dataset.js`**

```js
import { addDays } from '../engine/dates.js';
import { SALES_OBJECTIVES, withRatios } from '../repo/agentMetrics.js';

const EMPTY = { spend: 0, impressions: 0, clicks: 0, sales: 0, revenue: 0, metaPurchases: 0, metaValue: 0 };
const DAY_MS = 86400000;

function budgetOwner(r) {
  if (r.level === 'campaign') return r.is_cbo && r.daily_budget ? { id: r.id, level: 'campaign', daily: r.daily_budget } : null;
  if (r.level === 'adset') return !r.campaign_is_cbo && r.daily_budget ? { id: r.id, level: 'adset', daily: r.daily_budget } : null;
  return null;
}

export async function buildDataset({ db, metrics, today }) {
  const w7 = { from: addDays(today, -7), to: addDays(today, -1) };
  const wp = { from: addDays(today, -14), to: addDays(today, -8) };
  const w30 = { from: addDays(today, -30), to: addDays(today, -1) };
  const baseline = await metrics.baseline(w30);
  const coverage = await metrics.coverageByCampaign(w30);

  const { rows } = await db.query(
    `SELECT a.id, a.level, a.name, a.status, a.parent_id, a.campaign_id, a.daily_budget::float8 AS daily_budget, a.is_cbo,
            a.created_time, a.learning_status, a.status_updated_at,
            c.objective AS campaign_objective, c.is_cbo AS campaign_is_cbo, s.learning_status AS adset_learning
       FROM meta_ads a
       LEFT JOIN meta_ads c ON c.id = a.campaign_id AND c.level = 'campaign'
       LEFT JOIN meta_ads s ON s.id = a.parent_id AND s.level = 'adset'
      WHERE a.status IN ('ACTIVE', 'PAUSED')`,
  );

  const windows = {};
  for (const level of ['campaign', 'adset', 'ad']) {
    windows[level] = {
      m7: await metrics.byLevel({ level, ...w7 }),
      mPrev: await metrics.byLevel({ level, ...wp }),
      m30: await metrics.byLevel({ level, ...w30 }),
    };
  }
  const todayMs = Date.parse(`${today}T03:00:00Z`); // 00:00 ART

  const objects = rows.map((r) => {
    const w = windows[r.level];
    const learningStatus = r.level === 'ad' ? r.adset_learning : r.level === 'adset' ? r.learning_status : null;
    return {
      id: r.id,
      level: r.level,
      name: r.name,
      status: r.status,
      campaignId: r.campaign_id,
      parentId: r.parent_id,
      objective: r.campaign_objective,
      isSales: SALES_OBJECTIVES.includes(r.campaign_objective),
      ageDays: r.created_time ? Math.floor((todayMs - new Date(r.created_time).getTime()) / DAY_MS) : null,
      learning: learningStatus === 'LEARNING',
      statusUpdatedAt: r.status_updated_at ? new Date(r.status_updated_at).toISOString() : null,
      budgetOwner: budgetOwner(r),
      coverage: coverage.has(r.campaign_id) ? coverage.get(r.campaign_id) : null,
      m7: withRatios(w.m7.get(r.id) || EMPTY),
      mPrev: withRatios(w.mPrev.get(r.id) || EMPTY),
      m30: withRatios(w.m30.get(r.id) || EMPTY),
    };
  });
  return { today, windows: { w7, wp, w30 }, baseline, objects };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/agentMetrics.test.js`
Expected: PASS. Nota: el `ageDays` de `1000002` (creado 2026-10-04T12:00Z) contra hoy 2026-10-06 00:00 ART (03:00Z) es 1 día completo.

- [ ] **Step 7: Commit**

```bash
git add backend/src/repo/reports.js backend/src/repo/agentMetrics.js backend/src/agent/dataset.js backend/test/agentMetrics.test.js
git commit -m "feat: métricas por objeto y dataset diario del agente

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Detección de candidatos (pura)

**Files:**
- Create: `backend/src/agent/candidates.js`
- Test: `backend/test/candidates.test.js`

**Interfaces:**
- Consumes: `DatasetObject` y `dataset` de Task 3; `DEFAULT_CONFIG` de Task 2; filas de recomendaciones recientes `{ id, type, status, object_id, target_id, decided_at, created_at, snapshot }` (Task 5).
- Produces: `detectCandidates({ dataset, config, recent }) → Candidate[]`
  - `Candidate = { key, signal, level, objectId, targetId?, name, campaignId, parentId, suggested, doubtful, ageDays, learning, coverage, budget, status, metrics }`
  - `signal ∈ gasta_sin_vender | caro | ganador | reasignar | fatiga | pausado_que_vendia`
  - `suggested ∈ pause | budget_down | budget_up | shift | idea | reactivate`
  - `key = '<signal>:<objectId>'`; reasignación: `'reasignar:<fromId>><toId>'`, con `objectId = from`, `targetId = to`, `budget = { from, to }`, `metrics = { from, to }`.
  - `metrics = { m7, mPrev, m30 }` (para reasignación, uno por punta). `budget` = presupuesto diario del dueño (pesos) o `null`.
  - Ordenados por gasto 7d desc, máximo `thresholds.maxCandidates`. Sin línea de base (`roas`/`cpa` null) → `[]`.

- [ ] **Step 1: Tests `backend/test/candidates.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { detectCandidates } from '../src/agent/candidates.js';
import { DEFAULT_CONFIG } from '../src/repo/agentConfig.js';
import { withRatios } from '../src/repo/agentMetrics.js';

const mm = (o = {}) => withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 10000, clicks: 200, metaPurchases: 0, metaValue: 0, ...o });
const obj = (id, o = {}) => ({
  id, level: 'campaign', name: `obj ${id}`, status: 'ACTIVE', campaignId: id, parentId: null, objective: 'OUTCOME_SALES', isSales: true,
  ageDays: 30, learning: false, statusUpdatedAt: null, budgetOwner: null, coverage: 1, m7: mm(), mPrev: mm(), m30: mm(), ...o,
});
const BASE = { spend: 100000, sales: 100, revenue: 400000, roas: 4, cpa: 1000 };
const run = (objects, { recent = [], config = DEFAULT_CONFIG, baseline = BASE } = {}) =>
  detectCandidates({ dataset: { today: '2026-10-06', baseline, objects }, config, recent });
const signals = (cs) => cs.map((c) => `${c.signal}:${c.objectId}${c.targetId ? `>${c.targetId}` : ''}`);

describe('gasta sin vender', () => {
  it('activo y maduro con gasto ≥ 2×CPA y 0 ventas → pausar', () => {
    const [c] = run([obj('A', { m7: mm({ spend: 2500 }) })]);
    expect(c).toMatchObject({ key: 'gasta_sin_vender:A', suggested: 'pause', doubtful: false });
  });
  it('si Meta dice que vendió ≥ 2 → dudoso por atribución', () => {
    expect(run([obj('A', { m7: mm({ spend: 2500, metaPurchases: 3 }) })])[0].doubtful).toBe(true);
  });
  it('en aprendizaje solo si el gasto es ≥ 4×CPA', () => {
    expect(run([obj('A', { learning: true, m7: mm({ spend: 2500 }) })])).toEqual([]);
    expect(signals(run([obj('A', { learning: true, m7: mm({ spend: 4500 }) })]))).toEqual(['gasta_sin_vender:A']);
  });
  it('un hijo no se repite si su campaña ya gasta sin vender', () => {
    const cs = run([
      obj('C', { m7: mm({ spend: 9000 }) }),
      obj('S', { level: 'adset', campaignId: 'C', parentId: 'C', m7: mm({ spend: 3000 }) }),
    ]);
    expect(signals(cs)).toEqual(['gasta_sin_vender:C']);
  });
});

describe('caro y ganador', () => {
  it('caro con presupuesto propio → bajar presupuesto; sin presupuesto (anuncio) → pausar', () => {
    const cs = run([
      obj('C', { budgetOwner: { id: 'C', level: 'campaign', daily: 50000 }, m7: mm({ spend: 4000, sales: 2, revenue: 6000 }) }),
      obj('AD', { level: 'ad', campaignId: 'X', parentId: 'S', m7: mm({ spend: 3500, sales: 1, revenue: 1000 }) }),
    ]);
    expect(cs.find((c) => c.objectId === 'C')).toMatchObject({ signal: 'caro', suggested: 'budget_down', budget: 50000 });
    expect(cs.find((c) => c.objectId === 'AD')).toMatchObject({ signal: 'caro', suggested: 'pause' });
  });
  it('ganador con tendencia estable → subir; si viene cayendo fuerte → no', () => {
    const owner = { budgetOwner: { id: 'G', level: 'campaign', daily: 30000 } };
    expect(signals(run([obj('G', { ...owner, m7: mm({ spend: 5000, sales: 5, revenue: 40000 }), mPrev: mm({ spend: 5000, sales: 5, revenue: 42000 }) })])))
      .toEqual(['ganador:G']);
    expect(run([obj('G', { ...owner, m7: mm({ spend: 5000, sales: 5, revenue: 40000 }), mPrev: mm({ spend: 5000, sales: 9, revenue: 90000 }) })]))
      .toEqual([]);
  });
  it('caro + ganador del mismo nivel generan además una reasignación', () => {
    const cs = run([
      obj('CARO', { budgetOwner: { id: 'CARO', level: 'campaign', daily: 50000 }, m7: mm({ spend: 4000, sales: 2, revenue: 6000 }) }),
      obj('GAN', { budgetOwner: { id: 'GAN', level: 'campaign', daily: 30000 }, m7: mm({ spend: 5000, sales: 6, revenue: 40000 }) }),
    ]);
    expect(signals(cs)).toContain('reasignar:CARO>GAN');
    expect(cs.find((c) => c.signal === 'reasignar')).toMatchObject({ suggested: 'shift', budget: { from: 50000, to: 30000 } });
  });
});

describe('otras señales y protecciones', () => {
  it('fatiga: CTR del anuncio cae > 30%', () => {
    const cs = run([obj('AD', { level: 'ad', m7: mm({ spend: 500, sales: 1, revenue: 4000, impressions: 10000, clicks: 100 }), mPrev: mm({ impressions: 10000, clicks: 200 }) })]);
    expect(cs[0]).toMatchObject({ signal: 'fatiga', suggested: 'idea' });
  });
  it('pausado hace poco que vendía bien → reactivar; pausado hace meses → no', () => {
    const good = { status: 'PAUSED', m30: mm({ spend: 10000, sales: 8, revenue: 60000 }) };
    expect(signals(run([obj('P', { ...good, statusUpdatedAt: '2026-09-28T12:00:00.000Z' })]))).toEqual(['pausado_que_vendia:P']);
    expect(run([obj('P', { ...good, statusUpdatedAt: '2026-06-01T12:00:00.000Z' })])).toEqual([]);
  });
  it('campañas que no son de ventas, objetos nuevos y anuncios con poca cobertura no son candidatos', () => {
    expect(run([obj('E', { isSales: false, m7: mm({ spend: 9000 }) })])).toEqual([]);
    expect(run([obj('N', { ageDays: 1, budgetOwner: { id: 'N', level: 'campaign', daily: 1 }, m7: mm({ spend: 5000, sales: 6, revenue: 40000 }) })])).toEqual([]);
    expect(run([obj('AD', { level: 'ad', coverage: 0.3, m7: mm({ spend: 9000 }) })])).toEqual([]);
  });
  it('pendiente bloquea; rechazada reciente bloquea salvo que haya empeorado ≥ 30%', () => {
    const A = obj('A', { m7: mm({ spend: 2500 }) });
    expect(run([A], { recent: [{ status: 'pending', object_id: 'A' }] })).toEqual([]);
    const rejected = { status: 'rejected', object_id: 'A', decided_at: '2026-10-04T12:00:00Z', snapshot: { m7: { spend: 2400, roas: null } } };
    expect(run([A], { recent: [rejected] })).toEqual([]);
    const worse = obj('A', { m7: mm({ spend: 3200 }) });
    expect(signals(run([worse], { recent: [rejected] }))).toEqual(['gasta_sin_vender:A']);
  });
  it('ejecutada en los últimos días también bloquea (no reactivar lo que recién pausamos)', () => {
    const P = obj('P', { status: 'PAUSED', statusUpdatedAt: '2026-10-05T12:00:00.000Z', m30: mm({ spend: 10000, sales: 8, revenue: 60000 }) });
    expect(run([P], { recent: [{ status: 'executed', object_id: 'P', decided_at: '2026-10-05T12:00:00Z' }] })).toEqual([]);
  });
  it('sin línea de base no se juzga nada', () => {
    expect(run([obj('A', { m7: mm({ spend: 9000 }) })], { baseline: { spend: 0, sales: 0, revenue: 0, roas: null, cpa: null } })).toEqual([]);
  });
  it('ordena por gasto y respeta el máximo', () => {
    const config = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, maxCandidates: 2 } };
    const cs = run([obj('A', { m7: mm({ spend: 2500 }) }), obj('B', { m7: mm({ spend: 9000 }) }), obj('C', { m7: mm({ spend: 5000 }) })], { config });
    expect(cs.map((c) => c.objectId)).toEqual(['B', 'C']);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/candidates.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/agent/candidates.js`**

```js
// Detección de candidatos con números duros. Pura: no toca DB ni APIs.
const DAY = 86400000;

function worsened(now, snap, w) {
  if (snap.roas && now.roas !== null) return now.roas <= snap.roas * (1 - w);
  return now.spend >= snap.spend * (1 + w);
}

function blockedIds(recent, byId, config, nowMs) {
  const blocked = new Set();
  const cooldown = config.rejectCooldownDays * DAY;
  for (const r of recent) {
    const ids = [r.object_id, r.target_id].filter(Boolean);
    const decided = new Date(r.decided_at || r.created_at || 0).getTime(); // acepta Date (pg) o string
    const withinCooldown = nowMs - decided < cooldown;
    for (const id of ids) {
      if (['pending', 'approved'].includes(r.status)) blocked.add(id);
      else if (['executed', 'undone'].includes(r.status) && withinCooldown) blocked.add(id);
      else if (r.status === 'rejected' && withinCooldown) {
        const o = byId.get(id);
        const snap = r.snapshot?.m7;
        if (!o || !snap || !worsened(o.m7, snap, config.thresholds.worsenRatio)) blocked.add(id);
      }
    }
  }
  return blocked;
}

function candidate(signal, o, suggested, doubtful = false) {
  return {
    key: `${signal}:${o.id}`, signal, level: o.level, objectId: o.id, name: o.name, campaignId: o.campaignId, parentId: o.parentId,
    suggested, doubtful, ageDays: o.ageDays, learning: o.learning, coverage: o.coverage,
    budget: o.budgetOwner?.daily ?? null, status: o.status, metrics: { m7: o.m7, mPrev: o.mPrev, m30: o.m30 },
  };
}

const spendOf = (c) => (c.signal === 'reasignar' ? c.metrics.from.m7.spend : c.metrics.m7.spend);

export function detectCandidates({ dataset, config, recent = [] }) {
  const t = config.thresholds;
  const { baseline, objects, today } = dataset;
  if (!baseline?.roas || !baseline?.cpa) return [];
  const nowMs = Date.parse(`${today}T03:00:00Z`);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const blocked = blockedIds(recent, byId, config, nowMs);

  const levelOk = (o) => o.level === 'campaign' || (o.coverage !== null && o.coverage >= t.adLevelCoverage);
  const mature = (o) => (o.ageDays === null || o.ageDays >= t.minAgeDays) && !o.learning;
  const found = [];

  for (const o of objects) {
    if (!o.isSales || !levelOk(o) || blocked.has(o.id)) continue;
    const m = o.m7;
    if (o.status === 'ACTIVE') {
      const noSales = m.sales === 0 && m.spend >= t.noSalesSpendMultiple * baseline.cpa;
      if (noSales && (mature(o) || m.spend >= t.noSalesForceMultiple * baseline.cpa)) {
        found.push(candidate('gasta_sin_vender', o, 'pause', m.metaPurchases >= t.doubtfulMetaPurchases));
        continue;
      }
      if (!mature(o)) continue;
      const ownsBudget = o.budgetOwner?.id === o.id;
      if (m.sales > 0 && m.roas < t.expensiveRoasRatio * baseline.roas && m.spend >= t.expensiveSpendMultiple * baseline.cpa) {
        found.push(candidate('caro', o, ownsBudget ? 'budget_down' : 'pause'));
        continue;
      }
      if (ownsBudget && m.roas !== null && m.roas >= t.winnerRoasRatio * baseline.roas && m.sales >= t.winnerMinSales
        && (o.mPrev.roas === null || m.roas >= t.winnerTrendRatio * o.mPrev.roas)) {
        found.push(candidate('ganador', o, 'budget_up'));
        continue;
      }
      if (o.level === 'ad' && m.impressions >= t.fatigueMinImpressions && o.mPrev.ctr && m.ctr !== null
        && m.ctr < (1 - t.fatigueCtrDrop) * o.mPrev.ctr) {
        found.push(candidate('fatiga', o, 'idea'));
      }
    } else if (o.status === 'PAUSED') {
      const pausedAt = o.statusUpdatedAt ? Date.parse(o.statusUpdatedAt) : null;
      if (pausedAt && nowMs - pausedAt <= 30 * DAY && o.m30.sales >= t.reactivateMinSales && o.m30.roas >= baseline.roas) {
        found.push(candidate('pausado_que_vendia', o, 'reactivate'));
      }
    }
  }

  // Un padre que gasta sin vender tapa a sus hijos con la misma señal
  const noSalesIds = new Set(found.filter((c) => c.signal === 'gasta_sin_vender').map((c) => c.objectId));
  const out = found.filter((c) => !(c.signal === 'gasta_sin_vender' && c.level !== 'campaign'
    && (noSalesIds.has(c.campaignId) || noSalesIds.has(c.parentId))));

  // Reasignación: el caro con peor ROAS con el mejor ganador del mismo nivel (cada uno se usa una vez)
  const caros = out.filter((c) => c.signal === 'caro' && c.suggested === 'budget_down').sort((a, b) => a.metrics.m7.roas - b.metrics.m7.roas);
  const ganadores = out.filter((c) => c.signal === 'ganador').sort((a, b) => b.metrics.m7.roas - a.metrics.m7.roas);
  const used = new Set();
  for (const c of caros) {
    const g = ganadores.find((x) => x.level === c.level && !used.has(x.objectId));
    if (!g) continue;
    used.add(g.objectId);
    out.push({
      key: `reasignar:${c.objectId}>${g.objectId}`, signal: 'reasignar', level: c.level, objectId: c.objectId, targetId: g.objectId,
      name: `${c.name} → ${g.name}`, campaignId: c.campaignId, parentId: c.parentId, suggested: 'shift', doubtful: false,
      ageDays: null, learning: false, coverage: null, status: 'ACTIVE',
      budget: { from: c.budget, to: g.budget }, metrics: { from: c.metrics, to: g.metrics },
    });
  }
  return out.sort((a, b) => spendOf(b) - spendOf(a)).slice(0, t.maxCandidates);
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/candidates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/candidates.js backend/test/candidates.test.js
git commit -m "feat: detección de candidatos del agente (reglas con números duros)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Repositorios de recomendaciones, corridas y lecciones

**Files:**
- Create: `backend/src/repo/recommendations.js`
- Test: `backend/test/recommendationsRepo.test.js`

**Interfaces:**
- Produces:
  - `createRecommendationsRepo(db) → {`
    - `create(rec) → id:number` (`rec` con claves de columnas; las jsonb se pasan como objetos)
    - `get(id) → row | null` (incluye `object_name`, `target_name` del catálogo)
    - `list({ statuses?: string[], type?, beforeId?, limit? }) → row[]` (id desc)
    - `transition(id, fromStatuses, toStatus, fields?) → boolean` (atómico: solo si el estado actual está en `fromStatuses`)
    - `update(id, fields)`
    - `recent({ days, now }) → row[]`
    - `toMeasure({ now }) → row[]` (ejecutadas, no deshechas, que deben medición a 3 o 7 días)
    - `setOutcome(id, outcome, verdict)`
    - `expire({ now, hours }) → number`
    - `countPending() → number` (sin ideas)
    - `precision() → [{ type, good, total }]`
    - `measuredIds(ids) → number[]`
    - `pendingRefs() → [{ id, object_id, target_id }]` `}`
  - `createAgentRunsRepo(db) → { start({ trigger, model, startedAt? }) → id, finish(id, fields), manualCountSince(iso) → number, costSince(iso) → number, last() → row | null }`
  - `createLearningsRepo(db) → { listActive() → row[], create(text, evidenceIds) → id, remove(id) }`

- [ ] **Step 1: Tests `backend/test/recommendationsRepo.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from '../src/repo/recommendations.js';
import { createMetaRepo } from '../src/repo/meta.js';

let db; let recs; let runs; let learnings;
beforeEach(async () => {
  db = await createTestDb();
  recs = createRecommendationsRepo(db);
  runs = createAgentRunsRepo(db);
  learnings = createLearningsRepo(db);
});
afterEach(() => db.close());

const base = (o = {}) => ({
  type: 'pause', level: 'ad', object_id: '1000001', title: 'Pausar X', reasoning: 'porque', expected_impact: 'baja CPA',
  confidence: 'alta', signal: 'gasta_sin_vender', current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' },
  snapshot: { m7: { spend: 2500 } }, ...o,
});

describe('recommendationsRepo', () => {
  it('create/get con nombres del catálogo y jsonb', async () => {
    await createMetaRepo(db).upsertAds([{ id: '1000001', level: 'ad', name: 'Anuncio uno', status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null, has_attribution_params: false }]);
    const id = await recs.create(base());
    const r = await recs.get(id);
    expect(r).toMatchObject({ id, status: 'pending', object_name: 'Anuncio uno', proposed_value: { status: 'PAUSED' }, snapshot: { m7: { spend: 2500 } } });
    expect(await recs.get(999)).toBeNull();
  });
  it('transition es atómica: la segunda aprobación no pasa', async () => {
    const id = await recs.create(base());
    expect(await recs.transition(id, ['pending'], 'approved', { decided_at: new Date().toISOString() })).toBe(true);
    expect(await recs.transition(id, ['pending'], 'approved')).toBe(false);
    expect((await recs.get(id)).status).toBe('approved');
  });
  it('list filtra por estado y tipo; countPending no cuenta ideas', async () => {
    await recs.create(base());
    await recs.create(base({ type: 'idea', object_id: null, current_value: null, proposed_value: null }));
    const done = await recs.create(base({ object_id: '2' }));
    await recs.transition(done, ['pending'], 'rejected');
    expect((await recs.list({ statuses: ['pending'] })).length).toBe(2);
    expect((await recs.list({ statuses: ['pending'], type: 'idea' })).length).toBe(1);
    expect(await recs.countPending()).toBe(1);
    expect((await recs.pendingRefs()).map((r) => r.object_id).sort()).toEqual([null, '1000001'].sort());
  });
  it('expire vence pendientes viejas', async () => {
    const id = await recs.create(base());
    await db.query("UPDATE recommendations SET created_at = now() - interval '50 hours' WHERE id = $1", [id]);
    expect(await recs.expire({ now: new Date().toISOString(), hours: 48 })).toBe(1);
    expect((await recs.get(id)).status).toBe('expired');
  });
  it('toMeasure devuelve las que deben medición a 3 y 7 días; precision por tipo', async () => {
    const a = await recs.create(base());
    const b = await recs.create(base({ object_id: '2' }));
    await recs.transition(a, ['pending'], 'executed', { executed_at: '2026-10-01T12:00:00Z' });
    await recs.transition(b, ['pending'], 'executed', { executed_at: '2026-09-20T12:00:00Z' });
    await recs.setOutcome(b, { d3: { verdict: 'mejoro' } }, 'mejoro');
    const due = await recs.toMeasure({ now: '2026-10-06T12:00:00Z' });
    expect(due.map((r) => r.id).sort()).toEqual([a, b].sort()); // a debe d3; b debe d7
    await recs.setOutcome(b, { d3: { verdict: 'mejoro' }, d7: { verdict: 'mejoro' } }, 'mejoro');
    expect((await recs.toMeasure({ now: '2026-10-06T12:00:00Z' })).map((r) => r.id)).toEqual([a]);
    expect(await recs.precision()).toEqual([{ type: 'pause', good: 1, total: 1 }]);
    expect(await recs.measuredIds([a, b])).toEqual([b]);
  });
  it('recent trae las de los últimos N días', async () => {
    const id = await recs.create(base());
    await db.query("UPDATE recommendations SET created_at = now() - interval '20 days' WHERE id = $1", [id]);
    await recs.create(base({ object_id: '2' }));
    expect((await recs.recent({ days: 14, now: new Date().toISOString() })).map((r) => r.object_id)).toEqual(['2']);
  });
});

describe('agentRunsRepo y learningsRepo', () => {
  it('cuenta corridas manuales y costo desde una fecha', async () => {
    const r1 = await runs.start({ trigger: 'manual', model: 'claude-opus-5-5' });
    await runs.finish(r1, { status: 'ok', input_tokens: 100, output_tokens: 50, cost_usd: 0.12 });
    const r2 = await runs.start({ trigger: 'cron', model: 'claude-opus-5-5' });
    await runs.finish(r2, { status: 'ok', cost_usd: 0.2 });
    const since = new Date(Date.now() - 3600e3).toISOString();
    expect(await runs.manualCountSince(since)).toBe(1);
    expect(await runs.costSince(since)).toBeCloseTo(0.32);
    expect((await runs.last()).id).toBe(r2);
  });
  it('lecciones: crear, listar activas, borrar', async () => {
    const id = await learnings.create('Las DPA venden tarde', [1, 2, 3]);
    expect((await learnings.listActive()).map((l) => l.text)).toEqual(['Las DPA venden tarde']);
    await learnings.remove(id);
    expect(await learnings.listActive()).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/recommendationsRepo.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/repo/recommendations.js`**

```js
const JSON_COLS = new Set(['current_value', 'proposed_value', 'snapshot', 'execution_result', 'previous_value', 'outcome']);
const encode = (k, v) => (JSON_COLS.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : v ?? null);
const COLUMNS = new Set(['run_id', 'type', 'status', 'level', 'object_id', 'target_id', 'title', 'reasoning', 'expected_impact',
  'confidence', 'dudoso_atribucion', 'signal', 'current_value', 'proposed_value', 'snapshot', 'decided_at', 'reject_reason',
  'executed_at', 'execution_result', 'previous_value', 'undo_until', 'undone_at', 'outcome', 'verdict']);

function setClause(fields, startIndex) {
  const keys = Object.keys(fields).filter((k) => COLUMNS.has(k));
  return {
    sql: keys.map((k, i) => `${k} = $${startIndex + i}`).join(', '),
    params: keys.map((k) => encode(k, fields[k])),
  };
}

const SELECT = `SELECT r.*, r.id::int AS id, o.name AS object_name, t.name AS target_name
  FROM recommendations r
  LEFT JOIN meta_ads o ON o.id = r.object_id
  LEFT JOIN meta_ads t ON t.id = r.target_id`;

export function createRecommendationsRepo(db) {
  return {
    async create(rec) {
      const keys = Object.keys(rec).filter((k) => COLUMNS.has(k) && rec[k] !== undefined);
      const { rows } = await db.query(
        `INSERT INTO recommendations (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::int AS id`,
        keys.map((k) => encode(k, rec[k])),
      );
      return rows[0].id;
    },
    async get(id) {
      const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
      return rows[0] || null;
    },
    async list({ statuses, type, beforeId, limit = 50 } = {}) {
      const params = [];
      const where = [];
      if (statuses?.length) { params.push(statuses); where.push(`r.status = ANY($${params.length}::text[])`); }
      if (type) { params.push(type); where.push(`r.type = $${params.length}`); }
      if (beforeId) { params.push(beforeId); where.push(`r.id < $${params.length}`); }
      params.push(limit);
      const { rows } = await db.query(
        `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
    async transition(id, fromStatuses, toStatus, fields = {}) {
      const set = setClause(fields, 4);
      const { rows } = await db.query(
        `UPDATE recommendations SET status = $2${set.sql ? `, ${set.sql}` : ''}
          WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`,
        [id, toStatus, fromStatuses, ...set.params],
      );
      return rows.length === 1;
    },
    async update(id, fields) {
      const set = setClause(fields, 2);
      if (!set.sql) return;
      await db.query(`UPDATE recommendations SET ${set.sql} WHERE id = $1`, [id, ...set.params]);
    },
    async recent({ days, now }) {
      const { rows } = await db.query(
        `${SELECT} WHERE r.created_at >= $1::timestamptz - ($2 || ' days')::interval ORDER BY r.id DESC`,
        [now, String(days)],
      );
      return rows;
    },
    async toMeasure({ now }) {
      const { rows } = await db.query(
        `${SELECT}
          WHERE r.status = 'executed' AND r.undone_at IS NULL AND r.executed_at IS NOT NULL
            AND ((r.executed_at <= $1::timestamptz - interval '3 days' AND (r.outcome IS NULL OR r.outcome->'d3' IS NULL))
              OR (r.executed_at <= $1::timestamptz - interval '7 days' AND (r.outcome IS NULL OR r.outcome->'d7' IS NULL)))
          ORDER BY r.id`,
        [now],
      );
      return rows;
    },
    async setOutcome(id, outcome, verdict) {
      await db.query('UPDATE recommendations SET outcome = $2, verdict = $3 WHERE id = $1', [id, JSON.stringify(outcome), verdict]);
    },
    async expire({ now, hours }) {
      const { rows } = await db.query(
        `UPDATE recommendations SET status = 'expired'
          WHERE status = 'pending' AND type <> 'idea' AND created_at <= $1::timestamptz - ($2 || ' hours')::interval
          RETURNING id`,
        [now, String(hours)],
      );
      return rows.length;
    },
    async countPending() {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM recommendations WHERE status = 'pending' AND type <> 'idea'");
      return rows[0].n;
    },
    async precision() {
      const { rows } = await db.query(
        `SELECT type, (count(*) FILTER (WHERE verdict = 'mejoro'))::int AS good, (count(*) FILTER (WHERE verdict IS NOT NULL))::int AS total
           FROM recommendations WHERE status IN ('executed', 'undone') AND verdict IS NOT NULL GROUP BY type ORDER BY type`,
      );
      return rows;
    },
    async measuredIds(ids) {
      if (!ids.length) return [];
      const { rows } = await db.query(
        'SELECT id::int AS id FROM recommendations WHERE id = ANY($1::int[]) AND verdict IS NOT NULL ORDER BY id',
        [ids],
      );
      return rows.map((r) => r.id);
    },
    async pendingRefs() {
      const { rows } = await db.query("SELECT id::int AS id, object_id, target_id FROM recommendations WHERE status = 'pending'");
      return rows;
    },
  };
}

export function createAgentRunsRepo(db) {
  const RUN_COLS = new Set(['status', 'baseline', 'candidates', 'skipped', 'input_tokens', 'output_tokens', 'cost_usd', 'error']);
  return {
    async start({ trigger, model, startedAt = null }) {
      const { rows } = await db.query(
        'INSERT INTO agent_runs (trigger, model, started_at) VALUES ($1, $2, COALESCE($3::timestamptz, now())) RETURNING id::int AS id',
        [trigger, model, startedAt],
      );
      return rows[0].id;
    },
    async finish(id, fields) {
      const keys = Object.keys(fields).filter((k) => RUN_COLS.has(k));
      const params = keys.map((k) => (['baseline', 'candidates', 'skipped'].includes(k) ? JSON.stringify(fields[k]) : fields[k]));
      await db.query(
        `UPDATE agent_runs SET finished_at = now()${keys.map((k, i) => `, ${k} = $${i + 2}`).join('')} WHERE id = $1`,
        [id, ...params],
      );
    },
    async manualCountSince(iso) {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM agent_runs WHERE trigger = 'manual' AND status <> 'skipped' AND started_at >= $1::timestamptz",
        [iso],
      );
      return rows[0].n;
    },
    async costSince(iso) {
      const { rows } = await db.query('SELECT COALESCE(sum(cost_usd), 0)::float8 AS c FROM agent_runs WHERE started_at >= $1::timestamptz', [iso]);
      return rows[0].c;
    },
    async last() {
      const { rows } = await db.query(
        `SELECT id::int AS id, trigger, started_at, finished_at, status, model, input_tokens, output_tokens, cost_usd::float8 AS cost_usd,
                error, jsonb_array_length(COALESCE(candidates, '[]'::jsonb))::int AS candidates_count
           FROM agent_runs ORDER BY id DESC LIMIT 1`,
      );
      return rows[0] || null;
    },
  };
}

export function createLearningsRepo(db) {
  return {
    async listActive() {
      const { rows } = await db.query("SELECT id::int AS id, text, evidence_ids, created_at FROM learnings WHERE status = 'active' ORDER BY id");
      return rows;
    },
    async create(text, evidenceIds) {
      const { rows } = await db.query('INSERT INTO learnings (text, evidence_ids) VALUES ($1, $2::int[]) RETURNING id::int AS id', [text, evidenceIds]);
      return rows[0].id;
    },
    async remove(id) {
      await db.query("UPDATE learnings SET status = 'deleted', updated_at = now() WHERE id = $1", [id]);
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/recommendationsRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/recommendations.js backend/test/recommendationsRepo.test.js
git commit -m "feat: repositorios de recomendaciones, corridas del agente y lecciones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tools del agente y validación de cada llamada

**Files:**
- Create: `backend/src/agent/tools.js`
- Test: `backend/test/agentTools.test.js`

**Interfaces:**
- Consumes: `Candidate` (Task 4), config (Task 2), `recs.create` / `recs.measuredIds` / `learnings.create` (Task 5).
- Produces:
  - `TOOLS: Anthropic.Tool[]` — 7 tools con `strict: true` y `additionalProperties: false`: `recomendar_pausa`, `recomendar_reactivacion`, `recomendar_presupuesto`, `recomendar_reasignacion`, `registrar_idea`, `descartar_candidato`, `guardar_leccion`.
  - `createToolHandler({ runId, candidates, recs, learnings, config }) → { handle(name, input) → Promise<{ content: string, isError: boolean }>, handled: Set<key>, skipped: [{ key, motivo }], created: number[] }`.
  - Reglas: cada candidato se resuelve una sola vez; la acción debe corresponder a la señal (pausa: `gasta_sin_vender|caro`; reactivación: `pausado_que_vendia`; presupuesto: `ganador` (sube) o `caro` con presupuesto propio (baja); reasignación: `reasignar`); topes `budget.maxChangePct`, `minDaily`, `maxDaily`; presupuestos redondeados a pesos enteros; si `doubtful` la confianza se fuerza a `baja`; lección exige ≥ 3 ids con resultado medido.
  - Forma de lo guardado: pausa `current {status:'ACTIVE'} → proposed {status:'PAUSED'}`; reactivación al revés; presupuesto `{daily_budget}`; reasignación `{from, to}` (presupuestos diarios en pesos) con `target_id`.

- [ ] **Step 1: Tests `backend/test/agentTools.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { TOOLS, createToolHandler } from '../src/agent/tools.js';
import { DEFAULT_CONFIG } from '../src/repo/agentConfig.js';

const m = { m7: { spend: 2500, sales: 0 } };
const cands = [
  { key: 'gasta_sin_vender:A', signal: 'gasta_sin_vender', level: 'ad', objectId: 'A', doubtful: false, budget: null, metrics: m },
  { key: 'gasta_sin_vender:D', signal: 'gasta_sin_vender', level: 'ad', objectId: 'D', doubtful: true, budget: null, metrics: m },
  { key: 'ganador:G', signal: 'ganador', level: 'campaign', objectId: 'G', doubtful: false, budget: 50000, metrics: m },
  { key: 'caro:C', signal: 'caro', level: 'campaign', objectId: 'C', doubtful: false, budget: 40000, metrics: m },
  { key: 'reasignar:C>G', signal: 'reasignar', level: 'campaign', objectId: 'C', targetId: 'G', doubtful: false, budget: { from: 40000, to: 50000 }, metrics: { from: m, to: m } },
  { key: 'pausado_que_vendia:P', signal: 'pausado_que_vendia', level: 'adset', objectId: 'P', doubtful: false, budget: null, metrics: m },
];
const txt = { titulo: 'T', razonamiento: 'R', impacto_esperado: 'I', confianza: 'alta' };

function setup() {
  let next = 1;
  const recs = { create: vi.fn(async () => next++), measuredIds: vi.fn(async (ids) => ids.filter((i) => i <= 3)) };
  const learnings = { create: vi.fn(async () => 9) };
  const h = createToolHandler({ runId: 7, candidates: cands, recs, learnings, config: DEFAULT_CONFIG });
  return { h, recs, learnings };
}

describe('TOOLS', () => {
  it('7 tools estrictas sin propiedades extra', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'recomendar_pausa', 'recomendar_reactivacion', 'recomendar_presupuesto', 'recomendar_reasignacion',
      'registrar_idea', 'descartar_candidato', 'guardar_leccion',
    ]);
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required.sort()).toEqual(Object.keys(t.input_schema.properties).sort());
    }
  });
});

describe('toolHandler', () => {
  it('pausa válida crea la recomendación con valores actual/propuesto y snapshot', async () => {
    const { h, recs } = setup();
    const r = await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:A', ...txt });
    expect(r.isError).toBe(false);
    expect(recs.create).toHaveBeenCalledWith(expect.objectContaining({
      run_id: 7, type: 'pause', level: 'ad', object_id: 'A', confidence: 'alta', signal: 'gasta_sin_vender',
      current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' }, snapshot: m,
    }));
    expect(h.handled.has('gasta_sin_vender:A')).toBe(true);
    expect(h.created).toEqual([1]);
  });
  it('dudoso por atribución fuerza confianza baja', async () => {
    const { h, recs } = setup();
    await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:D', ...txt });
    expect(recs.create.mock.calls[0][0]).toMatchObject({ confidence: 'baja', dudoso_atribucion: true });
  });
  it('rechaza candidato inexistente, repetido o acción que no corresponde a la señal', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_pausa', { candidato: 'x:Z', ...txt })).isError).toBe(true);
    expect((await h.handle('recomendar_reactivacion', { candidato: 'gasta_sin_vender:A', ...txt })).isError).toBe(true);
    await h.handle('recomendar_pausa', { candidato: 'gasta_sin_vender:A', ...txt });
    expect((await h.handle('descartar_candidato', { candidato: 'gasta_sin_vender:A', motivo: 'x' })).isError).toBe(true);
    expect(recs.create).toHaveBeenCalledTimes(1);
  });
  it('presupuesto: respeta dirección y tope ±20%, redondea a pesos', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 45000, ...txt })).isError).toBe(true); // baja a un ganador
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 70000, ...txt })).isError).toBe(true); // +40%
    expect((await h.handle('recomendar_presupuesto', { candidato: 'ganador:G', presupuesto_nuevo: 59999.6, ...txt })).isError).toBe(false);
    expect(recs.create.mock.calls[0][0]).toMatchObject({ type: 'budget', object_id: 'G', current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 } });
    expect((await h.handle('recomendar_presupuesto', { candidato: 'caro:C', presupuesto_nuevo: 34000, ...txt })).isError).toBe(false);
  });
  it('reasignación: monto dentro del tope de ambas puntas', async () => {
    const { h, recs } = setup();
    expect((await h.handle('recomendar_reasignacion', { candidato: 'reasignar:C>G', monto_diario: 9000, ...txt })).isError).toBe(true); // > 20% de 40000
    expect((await h.handle('recomendar_reasignacion', { candidato: 'reasignar:C>G', monto_diario: 8000, ...txt })).isError).toBe(false);
    expect(recs.create.mock.calls[0][0]).toMatchObject({
      type: 'shift', object_id: 'C', target_id: 'G', current_value: { from: 40000, to: 50000 }, proposed_value: { from: 32000, to: 58000 },
    });
  });
  it('reactivación, idea y descarte', async () => {
    const { h, recs } = setup();
    await h.handle('recomendar_reactivacion', { candidato: 'pausado_que_vendia:P', ...txt });
    expect(recs.create.mock.calls[0][0]).toMatchObject({ type: 'reactivate', current_value: { status: 'PAUSED' }, proposed_value: { status: 'ACTIVE' } });
    await h.handle('registrar_idea', { candidato: '', titulo: 'Probar video', detalle: 'D' });
    expect(recs.create.mock.calls[1][0]).toMatchObject({ type: 'idea', object_id: null, title: 'Probar video', reasoning: 'D' });
    await h.handle('descartar_candidato', { candidato: 'caro:C', motivo: 'en lanzamiento' });
    expect(h.skipped).toEqual([{ key: 'caro:C', motivo: 'en lanzamiento' }]);
  });
  it('lección exige 3 recomendaciones medidas', async () => {
    const { h, learnings } = setup();
    expect((await h.handle('guardar_leccion', { texto: 'X', evidencia_ids: [1, 2, 8] })).isError).toBe(true);
    expect((await h.handle('guardar_leccion', { texto: 'X', evidencia_ids: [1, 2, 3] })).isError).toBe(false);
    expect(learnings.create).toHaveBeenCalledWith('X', [1, 2, 3]);
  });
  it('herramienta desconocida → error', async () => {
    const { h } = setup();
    expect((await h.handle('borrar_todo', {})).isError).toBe(true);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/agentTools.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/agent/tools.js`**

```js
// Tools del agente: SOLO crean registros (recomendaciones, ideas, descartes, lecciones). Nunca ejecutan en Meta.
const str = { type: 'string' };
const COMMON = { titulo: str, razonamiento: str, impacto_esperado: str, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] } };
const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tool = (name, description, properties) => ({ name, description, strict: true, input_schema: schema(properties) });

export const TOOLS = [
  tool('recomendar_pausa', 'Recomienda pausar el objeto de un candidato con señal gasta_sin_vender o caro.', { candidato: str, ...COMMON }),
  tool('recomendar_reactivacion', 'Recomienda reactivar un objeto pausado (señal pausado_que_vendia).', { candidato: str, ...COMMON }),
  tool('recomendar_presupuesto', 'Recomienda un nuevo presupuesto diario en pesos: subir a un ganador o bajar a un caro con presupuesto propio. Respetá el tope de cambio.',
    { candidato: str, presupuesto_nuevo: { type: 'number' }, ...COMMON }),
  tool('recomendar_reasignacion', 'Recomienda mover un monto diario en pesos del objeto caro al ganador (señal reasignar).',
    { candidato: str, monto_diario: { type: 'number' }, ...COMMON }),
  tool('registrar_idea', 'Registra una idea sin acción directa (ej. renovar creativo). candidato puede ser "" si no aplica a uno.',
    { candidato: str, titulo: str, detalle: str }),
  tool('descartar_candidato', 'Deja registrado por qué un candidato no merece acción ahora.', { candidato: str, motivo: str }),
  tool('guardar_leccion', 'Guarda una lección aprendida. Requiere al menos 3 ids de recomendaciones con resultado medido.',
    { texto: str, evidencia_ids: { type: 'array', items: { type: 'integer' } } }),
];

const ACTION_SIGNALS = {
  recomendar_pausa: ['gasta_sin_vender', 'caro'],
  recomendar_reactivacion: ['pausado_que_vendia'],
  recomendar_presupuesto: ['ganador', 'caro'],
  recomendar_reasignacion: ['reasignar'],
};

export function createToolHandler({ runId, candidates, recs, learnings, config }) {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const handled = new Set();
  const skipped = [];
  const created = [];
  const fail = (msg) => ({ content: `Error: ${msg}`, isError: true });
  const ok = (msg) => ({ content: msg, isError: false });
  const maxPct = config.budget.maxChangePct / 100;

  function take(key, signals) {
    const c = byKey.get(key);
    if (!c) return { error: `candidato inexistente: ${key}` };
    if (handled.has(key)) return { error: `el candidato ${key} ya fue resuelto` };
    if (signals && !signals.includes(c.signal)) return { error: `esa acción no corresponde a la señal ${c.signal}` };
    return { c };
  }

  const baseRec = (c, input, type) => ({
    run_id: runId, type, level: c.level, object_id: c.objectId, target_id: c.targetId ?? null,
    title: input.titulo, reasoning: input.razonamiento, expected_impact: input.impacto_esperado,
    confidence: c.doubtful ? 'baja' : input.confianza, dudoso_atribucion: Boolean(c.doubtful), signal: c.signal, snapshot: c.metrics,
  });

  async function save(c, rec) {
    const id = await recs.create(rec);
    created.push(id);
    if (c) handled.add(c.key);
    return ok(`Recomendación #${id} guardada.`);
  }

  const inRange = (v) => v >= config.budget.minDaily && v <= config.budget.maxDaily;

  const handlers = {
    async recomendar_pausa(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_pausa);
      if (error) return fail(error);
      return save(c, { ...baseRec(c, input, 'pause'), current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' } });
    },
    async recomendar_reactivacion(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_reactivacion);
      if (error) return fail(error);
      return save(c, { ...baseRec(c, input, 'reactivate'), current_value: { status: 'PAUSED' }, proposed_value: { status: 'ACTIVE' } });
    },
    async recomendar_presupuesto(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_presupuesto);
      if (error) return fail(error);
      if (!c.budget) return fail('el objeto no tiene presupuesto propio (el presupuesto está en otro nivel)');
      const next = Math.round(input.presupuesto_nuevo);
      if (c.signal === 'ganador' && next <= c.budget) return fail('a un ganador solo se le puede subir el presupuesto');
      if (c.signal === 'caro' && next >= c.budget) return fail('a un caro solo se le puede bajar el presupuesto');
      if (Math.abs(next - c.budget) / c.budget > maxPct + 1e-9) return fail(`el cambio supera el tope de ±${config.budget.maxChangePct}% (actual $${c.budget})`);
      if (!inRange(next)) return fail(`el presupuesto tiene que estar entre $${config.budget.minDaily} y $${config.budget.maxDaily}`);
      return save(c, { ...baseRec(c, input, 'budget'), current_value: { daily_budget: c.budget }, proposed_value: { daily_budget: next } });
    },
    async recomendar_reasignacion(input) {
      const { c, error } = take(input.candidato, ACTION_SIGNALS.recomendar_reasignacion);
      if (error) return fail(error);
      const amount = Math.round(input.monto_diario);
      const { from, to } = c.budget;
      if (!(amount > 0)) return fail('el monto tiene que ser positivo');
      if (amount > from * maxPct + 1e-9 || amount > to * maxPct + 1e-9) return fail(`el monto supera el tope de ${config.budget.maxChangePct}% de alguna de las puntas`);
      if (!inRange(from - amount) || !inRange(to + amount)) return fail('algún presupuesto resultante queda fuera de los mínimos/máximos');
      return save(c, { ...baseRec(c, input, 'shift'), current_value: { from, to }, proposed_value: { from: from - amount, to: to + amount } });
    },
    async registrar_idea(input) {
      let c = null;
      if (input.candidato) {
        const r = take(input.candidato, null);
        if (r.error) return fail(r.error);
        c = r.c;
      }
      return save(c, {
        run_id: runId, type: 'idea', level: c?.level ?? null, object_id: c?.objectId ?? null, target_id: null,
        title: input.titulo, reasoning: input.detalle, expected_impact: null, confidence: 'media',
        dudoso_atribucion: false, signal: c?.signal ?? null, snapshot: c?.metrics ?? null,
      });
    },
    async descartar_candidato(input) {
      const { c, error } = take(input.candidato, null);
      if (error) return fail(error);
      handled.add(c.key);
      skipped.push({ key: c.key, motivo: input.motivo });
      return ok('Descarte registrado.');
    },
    async guardar_leccion(input) {
      const ids = [...new Set(input.evidencia_ids)];
      if (!input.texto.trim()) return fail('la lección no puede estar vacía');
      const measured = await recs.measuredIds(ids);
      if (measured.length < 3) return fail(`hacen falta al menos 3 recomendaciones con resultado medido (válidas: ${measured.join(', ') || 'ninguna'})`);
      const id = await learnings.create(input.texto.trim(), measured);
      return ok(`Lección #${id} guardada.`);
    },
  };

  return {
    handled,
    skipped,
    created,
    async handle(name, input) {
      const fn = handlers[name];
      if (!fn) return fail(`herramienta desconocida: ${name}`);
      try {
        return await fn(input || {});
      } catch (err) {
        return fail(err.message);
      }
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/agentTools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/tools.js backend/test/agentTools.test.js
git commit -m "feat: tools del agente con validación de señal, topes y evidencia

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Prompt y runner (cupos, topes, loop con Claude, costo)

**Files:**
- Modify: `backend/package.json` (dependencia `@anthropic-ai/sdk`)
- Create: `backend/src/agent/prompt.js`, `backend/src/agent/runner.js`
- Test: `backend/test/agentRunner.test.js`

**Interfaces:**
- Consumes: `detectCandidates` (Task 4), `TOOLS`/`createToolHandler` (Task 6), repos (Task 5), `createAgentConfigRepo` (Task 2), `artDate`/`artDayStart` (Proyecto A).
- Produces:
  - `SYSTEM_PROMPT: string`, `buildUserMessage({ dataset, candidates, recent, learnings, config }) → string`.
  - `createAgentRunner({ anthropic, configRepo, runs, recs, learnings, loadDataset, now?, log? }) → { run({ trigger }) → Promise<{ runId, candidates, recommendations, costUsd } | { skipped: 'running'|'disabled'|'quota'|'budget' }>, quotaLeft() → Promise<number>, isRunning() → boolean }`.
    - `anthropic` es una instancia de `@anthropic-ai/sdk` (o un fake con `beta.messages.create`).
    - `loadDataset() → Promise<dataset>` (en producción: `buildDataset({ db, metrics, today: artDate() })`).
    - Lanza si Claude responde `refusal` o falla la API (la corrida queda `error` con el costo consumido).
  - Costo: `(input_tokens × precio_in + output_tokens × precio_out) / 1e6` con los precios del modelo en config; si `usage.iterations` existe (fallback), suma sus tokens.

- [ ] **Step 1: Dependencia**

Run: `cd backend && npm install @anthropic-ai/sdk@latest`
Expected: se agrega a `dependencies`.

- [ ] **Step 2: Tests `backend/test/agentRunner.test.js`**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo } from '../src/repo/agentConfig.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from '../src/repo/recommendations.js';
import { createAgentRunner } from '../src/agent/runner.js';
import { withRatios } from '../src/repo/agentMetrics.js';

const mm = (o = {}) => withRatios({ spend: 0, sales: 0, revenue: 0, impressions: 10000, clicks: 200, metaPurchases: 0, metaValue: 0, ...o });
const object = {
  id: 'A', level: 'campaign', name: 'Campaña A', status: 'ACTIVE', campaignId: 'A', parentId: null, objective: 'OUTCOME_SALES', isSales: true,
  ageDays: 30, learning: false, statusUpdatedAt: null, budgetOwner: null, coverage: 1, m7: mm({ spend: 2500 }), mPrev: mm(), m30: mm(),
};
const dataset = (objects = [object]) => ({
  today: '2026-10-06', windows: {}, baseline: { spend: 100000, sales: 100, revenue: 400000, roas: 4, cpa: 1000 }, objects,
});
const NOW = new Date('2026-10-06T12:00:00Z');
const toolUse = (name, input, id = 'tu1') => ({
  stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 },
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id, name, input }],
});
const endTurn = { stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 100 }, content: [{ type: 'text', text: 'Listo.' }] };
const pausaA = { candidato: 'gasta_sin_vender:A', titulo: 'Pausar A', razonamiento: 'Gastó $2.500 sin ventas', impacto_esperado: 'Ahorra', confianza: 'alta' };

let db; let deps;
beforeEach(async () => {
  db = await createTestDb();
  deps = {
    configRepo: createAgentConfigRepo(db), runs: createAgentRunsRepo(db), recs: createRecommendationsRepo(db),
    learnings: createLearningsRepo(db), now: () => NOW, log: { warn: () => {}, error: () => {} },
  };
});
afterEach(() => db.close());

const runnerWith = (responses, ds = dataset()) => {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const runner = createAgentRunner({ ...deps, anthropic: { beta: { messages: { create } } }, loadDataset: async () => ds });
  return { runner, create };
};

describe('agentRunner', () => {
  it('corrida completa: llama a Claude con el request correcto, guarda la recomendación y el costo', async () => {
    const { runner, create } = runnerWith([toolUse('recomendar_pausa', pausaA), endTurn]);
    const r = await runner.run({ trigger: 'cron' });
    expect(r).toMatchObject({ candidates: 1, recommendations: 1 });
    expect(r.costUsd).toBeCloseTo((2500 * 4 + 300 * 20) / 1e6);
    const req = create.mock.calls[0][0];
    expect(req).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(req.thinking).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.tools.every((t) => t.strict)).toBe(true);
    expect(req.messages[0].content).toContain('gasta_sin_vender:A');
    const second = create.mock.calls[1][0].messages;
    expect(second[1]).toEqual({ role: 'assistant', content: toolUse('recomendar_pausa', pausaA).content }); // append-only, con thinking
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' });
    const [rec] = await deps.recs.list({ statuses: ['pending'] });
    expect(rec).toMatchObject({ type: 'pause', object_id: 'A', title: 'Pausar A' });
    const last = await deps.runs.last();
    expect(last).toMatchObject({ status: 'ok', input_tokens: 2500, output_tokens: 300, candidates_count: 1 });
  });
  it('tool call inválido vuelve como is_error y el loop sigue', async () => {
    const { runner, create } = runnerWith([toolUse('recomendar_pausa', { ...pausaA, candidato: 'x:Z' }), toolUse('recomendar_pausa', pausaA, 'tu2'), endTurn]);
    await runner.run({ trigger: 'cron' });
    expect(create.mock.calls[1][0].messages[2].content[0]).toMatchObject({ is_error: true });
    expect((await deps.recs.list({})).length).toBe(1);
  });
  it('sin candidatos no llama a Claude y cuesta 0', async () => {
    const { runner, create } = runnerWith([], dataset([{ ...object, m7: mm({ spend: 100 }) }]));
    expect(await runner.run({ trigger: 'cron' })).toMatchObject({ candidates: 0, costUsd: 0 });
    expect(create).not.toHaveBeenCalled();
  });
  it('cupo manual diario: la tercera corrida manual del día se saltea', async () => {
    const { runner } = runnerWith([toolUse('recomendar_pausa', pausaA), endTurn, toolUse('descartar_candidato', { candidato: 'gasta_sin_vender:A', motivo: 'x' }), endTurn]);
    await runner.run({ trigger: 'manual' });
    await deps.recs.list({}).then(async ([r]) => deps.recs.transition(r.id, ['pending'], 'rejected'));
    await db.query("UPDATE recommendations SET decided_at = '2026-09-01T00:00:00Z'"); // fuera del cooldown
    await runner.run({ trigger: 'manual' });
    expect(await runner.quotaLeft()).toBe(0);
    expect(await runner.run({ trigger: 'manual' })).toEqual({ skipped: 'quota' });
  });
  it('tope mensual alcanzado → no corre', async () => {
    const id = await deps.runs.start({ trigger: 'cron', model: 'claude-opus-5-5', startedAt: NOW.toISOString() });
    await deps.runs.finish(id, { status: 'ok', cost_usd: 25 });
    const { runner, create } = runnerWith([]);
    expect(await runner.run({ trigger: 'cron' })).toEqual({ skipped: 'budget' });
    expect(create).not.toHaveBeenCalled();
  });
  it('agente apagado → no corre', async () => {
    await deps.configRepo.update({ agentEnabled: false });
    const { runner } = runnerWith([]);
    expect(await runner.run({ trigger: 'cron' })).toEqual({ skipped: 'disabled' });
  });
  it('maxTurns corta un loop infinito; los candidatos sin decisión quedan registrados', async () => {
    await deps.configRepo.update({ maxTurns: 2 });
    const bad = toolUse('recomendar_pausa', { ...pausaA, candidato: 'x:Z' });
    const { runner, create } = runnerWith([bad, bad, bad]);
    await runner.run({ trigger: 'cron' });
    expect(create).toHaveBeenCalledTimes(2);
    const { rows } = await db.query('SELECT skipped FROM agent_runs');
    expect(rows[0].skipped).toEqual([{ key: 'gasta_sin_vender:A', motivo: 'sin decisión del agente' }]);
  });
  it('refusal → la corrida queda en error con el costo consumido', async () => {
    const { runner } = runnerWith([{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: { input_tokens: 500, output_tokens: 0 }, content: [] }]);
    await expect(runner.run({ trigger: 'cron' })).rejects.toThrow(/rechazó/);
    expect(await deps.runs.last()).toMatchObject({ status: 'error', input_tokens: 500 });
  });
});
```

- [ ] **Step 3: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/agentRunner.test.js`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 4: `backend/src/agent/prompt.js`**

```js
export const SYSTEM_PROMPT = `Sos el analista de Meta Ads de Altorancho, un e-commerce argentino de muebles, iluminación y decoración (montos en pesos).
Objetivo: mejorar el ROAS real y bajar el costo por venta real. "Real" son las ventas de Tienda Nube atribuidas por UTM a Meta; "Meta dice" es lo que reporta Meta, que suele sobreestimar.

Recibís candidatos que detectaron reglas automáticas, con métricas de los últimos 7 días, los 7 días previos y 30 días.
Para CADA candidato llamá exactamente una herramienta: una recomendación, registrar_idea o descartar_candidato. Usá la clave del campo "candidato" tal cual viene.

Reglas:
- No inventes números: usá solo los del contexto. Montos en pesos con separador de miles; ROAS con un decimal.
- Si dudoso_atribucion es true, la confianza es baja; considerá descartar o registrar una idea.
- Respetá los topes de presupuesto informados y preferí cambios moderados.
- Si hay poca data, el objeto es nuevo o está en aprendizaje, descartalo explicando por qué.
- No repitas lo que el usuario rechazó hace poco salvo que los números hayan empeorado; tené en cuenta los motivos de rechazo, los resultados medidos y las lecciones.
- Títulos cortos y concretos (ej. "Pausar X: gastó $210.000 en 7 días sin ventas"). Razonamiento de 2 a 4 oraciones con los números clave. Impacto esperado en una oración.
- Guardá una lección solo si al menos 3 recomendaciones con resultado medido la respaldan (citá sus ids).
Escribí en español rioplatense. Cuando hayas resuelto todos los candidatos, respondé con un resumen de una línea.`;

const r0 = (v) => (v === null || v === undefined ? null : Math.round(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const compact = (m) => m && ({
  gasto: r0(m.spend), ventas_reales: m.sales, facturacion: r0(m.revenue), roas_real: r1(m.roas), costo_por_venta: r0(m.cpa),
  meta_dice_compras: m.metaPurchases, meta_dice_roas: m.spend > 0 ? r1(m.metaValue / m.spend) : null,
  ctr_pct: m.ctr === null ? null : r1(m.ctr * 100),
});
const windows = (w) => ({ ultimos_7d: compact(w.m7), previos_7d: compact(w.mPrev), ultimos_30d: compact(w.m30) });

export function buildUserMessage({ dataset, candidates, recent, learnings, config }) {
  const b = dataset.baseline;
  const payload = {
    fecha: dataset.today,
    linea_de_base_30d: { gasto: r0(b.spend), ventas_reales: b.sales, roas_real: r1(b.roas), costo_por_venta: r0(b.cpa) },
    topes: {
      cambio_presupuesto_max_pct: config.budget.maxChangePct,
      presupuesto_diario_min: config.budget.minDaily,
      presupuesto_diario_max: config.budget.maxDaily,
    },
    candidatos: candidates.map((c) => ({
      candidato: c.key, señal: c.signal, accion_sugerida: c.suggested, nivel: c.level, nombre: c.name,
      dias_de_vida: c.ageDays, en_aprendizaje: c.learning, cobertura_atribucion_anuncio: c.coverage === null ? null : r1(c.coverage * 100),
      dudoso_atribucion: c.doubtful, presupuesto_diario: c.budget,
      metricas: c.signal === 'reasignar' ? { desde: windows(c.metrics.from), hacia: windows(c.metrics.to) } : windows(c.metrics),
    })),
    recomendaciones_ultimos_14d: recent.map((r) => ({
      id: r.id, tipo: r.type, objeto: r.object_name || r.object_id, estado: r.status, motivo_rechazo: r.reject_reason,
      resultado: r.verdict, titulo: r.title,
    })),
    lecciones: learnings.map((l) => ({ id: l.id, texto: l.text })),
  };
  return `Datos del análisis de hoy (JSON):\n${JSON.stringify(payload, null, 1)}`;
}
```

- [ ] **Step 5: `backend/src/agent/runner.js`**

```js
import { detectCandidates } from './candidates.js';
import { TOOLS, createToolHandler } from './tools.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { artDate, artDayStart } from '../engine/dates.js';

function addUsage(acc, usage) {
  if (!usage) return;
  if (Array.isArray(usage.iterations) && usage.iterations.length) {
    for (const it of usage.iterations) {
      acc.input += (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0);
      acc.output += it.output_tokens || 0;
    }
    return;
  }
  acc.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  acc.output += usage.output_tokens || 0;
}

const cost = (acc, config) => {
  const p = config.prices[config.model];
  return (acc.input * p.input + acc.output * p.output) / 1e6;
};

export function createAgentRunner({ anthropic, configRepo, runs, recs, learnings, loadDataset, now = () => new Date(), log = console }) {
  let running = false;

  async function quotaLeftFor(config) {
    const since = artDayStart(artDate(now()));
    return Math.max(0, config.manualRunsPerDay - await runs.manualCountSince(since));
  }

  async function run({ trigger }) {
    if (running) return { skipped: 'running' };
    const config = await configRepo.get();
    if (!config.agentEnabled) return { skipped: 'disabled' };
    if (trigger === 'manual' && (await quotaLeftFor(config)) <= 0) return { skipped: 'quota' };
    const monthStart = `${artDate(now()).slice(0, 7)}-01T00:00:00-03:00`;
    if ((await runs.costSince(monthStart)) >= config.monthlyBudgetUsd) return { skipped: 'budget' };

    running = true;
    const runId = await runs.start({ trigger, model: config.model, startedAt: now().toISOString() });
    const usage = { input: 0, output: 0 };
    try {
      const dataset = await loadDataset();
      const recent = await recs.recent({ days: 14, now: now().toISOString() });
      const candidates = detectCandidates({ dataset, config, recent });
      const summary = candidates.map((c) => ({ key: c.key, signal: c.signal, name: c.name }));
      if (candidates.length === 0) {
        await runs.finish(runId, { status: 'ok', baseline: dataset.baseline, candidates: [], skipped: [] });
        return { runId, candidates: 0, recommendations: 0, costUsd: 0 };
      }

      const handler = createToolHandler({ runId, candidates, recs, learnings, config });
      const messages = [{
        role: 'user',
        content: buildUserMessage({ dataset, candidates, recent, learnings: await learnings.listActive(), config }),
      }];
      for (let turn = 0; turn < config.maxTurns; turn += 1) {
        const response = await anthropic.beta.messages.create({
          model: config.model,
          max_tokens: config.maxOutputTokens,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          output_config: { effort: config.effort },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        addUsage(usage, response.usage);
        if (response.stop_reason === 'refusal') {
          throw new Error(`Claude rechazó el análisis (${response.stop_details?.category ?? 'sin categoría'})`);
        }
        messages.push({ role: 'assistant', content: response.content });
        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;
        const results = [];
        for (const tu of toolUses) {
          const r = await handler.handle(tu.name, tu.input);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        if (turn === config.maxTurns - 1) log.warn(`[agente] corrida ${runId}: se alcanzó maxTurns (${config.maxTurns})`);
      }

      const skipped = [
        ...handler.skipped,
        ...candidates.filter((c) => !handler.handled.has(c.key)).map((c) => ({ key: c.key, motivo: 'sin decisión del agente' })),
      ];
      const costUsd = cost(usage, config);
      await runs.finish(runId, {
        status: 'ok', baseline: dataset.baseline, candidates: summary, skipped,
        input_tokens: usage.input, output_tokens: usage.output, cost_usd: costUsd,
      });
      return { runId, candidates: candidates.length, recommendations: handler.created.length, costUsd };
    } catch (err) {
      log.error(`[agente] corrida ${runId} falló:`, err);
      await runs.finish(runId, {
        status: 'error', error: String(err.message || err).slice(0, 2000),
        input_tokens: usage.input, output_tokens: usage.output, cost_usd: cost(usage, config),
      });
      throw err;
    } finally {
      running = false;
    }
  }

  return {
    run,
    quotaLeft: async () => quotaLeftFor(await configRepo.get()),
    isRunning: () => running,
  };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/agentRunner.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/agent/prompt.js backend/src/agent/runner.js backend/test/agentRunner.test.js
git commit -m "feat: runner del agente con Claude Opus 5.5, cupos, tope mensual y costo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Escrituras en Meta y executor (aprobar, rechazar, deshacer, vencer)

**Files:**
- Modify: `backend/src/services/meta.js` (métodos `getObject`, `setStatus`, `setDailyBudget`)
- Create: `backend/src/agent/executor.js`
- Test: `backend/test/meta.test.js` (agregar), `backend/test/executor.test.js`

**Interfaces:**
- Consumes: `createRecommendationsRepo` (Task 5), `createAgentConfigRepo` (Task 2), cliente Meta.
- Produces:
  - Cliente Meta: `getObject(id, fields) → json`, `setStatus(id, 'ACTIVE'|'PAUSED')`, `setDailyBudget(id, pesos)` (envía centavos).
  - `createExecutor({ meta, recs, configRepo, now?, log? }) → {`
    - `approve(id, { amount? }) → { status: 'approved'|'executed'|'stale'|'failed', error? }` — `amount` = nuevo presupuesto (tipo `budget`) o monto a mover (tipo `shift`). Errores con `.status`: 404 inexistente, 400 monto inválido o idea, 409 no pendiente.
    - `reject(id, reason) → void` (409 si no está pendiente)
    - `markSeen(id) → void` (ideas)
    - `undo(id) → { status: 'undone' }` (409 si no es deshacible)
    - `expire() → number` `}`

- [ ] **Step 1: Tests del cliente — agregar a `backend/test/meta.test.js`**

```js
  it('escrituras: estado y presupuesto diario en centavos', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ success: true }));
    const meta = make(fetchFn);
    await meta.setStatus('AD1', 'PAUSED');
    await meta.setDailyBudget('C1', 55000.4);
    await meta.getObject('C1', 'daily_budget');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ status: 'PAUSED' });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ daily_budget: 5500040 });
    expect(new URL(fetchFn.mock.calls[2][0]).searchParams.get('fields')).toBe('daily_budget');
  });
```

- [ ] **Step 2: Tests `backend/test/executor.test.js`**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo } from '../src/repo/agentConfig.js';
import { createRecommendationsRepo } from '../src/repo/recommendations.js';
import { createExecutor } from '../src/agent/executor.js';

const NOW = new Date('2026-10-06T12:00:00Z');
let db; let recs; let configRepo; let meta; let ex;

function fakeMeta(state) {
  return {
    getObject: vi.fn(async (id) => state[id]),
    setStatus: vi.fn(async (id, status) => { state[id] = { ...state[id], status }; }),
    setDailyBudget: vi.fn(async (id, pesos) => { state[id] = { ...state[id], daily_budget: String(Math.round(pesos * 100)) }; }),
  };
}
const pauseRec = { type: 'pause', level: 'ad', object_id: 'A', title: 'Pausar A', reasoning: 'r', confidence: 'alta', signal: 'gasta_sin_vender', current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' } };
const budgetRec = { type: 'budget', level: 'campaign', object_id: 'G', title: 'Subir G', reasoning: 'r', confidence: 'alta', signal: 'ganador', current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 } };
const shiftRec = { type: 'shift', level: 'campaign', object_id: 'C', target_id: 'G', title: 'Mover', reasoning: 'r', confidence: 'media', signal: 'reasignar', current_value: { from: 40000, to: 50000 }, proposed_value: { from: 32000, to: 58000 } };

beforeEach(async () => {
  db = await createTestDb();
  recs = createRecommendationsRepo(db);
  configRepo = createAgentConfigRepo(db);
  await configRepo.update({ executionEnabled: true });
  meta = fakeMeta({ A: { status: 'ACTIVE' }, G: { daily_budget: '5000000' }, C: { daily_budget: '4000000' } });
  ex = createExecutor({ meta, recs, configRepo, now: () => NOW, log: { error: () => {} } });
});
afterEach(() => db.close());

describe('executor.approve', () => {
  it('con ejecución apagada solo registra la aprobación', async () => {
    await configRepo.update({ executionEnabled: false });
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'approved' });
    expect(meta.setStatus).not.toHaveBeenCalled();
    expect((await recs.get(id)).status).toBe('approved');
  });
  it('pausa: pre-chequea, ejecuta y deja deshacer por 24 h', async () => {
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'executed' });
    expect(meta.setStatus).toHaveBeenCalledWith('A', 'PAUSED');
    const r = await recs.get(id);
    expect(r).toMatchObject({ status: 'executed', previous_value: { status: 'ACTIVE' } });
    expect(new Date(r.undo_until).toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });
  it('doble aprobación simultánea ejecuta una sola vez', async () => {
    const id = await recs.create(pauseRec);
    const results = await Promise.allSettled([ex.approve(id), ex.approve(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 409 });
    expect(meta.setStatus).toHaveBeenCalledTimes(1);
  });
  it('si cambió en Meta desde la recomendación queda desactualizada y no se toca', async () => {
    meta = fakeMeta({ A: { status: 'PAUSED' } });
    ex = createExecutor({ meta, recs, configRepo, now: () => NOW });
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'stale' });
    expect(meta.setStatus).not.toHaveBeenCalled();
    expect((await recs.get(id)).execution_result).toMatchObject({ actual: { status: 'PAUSED' } });
  });
  it('presupuesto con monto ajustado dentro del tope; fuera del tope → 400 y sigue pendiente', async () => {
    const id = await recs.create(budgetRec);
    await expect(ex.approve(id, { amount: 70000 })).rejects.toMatchObject({ status: 400 });
    expect((await recs.get(id)).status).toBe('pending');
    expect(await ex.approve(id, { amount: 55000 })).toEqual({ status: 'executed' });
    expect(meta.setDailyBudget).toHaveBeenCalledWith('G', 55000);
    expect((await recs.get(id)).proposed_value).toEqual({ daily_budget: 55000 });
  });
  it('reasignación: si falla la segunda escritura revierte la primera', async () => {
    meta.setDailyBudget.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('Meta 100: error')).mockImplementationOnce(async () => {});
    const id = await recs.create(shiftRec);
    const r = await ex.approve(id);
    expect(r).toMatchObject({ status: 'failed' });
    expect(meta.setDailyBudget.mock.calls).toEqual([['C', 32000], ['G', 58000], ['C', 40000]]);
  });
  it('error de Meta al ejecutar → failed con el motivo', async () => {
    meta.setStatus.mockRejectedValueOnce(new Error('Meta 190: token vencido'));
    const id = await recs.create(pauseRec);
    expect(await ex.approve(id)).toEqual({ status: 'failed', error: 'Meta 190: token vencido' });
  });
  it('idea o inexistente no se aprueban', async () => {
    const idea = await recs.create({ type: 'idea', title: 'x', reasoning: 'y', confidence: 'media' });
    await expect(ex.approve(idea)).rejects.toMatchObject({ status: 400 });
    await expect(ex.approve(999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('executor: rechazar, ideas, deshacer, vencer', () => {
  it('rechazar guarda el motivo; dos veces → 409', async () => {
    const id = await recs.create(pauseRec);
    await ex.reject(id, 'Está en lanzamiento');
    expect(await recs.get(id)).toMatchObject({ status: 'rejected', reject_reason: 'Está en lanzamiento' });
    await expect(ex.reject(id, 'x')).rejects.toMatchObject({ status: 409 });
  });
  it('idea vista', async () => {
    const id = await recs.create({ type: 'idea', title: 'x', reasoning: 'y', confidence: 'media' });
    await ex.markSeen(id);
    expect((await recs.get(id)).status).toBe('seen');
  });
  it('deshacer dentro de la ventana vuelve al estado anterior; después → 409', async () => {
    const id = await recs.create(shiftRec);
    await ex.approve(id);
    expect(await ex.undo(id)).toEqual({ status: 'undone' });
    expect(meta.setDailyBudget.mock.calls.slice(2)).toEqual([['C', 40000], ['G', 50000]]);
    await expect(ex.undo(id)).rejects.toMatchObject({ status: 409 });
    const id2 = await recs.create(pauseRec);
    await ex.approve(id2);
    const later = createExecutor({ meta, recs, configRepo, now: () => new Date('2026-10-08T12:00:00Z') });
    await expect(later.undo(id2)).rejects.toMatchObject({ status: 409 });
  });
  it('expire vence pendientes viejas según config', async () => {
    const id = await recs.create(pauseRec);
    await db.query("UPDATE recommendations SET created_at = '2026-10-03T00:00:00Z' WHERE id = $1", [id]);
    expect(await ex.expire()).toBe(1);
  });
});
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd backend && npx vitest run test/executor.test.js test/meta.test.js`
Expected: FAIL.

- [ ] **Step 4: Métodos en `backend/src/services/meta.js`** (agregar al objeto devuelto)

```js
    getObject: (id, fields) => req(id, { params: { fields } }),
    setStatus: (id, status) => req(id, { method: 'POST', body: { status } }),
    // daily_budget en Meta va en centavos (ARS, offset 100)
    setDailyBudget: (id, pesos) => req(id, { method: 'POST', body: { daily_budget: Math.round(pesos * 100) } }),
```

- [ ] **Step 5: `backend/src/agent/executor.js`**

```js
// Aplica en Meta las recomendaciones aprobadas. Nunca pisa un cambio manual: pre-chequea el estado actual.
const err = (status, msg) => Object.assign(new Error(msg), { status });

function adjust(rec, amount, config) {
  const pct = config.budget.maxChangePct / 100;
  const inRange = (v) => v >= config.budget.minDaily && v <= config.budget.maxDaily;
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw err(400, 'monto inválido');
  if (rec.type === 'budget') {
    const cur = rec.current_value.daily_budget;
    const up = rec.proposed_value.daily_budget > cur;
    if (up ? value <= cur : value >= cur) throw err(400, up ? 'el ajuste tiene que seguir subiendo el presupuesto' : 'el ajuste tiene que seguir bajando el presupuesto');
    if (Math.abs(value - cur) / cur > pct + 1e-9) throw err(400, `el cambio supera el tope de ±${config.budget.maxChangePct}%`);
    if (!inRange(value)) throw err(400, 'presupuesto fuera de los mínimos/máximos');
    return { daily_budget: value };
  }
  if (rec.type === 'shift') {
    const { from, to } = rec.current_value;
    if (value > from * pct + 1e-9 || value > to * pct + 1e-9) throw err(400, `el monto supera el tope de ${config.budget.maxChangePct}%`);
    if (!inRange(from - value) || !inRange(to + value)) throw err(400, 'algún presupuesto queda fuera de los mínimos/máximos');
    return { from: from - value, to: to + value };
  }
  throw err(400, 'este tipo de recomendación no admite monto');
}

export function createExecutor({ meta, recs, configRepo, now = () => new Date(), log = console }) {
  const budgetOf = async (id) => Number((await meta.getObject(id, 'daily_budget')).daily_budget) / 100;

  async function readState(rec) {
    if (rec.type === 'pause' || rec.type === 'reactivate') return { status: (await meta.getObject(rec.object_id, 'status')).status };
    if (rec.type === 'budget') return { daily_budget: await budgetOf(rec.object_id) };
    return { from: await budgetOf(rec.object_id), to: await budgetOf(rec.target_id) };
  }

  function sameState(type, expected, actual) {
    if (type === 'pause' || type === 'reactivate') return expected.status === actual.status;
    const close = (a, b) => Math.abs(a - b) < 1;
    if (type === 'budget') return close(expected.daily_budget, actual.daily_budget);
    return close(expected.from, actual.from) && close(expected.to, actual.to);
  }

  // revertTo: valores para deshacer la primera escritura de una reasignación si falla la segunda
  async function apply(rec, values, revertTo) {
    if (rec.type === 'pause' || rec.type === 'reactivate') return meta.setStatus(rec.object_id, values.status);
    if (rec.type === 'budget') return meta.setDailyBudget(rec.object_id, values.daily_budget);
    await meta.setDailyBudget(rec.object_id, values.from);
    try {
      await meta.setDailyBudget(rec.target_id, values.to);
    } catch (e) {
      try {
        await meta.setDailyBudget(rec.object_id, revertTo.from);
      } catch (revertErr) {
        log.error(`[executor] no se pudo revertir la reasignación #${rec.id}:`, revertErr);
      }
      throw e;
    }
    return undefined;
  }

  async function load(id) {
    const rec = await recs.get(id);
    if (!rec) throw err(404, 'recomendación no encontrada');
    return rec;
  }

  const fail = async (id, e) => {
    await recs.transition(id, ['approved'], 'failed', { execution_result: { error: e.message } });
    return { status: 'failed', error: e.message };
  };

  return {
    async approve(id, { amount } = {}) {
      const rec = await load(id);
      if (rec.type === 'idea') throw err(400, 'las ideas no se aprueban');
      if (rec.status !== 'pending') throw err(409, `la recomendación ya está ${rec.status}`);
      const config = await configRepo.get();
      const proposed = amount === undefined || amount === null ? rec.proposed_value : adjust(rec, amount, config);
      const claimed = await recs.transition(id, ['pending'], 'approved', { decided_at: now().toISOString(), proposed_value: proposed });
      if (!claimed) throw err(409, 'la recomendación ya fue resuelta');
      if (!config.executionEnabled) return { status: 'approved' };

      let actual;
      try {
        actual = await readState(rec);
      } catch (e) {
        return fail(id, e);
      }
      if (!sameState(rec.type, rec.current_value, actual)) {
        await recs.transition(id, ['approved'], 'stale', { execution_result: { reason: 'cambió en Meta desde la recomendación', actual } });
        return { status: 'stale' };
      }
      try {
        await apply(rec, proposed, rec.current_value);
      } catch (e) {
        return fail(id, e);
      }
      await recs.transition(id, ['approved'], 'executed', {
        executed_at: now().toISOString(),
        previous_value: rec.current_value,
        undo_until: new Date(now().getTime() + config.undoHours * 3600e3).toISOString(),
        execution_result: { applied: proposed },
      });
      return { status: 'executed' };
    },

    async reject(id, reason) {
      await load(id);
      const ok = await recs.transition(id, ['pending'], 'rejected', { decided_at: now().toISOString(), reject_reason: reason || null });
      if (!ok) throw err(409, 'la recomendación ya fue resuelta');
    },

    async markSeen(id) {
      const rec = await load(id);
      if (rec.type !== 'idea') throw err(400, 'solo las ideas se marcan como vistas');
      if (!(await recs.transition(id, ['pending'], 'seen', { decided_at: now().toISOString() }))) throw err(409, 'ya fue marcada');
    },

    async undo(id) {
      const rec = await load(id);
      if (rec.status !== 'executed' || rec.undone_at || !rec.undo_until || new Date(rec.undo_until) <= now()) {
        throw err(409, 'esta acción ya no se puede deshacer');
      }
      const applied = rec.execution_result?.applied || rec.proposed_value;
      await apply(rec, rec.previous_value, applied);
      if (!(await recs.transition(id, ['executed'], 'undone', { undone_at: now().toISOString() }))) throw err(409, 'ya fue deshecha');
      return { status: 'undone' };
    },

    async expire() {
      const config = await configRepo.get();
      return recs.expire({ now: now().toISOString(), hours: config.expireHours });
    },
  };
}
```

- [ ] **Step 6: Correr tests**

Run: `cd backend && npx vitest run test/executor.test.js test/meta.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/meta.js backend/src/agent/executor.js backend/test/executor.test.js backend/test/meta.test.js
git commit -m "feat: executor de recomendaciones con pre-chequeo, reversión y deshacer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Medición de resultados (3 y 7 días)

**Files:**
- Create: `backend/src/agent/outcomes.js`
- Test: `backend/test/outcomes.test.js`

**Interfaces:**
- Consumes: `recs.toMeasure` / `recs.setOutcome` (Task 5), `metrics.objectWindow` / `metrics.salesWindow` (Task 3), `artDate`/`addDays`.
- Produces: `createOutcomeMeter({ db, recs, metrics, now? }) → { measure() → number }` (cantidad de recomendaciones medidas en esta pasada).
  - Sujeto medido: pausa de anuncio/conjunto → su campaña; pausa de campaña → todas las campañas de ventas; reactivación y presupuesto → el objeto; reasignación → suma de ambas puntas.
  - Ventanas: `d0 = día ART de executed_at`; antes `[d0−7, d0−1]`; después `[d0+1, d0+N]` (N = 3 o 7), solo si `d0+N ≤ ayer`.
  - Métrica principal ROAS real. Veredicto `mejoro` (≥ +10%), `empeoro` (≤ −10%), `neutral`; sin gasto antes o después → `neutral` con `nota: 'sin datos suficientes'`; ROAS antes 0 y después > 0 → `mejoro`.
  - `outcome = { d3?: { before, after, change, verdict, nota? }, d7?: {...} }`; `verdict` de la fila = d7 si existe, si no d3.

- [ ] **Step 1: Tests `backend/test/outcomes.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createOrdersRepo } from '../src/repo/orders.js';
import { createMetaRepo } from '../src/repo/meta.js';
import { createReportsRepo } from '../src/repo/reports.js';
import { createAgentMetrics } from '../src/repo/agentMetrics.js';
import { createRecommendationsRepo } from '../src/repo/recommendations.js';
import { createOutcomeMeter } from '../src/agent/outcomes.js';
import { mapOrder } from '../src/engine/mapOrder.js';
import { attribute } from '../src/engine/attribution.js';

const row = (id, level, extra = {}) => ({
  id, level, name: `${level} ${id}`, status: 'ACTIVE', parent_id: null, campaign_id: null, thumbnail_url: null, url_tags: null,
  has_attribution_params: false, objective: null, daily_budget: null, is_cbo: false, created_time: null, learning_status: null, status_updated_at: null, ...extra,
});
const spend = (ad, adset, camp, date, s) => ({ ad_id: ad, adset_id: adset, campaign_id: camp, date, spend: s, impressions: 1, clicks: 1, meta_purchases: 0, meta_purchase_value: 0 });

let db; let recs; let meter;
beforeAll(async () => {
  db = await createTestDb();
  const meta = createMetaRepo(db);
  await meta.upsertAds([
    row('2000001', 'campaign', { campaign_id: '2000001', objective: 'OUTCOME_SALES' }),
    row('3000001', 'adset', { parent_id: '2000001', campaign_id: '2000001' }),
    row('1000001', 'ad', { parent_id: '3000001', campaign_id: '2000001' }),
  ]);
  await meta.upsertSpend([spend('1000001', '3000001', '2000001', '2026-09-25', 500), spend('1000001', '3000001', '2000001', '2026-10-01', 1000)]);
  const orders = createOrdersRepo(db);
  for (const o of [
    { id: 1, at: '2026-10-01T15:00:00+0000', total: 4000 },
    { id: 2, at: '2026-10-04T15:00:00+0000', total: 2000 },
  ]) {
    const m = mapOrder({ id: o.id, number: o.id, status: 'open', payment_status: 'paid', created_at: o.at, total: String(o.total), products: [],
      customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_content=1000001', utm_parameters: {} } });
    await orders.upsert({ ...m, attribution: attribute(m.visit) });
  }
  recs = createRecommendationsRepo(db);
  const metrics = createAgentMetrics({ db, reports: createReportsRepo(db) });
  meter = createOutcomeMeter({ db, recs, metrics, now: () => new Date('2026-10-06T12:00:00Z') });
});
afterAll(() => db.close());

const executed = async (rec, executedAt) => {
  const id = await recs.create({ title: 't', reasoning: 'r', confidence: 'alta', ...rec });
  await recs.transition(id, ['pending'], 'executed', { executed_at: executedAt });
  return id;
};

describe('outcomeMeter', () => {
  it('pausa de anuncio se mide sobre su campaña a 3 y 7 días', async () => {
    const id = await executed({ type: 'pause', level: 'ad', object_id: '1000001' }, '2026-09-28T15:00:00Z');
    const n = await meter.measure();
    expect(n).toBe(1);
    const r = await recs.get(id);
    expect(r.outcome.d3).toMatchObject({ before: { spend: 500, sales: 0 }, after: { spend: 1000, sales: 1, revenue: 4000 }, verdict: 'mejoro' });
    expect(r.outcome.d7).toMatchObject({ after: { spend: 1000, sales: 2, revenue: 6000 }, verdict: 'mejoro' });
    expect(r.verdict).toBe('mejoro');
  });
  it('lo ejecutado hace poco todavía no se mide', async () => {
    const id = await executed({ type: 'budget', level: 'campaign', object_id: '2000001' }, '2026-10-04T15:00:00Z');
    await meter.measure();
    expect((await recs.get(id)).outcome).toBeNull();
  });
  it('sin gasto antes → neutral con nota', async () => {
    const id = await executed({ type: 'budget', level: 'campaign', object_id: '9999999' }, '2026-09-20T15:00:00Z');
    await meter.measure();
    expect((await recs.get(id)).outcome.d7).toMatchObject({ verdict: 'neutral', nota: 'sin datos suficientes' });
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/outcomes.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/agent/outcomes.js`**

```js
import { artDate, addDays } from '../engine/dates.js';

const THRESHOLD = 0.1;
const roasOf = (w) => (w.spend > 0 ? w.revenue / w.spend : null);
const sum = (a, b) => ({ spend: a.spend + b.spend, sales: a.sales + b.sales, revenue: a.revenue + b.revenue });

function judge(before, after) {
  const rb = roasOf(before);
  const ra = roasOf(after);
  if (rb === null || ra === null) return { change: null, verdict: 'neutral', nota: 'sin datos suficientes' };
  if (rb === 0) return { change: null, verdict: ra > 0 ? 'mejoro' : 'neutral' };
  const change = (ra - rb) / rb;
  return { change, verdict: change >= THRESHOLD ? 'mejoro' : change <= -THRESHOLD ? 'empeoro' : 'neutral' };
}

export function createOutcomeMeter({ db, recs, metrics, now = () => new Date() }) {
  async function campaignOf(id) {
    const { rows } = await db.query('SELECT campaign_id FROM meta_ads WHERE id = $1', [id]);
    return rows[0]?.campaign_id || null;
  }

  async function subject(rec, window) {
    if (rec.type === 'pause') {
      if (rec.level === 'campaign') return metrics.salesWindow(window);
      const campaignId = await campaignOf(rec.object_id);
      return campaignId ? metrics.objectWindow({ level: 'campaign', id: campaignId, ...window }) : { spend: 0, sales: 0, revenue: 0 };
    }
    if (rec.type === 'shift') {
      return sum(
        await metrics.objectWindow({ level: rec.level, id: rec.object_id, ...window }),
        await metrics.objectWindow({ level: rec.level, id: rec.target_id, ...window }),
      );
    }
    return metrics.objectWindow({ level: rec.level, id: rec.object_id, ...window });
  }

  return {
    async measure() {
      const yesterday = addDays(artDate(now()), -1);
      let measured = 0;
      for (const rec of await recs.toMeasure({ now: now().toISOString() })) {
        const d0 = artDate(rec.executed_at);
        const outcome = { ...(rec.outcome || {}) };
        let changed = false;
        for (const n of [3, 7]) {
          const key = `d${n}`;
          if (outcome[key] || addDays(d0, n) > yesterday) continue;
          const before = await subject(rec, { from: addDays(d0, -7), to: addDays(d0, -1) });
          const after = await subject(rec, { from: addDays(d0, 1), to: addDays(d0, n) });
          outcome[key] = { before, after, ...judge(before, after) };
          changed = true;
        }
        if (changed) {
          await recs.setOutcome(rec.id, outcome, (outcome.d7 || outcome.d3).verdict);
          measured += 1;
        }
      }
      return measured;
    },
  };
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/outcomes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/outcomes.js backend/test/outcomes.test.js
git commit -m "feat: medición de resultados de recomendaciones ejecutadas a 3 y 7 días

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: API del agente, wiring y crons

**Files:**
- Create: `backend/src/routes/agent.js`
- Modify: `backend/src/index.js`, `backend/.env.example`, `README.md`
- Test: `backend/test/agentApi.test.js`

**Interfaces:**
- Consumes: runner (Task 7), executor (Task 8), meter (Task 9), repos (Tasks 2, 5), `buildDataset`/`createAgentMetrics` (Task 3).
- Produces (todas bajo `/api`, con auth):
  - `GET /agent/overview → { lastRun, running, pendingCount, manualRemaining, monthCostUsd, monthlyBudgetUsd, agentEnabled, executionEnabled, precision }`
  - `POST /agent/run → 202 { started: true } | 409 (corriendo) | 429 (sin cupo)`
  - `GET /recommendations?group=pending|history&type=&before= → row[]`
  - `GET /recommendations/refs → [{ id, object_id, target_id }]` (pendientes, para la pestaña Anuncios)
  - `GET /recommendations/:id`
  - `POST /recommendations/:id/approve { amount? }` · `/reject { reason? }` · `/undo` · `/seen`
  - `GET /learnings` · `DELETE /learnings/:id`
  - `GET /agent/config` · `PUT /agent/config`
  - Errores del dominio con `.status` 400/404/409/429 se devuelven como `{ error }` con ese status.
  - Crons ART: 08:00 sync catálogo + gasto y corrida del agente; 09:00 medición; minuto 30 de cada hora vence pendientes.
  - Env nueva: `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Tests `backend/test/agentApi.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAgentRouter } from '../src/routes/agent.js';
import { createAuthMiddleware } from '../src/routes/authMiddleware.js';

const domainError = (status, msg) => Object.assign(new Error(msg), { status });

function setup(over = {}) {
  const deps = {
    runner: { run: vi.fn().mockResolvedValue({}), quotaLeft: vi.fn().mockResolvedValue(2), isRunning: vi.fn().mockReturnValue(false) },
    executor: {
      approve: vi.fn().mockResolvedValue({ status: 'executed' }), reject: vi.fn().mockResolvedValue(), undo: vi.fn().mockResolvedValue({ status: 'undone' }),
      markSeen: vi.fn().mockResolvedValue(),
    },
    recs: {
      list: vi.fn().mockResolvedValue([{ id: 1 }]), get: vi.fn().mockResolvedValue(null), countPending: vi.fn().mockResolvedValue(3),
      precision: vi.fn().mockResolvedValue([]), pendingRefs: vi.fn().mockResolvedValue([{ id: 1, object_id: 'A', target_id: null }]),
    },
    runs: { last: vi.fn().mockResolvedValue(null), costSince: vi.fn().mockResolvedValue(1.5) },
    learnings: { listActive: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue() },
    configRepo: { get: vi.fn().mockResolvedValue({ monthlyBudgetUsd: 20, agentEnabled: true, executionEnabled: false }), update: vi.fn().mockResolvedValue({}) },
    now: () => new Date('2026-10-06T12:00:00Z'),
    ...over,
  };
  const app = createApp({ apiRouter: [createAuthMiddleware({ password: 'pw' }), createAgentRouter(deps)] });
  const call = (method, url, body) => request(app)[method](url).set('authorization', 'Bearer pw').send(body);
  return { deps, call };
}

describe('API del agente', () => {
  it('overview junta estado, cupo y costo del mes', async () => {
    const { call, deps } = setup();
    const res = await call('get', '/api/agent/overview');
    expect(res.body).toMatchObject({ pendingCount: 3, manualRemaining: 2, monthCostUsd: 1.5, monthlyBudgetUsd: 20, executionEnabled: false, running: false });
    expect(deps.runs.costSince).toHaveBeenCalledWith('2026-10-01T00:00:00-03:00');
  });
  it('run: 202 en segundo plano; 429 sin cupo; 409 si ya corre', async () => {
    const { call, deps } = setup();
    expect((await call('post', '/api/agent/run')).status).toBe(202);
    expect(deps.runner.run).toHaveBeenCalledWith({ trigger: 'manual' });
    deps.runner.quotaLeft.mockResolvedValue(0);
    expect((await call('post', '/api/agent/run')).status).toBe(429);
    deps.runner.isRunning.mockReturnValue(true);
    expect((await call('post', '/api/agent/run')).status).toBe(409);
  });
  it('lista por grupo y tipo; valida parámetros', async () => {
    const { call, deps } = setup();
    await call('get', '/api/recommendations?group=history&type=pause&before=10');
    expect(deps.recs.list).toHaveBeenCalledWith({
      statuses: ['approved', 'executed', 'failed', 'rejected', 'expired', 'stale', 'undone', 'seen'], type: 'pause', beforeId: 10, limit: 50,
    });
    expect((await call('get', '/api/recommendations?group=otra')).status).toBe(400);
    expect((await call('get', '/api/recommendations?type=borrar')).status).toBe(400);
  });
  it('refs no choca con /:id; detalle inexistente → 404', async () => {
    const { call } = setup();
    expect((await call('get', '/api/recommendations/refs')).body).toEqual([{ id: 1, object_id: 'A', target_id: null }]);
    expect((await call('get', '/api/recommendations/5')).status).toBe(404);
    expect((await call('get', '/api/recommendations/abc')).status).toBe(404);
  });
  it('approve pasa el monto y mapea errores del dominio', async () => {
    const { call, deps } = setup();
    expect((await call('post', '/api/recommendations/7/approve', { amount: 55000 })).body).toEqual({ status: 'executed' });
    expect(deps.executor.approve).toHaveBeenCalledWith(7, { amount: 55000 });
    deps.executor.approve.mockRejectedValueOnce(domainError(409, 'ya fue resuelta'));
    const r = await call('post', '/api/recommendations/7/approve', {});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'ya fue resuelta' });
  });
  it('reject, undo, seen, lecciones y config', async () => {
    const { call, deps } = setup();
    await call('post', '/api/recommendations/7/reject', { reason: 'Está en lanzamiento' });
    expect(deps.executor.reject).toHaveBeenCalledWith(7, 'Está en lanzamiento');
    expect((await call('post', '/api/recommendations/7/reject', { reason: 'x'.repeat(301) })).status).toBe(400);
    expect((await call('post', '/api/recommendations/7/undo')).body).toEqual({ status: 'undone' });
    await call('post', '/api/recommendations/7/seen');
    expect(deps.executor.markSeen).toHaveBeenCalledWith(7);
    await call('delete', '/api/learnings/4');
    expect(deps.learnings.remove).toHaveBeenCalledWith(4);
    deps.configRepo.update.mockRejectedValueOnce(domainError(400, 'effort inválido'));
    expect((await call('put', '/api/agent/config', { effort: 'mucho' })).status).toBe(400);
  });
  it('error inesperado → 500 genérico', async () => {
    const { call, deps } = setup();
    deps.recs.countPending.mockRejectedValueOnce(new Error('db caída'));
    const r = await call('get', '/api/agent/overview');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'error interno' });
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd backend && npx vitest run test/agentApi.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: `backend/src/routes/agent.js`**

```js
import express from 'express';
import { artDate } from '../engine/dates.js';

const GROUPS = {
  pending: ['pending'],
  history: ['approved', 'executed', 'failed', 'rejected', 'expired', 'stale', 'undone', 'seen'],
};
const TYPES = new Set(['pause', 'reactivate', 'budget', 'shift', 'idea']);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('no encontrado'), { status: 404 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const idParam = (req) => {
  if (!/^\d+$/.test(req.params.id)) throw notFound();
  return Number(req.params.id);
};

export function createAgentRouter({ runner, executor, recs, runs, learnings, configRepo, now = () => new Date() }) {
  const router = express.Router();

  router.get('/agent/overview', wrap(async (_req, res) => {
    const config = await configRepo.get();
    const monthStart = `${artDate(now()).slice(0, 7)}-01T00:00:00-03:00`;
    res.json({
      lastRun: await runs.last(),
      running: runner.isRunning(),
      pendingCount: await recs.countPending(),
      manualRemaining: await runner.quotaLeft(),
      monthCostUsd: await runs.costSince(monthStart),
      monthlyBudgetUsd: config.monthlyBudgetUsd,
      agentEnabled: config.agentEnabled,
      executionEnabled: config.executionEnabled,
      precision: await recs.precision(),
    });
  }));

  router.post('/agent/run', wrap(async (_req, res) => {
    if (runner.isRunning()) return res.status(409).json({ error: 'Ya hay un análisis corriendo' });
    if ((await runner.quotaLeft()) <= 0) return res.status(429).json({ error: 'No quedan análisis manuales por hoy' });
    runner.run({ trigger: 'manual' }).catch(() => {}); // el error queda registrado en agent_runs
    res.status(202).json({ started: true });
  }));

  router.get('/recommendations', wrap(async (req, res) => {
    const group = req.query.group || 'pending';
    if (!GROUPS[group]) throw badRequest('group inválido');
    if (req.query.type && !TYPES.has(req.query.type)) throw badRequest('type inválido');
    if (req.query.before && !/^\d+$/.test(req.query.before)) throw badRequest('before inválido');
    res.json(await recs.list({
      statuses: GROUPS[group], type: req.query.type || undefined,
      beforeId: req.query.before ? Number(req.query.before) : undefined, limit: 50,
    }));
  }));

  router.get('/recommendations/refs', wrap(async (_req, res) => res.json(await recs.pendingRefs())));

  router.get('/recommendations/:id', wrap(async (req, res) => {
    const rec = await recs.get(idParam(req));
    if (!rec) throw notFound();
    res.json(rec);
  }));

  router.post('/recommendations/:id/approve', wrap(async (req, res) => {
    res.json(await executor.approve(idParam(req), { amount: req.body?.amount }));
  }));

  router.post('/recommendations/:id/reject', wrap(async (req, res) => {
    const reason = req.body?.reason ?? null;
    if (reason !== null && (typeof reason !== 'string' || reason.length > 300)) throw badRequest('motivo inválido (máx. 300 caracteres)');
    await executor.reject(idParam(req), reason);
    res.json({ status: 'rejected' });
  }));

  router.post('/recommendations/:id/undo', wrap(async (req, res) => res.json(await executor.undo(idParam(req)))));

  router.post('/recommendations/:id/seen', wrap(async (req, res) => {
    await executor.markSeen(idParam(req));
    res.json({ status: 'seen' });
  }));

  router.get('/learnings', wrap(async (_req, res) => res.json(await learnings.listActive())));
  router.delete('/learnings/:id', wrap(async (req, res) => {
    await learnings.remove(idParam(req));
    res.json({ ok: true });
  }));

  router.get('/agent/config', wrap(async (_req, res) => res.json(await configRepo.get())));
  router.put('/agent/config', wrap(async (req, res) => res.json(await configRepo.update(req.body))));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if ([400, 404, 409, 429].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error('[api agente]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return router;
}
```

- [ ] **Step 4: Correr tests**

Run: `cd backend && npx vitest run test/agentApi.test.js`
Expected: PASS.

- [ ] **Step 5: Wiring en `backend/src/index.js`**

Agregar imports:

```js
import Anthropic from '@anthropic-ai/sdk';
import { createAgentConfigRepo } from './repo/agentConfig.js';
import { createAgentMetrics } from './repo/agentMetrics.js';
import { createRecommendationsRepo, createAgentRunsRepo, createLearningsRepo } from './repo/recommendations.js';
import { buildDataset } from './agent/dataset.js';
import { createAgentRunner } from './agent/runner.js';
import { createExecutor } from './agent/executor.js';
import { createOutcomeMeter } from './agent/outcomes.js';
import { createAgentRouter } from './routes/agent.js';
```

Después de crear `jobCatalog`, agregar:

```js
const configRepo = createAgentConfigRepo(db);
const recsRepo = createRecommendationsRepo(db);
const agentRuns = createAgentRunsRepo(db);
const learningsRepo = createLearningsRepo(db);
const agentMetrics = createAgentMetrics({ db, reports });
const runner = createAgentRunner({
  anthropic: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }),
  configRepo, runs: agentRuns, recs: recsRepo, learnings: learningsRepo,
  loadDataset: () => buildDataset({ db, metrics: agentMetrics, today: artDate() }),
});
const executor = createExecutor({ meta, recs: recsRepo, configRepo });
const meter = createOutcomeMeter({ db, recs: recsRepo, metrics: agentMetrics });
```

En `createApp`, sumar el router del agente al final del array `apiRouter`:

```js
    createAgentRouter({ runner, executor, recs: recsRepo, runs: agentRuns, learnings: learningsRepo, configRepo }),
```

Y los crons, después de los existentes:

```js
// Análisis diario del agente: datos frescos de Meta y corrida (08:00 ART)
cron.schedule('0 8 * * *', async () => {
  await runJob('meta-catalog');
  await runJob('meta-spend');
  await runner.run({ trigger: 'cron' }).catch(() => {});
}, TZ);
// Resultados de lo ejecutado (09:00 ART) y vencimiento de pendientes (cada hora)
cron.schedule('0 9 * * *', () => meter.measure().catch((e) => console.error('[agente] medición falló:', e)), TZ);
cron.schedule('30 * * * *', () => executor.expire().catch((e) => console.error('[agente] vencimiento falló:', e)), TZ);
```

En `backend/.env.example` agregar:

```
# Agente de recomendaciones (Claude)
ANTHROPIC_API_KEY=
```

En `README.md`, sección "Variables de entorno", agregar `ANTHROPIC_API_KEY`, y una sección:

```markdown
## Agente de recomendaciones
Corre todos los días a las 08:00 (ART) y con "Analizar ahora" (2 por día). Solo recomienda: ejecuta en Meta
al aprobar y solo si "Ejecución habilitada" está activo en Agente → Configuración (arranca apagado).
Spec: `docs/superpowers/specs/2026-10-06-altorancho-agente-recomendaciones-design.md`.
```

- [ ] **Step 6: Suite completa y sintaxis**

Run: `cd backend && node --check src/index.js && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/agent.js backend/src/index.js backend/.env.example README.md backend/test/agentApi.test.js
git commit -m "feat: API del agente, wiring y crons de análisis, medición y vencimiento

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Pestaña "Agente" en la PWA

**Files:**
- Create: `frontend/src/components/RecommendationCard.jsx`, `frontend/src/pages/Agente.jsx`
- Modify: `frontend/src/App.jsx` (ruta `/agente`), `frontend/src/components/Layout.jsx` (4ª pestaña + globito), `frontend/src/pages/Anuncios.jsx` (marca de recomendación pendiente), `frontend/src/styles.css`
- Test: `frontend/test/agente.test.jsx`, `frontend/test/layout.test.jsx` (ajuste)

**Interfaces:**
- Consumes: API de Task 10. Filas de recomendación con `{ id, type, status, level, object_id, target_id, object_name, target_name, title, reasoning, expected_impact, confidence, dudoso_atribucion, signal, current_value, proposed_value, snapshot, decided_at, reject_reason, executed_at, undo_until, outcome, verdict, created_at }`.
- Produces: `<RecommendationCard rec onApprove(amount?) onReject(reason) busy />`; página `/agente` con pestañas internas `pendientes | historial | aprendizaje | config`.

- [ ] **Step 1: Tests `frontend/test/agente.test.jsx`**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Agente from '../src/pages/Agente.jsx';

const m7 = { spend: 210000, sales: 0, revenue: 0, roas: null, cpa: null, metaPurchases: 1, metaValue: 50000 };
const pause = {
  id: 1, type: 'pause', status: 'pending', level: 'ad', object_id: 'A', object_name: 'Anuncio sillas', title: 'Pausar Anuncio sillas: gastó $210.000 sin ventas',
  reasoning: 'Lleva 7 días sin ventas reales.', expected_impact: 'Ahorra ~$30.000 por día', confidence: 'alta', dudoso_atribucion: false,
  current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' }, snapshot: { m7 }, created_at: '2026-10-06T11:00:00Z',
};
const budget = {
  ...pause, id: 2, type: 'budget', object_id: 'G', object_name: 'Campaña DPA', title: 'Subir Campaña DPA', confidence: 'media',
  current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 }, snapshot: { m7: { ...m7, sales: 9, revenue: 900000, roas: 4.3 } },
};
const idea = { ...pause, id: 3, type: 'idea', title: 'Renovar creativo de lámparas', reasoning: 'El CTR cayó 40%.', current_value: null, proposed_value: null };
const executed = {
  ...pause, id: 4, status: 'executed', decided_at: '2026-10-05T12:00:00Z', executed_at: '2026-10-05T12:00:00Z',
  undo_until: new Date(Date.now() + 3600e3).toISOString(), verdict: 'mejoro', outcome: { d3: { change: 0.25, verdict: 'mejoro' } },
};
const overview = (o = {}) => ({
  lastRun: { started_at: '2026-10-06T11:00:00Z', status: 'ok', candidates_count: 14, cost_usd: 0.14 }, running: false, pendingCount: 2,
  manualRemaining: 2, monthCostUsd: 1.2, monthlyBudgetUsd: 20, agentEnabled: true, executionEnabled: false,
  precision: [{ type: 'pause', good: 8, total: 10 }], ...o,
});
const config = {
  agentEnabled: true, executionEnabled: false, autoByType: { pause: false, reactivate: false, budget: false, shift: false },
  monthlyBudgetUsd: 20, manualRunsPerDay: 2, expireHours: 48, budget: { maxChangePct: 20, minDaily: 1000, maxDaily: 5000000 },
  thresholds: { noSalesSpendMultiple: 2, expensiveRoasRatio: 0.5, winnerRoasRatio: 1.5, winnerMinSales: 3 },
};

function setup(over = {}) {
  const api = {
    get: vi.fn(async (path) => {
      if (path === '/agent/overview') return over.overview || overview();
      if (path.startsWith('/recommendations?group=pending')) return [pause, budget, idea];
      if (path.startsWith('/recommendations?group=history')) return [executed];
      if (path === '/learnings') return [{ id: 9, text: 'Las DPA venden tarde', evidence_ids: [1, 2, 3] }];
      if (path === '/agent/config') return config;
      return null;
    }),
    post: vi.fn().mockResolvedValue({ status: 'approved' }),
    put: vi.fn().mockResolvedValue(config),
    del: vi.fn().mockResolvedValue({ ok: true }),
  };
  render(<MemoryRouter><Agente api={api} /></MemoryRouter>);
  return api;
}

describe('Agente — Pendientes', () => {
  it('cabecera con último análisis, cupo y aviso de ejecución apagada', async () => {
    setup();
    expect(await screen.findByText(/14 candidatos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /analizar ahora \(te quedan 2\)/i })).toBeEnabled();
    expect(screen.getByText(/ejecución está apagada/i)).toBeInTheDocument();
  });
  it('sin cupo el botón queda deshabilitado', async () => {
    setup({ overview: overview({ manualRemaining: 0 }) });
    expect(await screen.findByRole('button', { name: /disponible mañana/i })).toBeDisabled();
  });
  it('analizar ahora llama a la API', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /analizar ahora/i }));
    expect(api.post).toHaveBeenCalledWith('/agent/run');
  });
  it('tarjetas: aprobar una pausa', async () => {
    const api = setup();
    const card = (await screen.findByText(/pausar anuncio sillas/i)).closest('article');
    expect(within(card).getByText('Pausar')).toBeInTheDocument();
    expect(within(card).getByText('Alta')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /aprobar/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/1/approve', {});
  });
  it('presupuesto: se puede ajustar el monto antes de aprobar', async () => {
    const api = setup();
    const card = (await screen.findByText('Subir Campaña DPA')).closest('article');
    const input = within(card).getByLabelText(/nuevo presupuesto diario/i);
    await userEvent.clear(input);
    await userEvent.type(input, '55000');
    await userEvent.click(within(card).getByRole('button', { name: /aprobar/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/2/approve', { amount: 55000 });
  });
  it('rechazar con motivo rápido', async () => {
    const api = setup();
    const card = (await screen.findByText(/pausar anuncio sillas/i)).closest('article');
    await userEvent.click(within(card).getByRole('button', { name: /rechazar/i }));
    await userEvent.click(within(card).getByRole('button', { name: /está en lanzamiento/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/1/reject', { reason: 'Está en lanzamiento' });
  });
  it('ideas se listan aparte y se marcan como vistas', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /^vista$/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/3/seen');
  });
});

describe('Agente — otras pestañas', () => {
  it('historial muestra resultado y permite deshacer', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /historial/i }));
    expect(await screen.findByText('Ejecutada')).toBeInTheDocument();
    expect(screen.getByText(/mejoró \+25%/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /deshacer/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/4/undo');
  });
  it('aprendizaje: precisión y lecciones borrables', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /aprendizaje/i }));
    expect(await screen.findByText(/8 de 10 mejoraron/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /borrar/i }));
    expect(api.del).toHaveBeenCalledWith('/learnings/9');
  });
  it('configuración: guardar interruptores y umbrales', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /configuración/i }));
    await userEvent.click(await screen.findByLabelText(/ejecución habilitada/i));
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/agent/config', expect.objectContaining({ executionEnabled: true })));
  });
});
```

- [ ] **Step 2: Ajustar `frontend/test/layout.test.jsx`**

El fake de `api.get` del Layout ahora recibe también `/agent/overview`. Reemplazar `const api = { get: vi.fn().mockResolvedValue(status(12)) };` (y su equivalente con 200) por:

```jsx
    const api = { get: vi.fn(async (p) => (p === '/agent/overview' ? { pendingCount: 3 } : status(12))) };
```

(con `status(200)` en el segundo test) y agregar en el primer test:

```jsx
    expect(screen.getByRole('link', { name: /agente/i })).toHaveAttribute('href', '/agente');
    await waitFor(() => expect(screen.getByLabelText('3 pendientes')).toBeInTheDocument());
```

- [ ] **Step 3: Correr para verificar que fallan**

Run: `cd frontend && npx vitest run test/agente.test.jsx test/layout.test.jsx`
Expected: FAIL.

- [ ] **Step 4: Estilos — agregar a `frontend/src/styles.css`**

```css
.tabs { display: flex; gap: 6px; margin-bottom: 14px; overflow-x: auto; }
.rec { border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
.rec-head { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.rec-title { font-weight: 600; font-size: 15px; }
.rec-object { font-size: 12px; color: var(--muted); margin-top: 2px; }
.rec-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; font-size: 13px; }
.rec-grid dt { color: var(--muted); font-size: 11px; }
.rec details { font-size: 13px; margin-top: 6px; }
.rec details summary { cursor: pointer; color: var(--muted); }
.amount { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); margin-top: 8px; }
.amount input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 15px; color: var(--text); }
.reasons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.nav-badge { position: absolute; top: 6px; margin-left: 18px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--warn); color: #fff; font-size: 10px; line-height: 16px; text-align: center; }
.bottom-nav a { position: relative; }
.form-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
.form-row input[type=number] { width: 110px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; text-align: right; }
.banner { padding: 10px 12px; border-radius: 10px; background: var(--soft); font-size: 13px; margin-bottom: 12px; }
```

- [ ] **Step 5: `frontend/src/components/RecommendationCard.jsx`**

```jsx
import { useState } from 'react';
import { fmtMoney, fmtNumber, fmtRoas } from '../lib/format.js';

export const TYPE_LABEL = { pause: 'Pausar', reactivate: 'Reactivar', budget: 'Presupuesto', shift: 'Reasignar', idea: 'Idea' };
const CONF = { alta: { label: 'Alta', color: '#1E9E5A' }, media: { label: 'Media', color: '#F29900' }, baja: { label: 'Baja', color: '#8A8A8A' } };
export const REJECT_REASONS = ['No es momento', 'Está en lanzamiento', 'No estoy de acuerdo', 'Otro'];

function initialAmount(rec) {
  if (rec.type === 'budget') return rec.proposed_value.daily_budget;
  if (rec.type === 'shift') return rec.current_value.from - rec.proposed_value.from;
  return null;
}

export default function RecommendationCard({ rec, onApprove, onReject, busy }) {
  const [amount, setAmount] = useState(initialAmount(rec));
  const [rejecting, setRejecting] = useState(false);
  const m = rec.snapshot?.m7 || rec.snapshot?.from?.m7;
  const conf = CONF[rec.confidence] || CONF.media;
  const editable = rec.type === 'budget' || rec.type === 'shift';
  const changed = editable && Number(amount) !== initialAmount(rec);

  return (
    <article className="rec">
      <div className="rec-head">
        <span className="tag" style={{ '--tag': '#353434' }}>{TYPE_LABEL[rec.type]}</span>
        <span className="tag" style={{ '--tag': conf.color }}>{conf.label}</span>
        {rec.dudoso_atribucion && <span className="badge warn">Atribución dudosa</span>}
      </div>
      <div className="rec-title">{rec.title}</div>
      {(rec.object_name || rec.object_id) && (
        <div className="rec-object">{rec.object_name || rec.object_id}{rec.target_id ? ` → ${rec.target_name || rec.target_id}` : ''}</div>
      )}
      {m && (
        <dl className="rec-grid">
          <div><dt>Gasto 7 días</dt><dd>{fmtMoney(m.spend)}</dd></div>
          <div><dt>Ventas reales</dt><dd>{fmtNumber(m.sales)} <span className="muted">· Meta dice {fmtNumber(m.metaPurchases)}</span></dd></div>
          <div><dt>ROAS real</dt><dd>{fmtRoas(m.roas)}</dd></div>
          <div><dt>Costo por venta</dt><dd>{fmtMoney(m.cpa)}</dd></div>
        </dl>
      )}
      {rec.type === 'budget' && <p className="note">Presupuesto diario: {fmtMoney(rec.current_value.daily_budget)} → {fmtMoney(Number(amount))}</p>}
      {rec.type === 'shift' && (
        <p className="note">
          Mover {fmtMoney(Number(amount))} por día: {fmtMoney(rec.current_value.from)} → {fmtMoney(rec.current_value.from - Number(amount))} y{' '}
          {fmtMoney(rec.current_value.to)} → {fmtMoney(rec.current_value.to + Number(amount))}
        </p>
      )}
      {rec.expected_impact && <p className="note">Impacto esperado: {rec.expected_impact}</p>}
      <details>
        <summary>Por qué</summary>
        <p>{rec.reasoning}</p>
      </details>
      {editable && (
        <label className="amount">
          {rec.type === 'budget' ? 'Nuevo presupuesto diario ($)' : 'Monto a mover por día ($)'}
          <input type="number" inputMode="numeric" value={amount ?? ''} onChange={(e) => setAmount(e.target.value)} />
        </label>
      )}
      {!rejecting ? (
        <div className="actions">
          <button type="button" className="btn" disabled={busy || (editable && !(Number(amount) > 0))}
            onClick={() => onApprove(changed ? Number(amount) : undefined)}>Aprobar</button>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => setRejecting(true)}>Rechazar</button>
        </div>
      ) : (
        <div className="reasons">
          {REJECT_REASONS.map((r) => (
            <button key={r} type="button" className="chip" disabled={busy} onClick={() => onReject(r === 'Otro' ? null : r)}>{r}</button>
          ))}
          <button type="button" className="chip" onClick={() => setRejecting(false)}>Cancelar</button>
        </div>
      )}
    </article>
  );
}
```

- [ ] **Step 6: `frontend/src/pages/Agente.jsx`**

```jsx
import { useState, useCallback, useEffect } from 'react';
import RecommendationCard, { TYPE_LABEL } from '../components/RecommendationCard.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtDateTime, fmtRelative } from '../lib/format.js';

const TABS = [
  { id: 'pendientes', label: 'Pendientes' },
  { id: 'historial', label: 'Historial' },
  { id: 'aprendizaje', label: 'Aprendizaje' },
  { id: 'config', label: 'Configuración' },
];
const STATUS_LABEL = {
  pending: 'Pendiente', approved: 'Aprobada (sin ejecutar)', executed: 'Ejecutada', failed: 'Falló', rejected: 'Rechazada',
  expired: 'Vencida', stale: 'Desactualizada', undone: 'Deshecha', seen: 'Vista',
};
const VERDICT = { mejoro: 'Mejoró', neutral: 'Neutral', empeoro: 'Empeoró' };

function verdictText(rec) {
  if (!rec.verdict) return null;
  const o = rec.outcome?.d7 || rec.outcome?.d3;
  const pct = o?.change === null || o?.change === undefined ? '' : ` ${o.change >= 0 ? '+' : ''}${Math.round(o.change * 100)}%`;
  return `${VERDICT[rec.verdict]}${pct}`;
}

function Pendientes({ api, overview, reloadOverview }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const { data: recs, reload } = usePolling(() => api.get('/recommendations?group=pending'), [api], 60_000);

  const act = useCallback(async (id, fn) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      reload();
      reloadOverview();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, [reload, reloadOverview]);

  const runNow = () => act('run', () => api.post('/agent/run'));
  const actions = (recs || []).filter((r) => r.type !== 'idea');
  const ideas = (recs || []).filter((r) => r.type === 'idea');
  const last = overview?.lastRun;
  const left = overview?.manualRemaining ?? 0;

  return (
    <>
      {overview && (
        <div className="banner">
          {last ? `Último análisis: ${fmtDateTime(last.started_at)} · ${last.candidates_count} candidatos · USD ${Number(last.cost_usd).toFixed(2)}` : 'Todavía no hubo análisis.'}
          {last?.status === 'error' && <div className="error">El último análisis falló.</div>}
          {!overview.executionEnabled && <div>La ejecución está apagada: aprobar solo registra la decisión (se activa en Configuración).</div>}
        </div>
      )}
      <div className="actions" style={{ marginBottom: 12 }}>
        <button type="button" className="btn secondary" disabled={left <= 0 || overview?.running || busy === 'run'} onClick={runNow}>
          {overview?.running ? 'Analizando…' : left > 0 ? `Analizar ahora (te quedan ${left})` : 'Disponible mañana'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {recs && actions.length === 0 && <p className="muted">No hay recomendaciones pendientes.</p>}
      {actions.map((r) => (
        <RecommendationCard key={r.id} rec={r} busy={busy === r.id}
          onApprove={(amount) => act(r.id, () => api.post(`/recommendations/${r.id}/approve`, amount === undefined ? {} : { amount }))}
          onReject={(reason) => act(r.id, () => api.post(`/recommendations/${r.id}/reject`, { reason }))} />
      ))}
      {ideas.length > 0 && (
        <>
          <h2 className="section-title">Ideas</h2>
          <ul className="list">
            {ideas.map((r) => (
              <li key={r.id} className="row">
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: 'normal' }}>{r.title}</div>
                  <div className="note">{r.reasoning}</div>
                </div>
                <div className="row-side">
                  <button type="button" className="chip" disabled={busy === r.id} onClick={() => act(r.id, () => api.post(`/recommendations/${r.id}/seen`))}>Vista</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Historial({ api }) {
  const [type, setType] = useState('');
  const [error, setError] = useState(null);
  const { data: recs, reload } = usePolling(() => api.get(`/recommendations?group=history${type ? `&type=${type}` : ''}`), [api, type], 120_000);
  const undo = async (id) => {
    setError(null);
    try {
      await api.post(`/recommendations/${id}/undo`);
      reload();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <>
      <div className="chips" style={{ marginBottom: 10 }}>
        {[['', 'Todas'], ...Object.entries(TYPE_LABEL)].map(([id, label]) => (
          <button key={id || 'all'} type="button" className={type === id ? 'chip active' : 'chip'} onClick={() => setType(id)}>{label}</button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {(recs || []).map((r) => {
          const canUndo = r.status === 'executed' && r.undo_until && new Date(r.undo_until) > new Date();
          return (
            <li key={r.id} className="row">
              <div className="row-main">
                <div className="row-title" style={{ whiteSpace: 'normal' }}>{r.title}</div>
                <div className="row-sub">
                  <span className={['failed', 'stale'].includes(r.status) ? 'badge warn' : 'badge'}>{STATUS_LABEL[r.status]}</span>
                  {r.decided_at && <span>{fmtRelative(r.decided_at)}</span>}
                  {r.reject_reason && <span>· {r.reject_reason}</span>}
                </div>
                {verdictText(r) && <div className="note">Resultado: {verdictText(r)}</div>}
              </div>
              {canUndo && (
                <div className="row-side"><button type="button" className="chip" onClick={() => undo(r.id)}>Deshacer</button></div>
              )}
            </li>
          );
        })}
      </ul>
      {recs && recs.length === 0 && <p className="muted">Todavía no hay historial.</p>}
    </>
  );
}

function Aprendizaje({ api, overview }) {
  const { data: learnings, reload } = usePolling(() => api.get('/learnings'), [api], 300_000);
  const remove = async (id) => {
    await api.del(`/learnings/${id}`);
    reload();
  };
  return (
    <>
      <h2 className="section-title" style={{ marginTop: 0 }}>Precisión del agente</h2>
      {(overview?.precision || []).length === 0 && <p className="muted">Todavía no hay resultados medidos.</p>}
      <ul className="list">
        {(overview?.precision || []).map((p) => (
          <li key={p.type} className="row"><span>{TYPE_LABEL[p.type]}</span><span>{p.good} de {p.total} mejoraron</span></li>
        ))}
      </ul>
      <h2 className="section-title">Lecciones</h2>
      {(learnings || []).length === 0 && <p className="muted">El agente todavía no guardó lecciones.</p>}
      <ul className="list">
        {(learnings || []).map((l) => (
          <li key={l.id} className="row">
            <div className="row-main">
              <div style={{ whiteSpace: 'normal' }}>{l.text}</div>
              <div className="row-sub">Evidencia: recomendaciones {l.evidence_ids.join(', ')}</div>
            </div>
            <div className="row-side"><button type="button" className="chip" onClick={() => remove(l.id)}>Borrar</button></div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Config({ api, overview }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.get('/agent/config').then(setCfg).catch((e) => setMsg(e.message)); }, [api]);
  if (!cfg) return msg ? <p className="error">{msg}</p> : <p className="muted">Cargando…</p>;

  const set = (path, value) => setCfg((c) => {
    const [a, b] = path.split('.');
    return b ? { ...c, [a]: { ...c[a], [b]: value } } : { ...c, [a]: value };
  });
  const num = (path, label) => {
    const [a, b] = path.split('.');
    const value = b ? cfg[a][b] : cfg[a];
    return (
      <label className="form-row">
        {label}
        <input type="number" step="any" value={value} onChange={(e) => set(path, Number(e.target.value))} />
      </label>
    );
  };
  const save = async () => {
    setMsg(null);
    try {
      const { agentEnabled, executionEnabled, monthlyBudgetUsd, manualRunsPerDay, expireHours, budget, thresholds } = cfg;
      setCfg(await api.put('/agent/config', { agentEnabled, executionEnabled, monthlyBudgetUsd, manualRunsPerDay, expireHours, budget, thresholds }));
      setMsg('Guardado');
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <>
      <label className="form-row">Agente activado
        <input type="checkbox" checked={cfg.agentEnabled} onChange={(e) => set('agentEnabled', e.target.checked)} />
      </label>
      <label className="form-row">Ejecución habilitada
        <input type="checkbox" checked={cfg.executionEnabled} onChange={(e) => set('executionEnabled', e.target.checked)} />
      </label>
      <p className="note">Automático por tipo de acción: todo apagado (todas las acciones requieren aprobación).</p>
      <h2 className="section-title">Detección</h2>
      {num('thresholds.noSalesSpendMultiple', 'Gasta sin vender: gasto ≥ × costo por venta')}
      {num('thresholds.expensiveRoasRatio', 'Caro: ROAS < × promedio')}
      {num('thresholds.winnerRoasRatio', 'Ganador: ROAS ≥ × promedio')}
      {num('thresholds.winnerMinSales', 'Ganador: ventas mínimas (7 días)')}
      <h2 className="section-title">Topes</h2>
      {num('budget.maxChangePct', 'Cambio máximo de presupuesto (%)')}
      {num('expireHours', 'Vencimiento de tarjetas (horas)')}
      {num('manualRunsPerDay', 'Análisis manuales por día')}
      {num('monthlyBudgetUsd', 'Tope mensual de API (USD)')}
      <p className="note">Consumido este mes: USD {Number(overview?.monthCostUsd || 0).toFixed(2)}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={save}>Guardar</button>
        {msg && <span className={msg === 'Guardado' ? 'note' : 'error'}>{msg}</span>}
      </div>
    </>
  );
}

export default function Agente({ api }) {
  const [tab, setTab] = useState('pendientes');
  const { data: overview, reload: reloadOverview } = usePolling(() => api.get('/agent/overview'), [api], 30_000);
  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pendientes' && <Pendientes api={api} overview={overview} reloadOverview={reloadOverview} />}
      {tab === 'historial' && <Historial api={api} />}
      {tab === 'aprendizaje' && <Aprendizaje api={api} overview={overview} />}
      {tab === 'config' && <Config api={api} overview={overview} />}
    </>
  );
}
```

- [ ] **Step 7: Ruta, pestaña y marca en Anuncios**

`frontend/src/App.jsx`: importar `import Agente from './pages/Agente.jsx';` y agregar `<Route path="/agente" element={<Agente {...props} />} />` antes del `*`.

`frontend/src/components/Layout.jsx`: agregar `{ to: '/agente', label: 'Agente', icon: '✦' }` al final de `NAV`, y dentro del componente:

```jsx
  const { data: agent } = usePolling(() => api.get('/agent/overview'), [api], 5 * 60_000);
  const pending = agent?.pendingCount || 0;
```

y en el render de cada `NavLink`, después de `{item.label}`:

```jsx
            {item.to === '/agente' && pending > 0 && <span className="nav-badge" aria-label={`${pending} pendientes`}>{pending}</span>}
```

`frontend/src/pages/Anuncios.jsx`: en `Anuncios`, agregar

```jsx
  const [refs, setRefs] = useState(() => new Set());
  useEffect(() => {
    api.get('/recommendations/refs')
      .then((r) => setRefs(new Set((Array.isArray(r) ? r : []).flatMap((x) => [x.object_id, x.target_id]).filter(Boolean))))
      .catch(() => {});
  }, [api]);
```

y en la fila, dentro de `row-sub` después del badge "Gastó sin ventas":

```jsx
                      {refs.has(r.id) && <span className="badge">Recomendación pendiente</span>}
```

- [ ] **Step 8: Correr tests y build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS y build OK.

- [ ] **Step 9: Commit**

```bash
git add frontend/src frontend/test
git commit -m "feat: pestaña Agente — pendientes, historial, aprendizaje y configuración

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Logo real de Altorancho (encabezado e íconos de la PWA)

**Files:**
- Create: `frontend/scripts/build-logos.mjs`, `frontend/public/logo-wordmark.png`, `frontend/public/logo.png`
- Modify: `frontend/pwa-assets.config.js`, `frontend/src/components/Layout.jsx`, `frontend/src/components/Login.jsx`, `frontend/src/styles.css`, íconos generados en `frontend/public/`
- Delete: `frontend/public/logo.svg`

**Interfaces:**
- Consumes: logos de diseño en `C:\Users\Usuario\LETT COMERCIAL Dropbox\Diseño AR\4 - AR-LOGO-NUEVO\LOGO NUEVO 2024\PNG\` — `altorancho. gris-01.png` (wordmark gris, 5334×3000 con márgenes) y `alto. blanco_Mesa de trabajo 1.png` (isotipo blanco, fondo transparente).
- Produces: `public/logo-wordmark.png` (wordmark recortado, 600 px de ancho) para el encabezado; `public/logo.png` (1024×1024, fondo `#353434`, "alto." blanco centrado al 70% del ancho) como fuente de los íconos PWA.

- [ ] **Step 1: `frontend/scripts/build-logos.mjs`** (usa `sharp`, que ya viene como dependencia de `@vite-pwa/assets-generator`)

```js
// Genera los logos de la PWA a partir de los PNG de diseño. Uso: node scripts/build-logos.mjs "<carpeta PNG>"
import path from 'node:path';
import sharp from 'sharp';

const dir = process.argv[2];
if (!dir) throw new Error('Pasá la carpeta de los PNG de diseño');
const out = (f) => path.join(process.cwd(), 'public', f);

// Encabezado: wordmark gris recortado (sin márgenes) a 600 px de ancho
await sharp(path.join(dir, 'altorancho. gris-01.png'))
  .trim({ background: '#ffffff', threshold: 10 })
  .resize({ width: 600 })
  .png()
  .toFile(out('logo-wordmark.png'));

// Ícono: "alto." blanco centrado sobre #353434
const size = 1024;
const mark = await sharp(path.join(dir, 'alto. blanco_Mesa de trabajo 1.png'))
  .trim({ threshold: 10 })
  .resize({ width: Math.round(size * 0.7) })
  .png()
  .toBuffer();
const { height } = await sharp(mark).metadata();
await sharp({ create: { width: size, height: size, channels: 4, background: '#353434' } })
  .composite([{ input: mark, left: Math.round(size * 0.15), top: Math.round((size - height) / 2) }])
  .png()
  .toFile(out('logo.png'));
console.log('logos generados en public/');
```

Run: `cd frontend && node scripts/build-logos.mjs "C:/Users/Usuario/LETT COMERCIAL Dropbox/Diseño AR/4 - AR-LOGO-NUEVO/LOGO NUEVO 2024/PNG"`
Expected: `logos generados en public/`. Abrir `public/logo.png` y `public/logo-wordmark.png` y verificarlos a ojo (isotipo centrado, wordmark sin márgenes). Si `trim` deja bordes por antialiasing, subir `threshold` a 30.

- [ ] **Step 2: Íconos PWA desde el PNG — reescribir `frontend/pwa-assets.config.js`**

```js
import { defineConfig } from '@vite-pwa/assets-generator/config';

// El logo ya trae su fondo #353434: sin padding y con el mismo fondo en maskable/apple
export default defineConfig({
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']], padding: 0 },
    maskable: { sizes: [512], padding: 0.1, resizeOptions: { background: '#353434' } },
    apple: { sizes: [180], padding: 0.1, resizeOptions: { background: '#353434' } },
  },
  images: ['public/logo.png'],
});
```

Run: `cd frontend && git rm -q public/logo.svg && npm run generate-pwa-assets`
Expected: regenera `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`, `favicon.ico`. En `vite.config.js` reemplazar `'logo.svg'` por `'logo.png'` en `includeAssets`.

- [ ] **Step 3: Encabezado y login con el wordmark**

`frontend/src/components/Layout.jsx`: reemplazar `<div className="brand">ALTORANCHO <span>Ventas</span></div>` por

```jsx
        <div className="brand"><img src="/logo-wordmark.png" alt="altorancho." className="brand-logo" /> <span>Ventas</span></div>
```

`frontend/src/components/Login.jsx`: mismo reemplazo dentro del formulario.

`frontend/src/styles.css`, agregar:

```css
.brand { display: flex; align-items: center; gap: 6px; }
.brand-logo { height: 18px; width: auto; display: block; }
.login-card .brand-logo { height: 26px; }
```

- [ ] **Step 4: Tests y build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS y build OK (los tests no dependen del texto del logo).

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts frontend/public frontend/pwa-assets.config.js frontend/vite.config.js frontend/src
git commit -m "feat: logo real de Altorancho en encabezado e íconos de la PWA

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Deploy y primera corrida real (con ejecución apagada)

Operativa: cada paso se verifica contra los sistemas reales. **No encender "Ejecución habilitada" sin el OK explícito del usuario.**

**Files:** ninguno nuevo (ajustes que surjan, con test y commit).

- [ ] **Step 1: API key de Anthropic desde el proyecto de Gineza**

Run (lista sin mostrar valores): `railway list` → identificar el proyecto de Gineza; `railway variables --kv -p <proyecto-gineza> -s <servicio> | grep -c ANTHROPIC_API_KEY`
Expected: 1. Copiarla al servicio `web` de `altorancho-ventas` sin imprimirla:
`railway variables --set "ANTHROPIC_API_KEY=$(railway variables --kv -p <proyecto-gineza> -s <servicio> | grep ^ANTHROPIC_API_KEY= | cut -d= -f2-)"` (con el proyecto de Altorancho linkeado). Si el comando de lectura cruzada no está disponible en esta versión del CLI, pedirle al usuario que la pegue en Railway.

- [ ] **Step 2: Deploy del backend**

Run: `railway up --detach` y esperar `SUCCESS`; `curl -s https://web-production-71431.up.railway.app/health` → `{"ok":true,"db":true}`.
Verificar que la migración 002 corrió: `curl -s -H "Authorization: Bearer <pw>" https://web-production-71431.up.railway.app/api/agent/config` devuelve la config con `executionEnabled: false`.

- [ ] **Step 3: Catálogo con los campos nuevos**

Run: `curl -s -X POST -H "Authorization: Bearer <pw>" .../api/sync/meta-catalog` y, al terminar (pestaña Estado), consultar `GET /api/ads?from=<hoy-7>&to=<hoy-1>&level=campaign` y confirmar en la DB vía `/api/agent/overview` que no hay errores. Confirmar con `railway connect Postgres` o con un endpoint existente que `meta_ads.objective` y `daily_budget` quedaron cargados para las campañas activas (ej. `altorancho_conversiones_bazardeco_getaway` → OUTCOME_SALES, 20.000).

- [ ] **Step 4: Primera corrida manual**

Run: `curl -s -X POST -H "Authorization: Bearer <pw>" .../api/agent/run` → 202. Esperar y consultar `GET /api/agent/overview` hasta `running: false`.
Expected: `lastRun.status = 'ok'`, `candidates_count` > 0 (con los datos de hoy hay campañas que gastan sin vender, ej. `carritos_aon`), costo < USD 0,50. Si `status = 'error'`, leer `lastRun.error` y diagnosticar antes de seguir.

- [ ] **Step 5: Frontend**

Run: `cd frontend && npm run build` y rearmar el zip (`tar -a -cf ../altorancho-frontend.zip .htaccess *` desde `dist`). El usuario lo sube a Hostinger (`agente.techdi.com.ar`).

- [ ] **Step 6: Revisión con el usuario**

Recorrer juntos la pestaña Agente: ¿las recomendaciones tienen sentido? ¿los números coinciden con Ventas/Anuncios? ¿algún descarte es raro? Ajustar umbrales desde Configuración si hace falta. Recién con el OK del usuario, activar **Ejecución habilitada** y aprobar la primera recomendación de bajo riesgo juntos; verificar en Ads Manager que se aplicó y que "Deshacer" funciona.

- [ ] **Step 7: Cierre**

Commit de ajustes, actualizar memoria del proyecto y proponer merge de `altorancho-ventas` + `altorancho-agente` a `main`.
