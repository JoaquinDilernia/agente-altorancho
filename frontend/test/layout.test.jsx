// frontend/test/layout.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from '../src/components/Layout.jsx';

const status = (minutesAgo, status = 'ok') => ({
  runs: [{ source: 'tn_incremental', status }],
  lastSuccess: [{ source: 'tn_incremental', finished_at: new Date(Date.now() - minutesAgo * 60000).toISOString() },
    { source: 'meta_spend', finished_at: new Date(Date.now() - minutesAgo * 60000).toISOString() }],
});

describe('Layout', () => {
  it('muestra navegación inferior y última actualización', async () => {
    const api = { get: vi.fn(async (p) => (p === '/agent/overview' ? { pendingCount: 3 } : status(12))) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p>contenido</p></Layout></MemoryRouter>);
    expect(screen.getByRole('link', { name: /ventas/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /anuncios/i })).toHaveAttribute('href', '/anuncios');
    expect(screen.getByRole('link', { name: /estado/i })).toHaveAttribute('href', '/estado');
    await waitFor(() => expect(screen.getByText(/actualizado hace 12 min/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /agente/i })).toHaveAttribute('href', '/agente');
    await waitFor(() => expect(screen.getByLabelText('3 pendientes')).toBeInTheDocument());
  });
  it('avisa si los datos tienen más de 2 horas o la última corrida falló', async () => {
    const api = { get: vi.fn(async (p) => (p === '/agent/overview' ? { pendingCount: 3 } : status(200))) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p /></Layout></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/datos desactualizados/i)).toBeInTheDocument());
  });
});
