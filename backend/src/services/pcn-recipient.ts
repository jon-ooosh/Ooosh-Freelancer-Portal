/**
 * PCN recipient resolution — the SINGLE definition of "who does this PCN email
 * go to", shared by the action sender (pcn-actions.ts), the receipt chase
 * ladder (pcn-chase.ts) and the pre-send preview endpoint (routes/pcns.ts).
 *
 * WHY THIS EXISTS (job 16373, Sep 2026). A PCN's responsible driver lives in
 * one of TWO columns:
 *   - pcns.driver_id        → drivers  (a client's self-drive hirer)
 *   - pcns.driver_person_id → people   (a freelancer / crew member in our van)
 * The read path (SELECT_WITH_JOINS in routes/pcns.ts) has always joined both.
 * The SEND path joined only `drivers`, so for a freelancer driver the email
 * resolved to NULL, silently fell through to the client contacts, and the
 * CLIENT was emailed about a PCN their hirer never incurred. pcn-chase.ts
 * carried the identical bug, so the 3/5/7-day ladder would have kept chasing
 * the client for proof of a payment they were never asked to make.
 *
 * Rules:
 *   - audience 'driver'         → override → driver → freelancer → client → info@
 *   - audience 'client'         → override → client → info@
 *   - audience 'freelancer_only'→ override → freelancer → NOBODY.
 *
 * The last one is load-bearing: the "Internal — Freelancer" path means "our own
 * cost, not the client's", so it must NEVER be able to reach a client contact
 * or info@ by falling through. No freelancer on file = no email, and the caller
 * says so rather than sending to whoever happens to answer.
 *
 * `isClientFallback` is the flag the UI turns into an amber "this will go to
 * the CLIENT, not the driver" warning. Before this existed the fall-through was
 * completely silent — the timeline just read "emailed <address>" with nothing
 * to say it wasn't the driver.
 */
import { query } from '../config/database';
import { resolveClientEmailTarget } from './money-emails';

const OOOSH_EMAIL = 'info@oooshtours.co.uk';

export type PcnAudience = 'driver' | 'client' | 'freelancer_only';

/** Where the address actually came from — surfaced in the UI and the timeline. */
export type PcnRecipientKind = 'override' | 'driver' | 'freelancer' | 'client' | 'info' | 'none';

export interface PcnRecipient {
  to: string | null;
  cc: string[];
  /** Display name for {{driverName}} / {{clientName}}. */
  name: string;
  kind: PcnRecipientKind;
  /** A driver-facing action that could not reach a driver and landed on the client. */
  isClientFallback: boolean;
  /** Landed on info@ because nothing else resolved. */
  isInfoFallback: boolean;
  /** Human label for the confirm panel + timeline, e.g. "Lewis Hoadley (freelancer)". */
  label: string;
  /**
   * The client/organisation name, for the client-facing templates that greet
   * "Dear {{clientName}}". Kept separate from `name` (the personal greeting the
   * driver-facing templates use) — they are not interchangeable.
   */
  clientName: string | null;
  /** Why there's nobody to email (audience 'freelancer_only' with no freelancer). */
  reason: string | null;
}

/** The columns the resolver needs. Both driver joins — that's the whole point. */
export interface PcnRecipientRow {
  job_id: string | null;
  driver_id: string | null;
  driver_person_id: string | null;
  driver_name: string | null;
  driver_email: string | null;
  driver_person_name: string | null;
  driver_person_email: string | null;
  client_organisation_name?: string | null;
}


/** SELECT fragment carrying both driver identities. Use this, never a bare drivers join. */
export const PCN_RECIPIENT_JOINS = `
  LEFT JOIN drivers d  ON d.id = p.driver_id
  LEFT JOIN people  dp ON dp.id = p.driver_person_id
`;
export const PCN_RECIPIENT_FIELDS = `
  d.full_name                            AS driver_name,
  d.email                                AS driver_email,
  (dp.first_name || ' ' || dp.last_name) AS driver_person_name,
  dp.email                               AS driver_person_email
`;

/**
 * A pcns row with both driver identities attached. Declares the columns the
 * senders actually read (so they stay type-checked) and leaves the rest open —
 * pcns is a wide table and callers shouldn't have to mirror all of it.
 */
export interface PcnRow extends PcnRecipientRow {
  id: string;
  status: string;
  reference: string | null;
  vehicle_reg: string | null;
  fleet_reg: string | null;
  issuing_authority: string | null;
  location: string | null;
  fine_type: string | null;
  offence_at: string | null;
  offence_time_text: string | null;
  fine_amount: string | number | null;
  reduced_amount: string | number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  final_amount: string | number | null;
  hh_job_number: number | string | null;
  fine_recharged_at: string | null;
  pay_direct_deadline: string | null;
  receipt_upload_token: string | null;
  receipt_chase_level: number | null;
  receipt_chase_sent_for: string | null;
  documents: unknown;
  pcn_document_url: string | null;
  client_organisation_name: string | null;
  [key: string]: unknown;
}

/** Load one PCN with both driver identities attached. */
export async function loadPcnWithDrivers(pcnId: string): Promise<PcnRow | null> {
  const r = await query(
    `SELECT p.*, ${PCN_RECIPIENT_FIELDS},
            fv.reg  AS fleet_reg,
            o.name  AS client_organisation_name
     FROM pcns p
     ${PCN_RECIPIENT_JOINS}
     LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
     LEFT JOIN organisations o   ON o.id = p.client_organisation_id
     WHERE p.id = $1 AND p.is_deleted = false`,
    [pcnId]
  );
  return r.rows[0] ?? null;
}

const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};

export async function resolvePcnRecipient(
  pcn: PcnRecipientRow,
  opts: { audience: PcnAudience; templateId?: string | null; emailOverride?: string | null }
): Promise<PcnRecipient> {
  const { audience } = opts;

  const driverEmail = clean(pcn.driver_email);
  const driverName = clean(pcn.driver_name);
  const freelancerEmail = clean(pcn.driver_person_email);
  const freelancerName = clean(pcn.driver_person_name);

  // 0. Explicit override always wins — staff typed an address on purpose.
  const override = clean(opts.emailOverride);
  if (override) {
    const name = freelancerName || driverName || 'Sir/Madam';
    return {
      to: override, cc: [], name, kind: 'override',
      isClientFallback: false, isInfoFallback: false,
      label: `${override} (manually entered)`,
      clientName: clean(pcn.client_organisation_name), reason: null,
    };
  }

  // 1. Freelancer-only: the freelancer or nobody. No client, no info@.
  if (audience === 'freelancer_only') {
    if (freelancerEmail) {
      return {
        to: freelancerEmail, cc: [], name: freelancerName || 'there', kind: 'freelancer',
        isClientFallback: false, isInfoFallback: false,
        label: `${freelancerName || freelancerEmail} (freelancer)`,
        clientName: clean(pcn.client_organisation_name), reason: null,
      };
    }
    return {
      to: null, cc: [], name: freelancerName || 'there', kind: 'none',
      isClientFallback: false, isInfoFallback: false,
      label: 'nobody', clientName: clean(pcn.client_organisation_name),
      reason: pcn.driver_person_id
        ? 'The assigned freelancer has no email address on their contact record.'
        : 'No freelancer is assigned as the driver on this PCN.',
    };
  }

  // 2. Driver-facing: the client driver, then the freelancer/crew driver.
  if (audience === 'driver') {
    if (driverEmail) {
      return {
        to: driverEmail, cc: [], name: driverName || 'Sir/Madam', kind: 'driver',
        isClientFallback: false, isInfoFallback: false,
        label: `${driverName || driverEmail} (hire driver)`,
        clientName: clean(pcn.client_organisation_name), reason: null,
      };
    }
    if (freelancerEmail) {
      return {
        to: freelancerEmail, cc: [], name: freelancerName || 'Sir/Madam', kind: 'freelancer',
        isClientFallback: false, isInfoFallback: false,
        label: `${freelancerName || freelancerEmail} (freelancer)`,
        clientName: clean(pcn.client_organisation_name), reason: null,
      };
    }
  }

  // 3. Client contacts (the intended recipient for client-facing actions; a
  //    flagged fall-through for driver-facing ones).
  const driverFacing = audience === 'driver';
  if (pcn.job_id) {
    const tgt = await resolveClientEmailTarget(pcn.job_id, opts.templateId || undefined);
    if (tgt.primaryEmail && !tgt.isFallback) {
      const clientName = clean(tgt.clientName) || clean(pcn.client_organisation_name);
      return {
        to: tgt.primaryEmail,
        cc: tgt.ccEmails || [],
        name: driverFacing ? (driverName || freelancerName || 'Sir/Madam') : (clean(tgt.primaryFirstName) || clientName || 'Sir/Madam'),
        kind: 'client',
        isClientFallback: driverFacing,
        isInfoFallback: false,
        label: `${tgt.primaryEmail}${clientName ? ` — ${clientName}` : ''} (client contact)`,
        clientName,
        reason: driverFacing ? 'No driver contact on file for this PCN.' : null,
      };
    }
  }

  // 4. Last resort — info@, so a client-facing notice is never silently dropped.
  return {
    to: OOOSH_EMAIL, cc: [], name: driverName || freelancerName || 'Sir/Madam', kind: 'info',
    isClientFallback: false, isInfoFallback: true,
    label: `${OOOSH_EMAIL} (no contact on file)`,
    clientName: clean(pcn.client_organisation_name),
    reason: 'No driver or client contact could be resolved.',
  };
}
