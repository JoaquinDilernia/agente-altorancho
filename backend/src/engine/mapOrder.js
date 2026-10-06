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
