import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Estado from '../src/pages/Estado.jsx';

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const STATUS = {
  runs: [
    { source: 'tn_incremental', started_at: ago(10), finished_at: ago(9), status: 'ok', rows: 12, error: null },
    { source: 'meta_spend', started_at: ago(20), finished_at: ago(19), status: 'error', rows: 0, error: 'Meta 190: token vencido' },
  ],
  lastSuccess: [{ source: 'tn_incremental', finished_at: ago(9) }, { source: 'meta_spend', finished_at: ago(80) }],
  errors: [{ source: 'meta_spend', started_at: ago(20), error: 'Meta 190: token vencido' }],
  coverage: [{ week: '2026-09-28', ad: 1, campaign: 6, none: 3 }, { week: '2026-10-05', ad: 8, campaign: 1, none: 1 }],
  counts: { orders: 54463, adsMissingParams: 7 },
  running: ['tn_backfill'],
};

describe('Estado', () => {
  it('muestra sincronizaciones, errores, cobertura y conteos', async () => {
    render(<MemoryRouter><Estado api={{ get: vi.fn().mockResolvedValue(STATUS) }} /></MemoryRouter>);
    const tn = await screen.findByText('Tienda Nube (cada hora)');
    expect(within(tn.closest('li')).getByText('OK')).toBeInTheDocument();
    expect(within(tn.closest('li')).getByText(/hace 9 min/)).toBeInTheDocument();
    const meta = screen.getAllByText('Meta — gasto')[0].closest('li'); // también figura en Errores recientes
    expect(within(meta).getByText('Error')).toBeInTheDocument();
    expect(within(meta).getByText(/token vencido/)).toBeInTheDocument();
    expect(within(screen.getByText('Tienda Nube (histórico)').closest('li')).getByText('Corriendo')).toBeInTheDocument();
    expect(screen.getByText('54.463')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    const row = screen.getByText('05/10').closest('tr');
    expect(within(row).getByText('80%')).toBeInTheDocument();
  });
});
