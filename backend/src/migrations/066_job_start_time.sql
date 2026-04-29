-- Migration 066: Add start_time on jobs
--
-- HireHop's `start` datetime (when charging begins) can differ from `out`
-- (when equipment leaves the warehouse) — e.g. equipment goes out the night
-- before but charging only starts at 09:00 the next morning.
--
-- Until now we mapped both HH `out` and HH `start` to a single OP `out_time`
-- column, which forced them to match. This adds a separate `start_time`
-- column so they can be controlled independently. Defaults to '09:00'; the
-- UI keeps it linked to `out_time` by default but lets users unlink to set
-- different times.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS start_time TIME DEFAULT '09:00';

COMMENT ON COLUMN jobs.start_time IS 'Time charging starts (HireHop start time). Default 09:00. Often matches out_time but can differ — e.g. equipment leaves day before, charging starts next morning.';
