import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAgentConfigRepo, DEFAULT_CONFIG } from '../src/repo/agentConfig.js';

let db; let repo;
beforeEach(async () => { db = await createTestDb(); repo = createAgentConfigRepo(db); });
afterEach(() => db.close());

describe('agentConfig', () => {
  it('sin nada guardado devuelve los defaults (ejecución apagada, Opus 5.5)', async () => {
    const c = await repo.get();
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.executionEnabled).toBe(false);
    expect(c.model).toBe('claude-opus-5-5');
  });
  it('update mezcla parcial en 2 niveles y persiste', async () => {
    await repo.update({ executionEnabled: true, thresholds: { winnerMinSales: 5 } });
    const c = await repo.get();
    expect(c.executionEnabled).toBe(true);
    expect(c.thresholds.winnerMinSales).toBe(5);
    expect(c.thresholds.noSalesSpendMultiple).toBe(DEFAULT_CONFIG.thresholds.noSalesSpendMultiple);
  });
  it('rechaza valores inválidos con status 400', async () => {
    await expect(repo.update({ budget: { maxChangePct: 80 } })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ model: 'gpt-5' })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ monthlyBudgetUsd: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ manualRunsPerDay: 1.5 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.update({ inventado: true })).rejects.toMatchObject({ status: 400 });
    expect(await repo.get()).toEqual(DEFAULT_CONFIG);
  });
});
