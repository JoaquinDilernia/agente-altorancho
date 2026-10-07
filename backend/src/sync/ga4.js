// Trae de GA4, por transacción, el primer contacto del usuario y el canal de la sesión de compra.
const DIMENSIONS = ['transactionId', 'date', 'firstUserDefaultChannelGroup', 'firstUserSource', 'firstUserMedium', 'sessionDefaultChannelGroup'];

const lastDayOfMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const prevMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export function createGa4Sync({ ga4, ga4Repo }) {
  async function syncRange(from, to) {
    const rows = await ga4.runReportAll({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: DIMENSIONS.map((name) => ({ name })),
      metrics: [{ name: 'transactions' }],
    });
    return ga4Repo.upsertTransactions(rows.map((r) => {
      const [transactionId, date, firstGroup, firstSource, firstMedium, sessionGroup] = r.dimensionValues.map((d) => d.value);
      return { transactionId, date, firstGroup, firstSource, firstMedium, sessionGroup };
    }));
  }

  return {
    syncRange,
    // Mes a mes desde el actual hacia atrás
    async backfill({ today, months = 13, onMonthDone = () => {} }) {
      let ym = today.slice(0, 7);
      let total = 0;
      for (let i = 0; i < months; i++, ym = prevMonth(ym)) {
        total += await syncRange(`${ym}-01`, i === 0 ? today : lastDayOfMonth(ym));
        await onMonthDone(ym, total);
      }
      return total;
    },
  };
}
