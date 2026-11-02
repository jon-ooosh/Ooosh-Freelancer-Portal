-- 284: the GPS tracker register (docs/reference/VEHICLES-AND-FLEET.md "GPS trackers").
--
-- One row per physical tracker. Each unit carries a numbered label (001, 002…)
-- so it can be identified when it moves between vans. Traccar knows a unit by
-- its IMEI (Traccar's "identifier" / uniqueId), so OP finds a van's Traccar
-- device through the tracker fitted to it — not through the device's name.
--
-- Which van a tracker is in is NEVER a column on gps_trackers: it is the open
-- row (removed_on IS NULL) in gps_tracker_fittings. One fact, one place — the
-- history and the "current" view can't drift apart.
--
-- Replaces the R2 file trackers/assignments.json (never filled in).

CREATE TABLE IF NOT EXISTS gps_trackers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_number  VARCHAR(10) NOT NULL UNIQUE,     -- the label on the unit: '001'
  imei            VARCHAR(20) NOT NULL UNIQUE,     -- = Traccar device uniqueId
  iccid           VARCHAR(25),                     -- the SIM card number
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'faulty', 'retired')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gps_tracker_fittings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id  UUID NOT NULL REFERENCES gps_trackers(id) ON DELETE CASCADE,
  vehicle_id  UUID REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  vehicle_reg VARCHAR(20) NOT NULL,                -- kept so the history survives the van
  fitted_on   DATE NOT NULL,
  removed_on  DATE,                                -- NULL = still fitted
  fitted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A tracker is in at most one van, and a van has at most one tracker.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_tracker_fittings_open_tracker
  ON gps_tracker_fittings (tracker_id) WHERE removed_on IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_tracker_fittings_open_vehicle
  ON gps_tracker_fittings (vehicle_id) WHERE removed_on IS NULL AND vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gps_tracker_fittings_tracker
  ON gps_tracker_fittings (tracker_id, fitted_on);

-- ── Seed: the Monday "Trackers" board, exported Oct 2026 ─────────────────
-- 001–003 had no SIM number recorded (jon has the cards). 022 is a spare,
-- waiting to go into HK24GWE.

INSERT INTO gps_trackers (tracker_number, imei, iccid, notes) VALUES
  ('001', '864022082913871', NULL, NULL),
  ('002', '864022082913707', NULL, NULL),
  ('003', '864022082913681', NULL, NULL),
  ('004', '861327082800587', '89462038076010096040', NULL),
  ('005', '861076089130908', '89462038076010096057', NULL),
  ('006', '861076088985914', '89462038076010096123', NULL),
  ('007', '861327082765137', '89462038076010096115', NULL),
  ('008', '861327082800348', '89462038076010096107', NULL),
  ('009', '861076089131179', '89462038076010096099', NULL),
  ('010', '861076089131203', '89462038076010096081', NULL),
  ('011', '861327082766853', '89462038076010096073', NULL),
  ('012', '861076089131245', '89462038076010096065', NULL),
  ('013', '861327082766838', '89462038076010096024', NULL),
  ('014', '861327087418237', '89462038076010094581', NULL),
  ('015', '861076082007103', '89462038076023618723', NULL),
  ('016', '861076082006501', '89462038076023618731', NULL),
  ('017', '861327087407412', '89462038076010094573', NULL),
  ('018', '861327087424912', '89462038076010094599', NULL),
  ('019', '861327087418211', '89462038076010094540', NULL),
  ('020', '861076082006899', '89462038076023618707', NULL),
  ('021', '861327087418179', '89462038076023618715', NULL),
  ('022', '861076082003698', '89462038076010094565', 'Spare — waiting to be fitted to HK24GWE'),
  ('023', '861327087418278', '89462038076023618699', NULL),
  ('024', '861327085088768', '89462038076010094557', NULL)
ON CONFLICT (tracker_number) DO NOTHING;

-- Current fittings, matched to Fleet by registration (spaces ignored).
INSERT INTO gps_tracker_fittings (tracker_id, vehicle_id, vehicle_reg, fitted_on)
SELECT t.id, v.id, v.reg, d.fitted_on
FROM (VALUES
  ('001', 'RO23HLV', DATE '2026-02-19'),
  ('002', 'RO23HLU', DATE '2026-02-20'),
  ('003', 'RX22SWN', DATE '2026-02-20'),
  ('004', 'RO71JYA', DATE '2026-03-18'),
  ('005', 'RX73TCJ', DATE '2026-03-18'),
  ('006', 'RX24SZD', DATE '2026-03-19'),
  ('007', 'RX22SWV', DATE '2026-03-19'),
  ('008', 'RX21UOB', DATE '2026-03-19'),
  ('009', 'RX22SWO', DATE '2026-03-19'),
  ('010', 'RX24SZC', DATE '2026-03-20'),
  ('011', 'RX22SXL', DATE '2026-03-20'),
  ('012', 'RX73TBZ', DATE '2026-03-20'),
  ('013', 'RX24SZF', DATE '2026-03-20'),
  ('014', 'RX72TKO', DATE '2026-04-08'),
  ('015', 'RX22SWU', DATE '2026-04-08'),
  ('016', 'RX22SYV', DATE '2026-04-09'),
  ('017', 'RX24SZG', DATE '2026-04-15'),
  ('018', 'RO23HLR', DATE '2026-04-15'),
  ('019', 'RX24SZJ', DATE '2026-04-15'),
  ('020', 'RX24SZE', DATE '2026-04-15'),
  ('021', 'RF21PWX', DATE '2026-04-17'),
  ('023', 'DE21FBF', DATE '2026-04-17'),
  ('024', 'SA75RVV', DATE '2026-04-17')
) AS d(tracker_number, reg, fitted_on)
JOIN gps_trackers t ON t.tracker_number = d.tracker_number
JOIN fleet_vehicles v ON UPPER(REPLACE(v.reg, ' ', '')) = d.reg
WHERE NOT EXISTS (
  SELECT 1 FROM gps_tracker_fittings f WHERE f.tracker_id = t.id AND f.removed_on IS NULL
)
AND NOT EXISTS (
  SELECT 1 FROM gps_tracker_fittings f WHERE f.vehicle_id = v.id AND f.removed_on IS NULL
);
