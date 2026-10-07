import { artDate, addDays } from '../engine/dates.js';

export const PAID = "o.payment_status = 'paid' AND o.cancelled_at IS NULL";
// Rango de días ART inclusivo sobre orders.created_at ($a = desde, $b = hasta, 'YYYY-MM-DD')
export const RANGE = (a, b) => `o.created_at >= ($${a}::text || 'T00:00:00-03:00')::timestamptz
  AND o.created_at < (($${b}::date + 1)::text || 'T00:00:00-03:00')::timestamptz`;
const KEY = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const PARENT = { adset: 'campaign_id', ad: 'adset_id' };

const ratio = (a, b) => (b > 0 ? a / b : null);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function encodeCursor(row) {
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');
}
function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!ts || !/^\d+$/.test(id || '') || Number.isNaN(Date.parse(ts))) throw badRequest('cursor inválido');
  return [ts, id];
}

function enrich(r) {
  return {
    id: r.id, name: r.name, status: r.status, thumbnail_url: r.thumbnail_url,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, sales: r.sales, revenue: r.revenue,
    costPerSale: r.spend > 0 && r.sales > 0 ? r.spend / r.sales : null,
    roas: ratio(r.revenue, r.spend),
    metaPurchases: r.meta_purchases, metaValue: r.meta_value, metaRoas: ratio(r.meta_value, r.spend),
    noSales: r.spend > 0 && r.sales === 0,
  };
}

const SORTS = {
  spend: (a, b) => b.spend - a.spend,
  // los que gastan sin vender primero, después costo por venta más alto; sin dato al final
  cps: (a, b) => {
    const v = (x) => (x.noSales ? Infinity : x.costPerSale ?? -1);
    return v(b) - v(a);
  },
  roas: (a, b) => (a.roas ?? Infinity) - (b.roas ?? Infinity),
};

export function createReportsRepo(db) {
  async function googleRanking({ from, to, sort = 'spend' }) {
    const { rows } = await db.query(
      `WITH sp AS (
         SELECT campaign_id AS id, sum(spend) AS s, sum(impressions) AS imp, sum(clicks) AS clk,
                sum(purchases) AS mp, sum(purchases_value) AS mv
           FROM google_spend_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY 1),
       sa AS (
         SELECT a.campaign_id AS id, count(*) AS n, sum(o.total) AS rev
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'google' AND a.campaign_id IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)}
          GROUP BY 1)
       SELECT COALESCE(sp.id, sa.id) AS id, g.name, g.status, NULL AS thumbnail_url,
              COALESCE(sp.s, 0)::float8 AS spend, COALESCE(sp.imp, 0)::int AS impressions, COALESCE(sp.clk, 0)::int AS clicks,
              COALESCE(sp.mp, 0)::float8 AS meta_purchases, COALESCE(sp.mv, 0)::float8 AS meta_value,
              COALESCE(sa.n, 0)::int AS sales, COALESCE(sa.rev, 0)::float8 AS revenue
         FROM sp FULL OUTER JOIN sa ON sa.id = sp.id
         LEFT JOIN google_campaigns g ON g.id = COALESCE(sp.id, sa.id)`,
      [from, to],
    );
    const { rows: [u] } = await db.query(
      `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
         FROM orders o JOIN order_attribution a ON a.order_id = o.id
        WHERE a.channel = 'google' AND a.campaign_id IS NULL AND ${PAID} AND ${RANGE(1, 2)}`,
      [from, to],
    );
    return { level: 'campaign', platform: 'google', rows: rows.map(enrich).sort(SORTS[sort] || SORTS.spend), unidentified: u };
  }

  async function adsRanking({ from, to, level = 'campaign', parentId = null, sort = 'spend', platform = 'meta' }) {
    if (platform === 'google') return googleRanking({ from, to, sort });
    const key = KEY[level];
    if (!key) throw badRequest('level inválido');
    // en campañas/conjuntos: miniatura del anuncio que más gastó en el período
    const childCol = { campaign: 'campaign_id', adset: 'parent_id' }[level];
    const thumbSql = childCol
      ? `COALESCE(m.thumbnail_url, (SELECT ad.thumbnail_url FROM meta_ads ad
           LEFT JOIN meta_spend_daily sd ON sd.ad_id = ad.id AND sd.date BETWEEN $1::date AND $2::date
          WHERE ad.level = 'ad' AND ad.thumbnail_url IS NOT NULL AND ad.${childCol} = COALESCE(sp.id, sa.id)
          GROUP BY ad.id, ad.thumbnail_url ORDER BY COALESCE(sum(sd.spend), 0) DESC, ad.id LIMIT 1))`
      : 'm.thumbnail_url';
    const params = [from, to];
    let spendParent = '';
    let salesParent = '';
    if (parentId && PARENT[level]) {
      params.push(parentId);
      spendParent = `AND ${PARENT[level]} = $3`;
      salesParent = `AND a.${PARENT[level]} = $3`;
    }
    const { rows } = await db.query(
      `WITH sp AS (
         SELECT ${key} AS id, sum(spend) AS s, sum(impressions) AS imp, sum(clicks) AS clk,
                sum(meta_purchases) AS mp, sum(meta_purchase_value) AS mv
           FROM meta_spend_daily
          WHERE date BETWEEN $1::date AND $2::date AND ${key} IS NOT NULL ${spendParent}
          GROUP BY 1),
       sa AS (
         SELECT a.${key} AS id, count(*) AS n, sum(o.total) AS rev
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.${key} IS NOT NULL AND ${PAID} AND ${RANGE(1, 2)} ${salesParent}
          GROUP BY 1)
       SELECT COALESCE(sp.id, sa.id) AS id, m.name, m.status, ${thumbSql} AS thumbnail_url,
              COALESCE(sp.s, 0)::float8 AS spend, COALESCE(sp.imp, 0)::int AS impressions, COALESCE(sp.clk, 0)::int AS clicks,
              COALESCE(sp.mp, 0)::float8 AS meta_purchases, COALESCE(sp.mv, 0)::float8 AS meta_value,
              COALESCE(sa.n, 0)::int AS sales, COALESCE(sa.rev, 0)::float8 AS revenue
         FROM sp FULL OUTER JOIN sa ON sa.id = sp.id
         LEFT JOIN meta_ads m ON m.id = COALESCE(sp.id, sa.id)`,
      params,
    );
    const out = rows.map(enrich).sort(SORTS[sort] || SORTS.spend);
    let unidentified = null;
    if (level === 'campaign' && !parentId) {
      const { rows: u } = await db.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND a.campaign_id IS NULL AND ${PAID} AND ${RANGE(1, 2)}`,
        [from, to],
      );
      unidentified = u[0];
    }
    return { level, rows: out, unidentified };
  }

  return {
    async summary({ from, to }) {
      const { rows: [tot] } = await db.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue FROM orders o WHERE ${PAID} AND ${RANGE(1, 2)}`,
        [from, to],
      );
      const { rows: channels } = await db.query(
        `SELECT COALESCE(a.channel, 'unknown') AS channel, count(*)::int AS orders, COALESCE(sum(o.total), 0)::float8 AS revenue
           FROM orders o LEFT JOIN order_attribution a ON a.order_id = o.id
          WHERE ${PAID} AND ${RANGE(1, 2)} GROUP BY 1 ORDER BY revenue DESC`,
        [from, to],
      );
      const { rows: [sp] } = await db.query(
        `SELECT COALESCE(sum(spend), 0)::float8 AS spend, COALESCE(sum(meta_purchases), 0)::float8 AS purchases,
                COALESCE(sum(meta_purchase_value), 0)::float8 AS value
           FROM meta_spend_daily WHERE date BETWEEN $1::date AND $2::date`,
        [from, to],
      );
      const { rows: cov } = await db.query(
        `SELECT a.confidence, count(*)::int AS n FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND ${PAID} AND ${RANGE(1, 2)} GROUP BY 1`,
        [from, to],
      );
      const m = channels.find((c) => c.channel === 'meta') || { orders: 0, revenue: 0 };
      const coverage = { ad: 0, campaign: 0, none: 0 };
      for (const c of cov) coverage[c.confidence] = c.n;
      const { rows: [gs] } = await db.query(
        `SELECT COALESCE(sum(spend), 0)::float8 AS spend, COALESCE(sum(purchases), 0)::float8 AS conversions,
                COALESCE(sum(purchases_value), 0)::float8 AS value
           FROM google_spend_daily WHERE date BETWEEN $1::date AND $2::date`,
        [from, to],
      );
      const { rows: gcov } = await db.query(
        `SELECT a.confidence, count(*)::int AS n FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'google' AND ${PAID} AND ${RANGE(1, 2)} GROUP BY 1`,
        [from, to],
      );
      const g = channels.find((c) => c.channel === 'google') || { orders: 0, revenue: 0 };
      const googleCoverage = { campaign: 0, none: 0 };
      for (const c of gcov) googleCoverage[c.confidence] = c.n;
      const google = {
        spend: gs.spend, orders: g.orders, revenue: g.revenue,
        roas: ratio(g.revenue, gs.spend),
        costPerSale: gs.spend > 0 && g.orders > 0 ? gs.spend / g.orders : null,
        reported: { conversions: gs.conversions, value: gs.value, roas: ratio(gs.value, gs.spend) },
        coverage: googleCoverage,
      };
      return {
        from, to, revenue: tot.revenue, orders: tot.orders, avgTicket: ratio(tot.revenue, tot.orders), channels,
        meta: {
          spend: sp.spend, orders: m.orders, revenue: m.revenue,
          roas: ratio(m.revenue, sp.spend),
          costPerSale: sp.spend > 0 && m.orders > 0 ? sp.spend / m.orders : null,
          reported: { purchases: sp.purchases, value: sp.value, roas: ratio(sp.value, sp.spend) },
        },
        coverage,
        google,
      };
    },

    async listOrders({ from, to, channel, q, cursor, limit = 50 }) {
      const params = [];
      const where = [];
      const term = (q || '').trim();
      if (/^\d+$/.test(term)) {
        params.push(Number(term));
        where.push(`o.number = $${params.length}`);
      } else {
        params.push(from, to);
        where.push(RANGE(1, 2));
        if (term) {
          params.push(`%${term}%`);
          const i = params.length;
          where.push(`(o.customer_name ILIKE $${i} OR o.customer_email ILIKE $${i}
            OR EXISTS (SELECT 1 FROM order_items it WHERE it.order_id = o.id AND it.name ILIKE $${i}))`);
        }
      }
      if (channel) {
        params.push(channel);
        where.push(`COALESCE(a.channel, 'unknown') = $${params.length}`);
      }
      if (cursor) {
        const [ts, id] = decodeCursor(cursor);
        params.push(ts, id);
        where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
      }
      params.push(limit + 1);
      const { rows } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.total::float8 AS total, o.status, o.payment_status,
                o.cancelled_at IS NOT NULL AS cancelled, o.customer_name,
                (SELECT COALESCE(sum(it.quantity), 0) FROM order_items it WHERE it.order_id = o.id)::int AS items_count,
                COALESCE(a.channel, 'unknown') AS channel, a.confidence, a.ad_id, a.campaign_id,
                COALESCE(c.name, gc.name, a.campaign_name) AS campaign_name, ad.name AS ad_name
           FROM orders o
           LEFT JOIN order_attribution a ON a.order_id = o.id
           LEFT JOIN meta_ads c ON c.id = a.campaign_id
           LEFT JOIN google_campaigns gc ON gc.id = a.campaign_id AND a.channel = 'google'
           LEFT JOIN meta_ads ad ON ad.id = a.ad_id
          WHERE ${where.join(' AND ')}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $${params.length}`,
        params,
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
    },

    async orderDetail(id) {
      if (!/^\d+$/.test(String(id))) return null;
      const { rows } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.paid_at, o.cancelled_at, o.status, o.payment_status,
                o.total::float8 AS total, o.subtotal::float8 AS subtotal, o.discount::float8 AS discount,
                o.shipping_cost_customer::float8 AS shipping_cost_customer, o.currency, o.gateway_name, o.storefront,
                o.customer_name, o.customer_email, o.landing_url, o.visit_landing_page, o.visit_created_at,
                COALESCE(a.channel, 'unknown') AS channel, a.confidence, a.ad_id, a.adset_id, a.campaign_id, a.source_raw,
                COALESCE(c.name, gc.name, a.campaign_name) AS campaign_name, ad.name AS ad_name, ad.thumbnail_url, s.name AS adset_name
           FROM orders o
           LEFT JOIN order_attribution a ON a.order_id = o.id
           LEFT JOIN meta_ads ad ON ad.id = a.ad_id
           LEFT JOIN meta_ads s ON s.id = a.adset_id
           LEFT JOIN meta_ads c ON c.id = a.campaign_id
           LEFT JOIN google_campaigns gc ON gc.id = a.campaign_id AND a.channel = 'google'
          WHERE o.id = $1::bigint`,
        [id],
      );
      const order = rows[0];
      if (!order) return null;
      const { rows: items } = await db.query(
        `SELECT product_id::text AS product_id, variant_id::text AS variant_id, sku, name, quantity, price::float8 AS price
           FROM order_items WHERE order_id = $1::bigint`,
        [id],
      );
      let costEstimate = null;
      const level = order.ad_id ? 'ad' : order.campaign_id ? 'campaign' : null;
      if (order.channel === 'meta' && level) {
        const col = KEY[level];
        const key = order[col];
        const to = artDate(order.created_at);
        const from = addDays(to, -6);
        const { rows: [s] } = await db.query(
          `SELECT COALESCE(sum(spend), 0)::float8 AS spend FROM meta_spend_daily WHERE ${col} = $1 AND date BETWEEN $2::date AND $3::date`,
          [key, from, to],
        );
        const { rows: [n] } = await db.query(
          `SELECT count(*)::int AS sales FROM orders o JOIN order_attribution a ON a.order_id = o.id
            WHERE a.${col} = $1 AND ${PAID} AND ${RANGE(2, 3)}`,
          [key, from, to],
        );
        costEstimate = { level, from, to, spend: s.spend, sales: n.sales, costPerSale: s.spend > 0 && n.sales > 0 ? s.spend / n.sales : null };
      }
      return { ...order, items, costEstimate };
    },

    adsRanking,

    async adDetail({ id, from, to }) {
      const { rows } = await db.query(
        `SELECT id, level, name, status, thumbnail_url, has_attribution_params, url_tags, parent_id, campaign_id
           FROM meta_ads WHERE id = $1`,
        [id],
      );
      let ad = rows[0];
      if (!ad) {
        // Anuncio borrado/fuera del catálogo: si tiene gasto, se muestra igual con lo que sabemos
        const { rows: sp } = await db.query(
          'SELECT adset_id, campaign_id FROM meta_spend_daily WHERE ad_id = $1 ORDER BY date DESC LIMIT 1',
          [id],
        );
        if (!sp[0]) return null;
        ad = { id, level: 'ad', name: null, status: null, thumbnail_url: null, has_attribution_params: false, url_tags: null, parent_id: sp[0].adset_id, campaign_id: sp[0].campaign_id };
      }
      const parentId = ad.level === 'campaign' ? null : ad.parent_id;
      const ranking = await adsRanking({ from, to, level: ad.level, parentId });
      const metrics = ranking.rows.find((r) => r.id === id)
        || enrich({ id, name: ad.name, status: ad.status, thumbnail_url: ad.thumbnail_url, spend: 0, impressions: 0, clicks: 0, sales: 0, revenue: 0, meta_purchases: 0, meta_value: 0 });
      const col = KEY[ad.level];
      const { rows: orders } = await db.query(
        `SELECT o.id::text AS id, o.number, o.created_at, o.total::float8 AS total, o.customer_name
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.${col} = $1 AND ${PAID} AND ${RANGE(2, 3)}
          ORDER BY o.created_at DESC LIMIT 100`,
        [id, from, to],
      );
      return { ad, metrics, orders };
    },

    async coverageWeekly({ now = new Date() } = {}) {
      const since = new Date(new Date(now).getTime() - 56 * 86400000).toISOString();
      const { rows } = await db.query(
        `SELECT to_char(date_trunc('week', (o.created_at AT TIME ZONE 'UTC') - interval '3 hours'), 'YYYY-MM-DD') AS week,
                (count(*) FILTER (WHERE a.confidence = 'ad'))::int AS ad,
                (count(*) FILTER (WHERE a.confidence = 'campaign'))::int AS campaign,
                (count(*) FILTER (WHERE a.confidence = 'none'))::int AS "none"
           FROM orders o JOIN order_attribution a ON a.order_id = o.id
          WHERE a.channel = 'meta' AND ${PAID} AND o.created_at >= $1::timestamptz
          GROUP BY 1 ORDER BY 1`,
        [since],
      );
      return rows;
    },

    async counts() {
      const { rows: [o] } = await db.query('SELECT count(*)::int AS n FROM orders');
      const { rows: [a] } = await db.query(
        "SELECT count(*)::int AS n FROM meta_ads WHERE level = 'ad' AND status = 'ACTIVE' AND NOT has_attribution_params",
      );
      return { orders: o.n, adsMissingParams: a.n };
    },
  };
}
