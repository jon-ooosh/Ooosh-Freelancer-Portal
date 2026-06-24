/**
 * Shared PCN display helpers — the single source of truth for the `Pcn` shape,
 * status/fine-type labels, status colours, the status pill, and the
 * traffic-light derivation. Imported by PcnsPage (list), PcnDetailPage,
 * PcnHistorySection (Vehicle/Driver/Org/Job surfacing), and the vehicle
 * module's inline PCN section so they can never drift apart.
 */

// ── Types ───────────────────────────────────────────────────────────────
export interface Pcn {
  id: string;
  reference: string | null;
  fine_type: string;
  vehicle_id: string | null;
  driver_id: string | null;
  driver_person_id: string | null;
  job_id: string | null;
  client_organisation_id: string | null;
  pcn_document_url: string | null;
  hh_job_number: number | null;
  vehicle_reg: string | null;
  fleet_reg: string | null;
  driver_name: string | null;
  driver_email: string | null;
  driver_person_name: string | null;
  driver_person_email: string | null;
  client_organisation_name: string | null;
  job_name: string | null;
  offence_at: string | null;
  offence_time_text: string | null;
  location: string | null;
  issuing_authority: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  status: string;
  action_path: string | null;
  notes: string | null;
  pay_direct_deadline: string | null;
  receipt_url: string | null;
  receipt_uploaded_at: string | null;
  receipt_chase_level: number | null;
  documents?: PcnDocument[] | null;
  created_at: string;
}

// ── Documents (multi-doc audit: notice front/back, correspondence, responses) ─
export type PcnDocKind = 'notice_front' | 'notice_back' | 'correspondence' | 'response' | 'receipt' | 'other';

export interface PcnDocument {
  r2_key: string;
  name?: string | null;
  kind?: PcnDocKind | null;
  comment?: string | null;
  uploaded_at?: string | null;
  uploaded_by?: string | null;
}

export const PCN_DOC_KIND_LABEL: Record<PcnDocKind, string> = {
  notice_front: 'Notice (front)',
  notice_back: 'Notice (back)',
  correspondence: 'Correspondence',
  response: 'Issuer response',
  receipt: 'Receipt / proof',
  other: 'Other',
};

export const PCN_DOC_KINDS: PcnDocKind[] = ['notice_front', 'notice_back', 'correspondence', 'response', 'receipt', 'other'];

// Unified document list for display: the `documents` array, plus the legacy
// single pointers (pcn_document_url as the notice, receipt_url as the proof),
// deduped by r2_key. Mirrors the backend's noticeDocumentKeys merge so the UI
// and the email-attach agree about what a PCN "has".
export function mergePcnDocuments(
  pcn: Pick<Pcn, 'documents' | 'pcn_document_url' | 'receipt_url' | 'receipt_uploaded_at'>,
): PcnDocument[] {
  const out: PcnDocument[] = [...(pcn.documents || [])];
  const seen = new Set(out.map((d) => d.r2_key));
  if (pcn.pcn_document_url && !seen.has(pcn.pcn_document_url)) {
    out.push({ r2_key: pcn.pcn_document_url, name: 'Scanned notice', kind: 'notice_front' });
    seen.add(pcn.pcn_document_url);
  }
  if (pcn.receipt_url && !seen.has(pcn.receipt_url)) {
    out.push({ r2_key: pcn.receipt_url, name: 'Proof of payment', kind: 'receipt', uploaded_at: pcn.receipt_uploaded_at });
  }
  return out;
}

// ── Display maps ──────────────────────────────────────────────────────────
export const PCN_STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  awaiting_driver_id: 'Awaiting Driver ID',
  driver_notified_pay: 'Driver Notified — To Pay',
  paid_by_driver: 'Paid by Driver',
  liability_transferred: 'Liability Transferred',
  paid_recharged: 'Paid & Recharged',
  internal_ooosh: 'Internal (Ooosh)',
  internal_freelancer: 'Internal (Freelancer)',
  under_query: 'Under Query',
  closed: 'Closed',
};

// Distinct hue per lifecycle meaning so same-stage statuses don't blur together:
//   slate  = just in / not yet actioned (received)
//   amber  = waiting on the client (awaiting driver ID)
//   orange = waiting on payment (driver notified to pay)
//   purple = in dispute (under query)
//   green  = sorted — money's settled or liability has moved (paid by driver,
//            paid & recharged, liability transferred, closed)
//   indigo = we're absorbing it internally (Ooosh / freelancer) — NOT green,
//            because nobody's paid the issuer back to us
export const PCN_STATUS_COLOUR: Record<string, string> = {
  received: 'bg-slate-100 text-slate-700',
  awaiting_driver_id: 'bg-amber-100 text-amber-800',
  driver_notified_pay: 'bg-orange-100 text-orange-800',
  paid_by_driver: 'bg-green-100 text-green-800',
  liability_transferred: 'bg-green-100 text-green-800',
  paid_recharged: 'bg-green-100 text-green-800',
  internal_ooosh: 'bg-indigo-100 text-indigo-700',
  internal_freelancer: 'bg-indigo-100 text-indigo-700',
  under_query: 'bg-purple-100 text-purple-800',
  closed: 'bg-green-100 text-green-800',
};

export const FINE_TYPE_LABEL: Record<string, string> = {
  private_pcn: 'Private PCN',
  council_pcn: 'Council PCN',
  police_nip: 'Police NIP',
  toll: 'Toll',
  other: 'Other',
};

export const fmtPcnDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
export const fmtPcnMoney = (n: number | null | undefined) => (n == null ? '—' : `£${Number(n).toFixed(2)}`);

export function PcnStatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PCN_STATUS_COLOUR[status] || 'bg-slate-100 text-slate-700'}`}>
      {PCN_STATUS_LABEL[status] || status}
    </span>
  );
}

// ── Traffic-light derivation (§2 of the spec) ─────────────────────────────
// 🟢 sorted · 🟡 in-flight · 🔴 outstanding (past an issuer deadline, or past
// the final receipt-chase rung with no proof of payment). The final rung is
// the 3rd by default (pcn_receipt_chase_days = 3,5,7); this display constant
// matches that default — settings-driven precision isn't worth a round-trip
// for a dot colour.
export type PcnLight = 'green' | 'amber' | 'red';

const PCN_GREEN = new Set(['paid_by_driver', 'paid_recharged', 'internal_ooosh', 'internal_freelancer', 'closed']);
const FINAL_CHASE_RUNG = 3;

export function pcnTrafficLight(p: Pick<Pcn, 'status' | 'final_deadline' | 'receipt_chase_level' | 'receipt_url'>): PcnLight {
  if (PCN_GREEN.has(p.status)) return 'green';
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const finalDeadlinePassed = !!p.final_deadline && new Date(p.final_deadline) < todayMidnight;
  const chaseExhausted =
    p.status === 'driver_notified_pay' && (p.receipt_chase_level ?? 0) >= FINAL_CHASE_RUNG && !p.receipt_url;
  if (finalDeadlinePassed || chaseExhausted) return 'red';
  return 'amber';
}

export const PCN_LIGHT_DOT: Record<PcnLight, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
};

// ── Next-action countdown (derived from status + the relevant deadline) ───────
// Answers "what's the clock on this PCN right now?" without a stored field — the
// driving date depends on which stage it's in:
//   driver_notified_pay        → pay_direct_deadline (driver pays the issuer)
//   police NIP (open)          → offence + 28 days (statutory window to name the driver)
//   awaiting_driver_id / open  → reduced_deadline ?? final_deadline (issuer deadline)
//   terminal statuses          → nothing left to do
// tone: red = overdue, amber = due within 3 days, slate = comfortable / no date.
export type PcnActionTone = 'red' | 'amber' | 'slate' | 'green';

export interface PcnNextAction {
  label: string;          // what the date means ("Driver to pay", "Issuer deadline", …)
  date: string | null;    // ISO date driving the countdown, if any
  days: number | null;    // whole days from today (negative = overdue)
  tone: PcnActionTone;
}

const PCN_TERMINAL = new Set([
  'paid_by_driver', 'paid_recharged', 'liability_transferred',
  'internal_ooosh', 'internal_freelancer', 'closed',
]);

function daysFromToday(dateStr: string): number {
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function pcnNextAction(
  p: Pick<Pcn, 'status' | 'fine_type' | 'offence_at' | 'reduced_deadline' | 'final_deadline' | 'pay_direct_deadline'>,
): PcnNextAction {
  if (PCN_TERMINAL.has(p.status)) return { label: 'Resolved', date: null, days: null, tone: 'green' };

  const withTone = (label: string, date: string | null): PcnNextAction => {
    if (!date) return { label, date: null, days: null, tone: 'slate' };
    const days = daysFromToday(date);
    return { label, date, days, tone: days < 0 ? 'red' : days <= 3 ? 'amber' : 'slate' };
  };

  // Police NIP: the urgent clock is the 28-day window to name the driver.
  if (p.fine_type === 'police_nip' && (p.status === 'received' || p.status === 'awaiting_driver_id') && p.offence_at) {
    const nip = new Date(p.offence_at);
    nip.setHours(0, 0, 0, 0);
    nip.setDate(nip.getDate() + 28);
    return withTone('Name driver (NIP)', nip.toISOString().slice(0, 10));
  }

  if (p.status === 'driver_notified_pay') return withTone('Driver to pay', p.pay_direct_deadline);

  const deadline = p.reduced_deadline || p.final_deadline || null;
  const label = p.status === 'awaiting_driver_id' ? 'Client ID due'
    : p.status === 'under_query' ? 'Query deadline'
    : 'Issuer deadline';
  return withTone(label, deadline);
}

const PCN_ACTION_TONE_TEXT: Record<PcnActionTone, string> = {
  red: 'text-red-600',
  amber: 'text-amber-600',
  slate: 'text-slate-700',
  green: 'text-green-600',
};

// Compact two-line cell: the countdown on top, what it's for underneath.
export function PcnNextActionCell({ pcn }: { pcn: Parameters<typeof pcnNextAction>[0] }) {
  const a = pcnNextAction(pcn);
  if (a.days == null) {
    return <span className={`text-xs ${a.tone === 'green' ? 'text-green-600' : 'text-slate-400'}`}>{a.label === 'Resolved' ? 'Resolved' : '—'}</span>;
  }
  const countdown = a.days < 0 ? `${-a.days}d overdue` : a.days === 0 ? 'today' : `${a.days}d left`;
  return (
    <span className="inline-block leading-tight">
      <span className={`text-sm font-medium ${PCN_ACTION_TONE_TEXT[a.tone]}`}>{countdown}</span>
      <span className="block text-[11px] text-slate-400">{a.label} · {fmtPcnDate(a.date)}</span>
    </span>
  );
}
