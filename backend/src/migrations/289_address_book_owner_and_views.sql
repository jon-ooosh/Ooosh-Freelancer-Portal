-- 289_address_book_owner_and_views.sql
-- Address book round (jon, 15 Oct 2026).
--
-- 1. organisations.account_owner_user_id — "who at Ooosh looks after this client".
--    A field ready for when we start tracking it; nothing acts on it yet beyond
--    showing it and the list's "My clients" filter. ON DELETE SET NULL: a login
--    going away must never take an org with it.
--
-- 2. address_book_views — one row per (user, record), bumped each time that user
--    opens the person / organisation page. Drives "Sort: Recently viewed (me)".
--    Per user on purpose: what YOU opened, not the team. Written only by
--    services/address-book-views.ts recordAddressBookView(), and only from the
--    detail pages (?track_view=1) — the same GET is used by pickers and forms,
--    which must not count as a view.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS account_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organisations_account_owner
  ON organisations(account_owner_user_id) WHERE account_owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS address_book_views (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('person', 'organisation')),
  entity_id   UUID NOT NULL,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_address_book_views_recent
  ON address_book_views(user_id, entity_type, viewed_at DESC);
