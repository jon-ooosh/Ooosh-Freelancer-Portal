---
paths:
  - "backend/src/services/{hirehop-*,hh-*,hire-lifecycle,sync-review,staging-stock,backline-stock,booked-status-reconciler}.ts"
  - "backend/src/routes/{hirehop,webhooks,pipeline,staging}.ts"
  - "backend/src/config/hirehop.ts"
---

# HireHop integration — load-bearing rules

Full API reference, field tables and status codes: `docs/reference/SHARED-UTILITIES.md`
(broker) and the HireHop sections of `docs/reference/PIPELINE-AND-ORGS.md`.

## Every call goes through the broker

- **`services/hirehop-broker.ts` is the ONLY gateway.** Never call HireHop directly from a module — the broker owns the priority queue, Redis cache, rate limiter and dedup. (`config/hirehop.ts` `hireHopGet`/`hireHopPost` remain for backwards compatibility and internally delegate.)
- **⚠️ The broker RESOLVES `{success:false}` on a 327/329 rate-limit — it does NOT throw.** A `try { await hhBroker.post(...); /* mirror status locally */ } catch {}` never enters the catch and mirrors a FAILED push. **Gate every local mirror on `pushResult.success`.**
- **`minDelayMs` (1800ms) is the real throttle — do NOT "restore" 350ms.** It is enforced on every call regardless of tokens, so a full bucket can't burst. `maxTokens` is deliberately non-binding. HireHop's 60/min is **per API token and shared with every other caller on that token**, so a burst trips the limit for the payment portal too.
- Any new HH rate-limit surface routes through `isRateLimitSignal` / `notifyRateLimited` rather than re-deriving 327 handling. The cooldown pauses the whole queue so retries fire after the rolling window drains instead of amplifying.

## Writing to HireHop

- **Always include `no_webhook=1`** on status write-back to prevent sync loops.
- **Call order is `save_job.php` FIRST, then `job_save_contact.php`.** The contact endpoint is UPDATE-oriented and needs an existing `CLIENT_ID`; calling it without one fails with "Save error. 154". Never reorder.
- **Charge period = `ceil(elapsed_hours / 24)`, from the INSIDE dates only (Job Start → Job End).** `calcHHDuration()` in `routes/pipeline.ts` is the single source for all push paths. **CEIL, never floor** — HireHop counts any fraction past a whole 24h block as a new chargeable day, and we honour the `duration_days` we send, so pushing floor actively overrode HH with the wrong figure. Only shows on hires not entered on a 9am→9am boundary (most visibly rehearsals). Outgoing/Returning are their own fields and never feed the day count.
- **HireHop REJECTS negative deposits** — reduce a deposit with a refund payment application, never a negative deposit.

## Reading from HireHop

- **`job_value` is NOT written by the sync — do not reintroduce it.** HH's `MONEY` field is empty/0 for most jobs; the sync copied it over the cached value every 30 minutes, so Money-tab visits kept "fixing" it and the sync kept re-zeroing. It is owned by the billing-accrued path.
- **Preserve `kind:3` items (selected prompts)** when syncing line items — they are the source for HH-derived requirements (seat config, accessory options). Only the *selected* prompt appears in the response.
- **Detection must match `LIST_ID` AND `CATEGORY_ID`.** HireHop's asset and sale-item stock-ID spaces are separate, so a rental asset can share an id with a sale item — `LIST_ID` alone false-fired the carnet on three jobs.
- **Apply `stripProjectPrefix()` to any inbound `JOB_NAME` source.** Sub-jobs arrive decorated as `"<Project> ► <Leaf>"` — a *display* string. Store the leaf only, or OP renames revert on the next sync.

## Status semantics

- **`hireGenuinelyReturning()` (`services/hire-lifecycle.ts`) is THE test for "is this job in returns".** Never test `status >= 6` or `status IN (6,7,8)` raw. HH status 6 fires both for a genuine end-of-hire AND for a mid-hire partial return (client hands back two stands while the tour continues) — the discriminator is the hire END DATE.
- The model is **hold + reconcile**: the webhook holds `pipeline_status` when HH says 6 but the hire isn't genuinely returning; an hourly task advances it once the return date arrives. The reconcile is load-bearing — HH already sent its 6 and won't re-send.
- **Never wind back a status staff moved manually.** The hold only touches jobs still out; reconcile only moves forward.
- HH has no usable "prepped" — it jumps to 5 (Dispatched) on checkout. OP treats inbound 5 as `prepped`; OP's own `dispatched` is OP-only and doesn't push back.

## Client identity

- **`client_id` and `client_name` are gated on `client_locked_at`** in both sync UPDATEs — an OP-side client change otherwise reverts within 30 minutes because HireHop's `COMPANY` string wins every pass. When locked AND HH disagrees, queue a `client_mismatch` review rather than reverting: visible disagreement beats silent revert.
- **`company_name` is deliberately NOT gated** — nothing in OP ever writes it, so freezing it would pin a stale value forever.
- **Renaming an org to "fix" a job is the wrong move** — the sync matches the client org by NAME, so a rename means the next pass finds no match and creates a duplicate shell. Use the org merge tool for duplicates and the lead-org flag for "which name shows".
- **Any new org-creating sync path must go through `resolveClientOrgFromCompany`** (+ `services/sync-review.ts` guard rails). The guard rail ended up on the contact sync and not the job sync precisely because the shell-create was hand-copied.
