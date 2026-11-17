-- 348: "Good news - they've booked" (docs/BUSINESS-FIGURES-SPEC.md §8d).
-- Email 2 now promises the referrer "We'll keep you updated if they confirm and complete a
-- booking" (jon, 17 Nov 2026); this marks the confirm update as sent, once per referral.
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS booked_email_sent_at TIMESTAMPTZ;
