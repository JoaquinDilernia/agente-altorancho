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
