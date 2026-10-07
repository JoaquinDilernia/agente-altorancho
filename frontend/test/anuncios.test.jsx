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
      if (path.includes('level=campaign')) return { level: 'campaign', rows: [row('C1', { thumbnail_url: 'https://t/c1.jpg' }), row('C2', { sales: 0, revenue: 0, costPerSale: null, roas: 0, noSales: true })], unidentified: { orders: 2, revenue: 1500 } };
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
  it('selector Google: pide platform=google, muestra "Google dice" y no tiene drill-down ni parámetros', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /^google$/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/ads?from=2026-09-29&to=2026-10-05&level=campaign&sort=spend&platform=google'));
    expect(await screen.findAllByText(/google dice/i)).not.toHaveLength(0);
    expect(screen.queryByText(/parámetros de url/i)).not.toBeInTheDocument();
  });
  it('muestra la foto del anuncio en el listado', async () => {
    setup();
    const c1 = await screen.findByRole('button', { name: /nombre c1/i });
    expect(within(c1).getByRole('img', { name: /nombre c1/i })).toHaveAttribute('src', 'https://t/c1.jpg');
  });
});
