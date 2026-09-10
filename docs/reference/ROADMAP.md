<!--
Build status extracted from the root CLAUDE.md (Sep 2026 restructure).

CLAUDE.md is loaded into EVERY session's context window; a completed-work
checklist is not something Claude needs on every turn. It lives here instead.

READ THIS WHEN PLANNING what to build next. Don't read it to answer
"how does X work" — that's the module reference docs alongside this file.
-->

# Roadmap & build status

Phase 1 (core data model, auth, address book, HireHop contact sync, deployment) is
**complete**. Phase 2 has been running since March 2026 and is where all current
work sits. Phases 3–5 are in `docs/SPEC.md`.

The dependency chain below determined the original order. Most of it has now
shipped, so treat it as a map of what exists rather than a queue to work through.

## Where each area stands

| # | Area | State | Detail |
|---|---|---|---|
| 1 | Vehicle module integration | Mostly complete | `VEHICLES-AND-FLEET.md` |
| 1b | Vehicle maintenance & compliance | Phases A/C/D/E complete; F (turnaround schedule) in progress; B (AI extraction) deferred | `VEHICLES-AND-FLEET.md` |
| 2 | Driver hire forms & excess | Live since Apr 2026. Verification cockpit, document validity, identity review, referral gate all shipped. Phase 4 (document extraction) next, not built | `DRIVERS-AND-HIRE-FORMS.md` |
| 3 | Money system | Phases A–F largely shipped — Money tab, excess lifecycle, pre-auth, top-N reconciliation, VAT adjustment, payment-portal repointing, OP-initiated refunds | `MONEY-AND-EXCESS.md` |
| 4 | Status transition engine | Mostly complete — bidirectional HireHop sync live | `PIPELINE-AND-ORGS.md` |
| 4b | Returns & close-out | Phases A–D mostly complete | `RETURNS-AND-CANCELLATIONS.md` |
| 4c | Cancellation system | Foundation complete; combine-bookings shipped | `RETURNS-AND-CANCELLATIONS.md` |
| 5 | Payment portal repointing | Live (merged into step 3 phase E) | `MONEY-AND-EXCESS.md` |
| 6 | Operations modules | Requirements engine, backline, transport & crew ops, carnets shipped. Rehearsals/studio sitters phases A–E shipped. Sub-hires not started | `OPERATIONS-MODULES.md` |
| 7 | Inbox & notifications | Phases A–E shipped; F (threaded messaging) mostly shipped — problems integration remaining | `INBOX-AND-WAREHOUSE.md` |
| 8 | Warehouse collections | Live | `INBOX-AND-WAREHOUSE.md` |
| 9 | Client storage | Phase 1 built | `STORAGE-AND-HOLDING.md` |
| 10 | Holding module | Unified + live | `STORAGE-AND-HOLDING.md` |
| — | External tools (PCN, staging calculator, backline matcher, leads, auto-chase) | All integrated into OP | `INTEGRATIONS.md` |
| — | Freelancer onboarding | Phases A–C shipped; D next | `INTEGRATIONS.md` |
| — | Staff documents & training | Live | `INTEGRATIONS.md` |
| 11 | Staff calendar & time (holiday, TOIL, absence, freelancer day bookings) | Spec'd Sep 2026, not built. Replaces BrightHR — **hard deadline 1 Jan 2027** (subscription expiry + calendar leave year) | `docs/STAFF-CALENDAR-SPEC.md` |

**Monday.com is fully retired** (Jul 2026). Some fallback code and unused env vars
remain in the portal repos and can be swept.

## Open items

Roughly 100 unchecked items remain across the reference docs. The ones most likely
to come up:

**Known bugs / gaps**
- Portal shared files don't reach the portal UI (flag persists, endpoint returns them, the Next.js page expects the Monday-era shape).
- D&C venue connect-column parser doesn't extract `linkedPulseIds` — ~196 migrated rows show "No venue".
- Nav dropdown z-index — Leaflet map overlays the dropdown on the fleet map page.

**Deliberately deferred, revisit when it hurts**
- **Derived allocations from cost lines** (`docs/COST-LINES-SPEC.md` §7, §12) — BLOCKED, not merely unscheduled: nothing in the UI can set a line's `job_id`, so every line inherits the cost's and the derivation would no-op on every real cost. Needs a per-line job picker first (a search-autocomplete in a ~500px pane). The split modal covers multi-job attribution meanwhile.
- **Removing a supporting document doesn't remove the Xero attachment** — nothing deletes it there today; decide the semantics before adding a per-document delete.
- **A cost with supporting docs but NO main receipt renders no `+N` pip** — the pip hangs off the receipt thumb.
- Inline "Allocate Van" modal scoped to job (the AllocationsPage hop is acceptable for now).
- Slot-grouped cards — one card per van with sibling drivers nested, on both Allocations and Job Detail.
- Auto-cascade staff allocations onto matching hire forms at hire-form arrival.
- Post-hook outbox pattern (replaces `setImmediate` fire-and-forget; retry + alert is the interim).
- Interim assessment PDF on the swapped-out van.

**Not started**
- Staff calendar & time module — the largest not-started item, and the only one with a fixed external deadline (BrightHR expires ~Dec 2026). Spec: `docs/STAFF-CALENDAR-SPEC.md`.
- Sub-hires module (`job_subhires`).
- Global operations dashboard widgets (transport, crew, deliveries, carnets, lost property, rehearsals, payments).
- Initial card collection from OP (PaymentIntent create) — staff still walk to the terminal.
- Xero financial summary integration; win/loss analysis dashboard.
- Quote editing, quote status transition validation, RBAC on calculator settings.

**Security backlog**
- RBAC on PUT endpoints for people/organisations.
- PII encryption remaining slices: driver PII phase 2 (null the plaintext), receipt scans, freelancer PII.
- Data retention/expiry policy (GDPR); secrets rotation documentation.

The full, precise list — with the reasoning for each deferral — lives in the
module reference docs and `BACKLOG.md`. Search there rather than trusting this
summary for anything you're about to build.
