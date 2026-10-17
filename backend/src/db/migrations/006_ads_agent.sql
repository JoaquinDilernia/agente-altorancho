-- Agente de pauta (mismo esquema que uniformar, adaptado a ventas en la tienda): configuración, corridas,
-- recomendaciones, piezas, pedidos de piezas, aprendizajes, preguntas al equipo y posts de IG promocionados.
-- Las tablas del agente anterior (recommendations, learnings, agent_runs, agent_config) quedan como histórico.

CREATE TABLE ad_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agent_enabled boolean NOT NULL DEFAULT true,
  -- Con autonomous=false TODO lo que el agente quiere hacer queda pendiente de aprobación.
  autonomous boolean NOT NULL DEFAULT false,
  -- 0 = sin tope informado (el agente lo pregunta)
  monthly_cap_ars integer NOT NULL DEFAULT 0 CHECK (monthly_cap_ars >= 0),
  business_notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ad_settings (id) VALUES (1);

CREATE TABLE ad_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('daily','manual')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','skipped')),
  report text NOT NULL DEFAULT '',
  error text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ad_runs_recent ON ad_runs (started_at DESC);

-- Pieza cargada desde el panel. El archivo se sube a la biblioteca de Meta al cargarlo (ad_creative_media):
-- no hace falta storage propio.
CREATE TABLE ad_creatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  copy text NOT NULL,
  headline text NOT NULL DEFAULT '',
  link text NOT NULL,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','publishing','used','archived')),
  meta_ad_id text,
  meta_adset_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE ad_creative_media (
  creative_id uuid NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('feed','story')),
  kind text NOT NULL CHECK (kind IN ('image','video')),
  image_hash text,
  image_url text,
  video_id text,
  thumbnail_url text,
  original_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creative_id, slot)
);

CREATE TABLE ad_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES ad_runs(id) ON DELETE SET NULL,
  tool text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  title text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  expected_impact text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending','executed','rejected','failed')),
  result jsonb,
  error text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX ad_decisions_recent ON ad_decisions (created_at DESC);
CREATE INDEX ad_decisions_pending ON ad_decisions (status) WHERE status = 'pending';

CREATE TABLE ad_creative_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept text NOT NULL,
  style_notes text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE ad_learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  evidence text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','obsolete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES ad_runs(id) ON DELETE SET NULL,
  question text NOT NULL,
  why text NOT NULL DEFAULT '',
  quick_answers jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  answer text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_questions_open ON ad_questions (created_at DESC) WHERE status = 'open';

-- La fila se reserva antes de llamar a Meta (meta_ad_id null) y el UNIQUE impide dos anuncios del mismo post en el mismo conjunto.
CREATE TABLE ad_ig_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_media_id text NOT NULL,
  permalink text NOT NULL DEFAULT '',
  meta_ad_id text,
  meta_adset_id text NOT NULL,
  adset_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ig_media_id, meta_adset_id)
);
