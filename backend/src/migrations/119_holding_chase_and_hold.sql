-- Batch 3: lost-property chase + temp-storage hold-until
-- expected_collection_date: when a client says "I'll collect on X" / "hold till my
--   next hire", set this. Future-dated → pauses the chase queue until it passes
--   (doubles as the chase snooze). Lost property.
-- hold_until: temp-storage "hold until this date", with a staff reminder N days before.
-- hold_until_reminder_sent_for: per-cycle dedup stamp for that reminder.

ALTER TABLE held_items ADD COLUMN IF NOT EXISTS expected_collection_date     DATE;
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS hold_until                    DATE;
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS hold_until_reminder_sent_for  DATE;
