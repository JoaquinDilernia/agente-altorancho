const ORDER_COLS = ['id', 'number', 'created_at', 'paid_at', 'cancelled_at', 'status', 'payment_status', 'total',
  'subtotal', 'discount', 'shipping_cost_customer', 'currency', 'gateway_name', 'storefront', 'customer_name',
  'customer_email', 'landing_url', 'visit_landing_page', 'visit_created_at', 'visit_utm', 'updated_at_tn'];
const ATTR_COLS = ['channel', 'confidence', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'source_raw', 'rules_version'];

// Completa adset/campaign desde el catálogo de Meta. $1 = order_id o null (todas).
const RESOLVE_SQL = [
  `UPDATE order_attribution oa
      SET adset_id = COALESCE(oa.adset_id, a.parent_id), campaign_id = COALESCE(oa.campaign_id, a.campaign_id)
     FROM meta_ads a
    WHERE a.level = 'ad' AND a.id = oa.ad_id AND (oa.adset_id IS NULL OR oa.campaign_id IS NULL)
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
  `UPDATE order_attribution oa SET campaign_id = a.campaign_id
     FROM meta_ads a
    WHERE a.level = 'adset' AND a.id = oa.adset_id AND oa.campaign_id IS NULL
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
  `UPDATE order_attribution oa SET campaign_id = c.id
     FROM meta_ads c
    WHERE oa.channel = 'meta' AND oa.campaign_id IS NULL AND oa.campaign_name IS NOT NULL
      AND c.level = 'campaign' AND lower(c.name) = lower(oa.campaign_name)
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
  // Respaldo para anuncios borrados (fuera del catálogo): el gasto diario guarda su conjunto y campaña
  `UPDATE order_attribution oa
      SET adset_id = COALESCE(oa.adset_id, s.adset_id), campaign_id = COALESCE(oa.campaign_id, s.campaign_id)
     FROM (SELECT DISTINCT ON (ad_id) ad_id, adset_id, campaign_id FROM meta_spend_daily ORDER BY ad_id, date DESC) s
    WHERE s.ad_id = oa.ad_id AND (oa.adset_id IS NULL OR oa.campaign_id IS NULL)
      AND ($1::bigint IS NULL OR oa.order_id = $1::bigint)`,
];

async function writeAttribution(q, orderId, a) {
  const values = ATTR_COLS.map((c) => (c === 'source_raw' ? JSON.stringify(a.source_raw ?? {}) : a[c] ?? null));
  await q.query(
    `INSERT INTO order_attribution (order_id, ${ATTR_COLS.join(', ')})
     VALUES ($1, ${ATTR_COLS.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (order_id) DO UPDATE SET ${ATTR_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [orderId, ...values],
  );
}

async function resolveWith(q, orderId) {
  for (const sql of RESOLVE_SQL) await q.query(sql, [orderId]);
}

export function createOrdersRepo(db) {
  return {
    async upsert({ order, items, attribution }) {
      await db.tx(async (q) => {
        const values = ORDER_COLS.map((c) => (c === 'visit_utm' ? (order.visit_utm ? JSON.stringify(order.visit_utm) : null) : order[c]));
        await q.query(
          `INSERT INTO orders (${ORDER_COLS.join(', ')}) VALUES (${ORDER_COLS.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (id) DO UPDATE SET ${ORDER_COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, synced_at = now()`,
          values,
        );
        await q.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
        for (const it of items) {
          await q.query(
            'INSERT INTO order_items (order_id, product_id, variant_id, sku, name, quantity, price) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [order.id, it.product_id, it.variant_id, it.sku, it.name, it.quantity, it.price],
          );
        }
        await writeAttribution(q, order.id, attribution);
        await resolveWith(q, order.id);
      });
    },
    resolveMetaIds: (orderId = null) => resolveWith(db, orderId),
    async listForReattribution(afterId, limit) {
      const { rows } = await db.query(
        `SELECT id::text AS id, landing_url, visit_landing_page, visit_utm
           FROM orders WHERE id > $1::bigint ORDER BY id LIMIT $2`,
        [afterId, limit],
      );
      return rows;
    },
    setAttribution: (orderId, attribution) => db.tx((q) => writeAttribution(q, orderId, attribution)),
  };
}
