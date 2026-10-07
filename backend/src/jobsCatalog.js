import { attribute } from './engine/attribution.js';
import { artDate, addDays } from './engine/dates.js';

// Jobs disparables por cron o por POST /api/sync/:job. Cada fn(ctx) devuelve la cantidad de filas.
export function createJobCatalog({ orderSync, metaSync, ga4Sync, ordersRepo, syncRuns, now = () => new Date() }) {
  const ga4Jobs = ga4Sync ? {
    'ga4': {
      source: 'ga4',
      fn: () => {
        const today = artDate(now());
        return ga4Sync.syncRange(addDays(today, -3), today);
      },
    },
    'ga4-backfill': {
      source: 'ga4_backfill',
      fn: (ctx) => ga4Sync.backfill({ today: artDate(now()), onMonthDone: (month, total) => ctx.progress(total, { done: month }) }),
    },
  } : {};
  return {
    ...ga4Jobs,
    'tn-backfill': {
      source: 'tn_backfill',
      async fn(ctx) {
        const last = await syncRuns.lastCursor('tn_backfill');
        const resumeAfter = last && !last.complete ? last.done : null;
        const rows = await orderSync.backfill({
          to: artDate(now()),
          resumeAfter,
          onMonthDone: (month, total) => ctx.progress(total, { done: month, complete: false }),
        });
        await ctx.progress(rows, { done: artDate(now()).slice(0, 7), complete: true });
        return rows;
      },
    },
    'tn-incremental': {
      source: 'tn_incremental',
      fn: () => orderSync.syncUpdatedSince(new Date(now().getTime() - 2 * 3600 * 1000).toISOString()),
    },
    'meta-catalog': { source: 'meta_catalog', fn: () => metaSync.syncCatalog() },
    'meta-spend': {
      source: 'meta_spend',
      fn: () => {
        const today = artDate(now());
        return metaSync.syncSpend(addDays(today, -7), today);
      },
    },
    'meta-backfill': {
      source: 'meta_backfill',
      fn: (ctx) => metaSync.backfillSpend({ now: now(), onMonthDone: (month, total) => ctx.progress(total, { done: month }) }),
    },
    reattribute: {
      source: 'reattribute',
      async fn(ctx) {
        let after = '0';
        let n = 0;
        for (;;) {
          const batch = await ordersRepo.listForReattribution(after, 1000);
          if (batch.length === 0) break;
          for (const o of batch) {
            await ordersRepo.setAttribution(o.id, attribute({ landingUrl: o.landing_url, visitLandingPage: o.visit_landing_page, visitUtm: o.visit_utm }));
          }
          n += batch.length;
          after = batch[batch.length - 1].id;
          await ctx.progress(n);
        }
        await ordersRepo.resolveMetaIds();
        return n;
      },
    },
  };
}
