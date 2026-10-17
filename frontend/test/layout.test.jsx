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
    const api = { get: vi.fn(async (p) => (p === '/ads/badge' ? { pendingCount: 3 } : status(12))) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p>contenido</p></Layout></MemoryRouter>);
    expect(screen.getByRole('link', { name: /ventas/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /anuncios/i })).toHaveAttribute('href', '/anuncios');
    expect(screen.getByRole('link', { name: /estado/i })).toHaveAttribute('href', '/estado');
    await waitFor(() => expect(screen.getByText(/actualizado hace 12 min/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /agente/i })).toHaveAttribute('href', '/agente');
    await waitFor(() => expect(screen.getByLabelText('3 pendientes')).toBeInTheDocument());
  });
  it('avisa si los datos tienen más de 2 horas o la última corrida falló', async () => {
    const api = { get: vi.fn(async (p) => (p === '/ads/badge' ? { pendingCount: 3 } : status(200))) };
    render(<MemoryRouter><Layout api={api} onLogout={() => {}}><p /></Layout></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/datos desactualizados/i)).toBeInTheDocument());
  });
  it('en escritorio muestra el menú lateral con el título de la sección', async () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const api = { get: vi.fn(async (p) => (p === '/ads/badge' ? { pendingCount: 1, openQuestions: 1 } : status(12))) };
      const { container } = render(<MemoryRouter initialEntries={['/anuncios']}><Layout api={api} onLogout={() => {}}><p /></Layout></MemoryRouter>);
      expect(container.querySelector('aside.sidebar')).not.toBeNull();
      expect(container.querySelector('.bottom-nav')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Anuncios' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /anuncios/i })).toHaveClass('active');
      expect(screen.getByRole('button', { name: /salir/i })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('2 pendientes')).toBeInTheDocument());
    } finally {
      window.matchMedia = original;
    }
  });
});
