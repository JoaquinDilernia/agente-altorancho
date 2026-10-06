# Altorancho — Agente de recomendaciones de Meta Ads (Proyecto B)

**Fecha:** 2026-10-06
**Estado:** Diseño aprobado en conversación, pendiente de revisión del spec.
**Depende de:** Proyecto A (`2026-10-06-altorancho-ventas-atribucion-design.md`), ya en producción.

## 1. Objetivo

Un agente que todos los días analiza las campañas de Meta de Altorancho usando **ventas reales
de Tienda Nube** (no el ROAS que reporta Meta) y propone acciones concretas para **mejorar el ROAS
real y bajar el costo por venta**. Cada propuesta se aprueba o rechaza desde el panel; al aprobar,
el backend la ejecuta en Meta. El agente mide el resultado de lo ejecutado y aprende.

Línea de base al 2026-10-06 (30 días): ROAS real Meta 3,5x (Meta dice 5,3x), costo por venta real
~$104.800, 248 ventas reales vs 387 que reporta Meta.

### Alcance v1
- Acciones: **pausar / reactivar** (anuncio, conjunto, campaña), **cambiar presupuesto diario**,
  **reasignar presupuesto** entre dos objetos, **ideas** sin acción.
- **Todo requiere aprobación.** El diseño deja preparado "automático por tipo de acción" (apagado).

### Fuera de alcance v1
- Tests de campaña completos (crear conjuntos/anuncios, subir creativos).
- Chat con el agente.
- Notificaciones (WhatsApp/email).
- Cambios de precio en Tienda Nube.
- Metas fijas de negocio (ROAS/CPA objetivo) — se usan metas relativas al promedio de la cuenta,
  con umbrales configurables.

## 2. Flujo diario

1. **08:00 ART (cron)** o botón **"Analizar ahora"** (máx. 2 manuales por día, configurable).
2. Se refresca catálogo y gasto de Meta (jobs del Proyecto A) para tener datos de ayer completos.
3. **Detección de candidatos** (código, sección 3).
4. Si no hay candidatos → no se llama a Claude; la corrida queda registrada con costo 0.
5. **Agente** (Claude, sección 4) revisa candidatos y crea recomendaciones pendientes.
6. Panel muestra las pendientes; al aprobar → **ejecución** (sección 5).
7. Cron diario 09:00 → **medición de resultados** de lo ejecutado hace 3 y 7 días (sección 6).

## 3. Detección de candidatos (código, sin IA)

Ventanas: **7d** = últimos 7 días completos (hasta ayer, ART); **7d previos**; **30d** = línea de base.
Línea de base de la cuenta: ROAS real y costo por venta de Meta en 30d (solo campañas de ventas).

| Señal | Regla (umbrales en config) | Acción sugerida |
|---|---|---|
| `gasta_sin_vender` | gasto 7d ≥ `2 ×` CPA base y 0 ventas reales 7d | pausar |
| `caro` | ROAS real 7d < `50%` del base y gasto 7d ≥ `3 ×` CPA base | bajar presupuesto o pausar |
| `ganador` | ROAS real 7d ≥ `1,5 ×` base, ≥ `3` ventas 7d, ROAS 7d ≥ 80% del ROAS 7d previos | subir presupuesto |
| `reasignar` | existe un `caro` y un `ganador` que tienen presupuesto en el mismo nivel (campaña↔campaña o conjunto↔conjunto) | mover presupuesto |
| `fatiga` | CTR 7d cae > `30%` vs 7d previos, con ≥ 5.000 impresiones 7d | idea |
| `pausado_que_vendia` | pausado en los últimos 30d, ROAS real 30d (mientras corrió) ≥ base, ≥ 3 ventas | reactivar |

**Protecciones:**
- Solo campañas con objetivo de ventas (`OUTCOME_SALES`, `CONVERSIONS`, `PRODUCT_CATALOG_SALES`).
  Las demás (tráfico, interacción, alcance, seguidores) no generan candidatos.
- Se excluyen objetos con < 3 días de vida o en fase de aprendizaje, salvo `gasta_sin_vender`
  con gasto ≥ `4 ×` CPA base.
- **Nivel según atribución:** un anuncio solo es candidato si su campaña tiene ≥ 60% de ventas
  Meta atribuidas a nivel anuncio en 30d; si no, la evaluación sube a conjunto/campaña.
- **Atribución dudosa:** si ventas reales = 0 pero Meta reporta ≥ 2 compras, el candidato se marca
  `dudoso_atribucion = true`.
- Un objeto con recomendación `pendiente`, o `rechazada` hace < 7 días, no es candidato salvo que
  su gasto 7d sin ventas o su ROAS haya empeorado ≥ 30% desde la recomendación anterior.

**Datos nuevos de Meta** (se agregan a la sync de catálogo del Proyecto A): objetivo de campaña,
presupuesto diario de campaña y de conjunto (y si es CBO), `created_time`, estado de aprendizaje
del conjunto (`learning_stage_info.status`). Para "pausado que vendía": fecha de último cambio de
estado (`updated_time`) del objeto pausado.

## 4. El agente

- **Modelo:** Claude Sonnet 5.5 (`claude-sonnet-5-5`), configurable. Tool use.
- **Contexto (acotado):** línea de base y metas; candidatos con métricas 7d / 7d previos / 30d
  (gasto, ventas reales, ROAS real, costo por venta, compras y ROAS que dice Meta, CTR, días de
  vida, aprendizaje, presupuesto, objetivo, cobertura de atribución, `dudoso_atribucion`);
  recomendaciones de los últimos 14 días con estado, motivo de rechazo y resultado medido;
  lecciones activas; umbrales y topes de config.
- **Tools** (solo crean registros, nunca ejecutan):
  - `recomendar_pausa(objeto_id, nivel, titulo, razonamiento, impacto_esperado, confianza)`
  - `recomendar_reactivacion(...)` mismos campos
  - `recomendar_presupuesto(objeto_id, nivel, presupuesto_nuevo, ...)` — rechazada por el backend si
    el cambio supera el tope (`±20%` por defecto) o los mínimos/máximos de config
  - `recomendar_reasignacion(desde_id, hacia_id, monto_diario, ...)` — mismo tope para ambos lados
  - `registrar_idea(titulo, detalle, objetos_relacionados)`
  - `descartar_candidato(candidato_id, motivo)`
  - `guardar_leccion(texto, evidencia_recomendacion_ids)` — exige ≥ 3 recomendaciones con resultado
    medido; si no, error devuelto a Claude
- **Cada candidato debe terminar** en una recomendación, idea o descarte; los que Claude no cubre
  se registran como "sin decisión" en la corrida.
- **Validación del backend** sobre cada tool call: el objeto existe, pertenece a un candidato de la
  corrida, la acción es coherente (no pausar algo ya pausado, etc.).
- **Control de costo:** máx. 8 turnos y tope de tokens de salida por corrida; uso (tokens in/out)
  y costo USD registrados por corrida (precios por millón de tokens en config); si el gasto del mes
  + estimado de la corrida supera el **tope mensual** (config, USD), no se corre y se avisa.
- **Snapshot:** cada recomendación guarda las métricas del objeto al momento de recomendar.

## 5. Aprobación y ejecución

**Estados:** `pendiente → aprobada → ejecutada | fallida`; `pendiente → rechazada` (motivo
opcional: "No es momento", "Está en lanzamiento", "No estoy de acuerdo", texto libre);
`pendiente → vencida` (48 h sin respuesta, configurable) o `desactualizada` (ver abajo).

**Al aprobar:**
1. Se puede **ajustar el monto** (presupuesto/reasignación) dentro de los topes.
2. Si **Ejecución habilitada** está apagado → queda `aprobada` sin tocar Meta.
3. **Pre-chequeo** contra Meta: estado y presupuesto actuales iguales a los del snapshot; si no →
   `desactualizada`, no se ejecuta.
4. Ejecuta por Graph API: `status` (PAUSED/ACTIVE) o `daily_budget` en el nivel que tiene el
   presupuesto (campaña si CBO, si no conjunto). Reasignación: baja origen → sube destino; si sube
   falla, revierte la baja.
5. Guarda el valor anterior para **Deshacer** (disponible 24 h).

**Interruptores (config):** Agente activado · Ejecución habilitada · Automático por tipo de acción
(todos apagados; en v1 solo se guardan y se muestran, no tienen efecto).

## 6. Aprendizaje

- **Resultado medido** (código) a los 3 y 7 días de cada ejecución: compara 7d previos a la acción
  vs días posteriores disponibles. Pausa: CPA/ROAS de la campaña (o de la cuenta si era campaña).
  Presupuesto: ROAS real y ventas del objeto. Reasignación: ambas puntas. Veredicto
  `mejoro | neutral | empeoro` (umbral ±10% en la métrica principal) con números.
- **Lecciones:** `guardar_leccion` con evidencia ≥ 3; activas se inyectan al contexto; visibles
  y borrables en el panel.
- **Precisión:** por tipo de acción, ejecutadas con veredicto `mejoro` / total con veredicto.

## 7. Datos (Postgres, nuevas tablas y columnas)

- `meta_ads` + columnas: `objective`, `daily_budget` (numeric, ARS), `is_cbo` (bool, campañas),
  `created_time`, `learning_status`, `status_updated_at`.
- `agent_runs`: id, trigger (`cron|manual`), started_at, finished_at, status, baseline jsonb,
  candidates jsonb, skipped jsonb, model, input_tokens, output_tokens, cost_usd, error.
- `recommendations`: id, run_id, type (`pause|reactivate|budget|shift|idea`), status, level,
  object_id, target_id, title, reasoning, expected_impact, confidence, dudoso_atribucion,
  current_value jsonb, proposed_value jsonb, snapshot jsonb, decided_at, reject_reason,
  executed_at, execution_result jsonb, previous_value jsonb, undo_until, undone_at,
  outcome jsonb, verdict, created_at.
- `learnings`: id, text, evidence_ids int[], status (`active|deleted`), created_at, updated_at.
- `agent_config`: fila única jsonb con umbrales, topes, interruptores, modelo, precios y tope mensual.

## 8. API (con auth por contraseña)

- `GET /api/agent/overview` — último análisis, pendientes (count), análisis manuales restantes hoy,
  gasto del mes, precisión.
- `POST /api/agent/run` — análisis manual (409 si se agotó el cupo diario o hay uno corriendo).
- `GET /api/recommendations?status&type&cursor` · `GET /api/recommendations/:id`
- `POST /api/recommendations/:id/approve` (body opcional `{ amount }`) ·
  `POST /api/recommendations/:id/reject` (`{ reason }`) · `POST /api/recommendations/:id/undo` ·
  `POST /api/recommendations/:id/seen` (ideas)
- `GET /api/learnings` · `DELETE /api/learnings/:id`
- `GET /api/agent/config` · `PUT /api/agent/config`

## 9. Pantallas

Nueva pestaña **Agente** (4ª en la barra inferior, con globito de pendientes):
1. **Pendientes** (default): cabecera con último análisis, costo y botón "Analizar ahora (te quedan N)";
   tarjetas con etiquetas de acción y confianza, antes → esperado (ROAS real, costo por venta,
   gasto, Meta dice), "Por qué" desplegable, campo de monto ajustable, Aprobar / Rechazar con
   motivo rápido; debajo, Ideas (marcar vista/útil).
2. **Historial**: filtros estado/tipo, decisión, ejecución, resultado medido, Deshacer (24 h).
3. **Aprendizaje**: precisión por tipo y lecciones con evidencia y borrar.
4. **Configuración**: interruptores, umbrales, topes, vencimiento, tope mensual y consumo del mes,
   cupo de análisis manuales.

En **Anuncios**, un punto en filas con recomendación pendiente que lleva a la tarjeta.

## 10. Testing

- Unit: detección de candidatos (cada regla y protección, con datos sembrados en PGlite),
  validación de tool calls, topes de presupuesto, medición de resultados y veredictos.
- Agente con cliente de Anthropic falso (respuestas con tool_use pregrabadas): crea recomendaciones,
  respeta cupo y tope mensual, registra costo.
- Ejecución con cliente de Meta falso: pre-chequeo/desactualizada, reasignación con reversión,
  deshacer.
- Frontend: tarjetas, aprobar con monto ajustado, rechazar con motivo, cupo de análisis manual.
- Verificación real: primera corrida en producción con **Ejecución habilitada apagado**; revisar
  las recomendaciones con el usuario antes de encender la ejecución.

## 11. Riesgos

- **Atribución incompleta** (anuncios sin parámetros de URL): mitigado con evaluación a nivel
  campaña/conjunto, marca `dudoso_atribucion` y confianza baja.
- **Reinicio de aprendizaje** por cambios de presupuesto: tope ±20% y no tocar objetos en aprendizaje.
- **Costo de API:** cupo manual diario, tope mensual, sin llamada si no hay candidatos.
- **API key** de Anthropic reutilizada del proyecto Gineza en Railway.
