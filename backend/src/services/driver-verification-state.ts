/**
 * Driver verification state — what the driver and the system actually see.
 *
 * Feeds the staff cockpit on DriverDetailPage: a stage tracker showing where the
 * driver has got to, and a "what needs doing" list.
 *
 * WHY IT LIVES BESIDE THE ROUTER
 * ------------------------------
 * Both are derived from the SAME `computeDriverValidity` the hire-form routing
 * engine uses, so the tracker cannot tell staff one thing while the driver's
 * browser is being told another. That equivalence is the entire point: the
 * whole class of incident this work came out of (job 16291) was staff and the
 * router disagreeing about the same driver, with staff having no way to see it.
 *
 * Presentation stays on the frontend. What lives here is only the logic that
 * must not drift from the router.
 */

import { computeDriverValidity, todayYmd, type DocWindow } from './driver-validity';
import { isIdentityAuthorised } from './identity-review';

export type StageState = 'done' | 'todo' | 'blocked' | 'not_required';

export interface VerificationStage {
  key: 'contact' | 'insurance' | 'identity' | 'poa1' | 'poa2' | 'dvla' | 'passport' | 'signature';
  label: string;
  state: StageState;
  /** Short explanation shown under the stage when it isn't done. */
  detail: string | null;
}

export interface VerificationAction {
  severity: 'red' | 'amber' | 'info';
  message: string;
  /**
   * What the cockpit should offer. `slot` names the evidence group to scroll to
   * or act on, matching the frontend's group keys.
   */
  kind: 'compare_identity' | 'set_date' | 'replace_document' | 'send_hire_form' | 'resolve_referral' | 'none';
  slot?: string;
}

export interface DriverVerificationState {
  stages: VerificationStage[];
  actions: VerificationAction[];
  /** True when nothing is outstanding — the cockpit shows an "all clear" line. */
  allClear: boolean;
}

/** Columns this reads. Loose on purpose — callers pass raw driver rows. */
export interface VerificationStateInput {
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  insurance_status?: unknown;
  signature_date?: unknown;
  requires_referral?: unknown;
  referral_status?: unknown;
  identity_check_status?: unknown;
  idenfy_face_result?: unknown;
  licence_issued_by?: unknown;
  /**
   * HH job the driver has started a hire form for but NOT signed for — from
   * `unsignedJobNumberSql()` in driver-hire-progress.ts. A signature never
   * expires, so `signature_date` alone can't say whether they are joined to
   * the hire in front of them; this can.
   */
  unsigned_job_number?: unknown;
  [key: string]: unknown;
}

function daysBetween(fromYmd: string, toYmd_: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd_}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function formatUk(ymd: string | null): string {
  if (!ymd) return 'not set';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

/** Stage state for a document window, plus the reason when it isn't done. */
function windowStage(win: DocWindow, label: string, today: string): { state: StageState; detail: string | null } {
  if (win.trusted === false) {
    return { state: 'blocked', detail: win.untrustedReason };
  }
  if (!win.until) {
    return { state: 'todo', detail: `No ${label.toLowerCase()} on record` };
  }
  if (!win.valid) {
    return { state: 'blocked', detail: `Expired ${formatUk(win.until)}` };
  }
  const left = daysBetween(today, win.until);
  return { state: 'done', detail: left <= 30 ? `Expires in ${left} day${left === 1 ? '' : 's'}` : null };
}

export function computeVerificationState(
  driver: VerificationStateInput,
  today: string = todayYmd(),
): DriverVerificationState {
  const v = computeDriverValidity(driver as never, today);
  const stages: VerificationStage[] = [];
  const actions: VerificationAction[] = [];

  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : x ? String(x) : '');

  // ── 1. Contact ──────────────────────────────────────────────────────────
  const hasContact = !!str(driver.full_name) && !!str(driver.email);
  stages.push({
    key: 'contact',
    label: 'Contact',
    state: hasContact ? 'done' : 'todo',
    detail: hasContact ? (str(driver.phone) ? null : 'No phone number') : 'Name or email missing',
  });

  // ── 2. Insurance questionnaire ──────────────────────────────────────────
  // The hire form writes insurance_status ('Approved' | 'Referral') when the
  // questionnaire is submitted, so its presence IS the completion marker.
  const insuranceDone = !!str(driver.insurance_status);
  stages.push({
    key: 'insurance',
    label: 'Insurance Qs',
    state: insuranceDone ? 'done' : 'todo',
    detail: insuranceDone ? null : 'Questionnaire not submitted',
  });

  // ── 3. Identity (licence + selfie) ──────────────────────────────────────
  const identityStatus = str(driver.identity_check_status) || null;
  const identityHeld = !isIdentityAuthorised(identityStatus);
  const licenceStage = windowStage(v.licence, 'licence check', today);
  stages.push({
    key: 'identity',
    label: 'Identity',
    state: identityHeld ? 'blocked' : licenceStage.state,
    detail: identityHeld
      ? (identityStatus === 'rejected' ? 'Photo ID rejected on review' : 'Photo ID needs manual review')
      : licenceStage.detail,
  });

  // ── 4/5. Proof of address — independent of each other ───────────────────
  // Policy is BOTH must be valid, but one may lapse while the other stands, so
  // they are tracked and actioned separately: only the lapsed one is re-asked for.
  const poa1Stage = windowStage(v.poa1, 'proof of address 1', today);
  const poa2Stage = windowStage(v.poa2, 'proof of address 2', today);
  stages.push({ key: 'poa1', label: 'POA 1', ...poa1Stage });
  stages.push({ key: 'poa2', label: 'POA 2', ...poa2Stage });

  // ── 6. DVLA (UK) or passport (non-UK) ───────────────────────────────────
  const dvlaStage = windowStage(v.dvla, 'DVLA check', today);
  const passportStage = windowStage(v.passport, 'passport check', today);
  stages.push({
    key: 'dvla',
    label: 'DVLA',
    state: v.isUkDriver ? dvlaStage.state : 'not_required',
    detail: v.isUkDriver ? dvlaStage.detail : 'UK licence holders only',
  });
  stages.push({
    key: 'passport',
    label: 'Passport',
    state: v.isUkDriver ? 'not_required' : passportStage.state,
    detail: v.isUkDriver ? 'Non-UK licence holders only' : passportStage.detail,
  });

  // ── 7. Signature ────────────────────────────────────────────────────────
  //
  // "Signed" is per-HIRE, not per-driver. A returning driver carries last
  // time's signature_date, so a driver mid-form for a new hire read ✓ here
  // while nothing joined them to it (Cameron Williams-Hill / 16618, Sep 2026).
  const signed = !!driver.signature_date;
  const unsignedFor = Number(driver.unsigned_job_number) || null;
  stages.push({
    key: 'signature',
    label: 'Signature',
    state: signed && !unsignedFor ? 'done' : 'todo',
    detail: unsignedFor
      ? (signed ? `Signed before — not yet for #${unsignedFor}` : `Not yet signed for #${unsignedFor}`)
      : (signed ? null : 'Hire agreement not signed'),
  });

  // ── What needs doing ────────────────────────────────────────────────────
  // Ordered worst-first so the top line is the thing to act on.

  if (identityStatus === 'needs_review') {
    actions.push({
      severity: 'red',
      kind: 'compare_identity',
      slot: 'identity',
      message: str(driver.idenfy_face_result)
        ? `Selfie didn't match the licence photo (${str(driver.idenfy_face_result)}) — compare the two images and accept or reject`
        : "Selfie didn't match the licence photo — compare the two images and accept or reject",
    });
  } else if (identityStatus === 'rejected') {
    actions.push({
      severity: 'red', kind: 'none', slot: 'identity',
      message: 'Photo ID was rejected on review — this driver is not authorised to drive',
    });
  }

  if (v.licence.trusted === false) {
    actions.push({
      severity: 'red', kind: 'send_hire_form', slot: 'identity',
      message: v.licence.untrustedReason || 'Licence could not be verified — send a new hire form',
    });
  }

  if (driver.requires_referral === true
      && !['approved', 'waived'].includes(str(driver.referral_status))) {
    actions.push({
      severity: 'amber', kind: 'resolve_referral', slot: 'referral',
      message: str(driver.referral_status) === 'pending'
        ? 'Insurance referral sent — awaiting the insurer'
        : 'Insurance referral needed — nobody has contacted the insurer yet',
    });
  }

  // Expired / missing documents, each with the specific remedy.
  const docs: Array<{ slot: string; label: string; win: DocWindow; applies: boolean }> = [
    { slot: 'dvla', label: 'DVLA check', win: v.dvla, applies: v.isUkDriver },
    { slot: 'poa1', label: 'Proof of address 1', win: v.poa1, applies: true },
    { slot: 'poa2', label: 'Proof of address 2', win: v.poa2, applies: true },
    { slot: 'passport', label: 'Passport check', win: v.passport, applies: !v.isUkDriver },
  ];
  for (const doc of docs) {
    if (!doc.applies) continue;
    if (doc.win.until && !doc.win.valid) {
      actions.push({
        severity: 'amber', kind: 'send_hire_form', slot: doc.slot,
        message: `${doc.label} expired ${formatUk(doc.win.until)} — request a new one`,
      });
    } else if (!doc.win.until) {
      actions.push({
        severity: 'amber', kind: 'set_date', slot: doc.slot,
        message: `${doc.label} has no date recorded — add the date on the document`,
      });
    }
  }

  // A stale identity CHECK is amber, never red. The physical licence expiring is
  // what stops someone driving; our 90-day re-verification window lapsing just
  // means it is time to send them a hire form. Flipping this into the red tier
  // would block 186 drivers — over half the signed roster, because most people
  // hire once and never return.
  if (v.licence.trusted && v.licence.until && !v.licence.valid) {
    actions.push({
      severity: 'amber', kind: 'send_hire_form', slot: 'identity',
      message: `Identity check lapsed ${formatUk(v.licence.until)} — send a hire form to re-verify`,
    });
  }

  if (unsignedFor) {
    // Amber, not red: nothing is wrong with the driver, they just stopped one
    // screen short. Nothing links them to the hire until they sign.
    actions.push({
      severity: 'amber', kind: 'none', slot: 'signature',
      message: `Started the hire form for #${unsignedFor} but hasn't signed it — they're not on the hire until they do. Send the hire form link again.`,
    });
  } else if (!signed && hasContact) {
    actions.push({
      severity: 'info', kind: 'none', slot: 'signature',
      message: 'Hire agreement not signed yet',
    });
  }

  return {
    stages,
    actions,
    allClear: actions.filter(a => a.severity !== 'info').length === 0,
  };
}
