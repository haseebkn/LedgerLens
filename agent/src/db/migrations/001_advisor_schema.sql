-- LedgerLens Phase 3.4: Multi-tenant advisor schema with pgvector & Row-Level Security.
-- Every tenant-scoped table carries firm_id + advisor_id and enforces RLS via
-- current_setting('app.firm_id', true) and current_setting('app.advisor_id', true).

CREATE EXTENSION IF NOT EXISTS vector;

-- --- Reference tables (firm & advisor directory) -----------------------------

CREATE TABLE IF NOT EXISTS firms (
  firm_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advisors (
  advisor_id   TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  auth_subject TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Tenant-scoped CRM, custodian, communications & governance tables --------

CREATE TABLE IF NOT EXISTS households (
  household_id            TEXT PRIMARY KEY,
  firm_id                 TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id              TEXT NOT NULL REFERENCES advisors(advisor_id),
  name                    TEXT NOT NULL,
  primary_email           TEXT NOT NULL,
  phone                   TEXT,
  address                 TEXT NOT NULL,
  risk_profile            TEXT NOT NULL CHECK (risk_profile IN ('conservative', 'balanced', 'growth')),
  target_equity_pct       INTEGER NOT NULL CHECK (target_equity_pct BETWEEN 0 AND 100),
  target_fixed_income_pct INTEGER NOT NULL CHECK (target_fixed_income_pct BETWEEN 0 AND 100),
  target_cash_pct         INTEGER NOT NULL CHECK (target_cash_pct BETWEEN 0 AND 100),
  last_review_date        DATE NOT NULL,
  next_review_date        DATE,
  notes_summary           TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_equity_pct + target_fixed_income_pct + target_cash_pct = 100)
);

CREATE TABLE IF NOT EXISTS household_members (
  member_id     TEXT PRIMARY KEY,
  firm_id       TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id    TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id  TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  email         TEXT,
  date_of_birth DATE
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id     TEXT PRIMARY KEY,
  firm_id        TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id     TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id   TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  custodian      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_type   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  cash_balance   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  market_value   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ytd_return_pct NUMERIC(6, 2) NOT NULL DEFAULT 0,
  as_of_date     DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  position_id  TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  asset_class  TEXT NOT NULL CHECK (asset_class IN ('equity', 'fixed_income', 'cash')),
  quantity     NUMERIC(16, 4) NOT NULL,
  market_price NUMERIC(14, 4) NOT NULL,
  market_value NUMERIC(14, 2) NOT NULL,
  cost_basis   NUMERIC(14, 2) NOT NULL,
  as_of_date   DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  firm_id        TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id     TEXT NOT NULL REFERENCES advisors(advisor_id),
  account_id     TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  household_id   TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  txn_type       TEXT NOT NULL CHECK (txn_type IN ('contribution', 'withdrawal', 'buy', 'sell', 'dividend', 'fee')),
  symbol         TEXT,
  quantity       NUMERIC(16, 4),
  amount         NUMERIC(14, 2) NOT NULL,
  txn_date       DATE NOT NULL,
  description    TEXT NOT NULL,
  custodian      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_notes (
  note_id      TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  meeting_date DATE NOT NULL,
  title        TEXT NOT NULL,
  attendees    TEXT[] NOT NULL DEFAULT '{}',
  transcript   TEXT NOT NULL,
  search_tsv   TSVECTOR GENERATED ALWAYS AS (
                 to_tsvector('english', coalesce(title, '') || ' ' || coalesce(transcript, ''))
               ) STORED,
  embedding    vector(384) NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  email_id     TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  sent_at      TIMESTAMPTZ NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  search_tsv   TSVECTOR GENERATED ALWAYS AS (
                 to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body, ''))
               ) STORED,
  embedding    vector(384) NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  event_id     TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  location     TEXT,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id      TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date     DATE,
  source_ref   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id  TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  household_id TEXT NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('crm_update', 'draft_follow_up', 'create_task')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  summary      TEXT NOT NULL,
  before_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  sources      TEXT[] NOT NULL DEFAULT '{}',
  model        TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id     TEXT PRIMARY KEY,
  firm_id      TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id   TEXT NOT NULL REFERENCES advisors(advisor_id),
  proposal_id  TEXT REFERENCES proposals(proposal_id),
  action       TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  diff_json    JSONB NOT NULL,
  sources      TEXT[] NOT NULL DEFAULT '{}',
  model        TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_turns (
  trace_id                    TEXT PRIMARY KEY,
  firm_id                     TEXT NOT NULL REFERENCES firms(firm_id),
  advisor_id                  TEXT NOT NULL REFERENCES advisors(advisor_id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  stop_reason                 TEXT NOT NULL,
  iterations                  INTEGER NOT NULL,
  repaired                    BOOLEAN NOT NULL DEFAULT FALSE,
  errored                     BOOLEAN NOT NULL DEFAULT FALSE,
  citation_warnings           INTEGER NOT NULL DEFAULT 0,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd                    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  total_duration_ms           INTEGER NOT NULL DEFAULT 0,
  time_to_first_token_ms      INTEGER,
  tool_calls_json             JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- --- Append-only enforcement on audit_log ------------------------------------

CREATE OR REPLACE FUNCTION forbid_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; updates and deletes are prohibited'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();

-- --- Indexes (tenant lookups, full-text GIN, pgvector HNSW cosine) -----------

CREATE INDEX IF NOT EXISTS idx_households_tenant ON households (firm_id, advisor_id, last_review_date);
CREATE INDEX IF NOT EXISTS idx_members_household ON household_members (firm_id, advisor_id, household_id);
CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts (firm_id, advisor_id, household_id);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions (firm_id, advisor_id, symbol);
CREATE INDEX IF NOT EXISTS idx_positions_household ON positions (firm_id, advisor_id, household_id);
CREATE INDEX IF NOT EXISTS idx_transactions_hh_date ON transactions (firm_id, advisor_id, household_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_notes_household ON meeting_notes (firm_id, advisor_id, household_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_notes_tsv ON meeting_notes USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_notes_embedding ON meeting_notes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_emails_household ON emails (firm_id, advisor_id, household_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_tsv ON emails USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_emails_embedding ON emails USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_calendar_tenant ON calendar_events (firm_id, advisor_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks (firm_id, advisor_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_proposals_tenant ON proposals (firm_id, advisor_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (firm_id, advisor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_tenant ON agent_turns (firm_id, advisor_id, created_at DESC);

-- --- Row-Level Security (FORCE on every tenant-scoped table) -----------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'households',
    'household_members',
    'accounts',
    'positions',
    'transactions',
    'meeting_notes',
    'emails',
    'calendar_events',
    'tasks',
    'proposals',
    'audit_log',
    'agent_turns'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (firm_id = current_setting(''app.firm_id'', true) AND advisor_id = current_setting(''app.advisor_id'', true)) WITH CHECK (firm_id = current_setting(''app.firm_id'', true) AND advisor_id = current_setting(''app.advisor_id'', true))',
      tbl
    );
  END LOOP;
END $$;

-- --- Allowlisted read-only views (security_invoker enforces caller's RLS) ----

CREATE OR REPLACE VIEW v_households WITH (security_invoker = true) AS
SELECT household_id, firm_id, advisor_id, name, primary_email, phone, address,
       risk_profile, target_equity_pct, target_fixed_income_pct, target_cash_pct,
       last_review_date, next_review_date, notes_summary, updated_at
FROM households;

CREATE OR REPLACE VIEW v_household_members WITH (security_invoker = true) AS
SELECT member_id, firm_id, advisor_id, household_id, full_name, role, email, date_of_birth
FROM household_members;

CREATE OR REPLACE VIEW v_accounts WITH (security_invoker = true) AS
SELECT account_id, firm_id, advisor_id, household_id, custodian, account_number,
       account_type, status, cash_balance, market_value, ytd_return_pct, as_of_date
FROM accounts;

CREATE OR REPLACE VIEW v_positions WITH (security_invoker = true) AS
SELECT position_id, firm_id, advisor_id, account_id, household_id, symbol,
       asset_class, quantity, market_price, market_value, cost_basis, as_of_date
FROM positions;

CREATE OR REPLACE VIEW v_transactions WITH (security_invoker = true) AS
SELECT transaction_id, firm_id, advisor_id, account_id, household_id, txn_type,
       symbol, quantity, amount, txn_date, description, custodian
FROM transactions;

CREATE OR REPLACE VIEW v_meeting_notes WITH (security_invoker = true) AS
SELECT note_id, firm_id, advisor_id, household_id, meeting_date, title, attendees, transcript
FROM meeting_notes;

CREATE OR REPLACE VIEW v_emails WITH (security_invoker = true) AS
SELECT email_id, firm_id, advisor_id, household_id, sent_at, direction, sender, recipient, subject, body
FROM emails;

CREATE OR REPLACE VIEW v_calendar_events WITH (security_invoker = true) AS
SELECT event_id, firm_id, advisor_id, household_id, title, starts_at, ends_at, location, description
FROM calendar_events;

CREATE OR REPLACE VIEW v_tasks WITH (security_invoker = true) AS
SELECT task_id, firm_id, advisor_id, household_id, title, status, priority, due_date, source_ref, created_at, updated_at
FROM tasks;

CREATE OR REPLACE VIEW v_proposals WITH (security_invoker = true) AS
SELECT proposal_id, firm_id, advisor_id, household_id, kind, status, summary,
       before_json, after_json, sources, model, trace_id, created_at, decided_at, decided_by
FROM proposals;

CREATE OR REPLACE VIEW v_audit_log WITH (security_invoker = true) AS
SELECT audit_id, firm_id, advisor_id, proposal_id, action, actor_id,
       target_table, target_id, diff_json, sources, model, trace_id, created_at
FROM audit_log;

-- --- Optional non-superuser roles for Docker / CI (skipped if role creation disallowed) ---

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerlens_app') THEN
    CREATE ROLE ledgerlens_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerlens_ro') THEN
    CREATE ROLE ledgerlens_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  GRANT USAGE ON SCHEMA public TO ledgerlens_app, ledgerlens_ro;

  GRANT SELECT ON firms, advisors TO ledgerlens_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    households, household_members, accounts, positions, transactions,
    meeting_notes, emails, calendar_events, tasks, proposals, agent_turns
    TO ledgerlens_app;
  -- App role can only append to audit_log, never update or delete.
  GRANT SELECT, INSERT ON audit_log TO ledgerlens_app;
  GRANT SELECT ON
    v_households, v_household_members, v_accounts, v_positions, v_transactions,
    v_meeting_notes, v_emails, v_calendar_events, v_tasks, v_proposals, v_audit_log
    TO ledgerlens_app;

  -- SQL tool read-only role uses security_invoker=true views, so Postgres
  -- checks both RLS and base-table SELECT privileges as ledgerlens_ro.
  -- Grant SELECT only on safe tables/columns (never embedding vectors,
  -- internal advisors/firms/agent_turns, or any write privileges).
  GRANT SELECT ON
    households, household_members, accounts, positions, transactions,
    calendar_events, tasks, proposals, audit_log,
    v_households, v_household_members, v_accounts, v_positions, v_transactions,
    v_meeting_notes, v_emails, v_calendar_events, v_tasks, v_proposals, v_audit_log
    TO ledgerlens_ro;
  GRANT SELECT (note_id, firm_id, advisor_id, household_id, meeting_date, title, attendees, transcript)
    ON meeting_notes TO ledgerlens_ro;
  GRANT SELECT (email_id, firm_id, advisor_id, household_id, sent_at, direction, sender, recipient, subject, body)
    ON emails TO ledgerlens_ro;
EXCEPTION
  WHEN insufficient_privilege THEN
    -- Managed Postgres roles (e.g. Neon default owner) are already non-superuser,
    -- so FORCE ROW LEVEL SECURITY applies directly without CREATE ROLE.
    NULL;
END $$;
