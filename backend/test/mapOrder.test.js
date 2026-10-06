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
