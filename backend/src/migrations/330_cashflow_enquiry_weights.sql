-- 330: Cash forecast, Phase 2 — the fallback chances that an enquiry books
-- (docs/CASHFLOW-FORECAST-SPEC.md §6). Used when the last 24 months hold fewer
-- than 20 decided enquiries with the same likelihood, and always for provisional
-- (OP doesn't record which past jobs were provisional before they booked).
-- likely_threshold: a weighted enquiry at or above it is "likely", below it "possible".
INSERT INTO cashflow_settings (key, value) VALUES
  ('weight_provisional', '0.85'),
  ('weight_hot',         '0.70'),
  ('weight_warm',        '0.40'),
  ('weight_cold',        '0.15'),
  ('weight_unset',       '0.25'),
  ('likely_threshold',   '0.60')
ON CONFLICT (key) DO NOTHING;
