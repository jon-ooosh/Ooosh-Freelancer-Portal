-- 294: the card reader on the shop till and the sitter till (docs/STRIPE-TERMINAL-SPEC.md §14, Phase 3).
--
-- At the till the card is taken FIRST and the sale is created only once it is
-- approved, so a declined card never leaves a sale behind. Until then the basket
-- waits on the session:
--   shop_payload          the priced basket + who is selling (createShopSale's input)
--   shop_sale_id          the sale created from it once the card was approved
--   started_by_person_id  a studio sitter (people, no users row) who started it
-- shop_sales.stripe_payment_intent lets a Refund give the money back to the card
-- through Stripe, rather than someone doing it in the dashboard.
ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS shop_payload         JSONB,
  ADD COLUMN IF NOT EXISTS shop_sale_id         UUID REFERENCES shop_sales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_by_person_id UUID REFERENCES people(id) ON DELETE SET NULL;

ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS stripe_payment_intent VARCHAR(255);
