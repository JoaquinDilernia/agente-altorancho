CREATE TABLE google_campaigns (
  id text PRIMARY KEY,
  name text,
  status text,
  channel_type text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE google_spend_daily (
  campaign_id text NOT NULL,
  date date NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  conversions numeric(12,2) NOT NULL DEFAULT 0,
  conversions_value numeric(14,2) NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX google_spend_date_idx ON google_spend_daily (date);
