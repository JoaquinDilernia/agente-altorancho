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
  google: { spend: 2000, orders: 2, revenue: 9000, roas: 4.5, costPerSale: 1000, reported: { conversions: 6, value: 30000, roas: 15 }, coverage: { campaign: 2, none: 0 } },
};
const order = (id, extra = {}) => ({
  id: String(id), number: 59000 + id, created_at: new Date().toISOString(), total: 1000, status: 'open', payment_status: 'paid',
  cancelled: false, customer_name: 'Mariana Francia', items_count: 3, channel: 'meta', confidence: 'ad', ad_name: `Anuncio ${id}`, campaign_name: 'Camp', campaign_id: '1', ...extra,
});
const DETAIL = {
  id: '1', number: 59001, gateway_name: 'Pago Nube', shipping_cost_customer: 500, visit_landing_page: 'https://altorancho.com/?utm_source=meta',
  items: [{ name: 'Lámpara Fungi', sku: 'IME040', quantity: 2, price: 39990 }],
};
const PAGE1 = { items: [order(1), order(2, { payment_status: 'pending', channel: 'google', ad_name: null, campaign_id: '11472612872' })], nextCursor: 'C1' };
const PAGE2 = { items: [order(3, { channel: 'organic', ad_name: null })], nextCursor: null };

function setup() {
  const api = {
    get: vi.fn(async (path) => {
      if (path.startsWith('/summary')) return SUMMARY;
      if (/^\/orders\/\d+$/.test(path)) return DETAIL;
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
    expect(within(link).getByText('Mariana Francia')).toBeInTheDocument();
    expect(within(link).getByText('3 productos')).toBeInTheDocument();
    expect(within(link).getByRole('img', { name: 'Meta' })).toBeInTheDocument();
    const second = screen.getByRole('link', { name: /#59002/ });
    expect(within(second).getByText('Pendiente')).toBeInTheDocument();
    expect(within(second).getByText('Campaña 11472612872')).toBeInTheDocument();
  });
  it('el desplegable muestra productos, pago y envío', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /ver productos de #59001/i }));
    expect(api.get).toHaveBeenCalledWith('/orders/1');
    expect(await screen.findByText(/lámpara fungi/i)).toBeInTheDocument();
    expect(screen.getByText(/pago nube/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ver detalle completo/i })).toHaveAttribute('href', '/orden/1');
  });
  it('"Ver más" trae la página siguiente', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /ver más/i }));
    expect(await screen.findByRole('link', { name: /#59003/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ver más/i })).not.toBeInTheDocument();
  });
  it('una página de "Ver más" que llega tarde no se mezcla con un filtro nuevo', async () => {
    let releaseOld;
    const api = {
      get: vi.fn((path) => {
        if (path.startsWith('/summary')) return Promise.resolve(SUMMARY);
        if (path.includes('cursor=C1')) return new Promise((r) => { releaseOld = () => r(PAGE2); });
        if (path.includes('channel=organic')) return Promise.resolve({ items: [order(9, { channel: 'organic', ad_name: null })], nextCursor: null });
        return Promise.resolve(PAGE1);
      }),
    };
    render(<MemoryRouter><Ventas api={api} period={PERIOD} setPeriod={vi.fn()} /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: /ver más/i }));
    await userEvent.click(screen.getByRole('button', { name: /orgánica/i }));
    expect(await screen.findByRole('link', { name: /#59009/ })).toBeInTheDocument();
    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: /#59003/ })).not.toBeInTheDocument();
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
  it('tarjetas de Google con lo real vs lo que dice Google', async () => {
    setup();
    expect(await screen.findByText('Gasto Google')).toBeInTheDocument();
    expect(screen.getByText('4,5x')).toBeInTheDocument();
    expect(screen.getByText(/google dice 15,0x/i)).toBeInTheDocument();
  });
});
