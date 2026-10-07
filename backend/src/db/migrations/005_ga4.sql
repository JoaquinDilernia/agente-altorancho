-- Primer contacto y canal de la sesión de compra según GA4, por transacción (= número o id de orden de TN)
CREATE TABLE ga4_transactions (
  transaction_id text PRIMARY KEY,
  first_channel text,
  first_group text,
  first_source text,
  first_medium text,
  session_group text,
  date date,
  synced_at timestamptz NOT NULL DEFAULT now()
);
