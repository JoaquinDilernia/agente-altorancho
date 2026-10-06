import { mapOrder } from '../engine/mapOrder.js';
import { attribute } from '../engine/attribution.js';
import { artDate, addDays, artDayStart, monthRanges } from '../engine/dates.js';

const PAGE_SIZE = 200;

export function createOrderSync({ tn, ordersRepo, log = console }) {
  async function ingest(tnOrder) {
    const m = mapOrder(tnOrder);
    await ordersRepo.upsert({ ...m, attribution: attribute(m.visit) });
  }

  // Pagina con los filtros dados; las órdenes que fallan se acumulan en `failed` sin frenar el resto.
  async function syncPages(filters, failed) {
    let rows = 0;
    for (let page = 1; ; page += 1) {
      const list = await tn.listOrders({ ...filters, page });
      for (const o of list) {
        try {
          await ingest(o);
          rows += 1;
        } catch (err) {
          log.error(`[orders] no se pudo guardar la orden ${o?.id}:`, err);
          failed.push(o?.id);
        }
      }
      if (list.length < PAGE_SIZE) return rows;
    }
  }

  function assertNoFailures(failed) {
    if (failed.length) throw new Error(`${failed.length} órdenes fallaron: ${failed.slice(0, 20).join(', ')}`);
  }

  return {
    ingest,
    async syncOrder(id) {
      await ingest(await tn.getOrder(id));
      return 1;
    },
    async syncUpdatedSince(iso) {
      const failed = [];
      const rows = await syncPages({ updatedMin: iso }, failed);
      assertNoFailures(failed);
      return rows;
    },
    async backfill({ from = '2018-01-01', to = artDate(), resumeAfter = null, onMonthDone = async () => {} } = {}) {
      const failed = [];
      let rows = 0;
      for (const { since, until } of monthRanges(from, to)) {
        const month = since.slice(0, 7);
        if (resumeAfter && month <= resumeAfter) continue;
        rows += await syncPages({ createdMin: artDayStart(since), createdMax: artDayStart(addDays(until, 1)) }, failed);
        await onMonthDone(month, rows);
      }
      assertNoFailures(failed);
      return rows;
    },
  };
}
