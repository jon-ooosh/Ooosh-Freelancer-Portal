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
| 3 | Money system | Phases A–F largely shipped — Money tab, excess lifecycle, pre-auth, top-N reconciliation, VAT adjustment, payment-portal repointing, OP-initiated refunds. **Oct 2026:** PayPal via Stripe, portal redesign + hash lockdown, portal link in OP, **Wise incoming-payment matcher (live, awaiting its first real email)** | `MONEY-AND-EXCESS.md` ("Payments, Oct 2026") |
| 3b | Stripe Terminal — in-person card payments driven from OP, replacing Worldpay/Amex | **Planned** (6 Oct 2026). Reader on order; crossover deadline March 2027. Pre-auth viability depends on the account's merchant category | `docs/STRIPE-TERMINAL-SPEC.md` |
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
| — | Possible insurance claims (replaces the broker's Word form) | **Closed, Oct 2026** — case file, client form, reminders, GPS trace, SMS all live; video and retention not built | `docs/INCIDENT-CLAIMS-SPEC.md` (§22 troubleshooting) |
| 11 | Staff calendar & time (holiday, TOIL, absence, freelancer day bookings) | **LIVE, staff using it from Oct 2026 — expected complete.** Patterns, ledger, leave, overtime bank, payroll export (emailed on the 1st), absence, freelancer days, company days, working from home, personal calendar feed, days in lieu for company days, manual balance adjustments; Me area and every Staff page tab redesigned; 2026 backfilled from BrightHR. Only cover intelligence (Phase F) is deliberately left, see spec §16 | `docs/STAFF-CALENDAR-SPEC.md` §18 |

**Monday.com is fully retired** (Jul 2026). Some fallback code and unused env vars
remain in the portal repos and can be swept.

## Open items

Roughly 100 unchecked items remain across the reference docs. The ones most likely
to come up:

**Watching (Oct 2026)**
- **Wise matcher** — live since 6 Oct, no real email processed yet. First one decides: auto-recorded (check HireHop deposit + client email), queued (info@ email + Money overview panel), or nothing (`journalctl … | grep wise-incoming`). Then switch off the jon@ → info@ auto-forward.
- **Portal: bare `?jobId=` links no longer work** — anyone still using one needs the Money-tab link.
- Vehicles module `useAuth.tsx` still carries a dead `hubToken` exchange (Staff Hub retired) — tidy-up.
- Portal "Half now" option rounds to whole pounds (pre-existing logic, now visibly odd next to penny figures).

**Known bugs / gaps**
- Portal shared files don't reach the portal UI (flag persists, endpoint returns them, the Next.js page expects the Monday-era shape).
- D&C venue connect-column parser doesn't extract `linkedPulseIds` — ~196 migrated rows show "No venue".
- Nav dropdown z-index — Leaflet map overlays the dropdown on the fleet map page.

**Deliberately deferred, revisit when it hurts**
- **Derived allocations from cost lines** (`docs/COST-LINES-SPEC.md` §7, §12) — BLOCKED, not merely unscheduled: nothing in the UI can set a line's `job_id`, so every line inherits the cost's and the derivation would no-op on every real cost. Needs a per-line job picker first (a search-autocomplete in a ~500px pane). The split modal covers multi-job attribution meanwhile.
- **Void / delete a cost IN XERO from OP** (Jon, Sep 2026 — operationally the most useful of this group). `DELETE /costs/:id` is a hard `DELETE FROM costs` that touches Xero not at all; the bill or bank transaction survives, orphaned, with nothing in OP pointing at it. **Not silent** — the modal warns explicitly ("this removes the cost from OP only — it will NOT delete the bill/transaction in Xero") and refuses outright on a reconciled cost, so nobody has lost a bill without being told. What's missing is the push. Plan: a `voidBill()` on the broker (an AUTHORISED Xero invoice goes to `Status: VOIDED`; a DRAFT one can be deleted; a payment must be removed first, and a reconciled bank transaction can't be touched at all), then "Delete" becomes "Delete here and void in Xero?" with the Xero leg refused-and-explained where Xero won't allow it. **Confirm the Xero void/delete semantics per state before building.** Worth pairing with a second question: OP's delete is a HARD delete that cascades `cost_lines` + `cost_allocations` and leaves no trace, which sits oddly against this codebase's own "soft-cancel, don't delete" convention for financial records — a `voided` status may be the better shape.
- **Removing a supporting document doesn't remove the Xero attachment** — nothing deletes it there today; decide the semantics before adding a per-document delete. Largely hypothetical — there is no per-document delete button yet, so the gap only bites when one is added. Agreed low priority Sep 2026. NB the Xero API may not expose attachment deletion at all, in which case the honest answer is a warning, not a mechanism.
- **A cost with supporting docs but NO main receipt renders no `+N` pip** — `ReceiptThumb` opens with `if (!key) return null`, so the whole component bails and the pip never draws; such a cost reads as having no paperwork at all. Ten-line fix (a neutral 📎 placeholder to hang the pip on). Agreed low priority Sep 2026 — edge case in practice.
- **Freelancer rates live in four places and one of them is dead** (jon, Sep 2026 — agreed to tidy as a future revision rather than patch now). `people.day_rate_note` (free text), `people.default_day_rate` / `default_half_day_rate` (numeric), `calculator_settings.driver_day_rate` (company-wide), and the agreed figures snapshotted onto each quote assignment. The `default_*` pair is READ by the yard-day booking form to pre-fill the agreed rate but is **written by nothing** — no endpoint, no field — so the pre-fill has never fired and the placeholder always shows "—". Deliberately not fixed with a quick input: that would entrench a fourth surface. Full write-up, including why this wants a per-person × per-work-type rate CARD rather than one number, in `BACKLOG.md`. The snapshot-on-the-booking rule survives whatever it becomes.
- Inline "Allocate Van" modal scoped to job (the AllocationsPage hop is acceptable for now).
- Slot-grouped cards — one card per van with sibling drivers nested, on both Allocations and Job Detail.
- Auto-cascade staff allocations onto matching hire forms at hire-form arrival.
- Post-hook outbox pattern (replaces `setImmediate` fire-and-forget; retry + alert is the interim).
- Interim assessment PDF on the swapped-out van.

**Not started**
- Staff calendar — **everything planned has shipped** (Oct 2026: working from home, the personal calendar feed, the payroll email, days in lieu for company days and the Staff page restyle closed it). Open with jon, not code: an HR-advisor check on the lieu-day policy (spec §20.5b); compare Chris's and Matt's BrightHR TOIL balances for any more 2025 carry-over (add with the balance panel's adjustment form). Left on purpose, each shaped in `docs/STAFF-CALENDAR-SPEC.md` §16: **cover intelligence** (Phase F — wants a season of real data; jon to fill in `staff.min_headcount_by_weekday` first), on-site / travelling locations, half-day WFH, a team feed. §18 "Where it stands" is the handover.
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
