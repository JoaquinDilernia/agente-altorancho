ALTER TABLE meta_ads
  ADD COLUMN objective text,
  ADD COLUMN daily_budget numeric(14,2),
  ADD COLUMN is_cbo boolean NOT NULL DEFAULT false,
  ADD COLUMN created_time timestamptz,
  ADD COLUMN learning_status text,
  ADD COLUMN status_updated_at timestamptz;

CREATE TABLE agent_runs (
  id serial PRIMARY KEY,
  trigger text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  baseline jsonb,
  candidates jsonb,
  skipped jsonb,
  model text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX agent_runs_started_idx ON agent_runs (started_at DESC);

CREATE TABLE recommendations (
  id serial PRIMARY KEY,
  run_id int REFERENCES agent_runs(id),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  level text,
  object_id text,
  target_id text,
  title text NOT NULL,
  reasoning text NOT NULL,
  expected_impact text,
  confidence text NOT NULL,
  dudoso_atribucion boolean NOT NULL DEFAULT false,
  signal text,
  current_value jsonb,
  proposed_value jsonb,
  snapshot jsonb,
  decided_at timestamptz,
  reject_reason text,
  executed_at timestamptz,
  execution_result jsonb,
  previous_value jsonb,
  undo_until timestamptz,
  undone_at timestamptz,
  outcome jsonb,
  verdict text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_status_idx ON recommendations (status, created_at DESC);
CREATE INDEX recommendations_object_idx ON recommendations (object_id);

CREATE TABLE learnings (
  id serial PRIMARY KEY,
  text text NOT NULL,
  evidence_ids int[] NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
