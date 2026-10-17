// Lectura de las métricas en términos del negocio. Lo que importa son las ventas REALES de la tienda
// (Tienda Nube atribuidas por UTM); las compras que reporta Meta son una señal secundaria que suele inflar.
const PURCHASE_TYPES = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

const num = (v) => (v == null || v === '' ? 0 : Number(v));
const pick = (list) => {
  for (const type of PURCHASE_TYPES) {
    const hit = (list || []).find((a) => a.action_type === type);
    if (hit) return num(hit.value);
  }
  return 0;
};
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Fila de /insights de Meta: gasto y señales de entrega (frecuencia, CTR, CPM) + lo que Meta dice que vendió
export function summarizeMetaRow(row = {}) {
  return {
    spend: Math.round(num(row.spend)),
    impressions: num(row.impressions),
    frequency: row.frequency != null ? Number(num(row.frequency).toFixed(2)) : null,
    ctr: row.ctr != null ? Number(num(row.ctr).toFixed(2)) : null,
    cpm: row.cpm != null ? Math.round(num(row.cpm)) : null,
    metaPurchases: pick(row.actions),
    metaValue: Math.round(pick(row.action_values)),
  };
}

export function metaTotals(rows) {
  return rows.reduce((acc, r) => {
    const s = summarizeMetaRow(r);
    acc.spend += s.spend;
    acc.metaPurchases += s.metaPurchases;
    acc.metaValue += s.metaValue;
    return acc;
  }, { spend: 0, metaPurchases: 0, metaValue: 0 });
}

// Fila del ranking de reports (ventas reales por campaña/conjunto/anuncio) → resumen compacto
export function realMetrics(r) {
  if (!r) return { spend: 0, sales: 0, revenue: 0, roas: null, costPerSale: null, metaPurchases: 0 };
  return {
    spend: Math.round(r.spend), sales: r.sales, revenue: Math.round(r.revenue), roas: r1(r.roas),
    costPerSale: r.costPerSale == null ? null : Math.round(r.costPerSale), metaPurchases: r.metaPurchases,
  };
}

// Presupuestos de Meta en la moneda de la cuenta (ARS) vienen en centavos
export const centsToArs = (v) => (v == null ? null : Math.round(Number(v) / 100));
