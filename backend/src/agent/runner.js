import { detectCandidates } from './candidates.js';
import { TOOLS, createToolHandler } from './tools.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { artDate, artDayStart } from '../engine/dates.js';

function addUsage(acc, usage) {
  if (!usage) return;
  if (Array.isArray(usage.iterations) && usage.iterations.length) {
    for (const it of usage.iterations) {
      acc.input += (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0);
      acc.output += it.output_tokens || 0;
    }
    return;
  }
  acc.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  acc.output += usage.output_tokens || 0;
}

const cost = (acc, config) => {
  const p = config.prices[config.model];
  return (acc.input * p.input + acc.output * p.output) / 1e6;
};

export function createAgentRunner({ anthropic, configRepo, runs, recs, learnings, loadDataset, now = () => new Date(), log = console }) {
  let running = false;

  async function quotaLeftFor(config) {
    const since = artDayStart(artDate(now()));
    return Math.max(0, config.manualRunsPerDay - await runs.manualCountSince(since));
  }

  async function run({ trigger }) {
    if (running) return { skipped: 'running' };
    const config = await configRepo.get();
    if (!config.agentEnabled) return { skipped: 'disabled' };
    if (trigger === 'manual' && (await quotaLeftFor(config)) <= 0) return { skipped: 'quota' };
    const monthStart = `${artDate(now()).slice(0, 7)}-01T00:00:00-03:00`;
    if ((await runs.costSince(monthStart)) >= config.monthlyBudgetUsd) return { skipped: 'budget' };

    running = true;
    const runId = await runs.start({ trigger, model: config.model, startedAt: now().toISOString() });
    const usage = { input: 0, output: 0 };
    try {
      const dataset = await loadDataset();
      const recent = await recs.recent({ days: 14, now: now().toISOString() });
      const candidates = detectCandidates({ dataset, config, recent });
      const summary = candidates.map((c) => ({ key: c.key, signal: c.signal, name: c.name }));
      if (candidates.length === 0) {
        await runs.finish(runId, { status: 'ok', baseline: dataset.baseline, candidates: [], skipped: [] });
        return { runId, candidates: 0, recommendations: 0, costUsd: 0 };
      }

      const handler = createToolHandler({ runId, candidates, recs, learnings, config });
      const messages = [{
        role: 'user',
        content: buildUserMessage({ dataset, candidates, recent, learnings: await learnings.listActive(), config }),
      }];
      for (let turn = 0; turn < config.maxTurns; turn += 1) {
        const response = await anthropic.beta.messages.create({
          model: config.model,
          max_tokens: config.maxOutputTokens,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          output_config: { effort: config.effort },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        addUsage(usage, response.usage);
        if (response.stop_reason === 'refusal') {
          throw new Error(`Claude rechazó el análisis (${response.stop_details?.category ?? 'sin categoría'})`);
        }
        messages.push({ role: 'assistant', content: response.content });
        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;
        const results = [];
        for (const tu of toolUses) {
          const r = await handler.handle(tu.name, tu.input);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        if (turn === config.maxTurns - 1) log.warn(`[agente] corrida ${runId}: se alcanzó maxTurns (${config.maxTurns})`);
      }

      const skipped = [
        ...handler.skipped,
        ...candidates.filter((c) => !handler.handled.has(c.key)).map((c) => ({ key: c.key, motivo: 'sin decisión del agente' })),
      ];
      const costUsd = cost(usage, config);
      await runs.finish(runId, {
        status: 'ok', baseline: dataset.baseline, candidates: summary, skipped,
        input_tokens: usage.input, output_tokens: usage.output, cost_usd: costUsd,
      });
      return { runId, candidates: candidates.length, recommendations: handler.created.length, costUsd };
    } catch (err) {
      log.error(`[agente] corrida ${runId} falló:`, err);
      await runs.finish(runId, {
        status: 'error', error: String(err.message || err).slice(0, 2000),
        input_tokens: usage.input, output_tokens: usage.output, cost_usd: cost(usage, config),
      });
      throw err;
    } finally {
      running = false;
    }
  }

  return {
    run,
    quotaLeft: async () => quotaLeftFor(await configRepo.get()),
    isRunning: () => running,
  };
}
