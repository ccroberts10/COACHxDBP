-- DBP Coach — Postgres Schema
-- Run once on a fresh Postgres database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===================================================================
-- USERS & AUTH
-- ===================================================================

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  birthdate       DATE,                                       -- for birthday perk
  timezone        TEXT DEFAULT 'America/Denver',
  -- Stripe
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT,
  subscription_tier       TEXT,                                -- 'free', 'rewards' (rewards only), 'coach' (coach + rewards)
  subscription_status     TEXT,                                -- 'trialing', 'active', 'past_due', 'canceled'
  trial_ends_at           TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  -- Lifecycle
  onboarding_completed    BOOLEAN DEFAULT FALSE,
  email_verified          BOOLEAN DEFAULT FALSE,
  is_admin                BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  last_login_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(subscription_status) WHERE subscription_status IN ('active', 'trialing');

-- Magic link tokens for passwordless login
CREATE TABLE IF NOT EXISTS auth_tokens (
  token         TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);

-- Long-lived session cookies (30 days)
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ===================================================================
-- USER PROFILE & BENCHMARKS
-- ===================================================================

CREATE TABLE IF NOT EXISTS user_benchmarks (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ftp_watts               INTEGER,
  max_hr                  INTEGER,
  lthr                    INTEGER,
  rhr_baseline            INTEGER,
  hrv_baseline            REAL,
  bodyweight_kg           REAL,
  squat_1rm_lb            INTEGER,
  deadlift_1rm_lb         INTEGER,
  bench_1rm_lb            INTEGER,
  -- Training preferences
  primary_focus           TEXT,                       -- 'cycling', 'cycling-balanced', 'strength', 'general', 'aerobic_base'
  weekly_hours_target     REAL DEFAULT 8,
  strength_target_per_week INTEGER DEFAULT 2,
  -- Equipment (json array of strings)
  home_gym_equipment      JSONB DEFAULT '[]'::jsonb,  -- e.g. ["barbell", "rack", "dumbbells", "kettlebells", "bands", "pullup_bar"]
  has_indoor_trainer      BOOLEAN DEFAULT FALSE,
  -- Location
  location_lat            REAL,
  location_lng            REAL,
  location_name           TEXT,
  -- Event mode (nullable)
  current_event_name      TEXT,
  current_event_date      DATE,
  current_event_type      TEXT,                       -- 'gravel', 'road', 'mtb', 'gran_fondo', 'crit'
  current_event_distance_km REAL,
  current_event_elevation_m REAL,
  -- Local routes (json array of {name, description, type})
  local_routes            JSONB DEFAULT '[]'::jsonb,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ===================================================================
-- INTEGRATIONS (WHOOP, STRAVA TOKENS)
-- ===================================================================

CREATE TABLE IF NOT EXISTS integrations (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service         TEXT NOT NULL,                      -- 'whoop' | 'strava'
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  scope           TEXT,
  status          TEXT DEFAULT 'connected',           -- 'connected' | 'disconnected' | 'error'
  error_message   TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, service)
);

CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);

-- ===================================================================
-- TRAINING DATA
-- ===================================================================

CREATE TABLE IF NOT EXISTS daily_snapshots (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  recovery_pct            INTEGER,
  hrv                     REAL,
  rhr                     INTEGER,
  sleep_hours             REAL,
  sleep_efficiency        REAL,
  deep_sleep_min          INTEGER,
  rem_sleep_min           INTEGER,
  light_sleep_min         INTEGER,
  sleep_performance       INTEGER,
  yesterday_strain        REAL,
  weekly_strain_avg       REAL,
  monthly_strain_avg      REAL,
  acute_chronic_ratio     REAL,
  raw_whoop               JSONB,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_date ON daily_snapshots(user_id, date DESC);

CREATE TABLE IF NOT EXISTS activities (
  id                      TEXT NOT NULL,              -- Strava activity ID (string)
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  type                    TEXT,
  duration_sec            INTEGER,
  distance_m              REAL,
  avg_hr                  INTEGER,
  max_hr                  INTEGER,
  avg_power               INTEGER,
  normalized_power        INTEGER,
  elevation_gain_m        REAL,
  suffer_score            INTEGER,
  raw_strava              JSONB,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities(user_id, date DESC);

-- Member Rewards: auto-trigger tracking on activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS triggers_processed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_activities_unprocessed ON activities(triggers_processed_at) WHERE triggers_processed_at IS NULL;

-- Auto-trigger rules: e.g., "big ride finished" → issue reward
CREATE TABLE IF NOT EXISTS auto_triggers (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT NOT NULL,                   -- "Big ride bonus"
  trigger_type            TEXT NOT NULL,                   -- 'big_ride' | 'rainy_day' | 'sunday_morning' | etc.
  template_id             UUID REFERENCES perk_templates(id) ON DELETE CASCADE,
  conditions              JSONB NOT NULL DEFAULT '{}',     -- threshold rules per trigger type
  audience                TEXT DEFAULT 'paying',           -- 'all' | 'paying' | 'elite' | 'coach'
  message_subject         TEXT,                            -- email subject
  message_body            TEXT,                            -- email body text
  cooldown_hours          INTEGER DEFAULT 24,              -- min hours between firings per user
  expires_in_days         INTEGER DEFAULT 1,               -- reward validity (1 = today only)
  active                  BOOLEAN DEFAULT TRUE,
  created_by              TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Log of trigger firings (for cooldown enforcement + audit)
CREATE TABLE IF NOT EXISTS trigger_firings (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trigger_id              UUID NOT NULL REFERENCES auto_triggers(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id             TEXT,                            -- Strava activity that triggered it (if applicable)
  perk_redemption_id      UUID,                            -- the issued reward
  fired_at                TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trigger_firings_user ON trigger_firings(user_id, trigger_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS prescriptions (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  workout_type            TEXT,
  duration_min            INTEGER,
  intensity               TEXT,
  workout_detail          TEXT,
  nutrition               JSONB,
  rationale               TEXT,
  full_response           JSONB,
  delivered               BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_user_date ON prescriptions(user_id, date DESC);

CREATE TABLE IF NOT EXISTS workout_feedback (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  status                  TEXT NOT NULL,              -- 'did_it' | 'modified' | 'skipped'
  note                    TEXT,
  rpe                     INTEGER,                     -- 1-10
  actual_workout_type     TEXT,                        -- if modified: 'cycling' | 'strength' | 'run' | 'yoga' | 'hike' | 'other'
  actual_workout_detail   TEXT,                        -- e.g. "60 min easy spin instead"
  skip_reason             TEXT,                        -- if skipped: 'too_tired' | 'no_time' | 'weather' | 'sick' | 'other'
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

-- Migration: add new columns if not present (for existing tables)
ALTER TABLE workout_feedback ADD COLUMN IF NOT EXISTS actual_workout_type TEXT;
ALTER TABLE workout_feedback ADD COLUMN IF NOT EXISTS actual_workout_detail TEXT;
ALTER TABLE workout_feedback ADD COLUMN IF NOT EXISTS skip_reason TEXT;

-- Daily wellness check-in: morning, 4 tap-to-pick + optional note
CREATE TABLE IF NOT EXISTS daily_checkins (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  sleep_quality           INTEGER,                     -- 1-5 (1=terrible, 5=excellent)
  legs_feel              TEXT,                         -- 'fresh' | 'normal' | 'heavy' | 'trashed'
  alcohol_drinks          INTEGER,                     -- 0, 1, 2, 3, 4, 5+ (drinks last night)
  stress_level            TEXT,                        -- 'low' | 'medium' | 'high'
  note                    TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

-- ===================================================================
-- PERKS — DBP ELITE FEATURES
-- ===================================================================

-- Each redeemable perk issued to a user (Sunday drink, birthday drink, free tune-up, etc.)
CREATE TABLE IF NOT EXISTS perk_redemptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perk_type               TEXT NOT NULL,              -- 'sunday_drink' | 'birthday_drink' | 'free_flat_fix' | 'free_tuneup' | 'discount_code'
  code                    TEXT UNIQUE NOT NULL,        -- short code shown to user, e.g. 'CDB-3X7K'
  description             TEXT,                        -- "Sunday recovery drink — any drink"
  issued_at               TIMESTAMPTZ DEFAULT NOW(),
  expires_at              TIMESTAMPTZ,
  redeemed_at             TIMESTAMPTZ,
  redeemed_by_staff       TEXT,                        -- barista/mechanic name
  redemption_note         TEXT,                        -- e.g. "cortado" for drink choice tracking
  metadata                JSONB                        -- discount %, item type, etc.
);

CREATE INDEX IF NOT EXISTS idx_perks_user ON perk_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_perks_code ON perk_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_perks_unredeemed ON perk_redemptions(user_id, redeemed_at) WHERE redeemed_at IS NULL;

-- Migrations: extend perk_redemptions for Member Rewards system
ALTER TABLE perk_redemptions ADD COLUMN IF NOT EXISTS template_id UUID;
ALTER TABLE perk_redemptions ADD COLUMN IF NOT EXISTS savings_cents INTEGER;
ALTER TABLE perk_redemptions ADD COLUMN IF NOT EXISTS cost_cents INTEGER;
ALTER TABLE perk_redemptions ADD COLUMN IF NOT EXISTS trigger_type TEXT;
ALTER TABLE perk_redemptions ADD COLUMN IF NOT EXISTS issued_by TEXT;

-- Perk templates: types of rewards that can be issued
CREATE TABLE IF NOT EXISTS perk_templates (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT NOT NULL,
  category                TEXT NOT NULL,                   -- 'drink' | 'food' | 'service' | 'merch' | 'discount'
  description             TEXT,
  default_retail_cents    INTEGER,
  default_cost_cents      INTEGER,
  is_percentage           BOOLEAN DEFAULT FALSE,
  percentage_off          INTEGER,
  default_expires_days    INTEGER DEFAULT 30,
  active                  BOOLEAN DEFAULT TRUE,
  sort_order              INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perk_templates_active ON perk_templates(active, sort_order);

-- Seed standard templates if not present
INSERT INTO perk_templates (name, category, description, default_retail_cents, default_cost_cents, is_percentage, percentage_off, default_expires_days, sort_order)
SELECT v.name, v.category, v.description, v.default_retail_cents, v.default_cost_cents, v.is_percentage, v.percentage_off, v.default_expires_days, v.sort_order
FROM (VALUES
  ('Free drink (any size)', 'drink', 'Any drink on the menu — espresso, drip, latte, cortado.', 600, 150, FALSE, NULL::INTEGER, 7, 10),
  ('Free 12oz drink', 'drink', 'Any 12oz drink — drip, americano, latte, cortado.', 500, 130, FALSE, NULL::INTEGER, 7, 20),
  ('$1 off any drink', 'drink', '$1 off any drink, today only.', 100, 0, FALSE, NULL::INTEGER, 1, 30),
  ('Free bag of DBP coffee', 'merch', '12oz bag of DBP / 81301 house coffee.', 1800, 1100, FALSE, NULL::INTEGER, 30, 40),
  ('10% off coffee', 'discount', '10% off any drink.', 0, 0, TRUE, 10, 365, 50),
  ('Free pastry', 'food', 'Any pastry from the case.', 450, 200, FALSE, NULL::INTEGER, 7, 60),
  ('Free flat repair', 'service', 'Free flat tire repair, anytime.', 1500, 300, FALSE, NULL::INTEGER, 365, 70),
  ('Free tune-up', 'service', 'Free standard bike tune-up.', 9500, 2500, FALSE, NULL::INTEGER, 365, 80),
  ('10% off retail', 'discount', '10% off any retail or consignment item.', 0, 0, TRUE, 10, 365, 90),
  ('Bring a friend free coffee', 'drink', 'Buy a coffee, your friend gets one free.', 600, 150, FALSE, NULL::INTEGER, 30, 100)
) AS v(name, category, description, default_retail_cents, default_cost_cents, is_percentage, percentage_off, default_expires_days, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM perk_templates WHERE perk_templates.name = v.name);

-- Track service requests / priority queue
CREATE TABLE IF NOT EXISTS service_requests (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type            TEXT,                        -- 'tune_up' | 'flat_fix' | 'priority_appointment' | 'mechanic_question'
  priority                BOOLEAN DEFAULT FALSE,       -- elite members get TRUE
  status                  TEXT DEFAULT 'open',         -- 'open' | 'scheduled' | 'completed' | 'canceled'
  notes                   TEXT,
  scheduled_for           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_user ON service_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_service_open ON service_requests(status) WHERE status = 'open';

-- Service interval tracking (km accumulator for tune-up reminders)
CREATE TABLE IF NOT EXISTS service_intervals (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  km_at_last_tuneup       REAL DEFAULT 0,
  total_km_lifetime       REAL DEFAULT 0,
  last_tuneup_date        DATE,
  next_reminder_at_km     REAL DEFAULT 1500,
  reminder_sent_at        TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ===================================================================
-- COMPETITIONS & LEADERBOARDS
-- ===================================================================

CREATE TABLE IF NOT EXISTS competitions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT NOT NULL,
  description             TEXT,
  metric                  TEXT NOT NULL,               -- 'total_elevation_m' | 'total_km' | 'recovery_streak' | 'consistency_days'
  start_date              DATE NOT NULL,
  end_date                DATE NOT NULL,
  prize_description       TEXT,
  is_active               BOOLEAN DEFAULT TRUE,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competition_participants (
  competition_id          UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_score           REAL DEFAULT 0,
  rank                    INTEGER,
  joined_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (competition_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_comp_participants_score ON competition_participants(competition_id, current_score DESC);

-- ===================================================================
-- NOTIFICATIONS / EMAIL LOG
-- ===================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID REFERENCES users(id) ON DELETE CASCADE,
  channel                 TEXT,                        -- 'email' | 'sms' | 'push'
  template                TEXT,                        -- 'welcome' | 'magic_link' | 'sunday_drink' | 'birthday' | 'service_reminder' | 'competition_winner'
  recipient               TEXT,
  subject                 TEXT,
  payload                 JSONB,
  sent_at                 TIMESTAMPTZ DEFAULT NOW(),
  opened_at               TIMESTAMPTZ,
  clicked_at              TIMESTAMPTZ,
  status                  TEXT DEFAULT 'sent'          -- 'sent' | 'delivered' | 'bounced' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, sent_at DESC);

-- ===================================================================
-- ADMIN / OPERATIONAL
-- ===================================================================

-- For barista app — separate auth so staff can redeem codes without seeing user data
CREATE TABLE IF NOT EXISTS staff_pins (
  pin                     TEXT PRIMARY KEY,            -- 6-digit, hashed
  staff_name              TEXT NOT NULL,
  role                    TEXT,                        -- 'barista' | 'mechanic' | 'manager'
  active                  BOOLEAN DEFAULT TRUE,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Cron run history (for debugging)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID REFERENCES users(id) ON DELETE CASCADE,
  run_type                TEXT,                        -- 'cron_daily' | 'manual' | 'onboarding'
  status                  TEXT,                        -- 'success' | 'failed' | 'partial'
  error_message           TEXT,
  duration_ms             INTEGER,
  started_at              TIMESTAMPTZ DEFAULT NOW(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON pipeline_runs(user_id, started_at DESC);

-- ===================================================================
-- HELPER VIEWS
-- ===================================================================

-- Active users to run the cron pipeline against
CREATE OR REPLACE VIEW active_users AS
SELECT u.*
FROM users u
WHERE u.subscription_status IN ('active', 'trialing')
  AND u.onboarding_completed = TRUE;

-- Migration: old 'elite' tier becomes new 'coach' tier (coach + rewards bundled together)
UPDATE users SET subscription_tier = 'coach' WHERE subscription_tier = 'elite';

DROP VIEW IF EXISTS elite_users;
CREATE OR REPLACE VIEW rewards_members AS
SELECT u.*
FROM users u
WHERE u.subscription_tier IN ('rewards', 'coach')
  AND u.subscription_status IN ('active', 'trialing');

-- ===================================================================
-- MEMBER CODES, PURCHASES, STREAKS (Member Rewards Phase 3)
-- ===================================================================

-- Permanent member code for in-store identification (e.g., DBP-CASEY)
ALTER TABLE users ADD COLUMN IF NOT EXISTS member_code TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_member_code ON users(member_code);

-- Streak tracking (kept on users for fast access)
ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak_current INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak_longest INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak_last_date DATE;

-- Punch card counter (rolling — every 10th coffee free)
ALTER TABLE users ADD COLUMN IF NOT EXISTS punch_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS punch_total_lifetime INTEGER DEFAULT 0;

-- Purchases logged via barista app — every coffee, drink, service, retail item
CREATE TABLE IF NOT EXISTS purchases (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category                TEXT NOT NULL,                     -- 'drink' | 'food' | 'service' | 'retail'
  subcategory             TEXT,                              -- 'coffee' | 'latte' | 'pastry' | 'tune-up' | 'tube' etc
  amount_cents            INTEGER NOT NULL,
  staff_name              TEXT,
  notes                   TEXT,
  counted_toward_punch    BOOLEAN DEFAULT FALSE,             -- did this purchase increment punch_count?
  triggered_perk_code     TEXT,                              -- if a reward was issued from this, which one
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_date ON purchases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_category ON purchases(category, created_at DESC);

-- Streak milestone tracking — what milestones has this user already received rewards for?
CREATE TABLE IF NOT EXISTS streak_milestones (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_days          INTEGER NOT NULL,                  -- 7, 30, 100, etc
  awarded_at              TIMESTAMPTZ DEFAULT NOW(),
  perk_code               TEXT,                              -- the reward issued for this milestone
  UNIQUE(user_id, milestone_days)
);
CREATE INDEX IF NOT EXISTS idx_streak_milestones_user ON streak_milestones(user_id);
