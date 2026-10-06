-- Grupos de anuncios / grupos de recursos de Google con su campaña: en PMax el ID que viaja en el
-- link (gad_campaignid) puede no ser el de la campaña.
CREATE TABLE google_entities (
  id text PRIMARY KEY,
  campaign_id text NOT NULL,
  type text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Conversiones solo de categoría Compra (las totales incluyen acciones que no son ventas)
ALTER TABLE google_spend_daily
  ADD COLUMN purchases numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN purchases_value numeric(14,2) NOT NULL DEFAULT 0;
