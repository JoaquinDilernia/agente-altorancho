CREATE TABLE orders (
  id bigint PRIMARY KEY,
  number int NOT NULL,
  created_at timestamptz NOT NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  status text NOT NULL,
  payment_status text NOT NULL,
  total numeric(14,2) NOT NULL,
  subtotal numeric(14,2),
  discount numeric(14,2),
  shipping_cost_customer numeric(14,2),
  currency text,
  gateway_name text,
  storefront text,
  customer_name text,
  customer_email text,
  landing_url text,
  visit_landing_page text,
  visit_created_at timestamptz,
  visit_utm jsonb,
  updated_at_tn timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_idx ON orders (created_at DESC, id DESC);
CREATE INDEX orders_payment_status_idx ON orders (payment_status);
CREATE INDEX orders_number_idx ON orders (number);

CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint,
  variant_id bigint,
  sku text,
  name text,
  quantity int NOT NULL,
  price numeric(14,2) NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_attribution (
  order_id bigint PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  channel text NOT NULL,
  confidence text NOT NULL,
  campaign_id text,
  adset_id text,
  ad_id text,
  campaign_name text,
  source_raw jsonb,
  rules_version int NOT NULL
);
CREATE INDEX order_attr_channel_idx ON order_attribution (channel);
CREATE INDEX order_attr_ad_idx ON order_attribution (ad_id);
CREATE INDEX order_attr_adset_idx ON order_attribution (adset_id);
CREATE INDEX order_attr_campaign_idx ON order_attribution (campaign_id);

CREATE TABLE meta_ads (
  id text PRIMARY KEY,
  level text NOT NULL,
  name text,
  status text,
  parent_id text,
  campaign_id text,
  thumbnail_url text,
  url_tags text,
  has_attribution_params boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meta_ads_campaign_name_idx ON meta_ads (lower(name)) WHERE level = 'campaign';

CREATE TABLE meta_spend_daily (
  ad_id text NOT NULL,
  date date NOT NULL,
  campaign_id text,
  adset_id text,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  meta_purchases numeric(12,2) NOT NULL DEFAULT 0,
  meta_purchase_value numeric(14,2) NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, date)
);
CREATE INDEX meta_spend_date_idx ON meta_spend_daily (date);
CREATE INDEX meta_spend_campaign_idx ON meta_spend_daily (campaign_id, date);
CREATE INDEX meta_spend_adset_idx ON meta_spend_daily (adset_id, date);

CREATE TABLE sync_runs (
  id serial PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  rows int NOT NULL DEFAULT 0,
  error text,
  cursor jsonb
);
CREATE INDEX sync_runs_source_idx ON sync_runs (source, started_at DESC);
