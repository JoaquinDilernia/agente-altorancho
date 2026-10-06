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
