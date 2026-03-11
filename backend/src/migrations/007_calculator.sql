-- Migration 007: Crew/Transport Calculator — settings and saved quotes
-- Replaces Monday D&C Settings board

-- Calculator rate settings (key-value, one row per setting)
CREATE TABLE IF NOT EXISTS calculator_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       DECIMAL(12, 2) NOT NULL,
  label       VARCHAR(255),
  unit        VARCHAR(50),  -- 'per_hour', 'per_day', 'per_litre', 'minutes', 'percent', 'currency'
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id)
);

-- Default settings (from Monday D&C Settings board)
INSERT INTO calculator_settings (key, value, label, unit) VALUES
  ('freelancer_hourly_day',     18.00, 'Freelancer hourly (day)',       'per_hour'),
  ('freelancer_hourly_night',   25.00, 'Freelancer hourly (OOH/night)', 'per_hour'),
  ('client_hourly_day',         33.00, 'Client hourly (day)',           'per_hour'),
  ('client_hourly_night',       45.00, 'Client hourly (OOH/night)',     'per_hour'),
  ('driver_day_rate',          180.00, 'Driver day rate',               'per_day'),
  ('admin_cost_per_hour',        5.00, 'Admin cost per hour',           'per_hour'),
  ('fuel_price_per_litre',       1.45, 'Fuel price per litre',          'per_litre'),
  ('handover_time_mins',        15.00, 'Handover time (vehicle)',       'minutes'),
  ('unload_time_mins',          30.00, 'Unload time (equipment)',       'minutes'),
  ('expense_markup_percent',    10.00, 'Expense markup',                'percent'),
  ('min_hours_threshold',        5.00, 'Minimum hours threshold',       'hours'),
  ('min_client_charge_floor',    0.00, 'Minimum client charge floor',   'currency'),
  ('day_rate_client_markup',     1.80, 'Day rate client markup ratio',  'ratio'),
  ('fuel_efficiency_mpg',        5.00, 'Fuel: miles per litre',         'per_litre')
ON CONFLICT (key) DO NOTHING;

-- Saved quotes
CREATE TABLE IF NOT EXISTS quotes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID REFERENCES jobs(id) ON DELETE SET NULL,
  job_type          VARCHAR(20) NOT NULL CHECK (job_type IN ('delivery', 'collection', 'crewed')),
  calculation_mode  VARCHAR(20) NOT NULL CHECK (calculation_mode IN ('hourly', 'dayrate')),

  -- Input snapshot
  venue_name        VARCHAR(500),
  venue_id          UUID REFERENCES venues(id) ON DELETE SET NULL,
  distance_miles    DECIMAL(8, 1),
  drive_time_mins   INT,
  arrival_time      VARCHAR(10),     -- HH:MM
  job_date          DATE,
  work_duration_hrs DECIMAL(6, 2),
  num_days          INT,
  setup_extra_hrs   DECIMAL(6, 2),
  setup_premium     DECIMAL(12, 2),
  travel_method     VARCHAR(20) DEFAULT 'vehicle',
  day_rate_override DECIMAL(12, 2),
  client_rate_override DECIMAL(12, 2),
  expenses          JSONB DEFAULT '[]',

  -- Calculated outputs
  client_charge_labour    DECIMAL(12, 2),
  client_charge_fuel      DECIMAL(12, 2),
  client_charge_expenses  DECIMAL(12, 2),
  client_charge_total     DECIMAL(12, 2),
  client_charge_rounded   DECIMAL(12, 2),
  freelancer_fee          DECIMAL(12, 2),
  freelancer_fee_rounded  DECIMAL(12, 2),
  expected_fuel_cost      DECIMAL(12, 2),
  expenses_included       DECIMAL(12, 2),
  expenses_not_included   DECIMAL(12, 2),
  our_total_cost          DECIMAL(12, 2),
  our_margin              DECIMAL(12, 2),
  estimated_time_mins     INT,
  estimated_time_hrs      DECIMAL(6, 2),

  -- Settings snapshot (rates at time of calculation)
  settings_snapshot       JSONB,

  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  is_deleted        BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_quotes_job ON quotes (job_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes (created_at DESC);
