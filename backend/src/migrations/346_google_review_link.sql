-- 346: the tracked link Jon's review email points at (docs/BUSINESS-FIGURES-SPEC.md §8c).
--
-- go.oooshtours.co.uk/google-review → the Google review box, so Marketing › Tracked links
-- counts how many people press the email's button (jon, 16 Nov 2026). If someone already
-- made a link with this code by hand, theirs is kept as it is.
INSERT INTO marketing_links (code, label, destination, is_active)
VALUES ('google-review', 'Google review box — Jon''s review email', 'https://g.page/r/CSCv1HhULJ6nEAI/review', true)
ON CONFLICT (code) DO NOTHING;
