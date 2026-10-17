import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Agente from '../src/pages/Agente.jsx';

const real = (o = {}) => ({ spend: 9000, sales: 2, revenue: 60000, roas: 6.7, costPerSale: 4500, metaPurchases: 3, ...o });
const snapshot = {
  today: '2026-10-16', spendToday: 1500,
  month: { spend: 120000, metaPurchases: 10, metaValue: 500000 },
  last7d: { orders: 10, revenue: 300000, meta: { spend: 9000, sales: 2, revenue: 60000, roas: 6.7, metaPurchases: 3 }, byChannel: [] },
  campaigns: [{ id: '900', name: 'AR | VENTAS', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudgetArs: 50000, last7d: real() }],
  adsets: [{ id: '901', name: 'INT_DECO_AMBA', campaignId: '900', status: 'ACTIVE', effectiveStatus: 'ACTIVE', last7d: real(), learningStage: 'LEARNING' }],
  ads: [{ id: '902', name: 'AD1', adsetId: '901', status: 'ACTIVE', effectiveStatus: 'ACTIVE', last7d: real(), delivery7d: { frequency: 1.8 } }],
};
const overview = (o = {}) => ({
  configured: { meta: true, agent: true }, storeUrl: 'https://altorancho.com',
  settings: { agent_enabled: true, autonomous: false, monthly_cap_ars: 200000, business_notes: '' },
  lastRun: { id: 'r1', status: 'done', report: '**Cómo vamos** vendimos 2', finished_at: '2026-10-16T11:00:00Z' },
  pendingCount: 1, openQuestions: 1, snapshot, metaError: null, ...o,
});
const decision = {
  id: 'd1', tool: 'propose_budget_change', status: 'pending', title: 'Subir AR | VENTAS', reason: 'ROAS 6,7 con 2 ventas',
  expected_impact: 'Más ventas', input: { current_budget_ars: 50000, proposed_budget_ars: 60000 }, created_at: '2026-10-16T11:00:00Z',
};
const question = { id: 'q1', question: '¿Hay stock de la Nórdica?', why: 'para subir presupuesto', quick_answers: ['Sí', 'No'], created_at: '2026-10-16T11:00:00Z' };
const creative = {
  id: 'c1', name: 'Lámpara Nórdica', copy: 'Iluminá tu living', link: 'https://altorancho.com', status: 'unused',
  feed: { kind: 'image', image_url: 'https://img/1.png' }, story: null,
};

function setup(over = {}) {
  const api = {
    get: vi.fn(async (path) => {
      if (path.startsWith('/ads/overview')) return over.overview || overview();
      if (path === '/ads/questions?status=open') return { questions: over.questions ?? [question] };
      if (path === '/ads/questions?status=answered') return { questions: [] };
      if (path === '/ads/decisions') return { decisions: [decision, { ...decision, id: 'd2', status: 'failed', title: 'Pausar AD1', error: 'Meta 100' }] };
      if (path === '/ads/requests') return { requests: [{ id: 'rq', concept: 'Video del living', style_notes: '9:16', reason: 'falta video' }] };
      if (path === '/ads/learnings') return { learnings: [] };
      if (path === '/ads/creatives') return { creatives: [creative] };
      if (path === '/ads/ig-posts') return { posts: [] };
      throw new Error(`ruta no simulada ${path}`);
    }),
    post: vi.fn(async (path) => {
      if (path.endsWith('/answer')) return { question: { ...question, status: 'answered' }, run: { id: 'r2' }, note: null };
      if (path === '/ads/creatives') return { creative: { id: 'new' } };
      return { ok: true, decision: { ...decision, status: 'executed' } };
    }),
    put: vi.fn(async (_p, body) => ({ settings: body })),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
    upload: vi.fn(async (_p, _f, onProgress) => { onProgress(1); return { media: {} }; }),
  };
  render(<MemoryRouter><Agente api={api} /></MemoryRouter>);
  return { api, user: userEvent.setup() };
}

beforeEach(() => {
  localStorage.clear();
  // jsdom no implementa las URLs de objeto (vista previa del archivo elegido)
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('Agente de pauta', () => {
  it('resumen: ventas reales, informe, preguntas y campañas', async () => {
    setup();
    expect(await screen.findByText('Cómo vamos')).toBeInTheDocument();
    expect(screen.getByText('ROAS real (7 días)').nextSibling).toHaveTextContent('6,7x');
    expect(screen.getByText(/Meta dice 3/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /tope/i })).toBeInTheDocument();
    expect(await screen.findByText('¿Hay stock de la Nórdica?')).toBeInTheDocument();
    expect(screen.getByText('INT_DECO_AMBA')).toBeInTheDocument();
    expect(screen.getByText(/en aprendizaje/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Recomendaciones (1)' })).toBeInTheDocument();
  });

  it('responder una pregunta con respuesta rápida y analizar', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Sí' }));
    await user.click(screen.getByRole('button', { name: 'Guardar y analizar ahora' }));
    expect(api.post).toHaveBeenCalledWith('/ads/questions/q1/answer', { answer: 'Sí', analyze: true });
    expect(await screen.findByRole('status')).toHaveTextContent(/arrancó a analizar/);
  });

  it('pausar una campaña pide confirmación antes de tocar Meta', async () => {
    const { api, user } = setup({ questions: [] });
    await screen.findByText('AR | VENTAS');
    const [pausar] = screen.getAllByRole('button', { name: 'Pausar' });
    await user.click(pausar);
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sí, pausar' }));
    expect(api.post).toHaveBeenCalledWith('/ads/objects/900/status', { level: 'campaign', status: 'PAUSED', name: 'AR | VENTAS' });
  });

  it('recomendaciones: aprobar con doble toque, pedidos de piezas e historial', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: /Recomendaciones/ }));
    const card = (await screen.findByText('Subir AR | VENTAS')).closest('article');
    expect(within(card).getByText(/\$\s?50\.000 → \$\s?60\.000/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Aprobar' }));
    await user.click(within(card).getByRole('button', { name: 'Aplicar en Meta' }));
    expect(api.post).toHaveBeenCalledWith('/ads/decisions/d1/approve');
    expect(screen.getByText('Video del living')).toBeInTheDocument();
    expect(screen.getByText('Meta 100')).toBeInTheDocument();
  });

  it('piezas: crear una con imagen sube el archivo a la pieza', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Piezas' }));
    expect(await screen.findByText('Lámpara Nórdica')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nueva pieza' }));
    await user.type(screen.getByLabelText(/Nombre/), 'Sillas');
    await user.type(screen.getByLabelText(/Texto del anuncio/), 'Sillas de paraíso');
    const file = new File(['png'], 'feed.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/Feed 4:5/), file);
    await user.click(screen.getByRole('button', { name: 'Guardar pieza' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith('/ads/creatives/new/media/feed', file, expect.any(Function)));
    expect(api.post).toHaveBeenCalledWith('/ads/creatives', expect.objectContaining({ name: 'Sillas', copy: 'Sillas de paraíso', link: '' }));
  });

  it('piezas: publicar en un conjunto', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Piezas' }));
    await user.click(await screen.findByRole('button', { name: 'Publicar' }));
    await user.click(screen.getByRole('button', { name: 'Publicar en Meta' }));
    expect(api.post).toHaveBeenCalledWith('/ads/creatives/c1/publish', { adset_id: '901', adset_name: 'INT_DECO_AMBA' });
  });

  it('ajustes: guarda tope y contexto', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Ajustes' }));
    const tope = screen.getByLabelText(/Tope mensual/);
    await user.clear(tope);
    await user.type(tope, '1500000');
    await user.type(screen.getByLabelText(/Contexto para el agente/), 'Empujar iluminación');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(api.put).toHaveBeenCalledWith('/ads/settings', { agent_enabled: true, autonomous: false, monthly_cap_ars: 1500000, business_notes: 'Empujar iluminación' });
  });

  it('avisa si falta configurar Meta o Claude', async () => {
    setup({ overview: overview({ configured: { meta: true, agent: false }, snapshot: null }) });
    expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Analizar ahora' })).not.toBeInTheDocument();
  });
});
