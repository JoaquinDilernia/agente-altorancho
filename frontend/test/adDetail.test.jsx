import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdDetail from '../src/pages/AdDetail.jsx';

const PERIOD = { preset: '7d', from: '2026-09-29', to: '2026-10-05' };
const DETAIL = {
  ad: { id: 'A1', level: 'ad', name: 'Video lámparas', status: 'ACTIVE', thumbnail_url: 'https://t/a.jpg', has_attribution_params: false },
  metrics: { spend: 400, sales: 2, revenue: 4000, costPerSale: 200, roas: 10, metaPurchases: 3, metaRoas: 12.5, noSales: false },
  orders: [{ id: '2', number: 59002, created_at: '2026-10-05T12:00:00Z', total: 3000, customer_name: 'Ana Pérez' }],
};

describe('AdDetail', () => {
  it('muestra métricas reales vs Meta, aviso de parámetros y órdenes', async () => {
    const api = { get: vi.fn().mockResolvedValue(DETAIL) };
    render(
      <MemoryRouter initialEntries={['/anuncios/A1']}>
        <Routes><Route path="/anuncios/:id" element={<AdDetail api={api} period={PERIOD} />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Video lámparas')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/ads/A1?from=2026-09-29&to=2026-10-05');
    expect(screen.getByText(/sin parámetros de url/i)).toBeInTheDocument();
    expect(screen.getByText('10,0x')).toBeInTheDocument();
    expect(screen.getByText(/meta dice 12,5x/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#59002/ })).toHaveAttribute('href', '/orden/2');
  });
});
