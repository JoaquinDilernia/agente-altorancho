import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Agente from '../src/pages/Agente.jsx';

const m7 = { spend: 210000, sales: 0, revenue: 0, roas: null, cpa: null, metaPurchases: 1, metaValue: 50000 };
const pause = {
  id: 1, type: 'pause', status: 'pending', level: 'ad', object_id: 'A', object_name: 'Anuncio sillas', title: 'Pausar Anuncio sillas: gastó $210.000 sin ventas',
  reasoning: 'Lleva 7 días sin ventas reales.', expected_impact: 'Ahorra ~$30.000 por día', confidence: 'alta', dudoso_atribucion: false,
  current_value: { status: 'ACTIVE' }, proposed_value: { status: 'PAUSED' }, snapshot: { m7 }, created_at: '2026-10-06T11:00:00Z',
};
const budget = {
  ...pause, id: 2, type: 'budget', object_id: 'G', object_name: 'Campaña DPA', title: 'Subir Campaña DPA', confidence: 'media',
  current_value: { daily_budget: 50000 }, proposed_value: { daily_budget: 60000 }, snapshot: { m7: { ...m7, sales: 9, revenue: 900000, roas: 4.3 } },
};
const idea = { ...pause, id: 3, type: 'idea', title: 'Renovar creativo de lámparas', reasoning: 'El CTR cayó 40%.', current_value: null, proposed_value: null };
const executed = {
  ...pause, id: 4, status: 'executed', decided_at: '2026-10-05T12:00:00Z', executed_at: '2026-10-05T12:00:00Z',
  undo_until: new Date(Date.now() + 3600e3).toISOString(), verdict: 'mejoro', outcome: { d3: { change: 0.25, verdict: 'mejoro' } },
};
const overview = (o = {}) => ({
  lastRun: { started_at: '2026-10-06T11:00:00Z', status: 'ok', candidates_count: 14, cost_usd: 0.14 }, running: false, pendingCount: 2,
  manualRemaining: 2, monthCostUsd: 1.2, monthlyBudgetUsd: 20, agentEnabled: true, executionEnabled: false,
  precision: [{ type: 'pause', good: 8, total: 10 }], ...o,
});
const config = {
  agentEnabled: true, executionEnabled: false, autoByType: { pause: false, reactivate: false, budget: false, shift: false },
  monthlyBudgetUsd: 20, manualRunsPerDay: 2, expireHours: 48, budget: { maxChangePct: 20, minDaily: 1000, maxDaily: 5000000 },
  thresholds: { noSalesSpendMultiple: 2, expensiveRoasRatio: 0.5, winnerRoasRatio: 1.5, winnerMinSales: 3 },
};

function setup(over = {}) {
  const api = {
    get: vi.fn(async (path) => {
      if (path === '/agent/overview') return over.overview || overview();
      if (path.startsWith('/recommendations?group=pending')) return [pause, budget, idea];
      if (path.startsWith('/recommendations?group=history')) return [executed];
      if (path === '/learnings') return [{ id: 9, text: 'Las DPA venden tarde', evidence_ids: [1, 2, 3] }];
      if (path === '/agent/config') return config;
      return null;
    }),
    post: vi.fn().mockResolvedValue({ status: 'approved' }),
    put: vi.fn().mockResolvedValue(config),
    del: vi.fn().mockResolvedValue({ ok: true }),
  };
  render(<MemoryRouter><Agente api={api} /></MemoryRouter>);
  return api;
}

describe('Agente — Pendientes', () => {
  it('cabecera con último análisis, cupo y aviso de ejecución apagada', async () => {
    setup();
    expect(await screen.findByText(/14 candidatos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /analizar ahora \(te quedan 2\)/i })).toBeEnabled();
    expect(screen.getByText(/ejecución está apagada/i)).toBeInTheDocument();
  });
  it('sin cupo el botón queda deshabilitado', async () => {
    setup({ overview: overview({ manualRemaining: 0 }) });
    expect(await screen.findByRole('button', { name: /disponible mañana/i })).toBeDisabled();
  });
  it('analizar ahora llama a la API', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /analizar ahora/i }));
    expect(api.post).toHaveBeenCalledWith('/agent/run');
  });
  it('tarjetas: aprobar una pausa', async () => {
    const api = setup();
    const card = (await screen.findByText(/pausar anuncio sillas/i)).closest('article');
    expect(within(card).getByText('Pausar')).toBeInTheDocument();
    expect(within(card).getByText('Alta')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /aprobar/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/1/approve', {});
  });
  it('presupuesto: se puede ajustar el monto antes de aprobar', async () => {
    const api = setup();
    const card = (await screen.findByText('Subir Campaña DPA')).closest('article');
    const input = within(card).getByLabelText(/nuevo presupuesto diario/i);
    await userEvent.clear(input);
    await userEvent.type(input, '55000');
    await userEvent.click(within(card).getByRole('button', { name: /aprobar/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/2/approve', { amount: 55000 });
  });
  it('rechazar con motivo rápido', async () => {
    const api = setup();
    const card = (await screen.findByText(/pausar anuncio sillas/i)).closest('article');
    await userEvent.click(within(card).getByRole('button', { name: /rechazar/i }));
    await userEvent.click(within(card).getByRole('button', { name: /está en lanzamiento/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/1/reject', { reason: 'Está en lanzamiento' });
  });
  it('ideas se listan aparte y se marcan como vistas', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('button', { name: /^vista$/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/3/seen');
  });
});

describe('Agente — otras pestañas', () => {
  it('historial muestra resultado y permite deshacer', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /historial/i }));
    expect(await screen.findByText('Ejecutada')).toBeInTheDocument();
    expect(screen.getByText(/mejoró \+25%/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /deshacer/i }));
    expect(api.post).toHaveBeenCalledWith('/recommendations/4/undo');
  });
  it('aprendizaje: precisión y lecciones borrables', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /aprendizaje/i }));
    expect(await screen.findByText(/8 de 10 mejoraron/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /borrar/i }));
    expect(api.del).toHaveBeenCalledWith('/learnings/9');
  });
  it('configuración: guardar interruptores y umbrales', async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /configuración/i }));
    await userEvent.click(await screen.findByLabelText(/ejecución habilitada/i));
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/agent/config', expect.objectContaining({ executionEnabled: true })));
  });
});
