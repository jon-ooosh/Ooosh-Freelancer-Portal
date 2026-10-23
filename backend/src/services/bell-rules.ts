/**
 * THE rule for every bell that asks somebody to do something (jon, Oct 2026).
 *
 * A bell is a copy of a fact at the moment it happened. One that ASKS for
 * something ("New issue", "Storage invoice due", "A to-do needs you") is
 * stamped with a key (`notifications.resolve_key`, migration 310), and the
 * key's rule here says, in SQL, when the bell is STILL NEEDED. Once that stops
 * being true the bell is retired — read and done, greyed in the dropdown,
 * hidden in the Inbox — by `retireDoneBells()` in notification-resolve.ts:
 *
 *   - straight away, from the code that finished the thing
 *     (`retireDoneBells('problem_open', issueId)`), and
 *   - on a 5-minute sweep (`sweepDoneBells()`), which catches every other
 *     path, including ones added later. That is the point of ONE rule per key
 *     rather than a "clear the bell" call in every place that can finish it:
 *     a forgotten call only delays the bell, it never strands it.
 *
 * Writing a rule:
 *   - `stillWaiting` is a SQL boolean over the bell row, aliased `n`
 *     (n.entity_type, n.entity_id, n.user_id, n.created_at). It is checked
 *     per bell, so a rule can be per-recipient through n.user_id.
 *   - Use EXISTS / NOT EXISTS. The sweep retires `NOT (stillWaiting)`; a NULL
 *     answer keeps the bell, so a rule that can be NULL fails safe but never
 *     retires anything — make it a plain true/false.
 *   - A deleted row counts as done (EXISTS goes false), which is what we want.
 *   - Only bells that ask for something get a key. An FYI bell ("Issue
 *     resolved") is done when it is read, and must never carry one.
 *   - Never a `$n` parameter in a rule: the sweep owns the parameters.
 *
 * Leave / overtime / WFH requests and @mentions are wired directly instead
 * (staff-notifications.ts retire…Bells, notification-resolve.ts
 * resolveMyThreadMentions) — they predate this file and are instant in their
 * one service.
 */

import { SUPERSEDING_TYPES } from './staff-doc-cycles';
import { overtimeStillBankedSql } from './staff-balance';
import { COMPLIANCE_DEFAULTS } from './compliance-checker';
import { holdOccupiesSql } from './assignment-overlap';
import { RECEIPT_GRACE_DAYS } from './cost-receipt-chaser';

export interface BellRule {
  /** One line: what the bell asks for, and when that is done. */
  about: string;
  /** SQL boolean over the bell row `n`: TRUE while the thing still needs doing. */
  stillWaiting: string;
  /**
   * For a reminder that is sent again while the thing is still waiting (a
   * daily digest, a chase that re-arms): only the NEWEST copy to each person
   * stays live — an older copy of the same key, record and person is retired
   * as soon as a newer one exists, so they don't pile up.
   */
  latestOnly?: boolean;
}

/** A Problem is open until one of these (isResolvedStatus in routes/problems.ts). */
const PROBLEM_OPEN = `NOT IN ('resolved','written_off','cancelled')`;

/**
 * Copies of the scanners' own numbers. Their modules pull in the email
 * service and the auth middleware, which this file must not load;
 * bell-rules.test.ts fails if these drift from the originals.
 */
export const HOLD_UNTIL_LEAD_DAYS = 3;   // services/holding-reminders.ts
export const PIN_ROTATE_DAYS = 91;       // services/kiosk-till.ts
export const CLAIM_CHASE_ESCALATED = 5;  // services/claim-chase.ts CHASE_ESCALATED

/**
 * A van compliance setting, read the way compliance-checker.ts
 * getComplianceSettings() reads it: `Number(value) || default` — so a blank,
 * zero or non-number setting falls back to the default.
 */
function complianceSetting(key: keyof typeof COMPLIANCE_DEFAULTS): string {
  return `COALESCE((SELECT CASE WHEN btrim(s.value #>> '{}') ~ '^-?[0-9]+([.][0-9]+)?$'
                                THEN NULLIF(btrim(s.value #>> '{}')::numeric, 0) END
                      FROM vehicle_compliance_settings s WHERE s.key = '${key}'), ${COMPLIANCE_DEFAULTS[key]})`;
}

/**
 * The checker's own test, item by item (runComplianceCheck). It must never be
 * NARROWER than the checker, or a bell would retire while the checker still
 * calls the item due. Same vans: active and not old/sold.
 */
const COMPLIANCE_VAN = `v.id = n.entity_id AND v.is_active = true AND v.fleet_group <> 'old_sold'`;
/** A service booked in for today or later quiets Service and Rossetts. */
const SERVICE_NOT_BOOKED = `(v.service_booked_in_date IS NULL OR v.service_booked_in_date < CURRENT_DATE)`;
function complianceDateDue(column: string, warningKey: keyof typeof COMPLIANCE_DEFAULTS): string {
  return `EXISTS (SELECT 1 FROM fleet_vehicles v
                   WHERE ${COMPLIANCE_VAN}
                     AND v.${column} IS NOT NULL
                     AND v.${column} - CURRENT_DATE <= ${complianceSetting(warningKey)})`;
}

/** "Is THIS the bell's user still the owner of the to-do?" */
const TASK_STILL_MINE = `EXISTS (SELECT 1 FROM staff_tasks t JOIN users u ON u.id = n.user_id
                          WHERE t.id = n.entity_id AND t.status = 'open' AND t.person_id = u.person_id)`;

export const BELL_RULES = {
  // ── Problems, claims, sales, the studio ──────────────────────────────────
  problem_open: {
    about: '"New issue", "Issue re-flagged", "You\'ve been assigned an issue" — done once the Problem is resolved, written off or cancelled',
    stillWaiting: `EXISTS (SELECT 1 FROM job_issues ji
                    WHERE ji.id = n.entity_id AND ji.status ${PROBLEM_OPEN})`,
  },
  claim_review: {
    about: '"Claim form submitted" — a manager to review it; done once the claim moves on from Submitted',
    stillWaiting: `EXISTS (SELECT 1 FROM incident_claims c
                    WHERE c.id = n.entity_id AND c.stage = 'submitted' AND c.is_deleted = false)`,
  },
  claim_check_in: {
    about: '"Check in on claim" — done once the claim\'s check date moves (or is cleared), or the claim is closed',
    // runClaimCheckReminders stamps next_check_sent_for = next_check_on as it
    // bells, so "the date it belled for is still the date" means not moved.
    stillWaiting: `EXISTS (SELECT 1 FROM incident_claims c
                    WHERE c.id = n.entity_id AND c.is_deleted = false AND c.stage <> 'closed'
                      AND c.next_check_on IS NOT NULL
                      AND c.next_check_on = c.next_check_sent_for
                      AND c.next_check_on <= CURRENT_DATE)`,
    // Which date a bell was about isn't on the bell: only the newest stays lit.
    latestOnly: true,
  },
  claim_form_chase: {
    about: '"Client form not coming back" — done once the form is submitted (the claim leaves Form out), or chasing is paused or restarted',
    // The same test as the claim's Needs Attention "chasing has stopped".
    stillWaiting: `EXISTS (SELECT 1 FROM incident_claims c
                    WHERE c.id = n.entity_id AND c.is_deleted = false
                      AND c.stage = 'form_out' AND c.chase_paused_at IS NULL
                      AND c.chase_level >= ${CLAIM_CHASE_ESCALATED})`,
    latestOnly: true,
  },
  sale_photos: {
    about: '"<reg> is for sale — check its sale photos" — done once the sale page has nothing to re-check (the same test as loadRecheck in vehicle-sales.ts) or the sale is over',
    stillWaiting: `EXISTS (SELECT 1 FROM vehicle_sales s
                    WHERE s.id = n.entity_id
                      AND s.status IN ('preparing','listed','under_offer')
                      AND EXISTS (SELECT 1 FROM vehicle_sale_photos ph WHERE ph.sale_id = s.id)
                      AND EXISTS (SELECT 1 FROM job_issues ji
                                   WHERE ji.vehicle_id = s.vehicle_id
                                     AND ji.status <> 'cancelled'
                                     AND (s.photos_confirmed_at IS NULL
                                          OR ji.created_at > s.photos_confirmed_at
                                          OR EXISTS (SELECT 1 FROM job_issue_events e
                                                      WHERE e.issue_id = ji.id
                                                        AND e.event_type = 'reflagged'
                                                        AND e.created_at > s.photos_confirmed_at))))`,
  },
  lockup_missing: {
    about: '"Lock-up not submitted" — done once the sitter submits the report (or the evening is cancelled)',
    stillWaiting: `EXISTS (SELECT 1 FROM studio_sitter_shifts sh
                    WHERE sh.id = n.entity_id
                      AND sh.report_submitted_at IS NULL
                      AND sh.status <> 'cancelled')`,
  },
  option_siblings_open: {
    about: '"Option N confirmed — M still open" — done once no other option in the group is still live (or the prompt was handled)',
    stillWaiting: `EXISTS (SELECT 1 FROM jobs j
                      JOIN jobs sib ON sib.group_id = j.group_id AND sib.id <> j.id AND sib.is_deleted = false
                    WHERE j.id = n.entity_id AND j.group_id IS NOT NULL AND j.is_deleted = false
                      AND j.pipeline_status NOT IN ('new_enquiry','quoting','chasing','paused','provisional','lost','cancelled')
                      AND sib.dismissed_at IS NULL
                      AND sib.pipeline_status IN ('new_enquiry','quoting','chasing','paused','provisional'))`,
  },

  // ── Jobs: chases and requirements ────────────────────────────────────────
  chase_due: {
    about: '"Chase due", "Auto-chase stopped" — done once the job\'s chase date moves into the future (or is cleared), or the job leaves the enquiry stages',
    // The 08:00 chase scanner's own test, less who it tells. NOT the "Chase
    // reminder" bell New Enquiry sends at once with a future date — that one
    // would read as done the moment it was sent, so it stays un-keyed.
    stillWaiting: `EXISTS (SELECT 1 FROM jobs j
                    WHERE j.id = n.entity_id AND j.is_deleted = false AND j.dismissed_at IS NULL
                      AND j.pipeline_status IN ('new_enquiry','quoting','paused','provisional')
                      AND j.next_chase_date IS NOT NULL
                      AND j.next_chase_date <= CURRENT_DATE)`,
    // Re-sent every day or two while it waits: only the newest stays lit.
    latestOnly: true,
  },
  requirement_due: {
    about: '"Overdue: <requirement> — <job>", "Reminder: <label>" — done once the requirement is done or cancelled (blocked still waits; a suspended one is not required), or its job is lost / cancelled without keep-after-close',
    stillWaiting: `EXISTS (SELECT 1 FROM job_requirements jr
                      JOIN jobs j ON j.id = jr.job_id AND j.is_deleted = false
                    WHERE jr.id = n.entity_id
                      AND jr.status NOT IN ('done','cancelled')
                      AND COALESCE(jr.notes, '') NOT LIKE '%[Suspended:%'
                      AND (COALESCE(j.pipeline_status, '') NOT IN ('lost','cancelled') OR jr.keep_after_close = true))`,
    // Both scanners re-send daily while it waits: only the newest stays lit.
    latestOnly: true,
  },

  // ── Vans: compliance (one key per item, so MOT never retires Tax) ─────────
  compliance_mot: {
    about: '"OVERDUE / Due soon: MOT — <reg>" — done once the MOT date is outside its warning window, or the van leaves the fleet',
    stillWaiting: complianceDateDue('mot_due', 'mot_warning_days'),
    // "Due soon", then "OVERDUE" daily: only the newest stays lit.
    latestOnly: true,
  },
  compliance_tax: {
    about: '"OVERDUE / Due soon: Tax — <reg>" — done once the tax date is outside its warning window, or the van leaves the fleet',
    stillWaiting: complianceDateDue('tax_due', 'tax_warning_days'),
    latestOnly: true,
  },
  compliance_insurance: {
    about: '"OVERDUE / Due soon: Insurance — <reg>" — done once the insurance date is outside its warning window, or the van leaves the fleet',
    stillWaiting: complianceDateDue('insurance_due', 'insurance_warning_days'),
    latestOnly: true,
  },
  compliance_tfl: {
    about: '"OVERDUE / Due soon: TFL — <reg>" — done once the TFL date is outside its warning window, or the van leaves the fleet',
    stillWaiting: complianceDateDue('tfl_due', 'tfl_warning_days'),
    latestOnly: true,
  },
  compliance_service: {
    about: '"OVERDUE / Due soon: Service — <reg>" — done once the van is more than the warning mileage from its next service, a service is booked in, or the van leaves the fleet',
    stillWaiting: `EXISTS (SELECT 1 FROM fleet_vehicles v
                    WHERE ${COMPLIANCE_VAN} AND ${SERVICE_NOT_BOOKED}
                      AND v.next_service_due > 0 AND v.current_mileage IS NOT NULL
                      AND v.next_service_due - v.current_mileage <= ${complianceSetting('service_mileage_warning_miles')})`,
    latestOnly: true,
  },
  compliance_rossetts: {
    about: '"OVERDUE / Due soon: Rossetts Service — <reg>" — done once the next Rossetts service is outside its warning window, a service is booked in, or the van leaves the fleet',
    // Postgres clamps a month end (29 Feb + 12 months = 28 Feb) where the
    // checker's setMonth rolls on (1 Mar): never later, so never narrower.
    stillWaiting: `EXISTS (SELECT 1 FROM fleet_vehicles v
                    WHERE ${COMPLIANCE_VAN} AND ${SERVICE_NOT_BOOKED}
                      AND v.rossetts_applicable = true
                      AND COALESCE(v.last_rossetts_service_date, v.date_first_reg) IS NOT NULL
                      AND CASE WHEN v.last_rossetts_service_date IS NOT NULL
                               THEN (v.last_rossetts_service_date
                                     + make_interval(months => trunc(${complianceSetting('rossetts_interval_months')})::int))::date
                               ELSE (v.date_first_reg
                                     + make_interval(years => trunc(${complianceSetting('rossetts_first_service_years')})::int))::date
                          END - CURRENT_DATE <= ${complianceSetting('rossetts_warning_days')})`,
    latestOnly: true,
  },

  // ── Drivers ──────────────────────────────────────────────────────────────
  mid_tour_driver: {
    about: '"Mid-tour driver — <name>" — done once the driver is added to the van (booked out), the row is cancelled, or the job is finished',
    // Add to Hire books THIS row out. A soft / confirmed hold on a finished
    // job is dead (assignment-overlap.ts holdOccupiesSql) — nobody adds to it.
    stillWaiting: `EXISTS (SELECT 1 FROM vehicle_hire_assignments a
                      LEFT JOIN jobs j ON (a.job_id IS NOT NULL AND j.id = a.job_id)
                                       OR (a.job_id IS NULL AND j.hh_job_number = a.hirehop_job_id)
                    WHERE a.id = n.entity_id AND a.status IN ('soft','confirmed')
                      AND ${holdOccupiesSql('a', 'j')})`,
    latestOnly: true,
  },
  referral_needed: {
    about: '"Referral needed" — done once the referral has an outcome (approved, waived or declined) or the driver is removed',
    stillWaiting: `EXISTS (SELECT 1 FROM drivers d
                    WHERE d.id = n.entity_id AND d.is_active = true AND d.requires_referral = true
                      AND (d.referral_status IS NULL OR d.referral_status = 'pending'))`,
  },
  dva_check_needed: {
    about: '"NI licence check needed" — done once a licence check inside the last 30 days is recorded (driver-validity.ts window)',
    stillWaiting: `EXISTS (SELECT 1 FROM drivers d
                    WHERE d.id = n.entity_id AND d.is_active = true
                      AND UPPER(TRIM(COALESCE(d.licence_issued_by, ''))) = 'DVA'
                      AND (d.dvla_check_date IS NULL OR d.dvla_check_date + 30 < CURRENT_DATE))`,
  },

  // ── Storage and held items ───────────────────────────────────────────────
  storage_invoice: {
    about: '"Storage invoice due / overdue" — done once it is marked invoiced, the bill date moves out of the window, or the tenancy ends',
    stillWaiting: `EXISTS (SELECT 1 FROM storage_tenancies t
                    WHERE t.id = n.entity_id
                      AND t.status IN ('active','notice')
                      AND t.billing_mode = 'manual'
                      AND t.next_bill_date IS NOT NULL
                      AND CURRENT_DATE >= t.next_bill_date - t.bill_reminder_lead_days
                      AND NOT EXISTS (SELECT 1 FROM storage_invoice_log l
                                       WHERE l.tenancy_id = t.id AND l.sent_at >= n.created_at))`,
    // "Due" then "overdue" for the same bill: only the newer stays lit.
    latestOnly: true,
  },
  storage_rate_review: {
    about: '"Storage rate review due" — done once a rate is set, the review date moves on, or the tenancy ends',
    stillWaiting: `EXISTS (SELECT 1 FROM storage_tenancies t
                    WHERE t.id = n.entity_id
                      AND t.status IN ('active','notice')
                      AND t.next_rate_review_date IS NOT NULL
                      AND t.next_rate_review_date <= CURRENT_DATE
                      AND NOT EXISTS (SELECT 1 FROM storage_rate_history r
                                       WHERE r.tenancy_id = t.id AND r.created_at >= n.created_at))`,
  },
  held_item_review: {
    about: '"Hold/review date approaching / passed" — done once the item is collected, shipped, disposed of or its date moved on',
    stillWaiting: `EXISTS (SELECT 1 FROM held_items h
                    WHERE h.id = n.entity_id
                      AND h.kind IN ('incoming','temp_storage')
                      AND h.status NOT IN ('collected','given_to_client','shipped_back','disposed','cancelled')
                      AND h.hold_until IS NOT NULL
                      AND h.hold_until <= CURRENT_DATE + ${HOLD_UNTIL_LEAD_DAYS})`,
    latestOnly: true,
  },
  lost_property_chases: {
    about: '"Lost property: N chases ready to review" (a daily digest) — done once nothing is waiting to be chased',
    stillWaiting: `EXISTS (SELECT 1 FROM held_items h
                    WHERE h.kind = 'lost_property'
                      AND h.status NOT IN ('collected','shipped_back','disposed','cancelled')
                      AND (h.owner_person_id IS NOT NULL OR h.owner_organisation_id IS NOT NULL)
                      AND (h.last_chased_at IS NULL OR h.last_chased_at < NOW() - INTERVAL '7 days')
                      AND h.found_date IS NOT NULL AND h.found_date <= CURRENT_DATE - INTERVAL '7 days'
                      AND (h.expected_collection_date IS NULL OR h.expected_collection_date < CURRENT_DATE))`,
    latestOnly: true,
  },

  // ── Settings and money ───────────────────────────────────────────────────
  kiosk_pin_rotation: {
    about: '"Rotate the warehouse PIN" — done once the PIN-changed date is inside the rotation period again',
    stillWaiting: `EXISTS (SELECT 1 FROM system_settings ss
                    WHERE ss.key = 'kiosk_pin_rotated_at'
                      AND CASE WHEN btrim(ss.value) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                               THEN btrim(ss.value)::date <= CURRENT_DATE - ${PIN_ROTATE_DAYS}
                               ELSE false END)`,
    latestOnly: true,
  },
  cot_receipts: {
    about: '"N company-card purchases need a receipt" (a weekly digest) — done once none of the bell\'s person\'s card purchases is waiting for a receipt',
    // runCostReceiptChase's own test, for the person it was sent to.
    stillWaiting: `EXISTS (SELECT 1 FROM costs c
                    WHERE c.uploaded_by = n.user_id
                      AND c.payment_method = 'cot_card'
                      AND c.receipt_r2_key IS NULL
                      AND c.cost_date <= CURRENT_DATE - ${RECEIPT_GRACE_DAYS})`,
    latestOnly: true,
  },
  email_undelivered: {
    about: '"Email not delivered to <address>" (bounced / blocked / complained) — done once the address is marked fixed, or a later email to it is delivered',
    // The address is the one in the title; email_address_problems holds it
    // lower-cased, as raiseAlert writes it. A problem re-opened after the
    // bell (first_seen_at later) is a new one with its own bell.
    stillWaiting: `EXISTS (SELECT 1 FROM email_address_problems p
                    WHERE p.email = substring(n.title from '^Email not delivered to ([^ ]+)')
                      AND p.resolved_at IS NULL
                      AND p.first_seen_at <= n.created_at)`,
  },
  overtime_cashout: {
    about: '"Overtime to pay in January payroll — <year> banked hours" — done once nobody employed has banked overtime left in that year (v_staff_balances, as getBalance reads it)',
    // The year is the one in the title ("— 2026 banked hours"), which
    // runCashOutReminder writes; a title without one reads as done. The
    // balance itself comes from staff-balance.ts, the only reader of it.
    stillWaiting: overtimeStillBankedSql(
      `CASE WHEN n.title ~ '[0-9]{4} banked hours'
            THEN substring(n.title from '([0-9]{4}) banked hours')::int END`),
  },

  // ── Staff time, To Do, reviews, records ──────────────────────────────────
  rtw_due: {
    about: '"Return-to-work due / still outstanding" — done once the conversation is recorded or the absence cancelled',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_absences a
                    WHERE a.id = n.entity_id AND a.status = 'active' AND a.is_open = false
                      AND a.rtw_required AND a.rtw_completed_at IS NULL)`,
  },
  freelancer_unconfirmed: {
    about: '"<freelancer> has not confirmed for tomorrow" — done once the booking leaves Offered (answered, cancelled, completed, closed out)',
    stillWaiting: `EXISTS (SELECT 1 FROM freelancer_day_bookings b
                    WHERE b.id = n.entity_id AND b.status = 'offered'
                      AND (b.reoffered_at IS NULL OR b.reoffered_at < n.created_at))`,
  },
  task_owner: {
    about: '"A to-do needs you", "You\'ve been given a to-do", "A to-do was handed back to you" — done once it is no longer an open to-do of the bell\'s person',
    stillWaiting: TASK_STILL_MINE,
    // The chase re-arms every few days: only the newest copy stays lit.
    latestOnly: true,
  },
  task_list_item: {
    about: '"On <list>: something needs doing" — done once somebody takes the item or it is closed',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_tasks t
                    WHERE t.id = n.entity_id AND t.status = 'open' AND t.person_id IS NULL)`,
    latestOnly: true,
  },
  task_follow_up: {
    about: '"A to-do you set is still open" — done once it is closed, its follow-up date moves, or it comes back to the setter',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_tasks t JOIN users u ON u.id = n.user_id
                    WHERE t.id = n.entity_id AND t.status = 'open' AND t.created_by = n.user_id
                      AND t.person_id IS DISTINCT FROM u.person_id
                      AND t.follow_up_chased_at IS NOT NULL AND t.follow_up_chased_at <= n.created_at)`,
  },
  series_proposed: {
    about: '"A repeating to-do needs your OK" — done once the bell\'s person has answered, or it is ended or given to someone else',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_task_series s JOIN users u ON u.id = n.user_id
                    WHERE s.id = n.entity_id AND s.status = 'proposed' AND s.person_id = u.person_id)`,
  },
  review_due: {
    about: '"A staff review is due" — done once a review is booked or recorded, or the person has left',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_employment se
                    WHERE se.person_id = n.entity_id AND se.employment_status = 'employed'
                      AND se.review_due_chased_at IS NOT NULL AND se.review_due_chased_at <= n.created_at
                      AND NOT EXISTS (SELECT 1 FROM staff_reviews r
                                       WHERE r.person_id = se.person_id
                                         AND r.status IN ('proposed','confirmed')))`,
  },
  record_action: {
    about: '"A staff record needs looking at" — done once its date or kind changes, it is deleted, or a newer document of the same kind replaces it (listRecordActionsDue)',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_record_files f
                    WHERE f.id = n.entity_id AND f.deleted_at IS NULL AND f.action_kind = 'remind'
                      AND f.action_chased_at IS NOT NULL AND f.action_chased_at <= n.created_at
                      AND NOT (f.doc_type IN (${SUPERSEDING_TYPES.map((t) => `'${t}'`).join(',')})
                               AND EXISTS (SELECT 1 FROM staff_record_files newer
                                            WHERE newer.person_id = f.person_id AND newer.doc_type = f.doc_type
                                              AND newer.deleted_at IS NULL AND newer.id <> f.id
                                              AND COALESCE(newer.document_date, newer.uploaded_at::date)
                                                > COALESCE(f.document_date, f.uploaded_at::date))))`,
  },
  record_delete: {
    about: '"A staff record is due for deletion" — done once it is deleted, or its date or kind changes',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_record_files f
                    WHERE f.id = n.entity_id AND f.deleted_at IS NULL AND f.action_kind = 'delete'
                      AND f.action_chased_at IS NOT NULL AND f.action_chased_at <= n.created_at)`,
  },

  // ── Staff documents (bells point at the DOCUMENT; per person where it is theirs) ──
  staff_doc_to_complete: {
    about: '"Document to sign / acknowledge", "Renewal due", "Reminder", "A document was updated" — done once the bell\'s person has completed it since the bell, or the document is retired / made read-only',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_document_assignments a
                      JOIN staff_documents d ON d.id = a.document_id
                      LEFT JOIN staff_document_completions c ON c.id = a.current_completion_id
                    WHERE a.document_id = n.entity_id AND a.user_id = n.user_id
                      AND d.is_active = true AND d.completion_mode <> 'read_only'
                      AND (a.status IN ('pending','lapsed') OR c.completed_at IS NULL OR c.completed_at < n.created_at))`,
  },
  staff_doc_content_review: {
    about: '"Review due" / "Overdue content review" — done once the document is marked reviewed (or a new version uploaded) since the bell',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_documents d
                    WHERE d.id = n.entity_id AND d.is_active AND d.approval_status = 'approved'
                      AND d.content_review_interval_months IS NOT NULL AND d.content_review_due_date IS NOT NULL
                      AND d.content_review_due_date <= CURRENT_DATE
                      AND (d.content_reviewed_at IS NULL OR d.content_reviewed_at < n.created_at))`,
  },
  staff_doc_approval: {
    about: '"Document awaiting approval" — done once it is approved or sent back',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_documents d
                    WHERE d.id = n.entity_id AND d.approval_status = 'pending_approval'
                      AND (d.submitted_at IS NULL OR d.submitted_at <= n.created_at))`,
  },
  staff_doc_changes: {
    about: '"Changes requested" — done once the document is resubmitted (or approved, or retired)',
    stillWaiting: `EXISTS (SELECT 1 FROM staff_documents d
                    WHERE d.id = n.entity_id AND d.approval_status = 'draft' AND d.is_active)`,
  },
  staff_doc_escalation: {
    about: '"Outstanding staff document" (to managers) — done once THAT person completes it, leaves, or the document is retired / made read-only',
    // This bell points at the person's ASSIGNMENT, not the document, so one
    // person completing doesn't clear the bells about the others. The scanner
    // stamps escalated_at just before it bells: a later stamp is a newer rung.
    stillWaiting: `EXISTS (SELECT 1 FROM staff_document_assignments a
                      JOIN staff_documents d ON d.id = a.document_id
                      JOIN users u ON u.id = a.user_id
                    WHERE a.id = n.entity_id AND a.status = 'pending' AND u.is_active = true
                      AND d.is_active = true AND d.completion_mode <> 'read_only'
                      AND a.escalated_at IS NOT NULL AND a.escalated_at <= n.created_at)`,
    latestOnly: true,
  },
} as const satisfies Record<string, BellRule>;

export type BellKey = keyof typeof BELL_RULES;

/** The six van compliance keys, one per item the daily checker raises. */
export const COMPLIANCE_BELL_KEYS = [
  'compliance_mot', 'compliance_tax', 'compliance_insurance',
  'compliance_tfl', 'compliance_service', 'compliance_rossetts',
] as const satisfies readonly BellKey[];
