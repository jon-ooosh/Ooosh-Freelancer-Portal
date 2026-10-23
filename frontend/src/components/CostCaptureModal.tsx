/**
 * CostCaptureModal — capture or edit a cost/receipt for the Cost Capture &
 * Recharge module. Creates (POST) or updates (PATCH) a `costs` row.
 *
 * Layout: two panes on md+ (the document left, the form right, draggable
 * divider that remembers width). Stacks on mobile. Click backdrop or press Esc
 * to close.
 *
 * The form asks five things, top to bottom (Oct 2026 redesign, agreed with jon:
 * docs/design/cost-capture-redesign/DECISIONS.md):
 *   1. What is it? Receipt (paid already) / Bill (to pay) / Refund. A person
 *      answers it, not the AI. Refund hands over to the refund flow, which picks
 *      the purchase it refunds first.
 *   2. From the document: what the AI read, as a summary to check ("Edit
 *      details" turns it into inputs), with the amounts and VAT behind "Change
 *      amounts / VAT".
 *   3. What it's for: the category (drives both the Xero account code and the
 *      internal cost_type; staff never see codes or accountant terms) and the
 *      van, filled in from the job for vehicle costs.
 *   4. Jobs and who pays (CostJobsTable): which jobs it lands on and, per job,
 *      whether the quote covers it, the client is charged, or we cover it. It
 *      replaced the job picker, the quote/extra cards, the recharge selects and
 *      the separate split modal; a freelancer's ticked work fills it.
 *   5. Payment: Paid by (receipts) or "Pay later · due …" (bills).
 *
 * The supplier field autocompletes from existing Xero contacts so we don't
 * accumulate typo-duplicates. Net / VAT / Gross auto-calculate at 20% (switch
 * mode to edit manually).
 */
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { hasManagerRole } from '../lib/roles';
import { api } from '../services/api';
import FreelancerPersonPicker, { useFreelancerWork, UNMATCHED_REASONS, type FreelancerWorkItem, type PickedPerson } from './costs/FreelancerInvoiceLinks';
import CostJobsTable from './costs/CostJobsTable';
import {
  type JobChoice, DONE_RECHARGE, applyWork, choiceAmounts, defaultWhoPays, expensesByJob, jobAmountsFromWork,
  jobLabel, newChoice, num, planSplit, savedToWhoPays, vansOnDate, workAmounts, workPool, rowVerdict, type VanRow,
} from './costs/costJobs';
import { useJobInfo } from './costs/useJobInfo';
import { openR2Key } from '../lib/openAuthedFile';
import { useAuthStore } from '../hooks/useAuthStore';
import type { Cost, CostDocument, CostType, CostPaymentMethod, CostPaymentStatus } from '../../../shared/types';
import { ukToday, ukDatePlus } from '../lib/ukDate';

// Loaded on demand: the refund modal imports COST_CATEGORIES from this file.
const RecordRefundModal = lazy(() => import('./RecordRefundModal'));

interface Props {
  onClose: () => void;
  // null when a vehicle service record was saved with no cost (service-only),
  // or when "Refund" handed over to the refund flow and that saved.
  onSaved: (cost: Cost | null) => void;
  // "This is money coming BACK." Hands the chosen file to the refund flow
  // instead of capturing it as spend — a refund booked as a cost overstates
  // what we spent by twice the amount. Without it the form opens the refund
  // flow itself. Absent on the edit path.
  onRecordRefund?: (file: File | null) => void;
  existing?: Cost | null;
  presetJobId?: string | null;
  presetVehicleId?: string | null;
  presetIssueId?: string | null;
  /** Open with the Jobs section in view (the Costs list's ⑂, which used to open the split modal). */
  focusJobs?: boolean;
}

// Single source of truth for the staff-facing category picker. Each choice
// maps to a Xero account code (for the eventual push) + an internal cost_type
// (for filtering/reporting). Staff see only `label`, grouped under `group`.
// Keep in step with STAFF_COST_ACCOUNT_CODES in backend routes/costs.ts.
// Exported so the refund modal offers the SAME list — a credit coded to a
// different account than its purchase leaves both sides sitting in the accounts
// forever, netting to nothing useful.
export const COST_CATEGORIES: { group: string; label: string; xeroCode: string; costType: CostType }[] = [
  { group: 'People',         label: 'Freelance crew invoices',           xeroCode: '320', costType: 'freelancer_invoice' },
  { group: 'People',         label: 'Travel (taxis, trains etc.)',       xeroCode: '325', costType: 'job' },
  { group: 'Vehicles',       label: 'Vehicle servicing & upkeep',        xeroCode: '406', costType: 'vehicle' },
  { group: 'Vehicles',       label: 'Vehicle repairs (bodywork, glass)', xeroCode: '409', costType: 'vehicle' },
  { group: 'Vehicles',       label: 'Fuel',                              xeroCode: '410', costType: 'vehicle' },
  { group: 'Vehicles',       label: 'Parking',                           xeroCode: '411', costType: 'vehicle' },
  { group: 'Vehicles',       label: 'Parking fines / PCNs',              xeroCode: '399', costType: 'vehicle' },
  { group: 'Equipment',      label: 'Sub-hire of equipment',             xeroCode: '326', costType: 'job' },
  { group: 'Equipment',      label: 'Equipment repairs & spares',        xeroCode: '473', costType: 'parts' },
  { group: 'Equipment',      label: 'New equipment (backline, staging)', xeroCode: '764', costType: 'stock' },
  { group: 'Equipment',      label: 'Shop stock',                        xeroCode: '310', costType: 'stock' },
  { group: 'Office & other', label: 'Postage / courier',                 xeroCode: '425', costType: 'overhead' },
  { group: 'Office & other', label: 'Office supplies (milk, cleaning)',  xeroCode: '494', costType: 'overhead' },
  { group: 'Office & other', label: 'Office equipment',                  xeroCode: '710', costType: 'overhead' },
  { group: 'Office & other', label: 'Computer equipment',                xeroCode: '720', costType: 'overhead' },
  { group: 'Office & other', label: 'Something else',                    xeroCode: '429', costType: 'overhead' },
];

// Categories that represent a genuine service/repair EVENT on a vehicle — the
// only ones worth mirroring into the van's Service History. Other vehicle costs
// (fuel, parking, PCNs) keep their reg link on the cost row for charge-back
// clarity but must NOT create a service record, or the history clogs instantly.
const SERVICE_HISTORY_CATEGORY_CODES = new Set(['406', '409']);

// Paid-now methods push as a Xero Spend Money on the mapped bank/card account.
// Pay-later methods land as an authorised ACCPAY bill on approval, paid later.
// Receipts are paid by the uploader's company card, cash, Wise, or their own
// money (Reimburse me, a pay-later bill made out to them). Nothing else is
// offered for a NEW cost (jon, Oct 2026); an old cost on one of the others
// still shows and saves with it.
const PAID_BY: { value: CostPaymentMethod; label: string }[] = [
  { value: 'cot_card',     label: 'Company card' },
  { value: 'petty_cash',   label: 'Cash' },
  { value: 'wise',         label: 'Wise' },
  { value: 'reimburse_me', label: 'Me' },
];
const LEGACY_METHODS: { value: CostPaymentMethod; label: string }[] = [
  { value: 'amex',            label: 'Amex card' },
  { value: 'lloyds_cc',       label: 'Lloyds credit card' },
  { value: 'paypal',          label: 'PayPal' },
  { value: 'lloyds_transfer', label: 'Lloyds bank transfer' },
];
const METHOD_LABEL: Record<string, string> = {
  cot_card: 'company card', petty_cash: 'cash', wise: 'Wise', reimburse_me: 'my own money',
  not_yet_paid: 'supplier bill', amex: 'Amex', lloyds_cc: 'Lloyds card', paypal: 'PayPal', lloyds_transfer: 'Lloyds transfer',
};
// Keep in step with BILL_METHODS in backend routes/costs.ts + cost-xero-push.ts.
const BILL_METHODS: CostPaymentMethod[] = ['not_yet_paid', 'reimburse_me'];

// Xero takes 10 attachments per object; the main receipt claims one of them.
// Mirrors MAX_SUPPORTING_DOCUMENTS in backend routes/costs.ts.
const MAX_SUPPORTING_DOCS = 9;

// 'reclaim' = non-standard "VAT-only" invoice (insurance claim): enter the
// No-VAT amount (the excess) as Net + the reclaimable VAT; gross = net + vat.
// Pushed to Xero as the 3-line VAT-only structure (vat_treatment='reclaim_split').
type VatMode = 'vat20' | 'none' | 'manual' | 'reclaim';
const VAT_MODE_LABEL: Record<VatMode, string> = { vat20: '20% VAT', none: 'No VAT', manual: 'Manual', reclaim: 'VAT reclaim' };

type Kind = 'receipt' | 'bill' | 'refund';

const PAYMENT_STATUSES: { value: CostPaymentStatus; label: string }[] = [
  { value: 'paid', label: 'Paid' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
  { value: 'awaiting_invoice', label: 'Awaiting invoice' },
];

// Plain-English label for the terms behind a derived due date, so staff can see
// WHY the default is what it is (and whether it's worth correcting).
function describeTerms(t?: { basis: string; days: number; source: string } | null): string {
  if (!t) return '';
  if (t.source === 'freelancer') return 'Ooosh freelancer terms — first Friday a week after approval (8 to 14 days). Until it is approved, this assumes today';
  const base = t.basis === 'end_of_invoice_month' ? 'end of invoice month' : 'invoice date';
  const when = t.days === 0 ? base : `${base} + ${t.days} days`;
  if (t.source === 'manual') return `Supplier terms (set by us) — ${when}`;
  if (t.source === 'xero') return `Supplier terms (from Xero) — ${when}`;
  return `Default terms — ${when}`;
}

/** DD Mon YYYY for a YYYY-MM-DD string, without timezone drift. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

const SPLIT_KEY = 'ooosh_cost_modal_split_pct';
const round2 = (n: number) => Math.round(n * 100) / 100;

// One row of the cost-lines editor. Amounts stay strings while being typed —
// they only become numbers on save, same as the header amount fields.
interface LineDraft {
  key: string;
  description: string;
  amount_gross: string;   // INCLUSIVE of VAT — the figure printed on the invoice
  vatRate: LineVatRate;   // how much of amount_gross is VAT
  amount_vat: string;     // only edited directly on 'manual'; derived otherwise
  xero_account_code: string; // '' = inherit the cost's category
  crew_fronted: boolean;
  source: 'manual' | 'ai';
}

// A line states its amount INC VAT and a RATE, the way Xero and every other
// accounting package does it — rather than two money boxes where nothing says
// whether the total includes the VAT or not. The header's own VAT toggle is the
// same idea one level up: it sets the default rate for the whole invoice.
type LineVatRate = 'none' | 'vat20' | 'vat5' | 'manual';
const LINE_VAT_RATES: { v: LineVatRate; label: string; rate: number | null }[] = [
  { v: 'none', label: 'No VAT', rate: 0 },
  { v: 'vat20', label: '20%', rate: 0.20 },
  { v: 'vat5', label: '5%', rate: 0.05 },
  { v: 'manual', label: 'Manual £', rate: null },
];
// VAT contained in a VAT-inclusive amount: gross − gross/(1+rate).
const vatWithin = (gross: number, rate: number) => Math.round(gross * rate / (1 + rate) * 100) / 100;
// Read a stored line back into a rate. Nothing records which button was pressed —
// the same inference the header already does in inferVatMode, and for the same
// reason: it avoids a column that would only ever restore a radio button.
function inferLineRate(gross: number, vat: number): LineVatRate {
  if (vat <= 0) return 'none';
  for (const o of LINE_VAT_RATES) {
    if (o.rate) if (Math.abs(vat - vatWithin(gross, o.rate)) < 0.005) return o.v;
  }
  return 'manual';
}
const newLineKey = () => Math.random().toString(36).slice(2);
const gbp = (n: number) => `£${n.toFixed(2)}`;

// Beyond this a capture date stops being "recent" and starts being suspicious —
// almost always a misread year rather than a genuinely ancient receipt. Four
// months covers a year-end catch-up without nagging. Keep in step with STALE_MS
// in backend/src/services/cost-receipt-extract.ts, which downgrades confidence
// on the same boundary.
const STALE_COST_DAYS = 120;
// Same day and month, in the most recent year that isn't in the future. The
// one-click repair for a misread year: 23/08/2024 read today becomes 23/08/2026,
// or 23/08/2025 if August hasn't happened yet this year.
function mostRecentSameDayMonth(iso: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, , mo, da] = m;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const thisYear = `${now.getFullYear()}-${mo}-${da}`;
  const candidate = thisYear <= todayStr ? thisYear : `${now.getFullYear() - 1}-${mo}-${da}`;
  return candidate === iso ? null : candidate;
}
// Normalise a UK reg for comparison — strip spaces/punctuation, uppercase.
const normReg = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();

interface XeroContactLite { ContactID: string; Name: string }
type ExistingRow = (Cost & { hh_job_number?: number | null; job_name?: string | null }) | null | undefined;
interface SavedShare {
  id: string; job_id: string | null; hh_job_number?: number | null; job_name?: string | null; amount: number | string;
  cost_intent?: string | null; recharge_mode?: string | null; recharge_amount?: number | string | null; recharge_status?: string | null;
}
interface DuplicateCost { id: string; supplier_name: string | null; amount_gross: number; cost_date: string | null; payment_method: string | null; has_receipt: boolean; uploaded_by_name: string | null }

export default function CostCaptureModal({ onClose, onSaved, onRecordRefund, existing, presetJobId, presetVehicleId, presetIssueId, focusJobs }: Props) {
  const existingRow = existing as ExistingRow;
  const { user } = useAuthStore();
  // The cached login user can be stale if an admin set this staff member's COT
  // card in Settings AFTER they logged in. Read the card status fresh on open so
  // the "no card on file" hint reflects reality (the save already stamps it
  // server-side from the DB regardless).
  const [freshCardLast4, setFreshCardLast4] = useState<string | null | undefined>(user?.cot_card_last4);
  useEffect(() => {
    let cancelled = false;
    api.get<{ cot_card_last4?: string | null }>('/auth/me')
      .then((r) => { if (!cancelled) setFreshCardLast4(r?.cot_card_last4 ?? null); })
      .catch(() => { /* keep the cached value */ });
    return () => { cancelled = true; };
  }, []);
  const isEdit = Boolean(existing);
  // A refund row: stored negative, signed server-side (applyCreditSign), never
  // on a job split or a recharge. Its amounts are shown as on the slip.
  const isCredit = Boolean(existing?.is_credit);
  const magnitude = (v: number | string | null | undefined) => (v == null ? '' : String(isCredit ? Math.abs(Number(v)) : v));

  // ── What is it? ──────────────────────────────────────────────────────────
  // Asked first, by a person (jon, Oct 2026). An edit reads it off the cost:
  // a pay-later supplier bill is a Bill; anything paid already, or my own money
  // (Reimburse me), is a Receipt.
  const [kind, setKind] = useState<Kind | null>(() => {
    if (!existing) return null;
    if (existing.is_credit) return 'refund';
    return existing.payment_method === 'not_yet_paid' ? 'bill' : 'receipt';
  });
  const [showRefund, setShowRefund] = useState(false);

  // ── Form state ───────────────────────────────────────────────────────────
  const [supplierName, setSupplierName] = useState(existing?.supplier_name || '');
  // Xero contact id of a picked supplier suggestion — lets terms resolve by
  // stable id + seed from Xero. Cleared when the name is hand-edited (the id no
  // longer matches what's typed).
  const [xeroContactId, setXeroContactId] = useState<string | null>(existing?.xero_contact_id || null);
  const [costDate, setCostDate] = useState(() => (existing?.cost_date ? existing.cost_date.slice(0, 10) : ukToday()));
  const [invoiceNumber, setInvoiceNumber] = useState(existing?.invoice_number || '');
  // De-dup: warn if this supplier+invoice number was already captured.
  const [invoiceDup, setInvoiceDup] = useState<{ id: string; cost_date: string | null; amount_gross: number | null; payment_status: string } | null>(null);
  // De-dup without an invoice number: same amount, same day, same supplier
  // (several fuel receipts a day are normal, so it warns, never blocks).
  const [duplicates, setDuplicates] = useState<DuplicateCost[]>([]);
  // Due date. `dueDateOverride` is what staff typed (persisted as
  // costs.due_date_override); `derivedDueDate` is what the rules alone give and
  // is shown as the default + the "reset" target. Blank override = follow the
  // rules, so a cost staff never touch behaves exactly as it always did.
  const [dueDateOverride, setDueDateOverride] = useState(existing?.due_date_override ? existing.due_date_override.slice(0, 10) : '');
  const [derivedDueDate, setDerivedDueDate] = useState<string | null>(existing?.due_date_derived ?? null);
  const [derivedDueTermsLabel, setDerivedDueTermsLabel] = useState<string>('');
  const [amountGross, setAmountGross] = useState(magnitude(existing?.amount_gross));
  const [amountVat, setAmountVat] = useState(magnitude(existing?.amount_vat));
  const [amountNet, setAmountNet] = useState(magnitude(existing?.amount_net));
  // VAT handling: 20% (auto gross↔net), No VAT (net=gross, vat=0), or Manual
  // (edit all three). Default driven by category / AI; never assume 20% silently.
  const inferVatMode = (): VatMode => {
    if (!isEdit) return 'vat20';
    if (existing?.vat_treatment === 'reclaim_split') return 'reclaim';
    const g = Math.abs(Number(existing?.amount_gross || 0));
    const v = Math.abs(Number(existing?.amount_vat || 0));
    const n = Math.abs(Number(existing?.amount_net || 0));
    if (v <= 0 && (n === 0 || Math.abs(n - g) < 0.005)) return 'none';
    if (n > 0 && Math.abs(v - n * 0.2) < 0.02) return 'vat20';
    return 'manual';
  };
  const [vatMode, setVatMode] = useState<VatMode>(inferVatMode);
  const [vatTouched, setVatTouched] = useState(isEdit);
  const [description, setDescription] = useState(existing?.description || '');

  // The summary vs the inputs. A new cost shows inputs until the AI has read
  // the document; after that (and on edit) a summary to check, with "Edit details".
  const [detailsEditing, setDetailsEditing] = useState(false);
  const [amountsOpen, setAmountsOpen] = useState(false);

  // ── Jobs and who pays ────────────────────────────────────────────────────
  // One choice per job (costs/costJobs.ts). An edit reads the split back from
  // GET /costs/:id first; until it has, the jobs are left exactly as they are.
  const [choices, setChoices] = useState<JobChoice[]>(() =>
    (!existing && presetJobId ? [newChoice({ jobId: presetJobId, hhJobNumber: null, jobName: null }, true)] : []));
  const [splitState, setSplitState] = useState<'loading' | 'loaded' | 'failed'>(isEdit ? 'loading' : 'loaded');
  // The same, readable from the freelancer-work callback (set wherever splitState is).
  const splitStateRef = useRef(splitState);
  // The cost already sits on a split the old way, with a recharge on the whole cost.
  const [hadSplit, setHadSplit] = useState(false);

  // A freelancer invoice: whose it is and which of their work it covers, and
  // any question for them (FREELANCER-PORTAL-SPEC §5). Their portal's Earnings
  // page reads these.
  const [flPerson, setFlPerson] = useState<PickedPerson | null>(
    existing?.person_id ? { id: existing.person_id, name: existing.person_name || 'Linked freelancer' } : null);
  const [flPersonTouched, setFlPersonTouched] = useState(Boolean(existing?.person_id));
  const [flTicked, setFlTicked] = useState<string[]>([]);
  const [flTicksTouched, setFlTicksTouched] = useState(false);
  // Invoiced figure per ticked row, once staff type the freelancer's own number.
  const [flTyped, setFlTyped] = useState<Record<string, string>>({});
  const [flShowInvoiced, setFlShowInvoiced] = useState(false);
  // The ticked work as the edit form found it, until the saved split has loaded.
  const workSeedRef = useRef<{ keys: string[]; items: FreelancerWorkItem[] } | null>(null);
  // Saving one with no work ticked asks why first, never blocks (jon, Oct 2026).
  const [unmatchedAsk, setUnmatchedAsk] = useState<{ approve: boolean } | null>(null);
  const existingQuery = existing?.queried_at ? (existing.query_note || '') : '';
  const [queryNote, setQueryNote] = useState(existingQuery);
  const [questionOpen, setQuestionOpen] = useState(Boolean(existingQuery));
  const [categoryCode, setCategoryCode] = useState(existing?.xero_account_code || (presetVehicleId ? '406' : presetIssueId ? '473' : ''));

  // A CLOSE but unconfirmed Xero contact for the supplier the AI read. Shown as
  // "is it this one?" rather than applied — a wrong auto-merge files costs
  // against the wrong supplier, which is worse than a duplicate contact. Saying
  // yes is remembered server-side, so the question is asked once per letterhead.
  const [supplierSuggestion, setSupplierSuggestion] =
    useState<{ printed: string; name: string; xero_contact_id: string } | null>(null);

  // Cost lines — one payable split into parts that carry their own category and
  // VAT. The header (gross/VAT above) stays authoritative; lines only say how it
  // breaks down, and must add back up to it before we'll save. See
  // docs/COST-LINES-SPEC.md. Kept out of sight behind "Change amounts / VAT"
  // (22 costs ever had lines, 21 of them from the AI).
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [linesTouched, setLinesTouched] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<CostPaymentMethod>(existing?.payment_method || 'cot_card');
  const [paymentStatus, setPaymentStatus] = useState<CostPaymentStatus>(existing?.payment_status || 'paid');
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [notes, setNotes] = useState(existing?.notes || '');
  const [notesOpen, setNotesOpen] = useState(Boolean(existing?.notes));
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string>('');
  const [aiPrefilled, setAiPrefilled] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [receiptIsPdf, setReceiptIsPdf] = useState(false);
  // Supporting evidence filed alongside the main receipt (the freelancer's fuel
  // receipt behind their invoice, a delivery note). Evidence only: the AI reads
  // the main document, never these.
  const [supportingDocs, setSupportingDocs] = useState<CostDocument[]>(existing?.supporting_documents ?? []);
  const [newSupportingFiles, setNewSupportingFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // AI-spotted job number (suggestion only — staff confirm to link).
  const [suggestedJobNumber, setSuggestedJobNumber] = useState<string | null>(null);
  // AI-spotted vehicle reg feedback: matched=true → we auto-linked the van
  // (still flag it for a sanity check); matched=false → reg seen but not in the
  // active fleet, so the user links manually.
  const [vehicleRegNote, setVehicleRegNote] = useState<{ reg: string; matched: boolean } | null>(null);
  // Reg extracted from the receipt, awaiting a fleet match. Held in state (not
  // matched inline in the async handler) so the match runs in an effect once the
  // fleet list has actually loaded — the fleet fetch can still be in flight when
  // the multi-second AI extraction returns, and an inline match would compare
  // against a stale/empty fleet captured in the handler's closure.
  const [pendingVehicleReg, setPendingVehicleReg] = useState<string | null>(null);

  // ── Vehicle link + optional "also log to service history" ────────────────
  // Forward unification: a garage/vehicle cost can ALSO create a vehicle_service_log
  // record in one go (no double entry). Offered on new costs AND in edit mode when
  // the cost has no linked service record yet (e.g. the van link was added in a
  // later edit — previously that path silently skipped the service record).
  // Editing never re-touches an already-linked service record.
  type FleetLite = { id: string; reg: string; make?: string | null; model?: string | null; simple_type?: string | null };
  const [vehicleId, setVehicleId] = useState<string | null>(existing?.vehicle_id || presetVehicleId || null);
  const [fleet, setFleet] = useState<FleetLite[]>([]);
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [vehicleFocused, setVehicleFocused] = useState(false);
  const [vanPickerOpen, setVanPickerOpen] = useState(false);
  // The van(s) on the job on the cost date, for a vehicle cost (fuel, parking…).
  const [jobVans, setJobVans] = useState<{ jobId: string; vans: Array<{ id: string; reg: string }> } | null>(null);
  const [vanFromJob, setVanFromJob] = useState<string | null>(null);
  const [vanRemoved, setVanRemoved] = useState(false);
  // Default ON when a vehicle is in play at create time — "ask per cost,
  // defaulted to yes". Edit mode opens unticked: adding a service record
  // retroactively is an explicit opt-in, except when the edit itself ADDS the
  // van link (the picker auto-ticks, mirroring create).
  const [logService, setLogService] = useState<boolean>(!isEdit && Boolean(existing?.vehicle_id || presetVehicleId));
  const [serviceType, setServiceType] = useState<'service' | 'repair' | 'mot' | 'insurance' | 'tax' | 'tyre' | 'other'>('repair');
  const [serviceMileage, setServiceMileage] = useState('');
  const [serviceGarage, setServiceGarage] = useState('');
  const [serviceStatus, setServiceStatus] = useState('Done');
  const [serviceNextDueDate, setServiceNextDueDate] = useState('');
  const [serviceNextDueMileage, setServiceNextDueMileage] = useState('');
  const [applyToVehicle, setApplyToVehicle] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const jobsRef = useRef<HTMLDivElement>(null);

  // ── Supplier autocomplete (Xero contact search) ──────────────────────────
  const [supplierSuggestions, setSupplierSuggestions] = useState<XeroContactLite[]>([]);
  const [supplierFocused, setSupplierFocused] = useState(false);

  useEffect(() => {
    if (supplierName.trim().length < 2) { setSupplierSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: XeroContactLite[] }>(`/costs/xero/suppliers?search=${encodeURIComponent(supplierName.trim())}`);
        setSupplierSuggestions(r.data || []);
      } catch { setSupplierSuggestions([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [supplierName]);

  // Existing lines and the job split. The list query the table hands us doesn't
  // carry them (only GET /costs/:id does), so fetch once on open in edit mode.
  // On failure `lines` stays empty AND `linesTouched` stays false, which is what
  // stops the save sending an empty array and silently wiping a split we simply
  // couldn't read; the jobs likewise stay as they are (splitState 'failed').
  useEffect(() => {
    if (!isEdit || !existing?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ data: { lines?: Array<{ description: string | null; amount_gross: number | string;
          amount_vat: number | string; xero_account_code: string | null; crew_fronted: boolean; source: 'manual' | 'ai' }>;
          allocations?: SavedShare[] } }>(
          `/costs/${existing.id}`,
        );
        if (cancelled) return;
        if (r.data.lines?.length) {
          setLines(r.data.lines.map((l) => {
            const g = Number(l.amount_gross ?? 0);
            const v = Number(l.amount_vat ?? 0);
            return {
              key: newLineKey(),
              description: l.description || '',
              amount_gross: String(g),
              vatRate: inferLineRate(g, v),
              amount_vat: String(v),
              xero_account_code: l.xero_account_code || '',
              crew_fronted: Boolean(l.crew_fronted),
              source: l.source || 'manual',
            };
          }));
        }
        // The split, one choice per job, each with its own saved answer. The
        // old split modal only ever wrote shares on a job; one without is left out
        // (and so dropped on save), as that modal did.
        const shares = (r.data.allocations || []).filter((a) => a.job_id);
        const costDone = (existing.recharge_mode ?? 'none') !== 'none' && DONE_RECHARGE.has(String(existing.recharge_status));
        let built: JobChoice[] = [];
        if (shares.length) {
          setHadSplit(true);
          built = shares.map((a) => ({
            jobId: a.job_id as string, hhJobNumber: a.hh_job_number ?? null, jobName: a.job_name ?? null,
            ...savedToWhoPays(a.cost_intent ?? existing.cost_intent, a.recharge_mode, a.recharge_amount),
            amount: String(Number(a.amount)),
            allocationId: a.id,
            locked: (a.recharge_mode ?? 'none') !== 'none' && DONE_RECHARGE.has(String(a.recharge_status)) ? String(a.recharge_status) : null,
            touched: true, manual: true, seeded: true,
          }));
        } else if (existing.job_id) {
          built = [{
            jobId: existing.job_id, hhJobNumber: existingRow?.hh_job_number ?? null, jobName: existingRow?.job_name ?? null,
            ...savedToWhoPays(existing.cost_intent, existing.recharge_mode, existing.recharge_amount),
            amount: '', allocationId: null,
            locked: costDone ? String(existing.recharge_status) : null,
            touched: true, manual: true, seeded: true,
          }];
        }
        // Whichever of this and the freelancer's work arrives second does the
        // matching up, so both refs are set before any re-render.
        const seed = workSeedRef.current;
        splitStateRef.current = 'loaded';
        setChoices(seed ? applyWork(built, seed.items, seed.keys) : built);
        setSplitState('loaded');
      } catch {
        if (!cancelled) { splitStateRef.current = 'failed'; setSplitState('failed'); }
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A job handed in by the page (the Money tab, a Problem) needs its number and name.
  useEffect(() => {
    if (isEdit || !presetJobId) return;
    let cancelled = false;
    api.get<{ data?: { hh_job_number?: number | null; job_name?: string | null }; hh_job_number?: number | null; job_name?: string | null }>(`/hirehop/jobs/${presetJobId}`)
      .then((r) => {
        if (cancelled) return;
        const j = r.data ?? r;
        setChoices((prev) => prev.map((c) => (c.jobId === presetJobId
          ? { ...c, hhJobNumber: j.hh_job_number ?? null, jobName: j.job_name ?? null } : c)));
      })
      .catch(() => { /* the row reads "Job (no HireHop number)" */ });
    return () => { cancelled = true; };
  }, [isEdit, presetJobId]);

  // The Costs list's ⑂ opens the form here, at the jobs.
  useEffect(() => {
    if (focusJobs && splitState === 'loaded') jobsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusJobs, splitState]);

  // Invoice-number de-dup — debounced; warns if this supplier+invoice number was
  // already captured (non-blocking). Skips while editing the same cost.
  useEffect(() => {
    const invNo = invoiceNumber.trim();
    if (!invNo) { setInvoiceDup(null); return; }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ invoice_number: invNo, supplier_name: supplierName.trim() });
        if (existing?.id) params.set('exclude_id', existing.id);
        const r = await api.get<{ data: { duplicate: boolean; match: typeof invoiceDup } }>(`/costs/check-invoice?${params}`);
        setInvoiceDup(r.data.duplicate ? r.data.match : null);
      } catch { setInvoiceDup(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [invoiceNumber, supplierName, existing?.id]);

  // Same amount + same day + same supplier (the Xero contact where we have it,
  // else the name as the matcher normalises it). A warning with "Open it".
  useEffect(() => {
    const g = Number(amountGross);
    if (isCredit || !(g > 0) || !costDate || !supplierName.trim()) { setDuplicates([]); return; }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ amount_gross: g.toFixed(2), cost_date: costDate, supplier_name: supplierName.trim() });
        if (xeroContactId) params.set('xero_contact_id', xeroContactId);
        if (existing?.id) params.set('exclude_id', existing.id);
        const r = await api.get<{ data: { duplicates: DuplicateCost[] } }>(`/costs/check-duplicate?${params}`);
        setDuplicates(r.data.duplicates || []);
      } catch { setDuplicates([]); }
    }, 500);
    return () => clearTimeout(t);
  }, [amountGross, costDate, supplierName, xeroContactId, existing?.id, isCredit]);

  // Derived due date — debounced preview of what the rules give for this
  // supplier + date + cost type, so staff see the real default at capture time
  // rather than discovering it on the Bills-to-Pay list a day later. Same
  // engine as the list / Xero push, so the number shown is the number that
  // lands. Suggestion only: staff can override, and the override wins.
  useEffect(() => {
    if (!costDate) { setDerivedDueDate(null); setDerivedDueTermsLabel(''); return; }
    const costType = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode)?.costType || '';
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ cost_date: costDate });
        if (costType) params.set('cost_type', costType);
        if (supplierName.trim()) params.set('supplier_name', supplierName.trim());
        if (xeroContactId) params.set('xero_contact_id', xeroContactId);
        if (existing?.approved_at) params.set('approved_at', existing.approved_at);
        const r = await api.get<{ data: { due_date: string | null; terms: { basis: string; days: number; source: string } } }>(
          `/costs/due-date-preview?${params}`,
        );
        setDerivedDueDate(r.data.due_date);
        setDerivedDueTermsLabel(describeTerms(r.data.terms));
      } catch {
        setDerivedDueDate(null);
        setDerivedDueTermsLabel('');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [costDate, supplierName, xeroContactId, categoryCode, existing?.approved_at]);

  // Fleet list (small, ~20 vans) — fetched once for the vehicle picker, filtered
  // client-side. Active vehicles only.
  useEffect(() => {
    api.get<{ data: FleetLite[] }>('/vehicles/fleet')
      .then((r) => setFleet(r.data || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Match an AI-extracted reg against the fleet once the fleet has loaded.
  // Done here (not inline in the async extract handler) so a fleet fetch still
  // in flight when extraction returns doesn't cause a false "not in fleet". An
  // exact match auto-links the van (it's our plate) so the mileage/garage
  // pre-fill has somewhere to land; an unrecognised reg is surfaced as a note.
  useEffect(() => {
    if (!pendingVehicleReg || fleet.length === 0) return;
    if (vehicleId) { setPendingVehicleReg(null); return; }
    const wanted = normReg(pendingVehicleReg);
    const match = fleet.find((v) => normReg(v.reg) === wanted);
    if (match) {
      setVehicleId(match.id);
      if (SERVICE_HISTORY_CATEGORY_CODES.has(categoryCode)) setLogService(true);
      setVehicleRegNote({ reg: match.reg, matched: true });
    } else {
      setVehicleRegNote({ reg: pendingVehicleReg, matched: false });
    }
    setPendingVehicleReg(null);
  }, [pendingVehicleReg, fleet, vehicleId, categoryCode]);

  const vehicleLabel = (v: FleetLite | undefined) =>
    v ? `${v.reg}${v.make || v.model ? ` — ${[v.make, v.model].filter(Boolean).join(' ')}` : v.simple_type ? ` — ${v.simple_type}` : ''}` : '';
  const selectedVehicle = fleet.find((v) => v.id === vehicleId);
  const vehFiltered = (() => {
    const q = vehicleSearch.trim().toLowerCase();
    const list = q
      ? fleet.filter((v) => v.reg.toLowerCase().includes(q) || `${v.make || ''} ${v.model || ''} ${v.simple_type || ''}`.toLowerCase().includes(q))
      : fleet;
    return list.slice(0, 12);
  })();

  // ── Resizable split (md+ only) ───────────────────────────────────────────
  const [leftPct, setLeftPct] = useState<number>(() => Number(localStorage.getItem(SPLIT_KEY)) || 45);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(70, Math.max(25, pct));
      setLeftPct(clamped);
      localStorage.setItem(SPLIT_KEY, String(Math.round(clamped)));
    };
    const onUp = () => { draggingRef.current = false; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Misc effects ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (isEdit) return;
    setPaymentStatus(BILL_METHODS.includes(paymentMethod) ? 'awaiting_payment' : 'paid');
  }, [paymentMethod, isEdit]);

  // Category-driven defaults: a freelance crew invoice is usually NOT VAT-bearing;
  // most other supplier costs carry 20% VAT. Applied until the user overrides
  // the VAT (and never in edit mode). How it's paid follows "What is it?".
  useEffect(() => {
    if (isEdit || !categoryCode) return;
    const cat = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode);
    const isFreelance = cat?.costType === 'freelancer_invoice';
    if (!vatTouched) {
      const mode: VatMode = isFreelance ? 'none' : 'vat20';
      setVatMode(mode);
      const gross = parseFloat(amountGross);
      if (!isNaN(gross)) {
        if (mode === 'vat20') {
          const net = round2(gross / 1.2);
          setAmountNet(net.toFixed(2));
          setAmountVat(round2(gross - net).toFixed(2));
        } else {
          setAmountNet(gross.toFixed(2));
          setAmountVat('0.00');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryCode]);

  useEffect(() => {
    if (!receiptFile) { setReceiptPreview(null); setReceiptIsPdf(false); return; }
    const url = URL.createObjectURL(receiptFile);
    setReceiptPreview(url);
    setReceiptIsPdf(receiptFile.type === 'application/pdf');
    return () => URL.revokeObjectURL(url);
  }, [receiptFile]);

  // ── Amount handlers ──────────────────────────────────────────────────────
  const onGrossChange = (v: string) => {
    setAmountGross(v);
    if (v === '') return;
    const gross = parseFloat(v);
    if (isNaN(gross)) return;
    if (vatMode === 'vat20') {
      const net = round2(gross / 1.2);
      setAmountNet(net.toFixed(2));
      setAmountVat(round2(gross - net).toFixed(2));
    } else if (vatMode === 'none') {
      setAmountNet(gross.toFixed(2));
      setAmountVat('0.00');
    }
  };
  const onNetChange = (v: string) => {
    setAmountNet(v);
    if (v === '') return;
    const net = parseFloat(v);
    if (isNaN(net)) return;
    if (vatMode === 'vat20') {
      const vat = round2(net * 0.2);
      setAmountVat(vat.toFixed(2));
      setAmountGross(round2(net + vat).toFixed(2));
    } else if (vatMode === 'none') {
      setAmountVat('0.00');
      setAmountGross(net.toFixed(2));
    } else if (vatMode === 'reclaim') {
      const vat = parseFloat(amountVat);
      if (!isNaN(vat)) setAmountGross(round2(net + vat).toFixed(2));
    }
  };
  // In reclaim mode, VAT is entered directly and gross = net + vat.
  const onVatChange = (v: string) => {
    setAmountVat(v);
    if (vatMode !== 'reclaim') return;
    const vat = parseFloat(v);
    const net = parseFloat(amountNet);
    if (!isNaN(vat) && !isNaN(net)) setAmountGross(round2(net + vat).toFixed(2));
  };

  // Recompute amounts when the VAT mode changes (keep gross fixed as the anchor).
  const applyVatMode = (mode: VatMode) => {
    setVatMode(mode);
    setVatTouched(true);
    const gross = parseFloat(amountGross);
    if (isNaN(gross)) return;
    if (mode === 'vat20') {
      const net = round2(gross / 1.2);
      setAmountNet(net.toFixed(2));
      setAmountVat(round2(gross - net).toFixed(2));
    } else if (mode === 'none') {
      setAmountNet(gross.toFixed(2));
      setAmountVat('0.00');
    } else if (mode === 'reclaim') {
      // Switching in: keep whatever net/vat are set; recompute gross from them
      // if both present, else leave the user to enter net + vat.
      const net = parseFloat(amountNet);
      const vat = parseFloat(amountVat);
      if (!isNaN(net) && !isNaN(vat)) setAmountGross(round2(net + vat).toFixed(2));
    }
  };

  // AI extraction — POSTs the receipt to /api/costs/extract and pre-fills form.
  // The backend uses Claude vision (Haiku) + prompt caching on the system prompt.
  // Runs on its own as soon as a document is picked on a new cost.
  async function extractReceipt(file: File) {
    setExtracting(true);
    setExtractError('');
    setAiPrefilled(false);
    setVehicleRegNote(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<{
        data: {
          supplier: string | null;
          cost_date: string | null;
          due_date: string | null;
          amount_gross: number | null;
          amount_vat: number | null;
          amount_net: number | null;
          vat_treatment: 'standard' | 'no_vat';
          invoice_number: string | null;
          job_number: string | null;
          vehicle_reg: string | null;
          mileage: number | null;
          service_type: 'service' | 'repair' | 'mot' | 'insurance' | 'tax' | 'tyre' | 'other' | null;
          description: string | null;
          category_code: string | null;
          confidence: 'high' | 'medium' | 'low';
          lines?: Array<{ description: string | null; amount_gross: number; amount_vat: number; category_code: string | null }>;
          supplier_matched?: { from: string; to: string };
          xero_contact_id?: string | null;
          supplier_suggestion?: { name: string; xero_contact_id: string };
        };
      }>('/costs/extract', fd);
      const ex = res.data;
      if (ex.supplier) setSupplierName(ex.supplier);
      // An alias or exact match arrives already applied, with the contact id.
      if (ex.xero_contact_id) setXeroContactId(ex.xero_contact_id);
      setSupplierSuggestion(ex.supplier_suggestion && ex.supplier
        ? { printed: ex.supplier, ...ex.supplier_suggestion }
        : null);
      if (ex.cost_date) setCostDate(ex.cost_date);
      if (ex.invoice_number) setInvoiceNumber(ex.invoice_number);
      // A printed due date is the document's own answer, so it beats our derived
      // default — stored as an override (staff can clear it back to the rule).
      if (ex.due_date) setDueDateOverride(ex.due_date);
      if (ex.description) setDescription(ex.description);
      if (ex.category_code) setCategoryCode(ex.category_code);
      // The document is authoritative on VAT: no VAT shown → No VAT, never an
      // assumed 20%. When VAT IS shown, use the document's actual figures —
      // only snap to the 20%-auto mode when the VAT really is 20% of net;
      // otherwise keep all three figures verbatim in Manual mode (recomputing
      // at a forced 20% was mangling correct extractions on non-20% docs).
      setVatTouched(true);
      const gross = ex.amount_gross;
      const vat = ex.amount_vat;
      const net = ex.amount_net;
      if (ex.vat_treatment === 'standard' && vat != null && vat > 0 && net != null && gross != null) {
        const is20 = Math.abs(vat - round2(net * 0.2)) <= 0.02;
        setVatMode(is20 ? 'vat20' : 'manual');
        setAmountGross(gross.toFixed(2));
        setAmountVat(vat.toFixed(2));
        setAmountNet(net.toFixed(2));
      } else if (ex.vat_treatment === 'standard' && gross != null) {
        // VAT-bearing but incomplete figures — derive at 20% from gross.
        setVatMode('vat20');
        setAmountGross(String(gross));
        const derivedNet = round2(gross / 1.2);
        setAmountNet(derivedNet.toFixed(2));
        setAmountVat(round2(gross - derivedNet).toFixed(2));
      } else {
        setVatMode('none');
        const total = gross ?? net;
        if (total != null) {
          setAmountGross(total.toFixed(2));
          setAmountNet(total.toFixed(2));
          setAmountVat('0.00');
        }
      }
      // Job number is a suggestion only — staff confirm before it links.
      setSuggestedJobNumber(ex.job_number ? ex.job_number.replace(/\D/g, '') || null : null);
      // Vehicle reg → hand off to the fleet-match effect (waits for the fleet
      // list to load before matching). Never overrides an existing link.
      if (ex.vehicle_reg && !vehicleId) setPendingVehicleReg(ex.vehicle_reg);
      // Service type → pre-select the matching pill when the AI classified the
      // work (e.g. a tyres-only invoice → "tyre"). Mixed invoices come back as
      // "service"/"other"; staff adjust. Suggestion only.
      if (ex.service_type) setServiceType(ex.service_type);
      // Mileage → pre-fill the service-history mileage field (suggestion only;
      // confirmed before save, and the service endpoint's upward-only ratchet
      // still guards the van's live odometer).
      if (ex.mileage != null) setServiceMileage(String(ex.mileage));
      // Garage is the supplier on a garage invoice — pre-fill if not set.
      if (ex.supplier && !serviceGarage.trim()) setServiceGarage(ex.supplier);
      // A proposed split, only when the document itself itemised — the server
      // has already discarded anything that didn't reconcile to the totals, so
      // whatever arrives here adds up. Marked as AI so it reads as a proposal,
      // and staff correct or delete rows like any other.
      if (ex.lines?.length) {
        setLines(ex.lines.map((l) => ({
          key: newLineKey(),
          description: l.description || '',
          amount_gross: String(l.amount_gross),
          vatRate: inferLineRate(l.amount_gross, l.amount_vat),
          amount_vat: String(l.amount_vat),
          xero_account_code: l.category_code || '',
          crew_fronted: false,
          source: 'ai' as const,
        })));
        setLinesTouched(true);
      }
      setAiPrefilled(true);
      setAiConfidence(ex.confidence);
      setDetailsEditing(false);
      // Not sure of everything: open the amounts so they get checked.
      setAmountsOpen(ex.confidence !== 'high');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 503 from the backend = no API key. Don't make it look like a bug.
      if (msg.includes('not configured')) {
        setExtractError('AI extraction isn\'t enabled on the server yet — fill in the form manually.');
      } else {
        setExtractError(msg);
      }
    } finally {
      setExtracting(false);
    }
  }

  function pickReceipt(file: File | null) {
    setReceiptFile(file);
    setAiPrefilled(false);
    setAiConfidence(null);
    setExtractError('');
    setSuggestedJobNumber(null);
    if (file && !isEdit) void extractReceipt(file);
  }

  const viewExistingReceipt = useCallback(async () => {
    if (!existing?.receipt_r2_key) return;
    try {
      await openR2Key(existing.receipt_r2_key, existing.receipt_filename || undefined);
    } catch { setError('Could not open the saved receipt.'); }
  }, [existing]);

  const viewSupportingDoc = useCallback(async (doc: CostDocument) => {
    try {
      await openR2Key(doc.r2_key, doc.filename);
    } catch { setError(`Could not open ${doc.filename}.`); }
  }, []);

  const totalSupporting = supportingDocs.length + newSupportingFiles.length;
  function addSupporting(picked: File[]) {
    if (picked.length) {
      setNewSupportingFiles((prev) => [...prev, ...picked].slice(0, MAX_SUPPORTING_DOCS - supportingDocs.length));
    }
  }
  // Whether this cost becomes a Xero bill (pay-later) or a spend-money
  // transaction.
  const isBillMethod = BILL_METHODS.includes(paymentMethod);

  // Already in Xero, and the method now points at the OTHER kind of Xero object
  // (Spend Money vs Bill)? Saving doesn't convert one into the other — warn.
  // Legacy rows with no recorded type fall back to the method it was saved with.
  const xeroKind = existing?.xero_object_id
    ? (existing.xero_object_type
      ?? (existing.payment_method && BILL_METHODS.includes(existing.payment_method) ? 'invoice' : 'banktransaction'))
    : null;
  const xeroKindMismatch = xeroKind !== null && (xeroKind === 'invoice') !== isBillMethod;

  const cat = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode);
  // A freelancer invoice gets "Whose invoice?" and their work in the Jobs table (FREELANCER-PORTAL-SPEC §5).
  const isFreelanceCategory = cat?.costType === 'freelancer_invoice' && !isCredit;
  const isVehicleCategory = cat?.costType === 'vehicle';
  const alreadyApproved = existing?.approval_state === 'approved' || existing?.approval_state === 'paid';

  // ── Freelancer work → jobs ─────────────────────────────────────────────────
  const fw = useFreelancerWork(isFreelanceCategory ? flPerson : null, existing?.id ?? null, flShowInvoiced, flTicksTouched,
    (keys, items) => {
      setFlTicked(keys);
      // A figure saved as typed (it isn't the share the booking gives) stays typed.
      const linked = items.filter((it) => keys.includes(it.key));
      const pot = linked.reduce((t, it) => t + Number(it.linkedAmount || 0), 0);
      const even = workAmounts(items, keys, {}, pot);
      const typed: Record<string, string> = {};
      for (const it of linked) {
        if (it.linkedAmount != null && Math.abs(Number(it.linkedAmount) - (even[it.key] ?? 0)) > 0.01) typed[it.key] = Number(it.linkedAmount).toFixed(2);
      }
      setFlTyped(typed);
      workSeedRef.current = { keys, items };
      if (splitStateRef.current === 'loaded') setChoices((prev) => applyWork(prev, items, keys));
    });

  function toggleWork(key: string) {
    const next = flTicked.includes(key) ? flTicked.filter((k) => k !== key) : [...flTicked, key];
    setFlTicked(next);
    setFlTicksTouched(true);
    if (!next.includes(key)) setFlTyped((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setChoices((prev) => applyWork(prev, fw.items, next));
  }

  // Out of the freelancer category: jobs that were only there for ticked work go.
  useEffect(() => {
    if (!isFreelanceCategory) setChoices((prev) => prev.filter((c) => c.manual || c.locked || c.seeded));
  }, [isFreelanceCategory]);

  // ── Cost-lines maths ───────────────────────────────────────────────────────
  // The invoice TOTAL is authoritative and staff-typed; lines only describe how
  // it breaks down, and are refused rather than saved-and-flagged if they don't
  // add up — an unbalanced saved cost is an unflagged problem with no owner.
  //
  // VAT is NOT checked, because it can't disagree: each line states its own rate
  // and the header's VAT is simply their sum. That removes the confusing failure
  // where the amounts balanced but the VAT didn't, and halves the typing.
  const lineNum = (v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const lineVat = (l: LineDraft) => {
    const rate = LINE_VAT_RATES.find((o) => o.v === l.vatRate)?.rate;
    return rate == null ? lineNum(l.amount_vat) : vatWithin(lineNum(l.amount_gross), rate);
  };
  const linesGross = round2(lines.reduce((t, l) => t + lineNum(l.amount_gross), 0));
  const linesVat = round2(lines.reduce((t, l) => t + lineVat(l), 0));
  const headerGross = round2(lineNum(amountGross));
  const grossDiff = round2(linesGross - headerGross);
  const linesBalanced = !lines.length || Math.abs(grossDiff) <= 0.01;
  // With lines, the header's VAT is theirs — shown, not typed. The gross stays
  // staff-entered because it is what we owe; the VAT is only an analysis of it.
  const vatFromLines = lines.length > 0 && vatMode !== 'reclaim';
  const shownVat = vatFromLines ? linesVat.toFixed(2) : amountVat;
  const shownNet = vatFromLines ? round2(headerGross - linesVat).toFixed(2) : amountNet;
  // reclaim_split pushes its own three-line structure to Xero, so it can't also
  // carry lines — the backend rejects the combination outright.
  const linesAvailable = vatMode !== 'reclaim';
  const groups = Array.from(new Set(COST_CATEGORIES.map((c) => c.group)));

  function addLine() {
    setLinesTouched(true);
    // A new line inherits the header's VAT treatment as its starting rate — the
    // header toggle IS the invoice-wide default, so most lines want it.
    const inherited: LineVatRate = vatMode === 'vat20' ? 'vat20' : vatMode === 'manual' ? 'manual' : 'none';
    const blank = () => ({ key: newLineKey(), description: '', amount_gross: '', vatRate: inherited,
      amount_vat: '', xero_account_code: '', crew_fronted: false, source: 'manual' as const });
    setLines((prev) => prev.length
      // First click seeds one line holding the whole invoice, so splitting is
      // "take some off this and put it on the next" rather than typing it twice.
      ? [...prev, blank()]
      : [{ ...blank(), description: description || '', amount_gross: amountGross,
           amount_vat: amountVat, xero_account_code: categoryCode },
         blank()]);
  }
  function patchLine(key: string, patch: Partial<LineDraft>) {
    setLinesTouched(true);
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLinesTouched(true);
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  // ── Jobs: amounts, who pays, how it saves ─────────────────────────────────
  const grossNum = vatMode === 'reclaim' ? round2(num(amountNet) + num(amountVat)) : headerGross;
  const netNum = num(shownNet);
  const netRatio = grossNum > 0 ? Math.min(1, Math.max(0, netNum / grossNum)) : 1;
  const workItems = isFreelanceCategory ? fw.items : [];
  const workTicked = isFreelanceCategory ? flTicked : [];
  const pool = workPool(grossNum, choices, workItems, workTicked);
  const itemAmounts = workAmounts(workItems, workTicked, flTyped, pool);
  const amountByJob = jobAmountsFromWork(workItems, workTicked, itemAmounts);
  const expenses = expensesByJob(workItems, workTicked, itemAmounts, netRatio);
  const jobInfo = useJobInfo(choices.map((c) => c.jobId), existing?.id ?? null);
  const whoPaysOf = (c: JobChoice) => (c.touched ? c.whoPays : defaultWhoPays({
    freelance: isFreelanceCategory, categoryCode,
    rechargesRunningCosts: jobInfo[c.jobId]?.loaded ? jobInfo[c.jobId].rechargesRunningCosts : undefined,
    hasQuotes: jobInfo[c.jobId]?.loaded ? jobInfo[c.jobId].hasQuotes : undefined,
  }));
  // A freelancer's "Charge to client" is what they invoiced over their fee, until someone types a figure.
  const partOf = (c: JobChoice) => {
    if (c.part.trim() !== '') return c.part;
    const over = expenses.get(c.jobId) ?? 0;
    return isFreelanceCategory && over > 0 ? over.toFixed(2) : '';
  };
  const costRechargeOn = Boolean(existing) && (existing?.recharge_mode ?? 'none') !== 'none';
  const costRechargeDone = costRechargeOn && DONE_RECHARGE.has(String(existing?.recharge_status));
  // A recharge on the whole cost that has to stand: done, or on a cost split the
  // old way. Who pays per job is then not ours to send (one or the other, never both).
  const wholeLocked = costRechargeOn && (costRechargeDone || hadSplit);
  const plan = planSplit(grossNum, choices.map((c) => ({ ...c, part: partOf(c) })), amountByJob, wholeLocked, whoPaysOf);
  const jobAmounts = choiceAmounts(grossNum, choices, amountByJob);
  const jobsEditable = !isEdit || splitState === 'loaded';
  const wholeLockedNote = wholeLocked && (hadSplit || choices.length > 1)
    ? `This cost is recharged as a whole${existingRow?.hh_job_number ? ` to job #${existingRow.hh_job_number}` : ''}${costRechargeDone ? ', and that is done' : ''}, so who pays can't be set per job here.${costRechargeDone ? '' : ' Resolve it on the Recharges tab first if it should be per job.'}`
    : null;

  // ── The van, for a vehicle cost on a job ──────────────────────────────────
  // Filled in from the job: the van it had on the cost date (after any swap).
  // One van links itself on a new cost; several are offered.
  const vanJob = plan.jobId ?? choices[0]?.jobId ?? null;
  const vanJobChoice = choices.find((c) => c.jobId === vanJob);
  useEffect(() => {
    if (!isVehicleCategory || !vanJob) { setJobVans(null); return; }
    let cancelled = false;
    const hh = choices.find((c) => c.jobId === vanJob)?.hhJobNumber;
    // Staff allocations carry only the HireHop number until a hire form lands,
    // so ask by both (the dual match).
    Promise.all([
      api.get<{ data: VanRow[] }>(`/assignments?job_id=${vanJob}&limit=100`).catch(() => ({ data: [] as VanRow[] })),
      hh ? api.get<{ data: VanRow[] }>(`/assignments?hirehop_job_id=${hh}&limit=100`).catch(() => ({ data: [] as VanRow[] })) : Promise.resolve({ data: [] as VanRow[] }),
    ]).then(([a, b]) => {
      if (cancelled) return;
      setJobVans({ jobId: vanJob, vans: vansOnDate([...(a.data || []), ...(b.data || [])], costDate) });
    });
    return () => { cancelled = true; };
  }, [isVehicleCategory, vanJob, vanJobChoice?.hhJobNumber, costDate]); // eslint-disable-line react-hooks/exhaustive-deps
  // A van filled in from a job goes if that job is taken off the cost.
  useEffect(() => {
    if (vanFromJob && !choices.some((c) => c.jobId === vanFromJob)) {
      setVehicleId(null); setVanFromJob(null); setLogService(false);
    }
  }, [choices, vanFromJob]);
  useEffect(() => {
    if (isEdit || vehicleId || vanRemoved || !jobVans || jobVans.vans.length !== 1) return;
    setVehicleId(jobVans.vans[0].id);
    setVanFromJob(jobVans.jobId);
    if (SERVICE_HISTORY_CATEGORY_CODES.has(categoryCode)) setLogService(true);
  }, [jobVans, vehicleId, vanRemoved, isEdit, categoryCode]);

  // Service-record creation is offered when a vehicle is linked, the cost has no
  // service record yet, AND the category is a genuine servicing/repair event —
  // at create OR in a later edit (the "van link added after first save" hole,
  // fixed Jun 2026). Fuel/parking/PCN costs keep the reg link but never log to
  // Service History (decoupled Jun 2026 — would clog it instantly).
  const serviceLinkMissing = Boolean(vehicleId)
    && !existing?.vehicle_service_log_id
    && SERVICE_HISTORY_CATEGORY_CODES.has(categoryCode);
  const wantsService = logService && serviceLinkMissing;
  // A vehicle service record can be logged with no cost (e.g. a £0 MOT pass, or
  // a future service that's only "Booked"). When that's the case the cost is
  // optional — we create the service record alone. Create mode only: an edit
  // always has a cost row, so amounts stay required.
  const serviceOnlyEligible = wantsService && !isEdit;
  const noAmount = vatMode === 'reclaim' ? !(Number(amountNet) > 0) : !(Number(amountGross) > 0);
  const serviceOnlySave = serviceOnlyEligible && noAmount;

  // "Yes, use it" adopts the Xero contact AND teaches the matcher, so this
  // letterhead resolves on its own from now on. "No" simply drops the prompt —
  // we never record a negative, because the next receipt from a genuinely
  // similar-but-different supplier deserves the same question.
  async function confirmSupplierAlias(yes: boolean) {
    const sug = supplierSuggestion;
    setSupplierSuggestion(null);
    if (!sug || !yes) return;
    setSupplierName(sug.name);
    setXeroContactId(sug.xero_contact_id);
    try {
      await api.post('/costs/supplier-alias', {
        printed_name: sug.printed,
        xero_contact_id: sug.xero_contact_id,
        xero_name: sug.name,
      });
    } catch {
      // The contact is adopted on this cost either way; only the memory is lost.
    }
  }

  // "What is it?" Refund goes to the refund flow, which picks the purchase it
  // refunds first, so the credit inherits its job, van, category and card.
  function chooseKind(k: Kind) {
    if (k === 'refund') {
      if (onRecordRefund) onRecordRefund(receiptFile);
      else setShowRefund(true);
      return;
    }
    setKind(k);
    if (k === 'bill' && paymentMethod !== 'not_yet_paid') setPaymentMethod('not_yet_paid');
    if (k === 'receipt' && paymentMethod === 'not_yet_paid') setPaymentMethod('cot_card');
  }

  // Closing on an unbalanced split loses the work AND the receipt, so say so
  // rather than letting a stray backdrop click bin it.
  function guardedClose() {
    if (lines.length && !linesBalanced
      && !window.confirm('The lines don’t add up to the invoice total, so nothing will be saved — including the receipt. Close and lose these changes?')) return;
    onClose();
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') guardedClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Rows a freelancer invoiced well over the booking, once their figure is typed.
  const rowsOver = isFreelanceCategory
    ? workItems.filter((it) => workTicked.includes(it.key) && flTyped[it.key]?.trim()
      && rowVerdict(round2((itemAmounts[it.key] ?? 0) * netRatio), it.fee, it.estimate, fw.tolerance).tone === 'over').length
    : 0;
  // A charge on a freelancer's job needs the part to charge (their fee is in the
  // quote); an "Only part?" left open and blank needs a figure or "Charge all of it".
  const chargeWithoutPart = choices.find((c) => !c.locked && !wholeLocked && whoPaysOf(c) === 'charge'
    && (isFreelanceCategory || c.partOpen) && !(num(partOf(c)) > 0) && (jobAmounts.get(c.jobId) ?? 0) > 0);

  async function handleSave(approveOnSave = false, unmatchedAnswer?: string) {
    setError('');
    setUnmatchedAsk(null);
    if (!isEdit && !kind) { setError('Say what you’re adding first: a receipt, a bill or a refund.'); return; }
    if (vatMode === 'reclaim') {
      if (!amountNet || Number(amountNet) <= 0) { setError('Enter the No-VAT (net) amount, e.g. the excess.'); return; }
      if (!amountVat || Number(amountVat) <= 0) { setError('Enter the reclaimable VAT amount.'); return; }
    } else if (!amountGross || Number(amountGross) <= 0) {
      if (!serviceOnlyEligible) { setError('Gross amount is required.'); return; }
    }
    // A cost row needs a category — it's the Xero account code, and the push
    // fails without it. Service-record-only saves (no cost amount) are exempt.
    if (!serviceOnlySave && !categoryCode) {
      setError('Pick a category under "What it’s for": it sets the Xero category, and the push to Xero fails without it.');
      return;
    }
    if (lines.length && !linesAvailable) {
      setError('A VAT-reclaim cost can’t also be split into lines — remove the lines, or switch the VAT handling back.');
      return;
    }
    if (lines.length && !linesBalanced) {
      setError(`The lines add up to £${linesGross.toFixed(2)} but the cost is £${headerGross.toFixed(2)}. Adjust them so they match the invoice.`);
      return;
    }
    // "Split by VAT rate or category" seeds an empty second row to type into.
    // Saving with it still blank is a no-op, not a mistake, so drop it rather
    // than scolding.
    const filledLines = lines.filter((l) => lineNum(l.amount_gross) > 0 || l.description.trim());
    if (filledLines.some((l) => !(lineNum(l.amount_gross) > 0))) {
      setError('Every line needs an amount greater than zero — remove the empty one or fill it in.');
      return;
    }
    const sendJobs = !isCredit && jobsEditable && !serviceOnlySave;
    if (sendJobs) {
      if (plan.over > 0.005) {
        setError(`The jobs add up to ${gbp(plan.onJobs)}, more than the invoice (${gbp(grossNum)}). Take some off a job.`);
        return;
      }
      if (plan.empty.length) {
        setError(`Type ${plan.empty.map(jobLabel).join(', ')}'s share of the invoice, or take ${plan.empty.length === 1 ? 'it' : 'them'} off.`);
        return;
      }
      if (chargeWithoutPart) {
        setError(isFreelanceCategory
          ? `Say how much of ${jobLabel(chargeWithoutPart)} to charge the client. Their fee is already in the quote, so only the extras are charged.`
          : `Say how much of ${jobLabel(chargeWithoutPart)} to charge the client, or choose "Charge all of it".`);
        return;
      }
    }
    // A question for the freelancer is the alternative to approving (jon).
    const wantsQueryChange = isFreelanceCategory && !alreadyApproved && queryNote.trim() !== existingQuery.trim();
    if (approveOnSave && isFreelanceCategory && queryNote.trim()) {
      setError('This has a question for the freelancer. Save it without approving, or clear the question first.');
      return;
    }
    // No work ticked on a freelancer invoice: ask why, then save whatever the
    // answer. Not asked again once answered "not in OP", nor for one already
    // paid (history). Before the work list loads, the list's count stands in.
    if (isFreelanceCategory && !unmatchedAnswer) {
      const hasWork = flTicked.length > 0 || (!flTicksTouched && Number(existing?.work_item_count || 0) > 0);
      const settledWhy = existing?.work_unmatched_reason === 'work_not_in_op'
        || (existing?.work_unmatched_reason === 'person_not_in_op' && !flPerson);
      if (!hasWork && !settledWhy && existing?.payment_status !== 'paid') {
        setUnmatchedAsk({ approve: approveOnSave });
        return;
      }
    }
    setSaving(true);
    try {
      let receiptKey = existing?.receipt_r2_key ?? null;
      let receiptName = existing?.receipt_filename ?? null;
      if (receiptFile) {
        const fd = new FormData();
        fd.append('file', receiptFile);
        fd.append('attachment_only', 'true');
        const up = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
        receiptKey = up.r2_key;
        receiptName = up.filename;
      }

      // Supporting docs: upload the pending files, then send the WHOLE list
      // (already-saved + new). The array is an idempotent replace server-side,
      // so a removal is simply a shorter list.
      let allSupporting = supportingDocs;
      if (newSupportingFiles.length) {
        const uploaded = await Promise.all(newSupportingFiles.map(async (file) => {
          const dfd = new FormData();
          dfd.append('file', file);
          dfd.append('attachment_only', 'true');
          const up = await api.upload<{ r2_key: string; filename: string }>('/files/upload', dfd);
          return {
            r2_key: up.r2_key,
            filename: up.filename,
            content_type: file.type || null,
            size_bytes: file.size,
            uploaded_at: new Date().toISOString(),
          } as CostDocument;
        }));
        allSupporting = [...supportingDocs, ...uploaded];
      }
      // cot_card_holder + cot_card_last4 are stamped server-side from the
      // uploader's user record — staff don't enter them on the modal.

      // Builds the vehicle_service_log payload. Reused by the service-only path
      // and the cost+service path. costless = no cost row to attach to.
      const serviceLogBody = (costless: boolean) => ({
        name: description.trim() || cat?.label || (costless ? 'Vehicle service' : 'Vehicle cost'),
        service_type: serviceType,
        service_date: costDate || null,
        mileage: serviceMileage ? Number(serviceMileage) : null,
        cost: costless ? null : amountNet ? Number(amountNet) : amountGross ? Number(amountGross) : null,
        status: serviceStatus,
        garage: serviceGarage.trim() || supplierName || null,
        notes: notes || null,
        next_due_date: serviceNextDueDate || null,
        next_due_mileage: serviceNextDueMileage ? Number(serviceNextDueMileage) : null,
        apply_to_vehicle: applyToVehicle,
        files: receiptKey ? [{ name: receiptName || 'Receipt', url: receiptKey, type: receiptFile?.type || '', size: receiptFile?.size || 0 }] : [],
      });

      // Service-only: no cost amount entered → create just the service record.
      if (serviceOnlySave) {
        await api.post(`/vehicles/fleet/${vehicleId}/service-log`, serviceLogBody(true));
        onSaved(null);
        return;
      }

      const payload: Record<string, unknown> = {
        supplier_name: supplierName || null,
        xero_contact_id: xeroContactId,
        cost_date: costDate || null,
        amount_gross: amountGross ? Number(amountGross) : null,
        amount_vat: amountVat ? Number(amountVat) : null,
        amount_net: amountNet ? Number(amountNet) : null,
        vat_treatment: vatMode === 'reclaim' ? 'reclaim_split' : 'standard',
        invoice_number: invoiceNumber.trim() || null,
        // Blank = follow the derived rule; a value always wins (and marks the
        // Xero bill stale so it can be re-synced).
        due_date_override: dueDateOverride || null,
        description: description || null,
        category: cat?.label || null,
        xero_account_code: cat?.xeroCode || null,
        cost_type: cat?.costType || 'overhead',
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
        supporting_documents: allSupporting,
        notes: notes || null,
        vehicle_id: vehicleId || null,
      };

      // The jobs and who pays, from the Jobs table (costs/costJobs.ts planSplit):
      // one job holding the whole cost saves on the cost, as it always did;
      // anything else is a split whose shares each carry who pays (migration
      // 318), in the SAME request so a half-saved cost can't happen. Left out
      // entirely for a refund (it inherits its purchase's job and never
      // recharges) and for an edit whose split couldn't be read.
      if (sendJobs) {
        payload.job_id = plan.jobId;
        if (plan.costLevel) {
          payload.cost_intent = plan.costLevel.cost_intent;
          payload.recharge_mode = plan.costLevel.recharge_mode;
          payload.recharge_amount = plan.costLevel.recharge_amount;
        }
        if (isEdit || plan.shares.length) payload.allocations = plan.shares;
      }

      // Whose invoice and which work (FREELANCER-PORTAL-SPEC §5). The ticks are
      // sent once touched, each with its share of the invoice; moving a cost OUT
      // of the freelancer category drops both.
      if (isFreelanceCategory) {
        payload.person_id = flPerson?.id ?? null;
        // Why no work is ticked (cleared server-side once some is).
        if (unmatchedAnswer) payload.work_unmatched_reason = unmatchedAnswer;
        // Re-sent whenever any are ticked, so an edited total re-shares them.
        if (flTicksTouched || flTicked.length > 0) {
          payload.work_items = workItems.filter((it) => flTicked.includes(it.key))
            .map((it) => ({ key: it.key, amount: itemAmounts[it.key] ?? 0 }));
        }
      } else if (existing?.person_id || existing?.work_unmatched_reason) {
        payload.person_id = null;
        payload.work_items = [];
        payload.work_unmatched_reason = null;
      }

      // Lines ride in the SAME request as the header — the backend writes them
      // before it fires the Xero push, so the bill is built from them. A
      // separate call would race that push onto a one-line bill. Only sent once
      // the user has actually touched them, so a failed load can't wipe a split.
      if (linesTouched) {
        if (filledLines.length) {
          payload.amount_vat = round2(filledLines.reduce((t, l) => t + lineVat(l), 0));
          payload.amount_net = round2(headerGross - (payload.amount_vat as number));
        }
        payload.lines = filledLines.map((l) => ({
          description: l.description.trim() || null,
          amount_gross: lineNum(l.amount_gross),
          // The rate is a UI convenience; what's stored (and pushed to Xero) is
          // the money. The server re-derives the header's VAT from these.
          amount_vat: lineVat(l),
          xero_account_code: l.xero_account_code || null,
          crew_fronted: l.crew_fronted,
          source: l.source,
        }));
      }
      if (!isEdit) {
        payload.job_issue_id = presetIssueId || null;
        payload.status = 'confirmed';
        // One-click "Approve & send to Xero" — backend honours it only for a
        // payable + an approver (manager tier), and fires the bill push on approval.
        if (approveOnSave) payload.approve = true;
      }

      const res = isEdit
        ? await api.patch<{ data: Cost }>(`/costs/${existing!.id}`, payload)
        : await api.post<{ data: Cost }>('/costs', payload);

      // Forward unification: optionally create a vehicle service-history record
      // and link it back to the cost. Fires on create, or on edit when no
      // service record is linked yet. Non-fatal if it fails (the cost is
      // already saved — we surface a warning rather than lose it).
      if (wantsService && vehicleId) {
        try {
          const sl = await api.post<{ id: string }>(`/vehicles/fleet/${vehicleId}/service-log`, serviceLogBody(false));
          await api.patch(`/costs/${res.data.id}`, { vehicle_service_log_id: sl.id });
        } catch (slErr) {
          console.error('[cost] service-log link failed:', slErr);
          setError('Cost saved, but adding it to the vehicle service history failed — add it manually from the vehicle page.');
          setSaving(false);
          return;
        }
      }
      // The question for the freelancer, if it changed. After the save, never
      // instead of it: a refusal here must not lose the cost (and a retry from
      // an open create form would capture it twice), so it is reported, not thrown.
      let saved = res.data;
      if (wantsQueryChange && saved) {
        try {
          const q = queryNote.trim()
            ? await api.post<{ data: Cost }>(`/costs/${saved.id}/query`, { note: queryNote.trim() })
            : await api.delete<{ data: Cost }>(`/costs/${saved.id}/query`);
          saved = { ...saved, ...q.data };
        } catch (qErr) {
          alert(`Saved, but the question for the freelancer wasn't recorded: ${qErr instanceof Error ? qErr.message : 'unknown error'}`);
        }
      }
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cost');
    } finally {
      setSaving(false);
    }
  }

  // ── What the footer says will happen ──────────────────────────────────────
  const recharged = isCredit || wholeLocked ? 0 : round2(plan.kind === 'none' ? 0 : choices.reduce((t, c) => {
    if (c.locked || whoPaysOf(c) !== 'charge') return t;
    const share = jobAmounts.get(c.jobId) ?? 0;
    if (!(share > 0)) return t;
    const part = num(partOf(c));
    return t + (part > 0 ? part : share * netRatio);
  }, 0));
  const personName = flPerson?.name?.split(' ')[0] || 'them';
  const summaryBits: string[] = [];
  if (grossNum > 0) {
    summaryBits.push(isCredit ? `${gbp(grossNum)} back`
      : plan.kind === 'none' ? `${gbp(grossNum)} to overheads`
      : plan.kind === 'whole' ? `${gbp(grossNum)} → ${choices.find((c) => c.jobId === plan.jobId)?.hhJobNumber ? `#${choices.find((c) => c.jobId === plan.jobId)?.hhJobNumber}` : 'the job'}`
      : `${gbp(grossNum)} across ${plan.shares.length} job${plan.shares.length === 1 ? '' : 's'}`);
  }
  if (recharged > 0) summaryBits.push(`${gbp(recharged)} to charge the client (+ markup and VAT)`);
  if (isFreelanceCategory && queryNote.trim()) summaryBits.push(`1 question to ${personName}`);
  if (!isCredit && kind === 'receipt' && paymentMethod !== 'reimburse_me') summaryBits.push(`paid on ${METHOD_LABEL[paymentMethod] || paymentMethod}`);
  if (!isCredit && paymentMethod === 'reimburse_me') summaryBits.push('paid with my own money, to reimburse');
  if (!isCredit && kind === 'bill') {
    const due = dueDateOverride || derivedDueDate;
    summaryBits.push(paymentStatus === 'awaiting_invoice' ? 'awaiting the invoice' : due ? `bill due ${fmtDate(due)}` : 'bill to pay');
  }
  if (selectedVehicle) summaryBits.push(`van ${selectedVehicle.reg}`);
  const topWarning = !jobsEditable || isCredit ? null
    : plan.over > 0.005 ? { tone: 'red', text: `The jobs add up to more than the invoice by ${gbp(plan.over)}.` }
    : plan.empty.length ? { tone: 'amber', text: `Type ${jobLabel(plan.empty[0])}'s share, or take it off.` }
    : chargeWithoutPart ? { tone: 'amber', text: `Say how much of ${jobLabel(chargeWithoutPart)} to charge the client.` }
    : rowsOver ? { tone: 'amber', text: `${rowsOver} row${rowsOver === 1 ? '' : 's'} invoiced well over the booking. Ask ${personName} about it, or save as it is.` }
    : duplicates.length ? { tone: 'amber', text: 'Looks like this was already added. Check before saving.' }
    : null;

  const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500';
  const leftPaneStyle: React.CSSProperties = isDesktop ? { width: `${leftPct}%` } : {};
  const editingDetails = detailsEditing || (!isEdit && !aiPrefilled);
  const amountsShown = amountsOpen || editingDetails;
  const showForm = isEdit || kind !== null;
  const futureDate = costDate && costDate > ukDatePlus(7);
  const staleDate = costDate && costDate < ukDatePlus(-STALE_COST_DAYS);
  const dueShown = dueDateOverride || derivedDueDate || '';
  const isLegacyMethod = LEGACY_METHODS.some((m) => m.value === paymentMethod);
  const canApprove = !isEdit && paymentStatus !== 'paid' && hasManagerRole(user?.role) && !(isFreelanceCategory && queryNote.trim());
  const sectionHead = (t: string) => (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100 pb-1">{t}</h3>
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-stretch sm:items-start justify-center z-50 sm:overflow-y-auto sm:p-4" onClick={guardedClose}>
      <div className="bg-white shadow-xl w-full max-h-screen sm:max-w-5xl sm:my-4 sm:rounded-lg sm:max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{isEdit ? (isCredit ? 'Edit refund' : 'Edit cost') : 'Capture cost'}</h2>
          <button onClick={guardedClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Close">&times;</button>
        </div>

        <div ref={containerRef} className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          {/* LEFT: the document — single scroll: a non-scrolling header over a
              flex-fill preview area (the PDF/image scrolls inside that area). */}
          <div className="px-6 py-4 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col md:min-h-0 bg-gray-50/60" style={leftPaneStyle}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs text-gray-500 truncate">
                {receiptFile ? receiptFile.name : existing?.receipt_filename || 'The receipt or invoice'}
              </span>
              {/* A labelled button, not a bare file input: the input is cleared
                  after each pick so the same file can be chosen again. */}
              <label className="shrink-0 text-xs font-medium text-purple-700 hover:underline cursor-pointer">
                {receiptFile || existing?.receipt_filename ? 'Replace' : 'Choose a file'}
                <input type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; pickReceipt(f); }} />
              </label>
            </div>
            {extracting && (
              <div className="mb-2 px-3 py-2 text-xs rounded-md border border-purple-200 bg-purple-50 text-purple-800">✨ Reading the document…</div>
            )}
            {extractError && (
              <div className="mb-2 px-3 py-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-md">
                {extractError}{' '}
                {receiptFile && <button type="button" className="underline" onClick={() => extractReceipt(receiptFile)}>Try again</button>}
              </div>
            )}
            {vehicleRegNote?.matched && (
              <div className="mb-2 px-3 py-2 text-xs rounded-md border border-purple-200 bg-purple-50 text-purple-800">
                🚐 Linked <strong>{vehicleRegNote.reg}</strong> from the receipt — check it&apos;s the right van before saving.
              </div>
            )}
            {vehicleRegNote && !vehicleRegNote.matched && (
              <div className="mb-2 px-3 py-2 text-xs rounded-md border border-amber-200 bg-amber-50 text-amber-800">
                🚐 Receipt shows reg <strong>{vehicleRegNote.reg}</strong> — not in the active fleet. Link a van under &quot;What it&apos;s for&quot; if needed.
              </div>
            )}
            <div className="mt-1 md:flex-1 md:min-h-0 md:overflow-auto">
              {receiptPreview && !receiptIsPdf && (
                <img src={receiptPreview} alt="Receipt preview" onClick={() => window.open(receiptPreview, '_blank')}
                  className="w-full max-h-[50vh] md:max-h-none md:h-full object-contain rounded border border-gray-200 cursor-zoom-in bg-white" />
              )}
              {receiptPreview && receiptIsPdf && (
                <embed src={receiptPreview} type="application/pdf" className="w-full h-[50vh] md:h-full rounded border border-gray-200" />
              )}
              {!receiptFile && existing?.receipt_filename && (
                <div className="text-sm text-gray-600 flex items-center gap-2">
                  <span>📄 {existing.receipt_filename}</span>
                  <button type="button" onClick={viewExistingReceipt} className="text-purple-700 hover:underline">View</button>
                </div>
              )}
              {!receiptFile && !existing?.receipt_filename && (
                <label className="block rounded-md border-2 border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 cursor-pointer hover:border-purple-300">
                  Choose the receipt or invoice{!isEdit ? ': the AI reads it and fills in the form' : ''}.
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; pickReceipt(f); }} />
                </label>
              )}
            </div>

            {/* Supporting documents. Everything filed here rides to Xero on the
                same bill, so the evidence sits with the payable. Several at once,
                picked or dropped. */}
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="flex items-baseline justify-between mb-1 gap-2">
                <span className="text-sm font-medium text-gray-700">Supporting documents</span>
                <span className="text-xs text-gray-400">Evidence only, not read by the AI</span>
              </div>
              {supportingDocs.map((doc, i) => (
                <div key={`${doc.r2_key}-${i}`} className="flex items-center gap-2 text-sm text-gray-700 py-1">
                  <span className="truncate">📄 {doc.filename}</span>
                  <button type="button" onClick={() => viewSupportingDoc(doc)}
                    className="text-purple-700 hover:underline text-xs shrink-0">View</button>
                  <button type="button" title="Remove"
                    onClick={() => setSupportingDocs((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-auto text-gray-400 hover:text-red-600 shrink-0">&times;</button>
                </div>
              ))}
              {newSupportingFiles.map((file, i) => (
                <div key={`new-${file.name}-${i}`} className="flex items-center gap-2 text-sm text-gray-700 py-1">
                  <span className="truncate">📄 {file.name}</span>
                  <span className="text-xs text-gray-400 shrink-0">not saved yet</span>
                  <button type="button" title="Remove"
                    onClick={() => setNewSupportingFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-auto text-gray-400 hover:text-red-600 shrink-0">&times;</button>
                </div>
              ))}
              {totalSupporting < MAX_SUPPORTING_DOCS ? (
                <label
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); addSupporting(Array.from(e.dataTransfer.files || [])); }}
                  className={`mt-1 block rounded-md border border-dashed px-3 py-3 text-center text-sm cursor-pointer ${
                    dragOver ? 'border-purple-400 bg-purple-50 text-purple-800' : 'border-gray-300 bg-white text-purple-700 hover:bg-purple-50'}`}>
                  + Add supporting documents
                  <span className="block text-[11px] text-gray-400">
                    A fuel receipt, a delivery note. Up to {MAX_SUPPORTING_DOCS}; they all go to Xero with the {isBillMethod ? 'bill' : 'transaction'}.
                  </span>
                  <input type="file" multiple accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => {
                      // Capture the list BEFORE clearing the input — reading
                      // e.target.files inside the deferred updater finds it
                      // already emptied.
                      const picked = Array.from(e.target.files || []);
                      e.target.value = '';
                      addSupporting(picked);
                    }} />
                </label>
              ) : (
                <p className="text-xs text-amber-700 mt-2">
                  That&apos;s the maximum Xero accepts on one {isBillMethod ? 'bill' : 'transaction'}.
                </p>
              )}
            </div>
          </div>

          {/* Draggable divider (md+ only) */}
          {isDesktop && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              onMouseDown={(e) => { e.preventDefault(); draggingRef.current = true; document.body.style.userSelect = 'none'; }}
              className="hidden md:block w-1 bg-gray-200 hover:bg-purple-400 cursor-col-resize transition-colors"
            />
          )}

          {/* RIGHT: the form */}
          <div className="flex-1 px-6 py-4 space-y-5 md:overflow-y-auto">
            {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}

            {/* 1. What is it? */}
            <div>
              <div className="mb-1.5">{sectionHead('What is it?')}</div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { k: 'receipt' as Kind, label: 'Receipt', sub: 'Already paid' },
                  { k: 'bill' as Kind, label: 'Bill', sub: 'To be paid' },
                  { k: 'refund' as Kind, label: 'Refund', sub: 'Money back to us' },
                ]).filter((o) => (isCredit ? o.k === 'refund' : !(isEdit && o.k === 'refund'))).map((o) => (
                  <button key={o.k} type="button" disabled={isCredit} onClick={() => chooseKind(o.k)}
                    className={`text-left px-3 py-2 rounded-md border text-sm ${
                      kind === o.k ? 'border-purple-500 bg-purple-50 ring-1 ring-purple-500' : 'border-gray-300 hover:bg-gray-50'
                    } disabled:cursor-default`}>
                    <div className="font-medium text-gray-800">{o.label}</div>
                    <div className="text-xs text-gray-500">{o.sub}</div>
                  </button>
                ))}
              </div>
              {!showForm && (
                <p className="text-xs text-gray-500 mt-2">
                  Pick one to carry on. {receiptFile ? 'The AI is reading the document meanwhile.' : 'Choose the document on the left and the AI fills in the rest.'}
                </p>
              )}
              {isCredit && (
                <p className="text-xs text-gray-500 mt-2">
                  Money back from the supplier, recorded against the purchase it refunds. It keeps that purchase&apos;s job, van and category, and is never charged to a client.
                </p>
              )}
            </div>

            {showForm && (
              <>
                {/* 2. From the document */}
                <div className="rounded-lg border border-gray-200 px-4 py-3 space-y-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">From the document</span>
                    {editingDetails
                      ? (aiPrefilled || isEdit) && <button type="button" className="text-xs text-purple-700 hover:underline" onClick={() => setDetailsEditing(false)}>Done</button>
                      : <button type="button" className="text-xs text-purple-700 hover:underline" onClick={() => setDetailsEditing(true)}>Edit details</button>}
                  </div>
                  {aiPrefilled && aiConfidence && aiConfidence !== 'high' && (
                    <p className={`text-xs rounded px-2 py-1.5 ${aiConfidence === 'medium' ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-800'}`}>
                      The AI wasn&apos;t sure of everything on this one ({aiConfidence} confidence). Check the details and amounts against the document.
                    </p>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                    <div className="relative">
                      <div className="text-xs text-gray-500 mb-0.5">Supplier</div>
                      {editingDetails ? (
                        <input className={inputCls} value={supplierName}
                          onChange={(e) => { setSupplierName(e.target.value); setXeroContactId(null); setSupplierSuggestion(null); }}
                          onFocus={() => setSupplierFocused(true)}
                          onBlur={() => setTimeout(() => setSupplierFocused(false), 150)}
                          placeholder="e.g. TTS360, Shell" autoComplete="off" />
                      ) : (
                        <div className="text-sm font-medium text-gray-900">{supplierName || '—'}</div>
                      )}
                      {xeroContactId && !supplierSuggestion && <div className="text-xs text-emerald-700 mt-0.5">Matched to its Xero contact ✓</div>}
                      {supplierSuggestion && supplierSuggestion.name !== supplierName && (
                        <p className="text-xs text-amber-700 mt-1 rounded bg-amber-50 px-2 py-1">
                          Xero already has <strong>{supplierSuggestion.name}</strong> — is that the same supplier?{' '}
                          <button type="button" onClick={() => confirmSupplierAlias(true)}
                            className="underline hover:no-underline font-medium">Yes, use it</button>
                          {' · '}
                          <button type="button" onClick={() => confirmSupplierAlias(false)}
                            className="underline hover:no-underline">No, it&apos;s different</button>
                          <span className="block text-gray-400">
                            Saying yes is remembered, so “{supplierSuggestion.printed}” maps straight through next time.
                          </span>
                        </p>
                      )}
                      {supplierFocused && editingDetails && supplierSuggestions.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                          {supplierSuggestions.map((s) => (
                            <button key={s.ContactID} type="button"
                              onMouseDown={(e) => { e.preventDefault(); setSupplierName(s.Name); setXeroContactId(s.ContactID); setSupplierSuggestions([]); }}
                              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
                              {s.Name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Date</div>
                      {editingDetails
                        ? <input type="date" className={inputCls} value={costDate} onChange={(e) => setCostDate(e.target.value)} />
                        : <div className={`text-sm font-medium ${futureDate || staleDate ? 'text-amber-700' : 'text-gray-900'}`}>{fmtDate(costDate) || '—'}</div>}
                      {futureDate && (
                        <p className="text-xs text-amber-600 mt-1">⚠️ This date is in the future — is that right? Receipt dates are usually today or earlier (UK day/month).</p>
                      )}
                      {/* The mirror image: a date too far in the PAST. Nearly always a
                          misread year rather than a genuinely old receipt, so offer the
                          same day and month in the most recent year — but never apply it
                          on our own. A historic invoice does get captured occasionally,
                          and silently moving its date would be worse than the misread. */}
                      {staleDate && (
                        <p className="text-xs text-amber-600 mt-1">
                          ⚠️ That&apos;s over {Math.round(STALE_COST_DAYS / 30)} months ago — are we really capturing a receipt from {fmtDate(costDate)}?
                          {mostRecentSameDayMonth(costDate) && (
                            <>{' '}
                              <button type="button" onClick={() => setCostDate(mostRecentSameDayMonth(costDate) as string)}
                                className="underline hover:no-underline font-medium">
                                Use {fmtDate(mostRecentSameDayMonth(costDate) as string)} instead
                              </button>
                            </>
                          )}
                        </p>
                      )}
                    </div>

                    {isFreelanceCategory && (
                      <div className="sm:col-span-2">
                        <FreelancerPersonPicker
                          costId={existing?.id ?? null}
                          supplierName={supplierName}
                          person={flPerson}
                          personTouched={flPersonTouched}
                          onPersonChange={(p, byUser) => {
                            setFlPerson(p);
                            if (byUser) {
                              setFlPersonTouched(true);
                              // Someone else's invoice: none of the ticked work is theirs.
                              setFlTicked([]); setFlTicksTouched(true); setFlTyped({});
                              setChoices((prev) => applyWork(prev, [], []));
                            }
                          }}
                        />
                      </div>
                    )}

                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Invoice / ref <span className="text-gray-400">(optional)</span></div>
                      {editingDetails
                        ? <input className={inputCls} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="e.g. INV-10472 (blank for till receipts)" />
                        : <div className="text-sm font-medium text-gray-900">{invoiceNumber || '—'}</div>}
                      {invoiceDup && (
                        <p className="text-xs text-red-600 font-medium mt-1">
                          ⚠ Already captured: a cost with this invoice number{supplierName.trim() ? ` for ${supplierName.trim()}` : ''} exists
                          {invoiceDup.amount_gross != null ? ` (£${Number(invoiceDup.amount_gross).toFixed(2)}` : ''}{invoiceDup.cost_date ? `, ${new Date(invoiceDup.cost_date).toLocaleDateString('en-GB')}` : ''}{invoiceDup.amount_gross != null ? ', ' + invoiceDup.payment_status.replace(/_/g, ' ') + ')' : ''}. Check you&apos;re not submitting it twice.
                        </p>
                      )}
                    </div>
                    {/* Due date only exists for a pay-later bill (a paid-now cost
                        owes nothing). Its default is derived from the supplier's
                        terms AND the cost type, so it fills itself in once the
                        category is picked. */}
                    {isBillMethod && !isCredit && (
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5">Pay by</div>
                        {editingDetails ? (
                          <input type="date" className={inputCls} value={dueShown} onChange={(e) => setDueDateOverride(e.target.value)} />
                        ) : (
                          <div className="text-sm font-medium text-gray-900">{fmtDate(dueShown) || '—'}</div>
                        )}
                        {dueDateOverride ? (
                          <p className="text-xs text-amber-600 mt-1">
                            From the invoice{derivedDueDate ? <> (terms say <strong>{fmtDate(derivedDueDate)}</strong>)</> : null}.{' '}
                            <button type="button" onClick={() => setDueDateOverride('')} className="underline hover:no-underline">
                              Use the terms
                            </button>
                          </p>
                        ) : derivedDueDate ? (
                          <p className="text-xs text-gray-400 mt-1">{derivedDueTermsLabel}</p>
                        ) : (
                          <p className="text-xs text-gray-400 mt-1">Set a date to work the due date out from the supplier&apos;s terms.</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* The amounts, on one line. "Change amounts / VAT" opens the VAT
                      modes and the inputs in place, and the lines behind them. */}
                  <div className="border-t border-gray-100 pt-3">
                    <div className="flex items-end gap-x-6 gap-y-2 flex-wrap">
                      {vatMode === 'reclaim' ? (
                        <>
                          <div><div className="text-xs text-gray-500">Net, no VAT</div><div className="text-base font-semibold text-gray-900 tabular-nums">{amountNet ? gbp(num(amountNet)) : '—'}</div></div>
                          <div><div className="text-xs text-gray-500">VAT to reclaim</div><div className="text-base text-gray-700 tabular-nums">{amountVat ? gbp(num(amountVat)) : '—'}</div></div>
                          <div><div className="text-xs text-gray-500">Total</div><div className="text-base text-gray-700 tabular-nums">{gbp(grossNum)}</div></div>
                        </>
                      ) : (
                        <>
                          <div><div className="text-xs text-gray-500">Gross</div><div className="text-base font-semibold text-gray-900 tabular-nums">{amountGross ? gbp(headerGross) : '—'}</div></div>
                          <div><div className="text-xs text-gray-500">VAT</div><div className="text-base text-gray-700 tabular-nums">{shownVat !== '' ? gbp(num(shownVat)) : '—'}</div></div>
                          <div><div className="text-xs text-gray-500">Net</div><div className="text-base text-gray-700 tabular-nums">{shownNet !== '' ? gbp(num(shownNet)) : '—'}</div></div>
                        </>
                      )}
                      <div><div className="text-xs text-gray-500">Rate</div><div className="text-base font-semibold text-purple-700">{vatFromLines ? 'From the lines' : VAT_MODE_LABEL[vatMode]}</div></div>
                      {!editingDetails && (
                        <button type="button" className="ml-auto text-xs text-purple-700 hover:underline" onClick={() => setAmountsOpen(!amountsOpen)}>
                          {amountsOpen ? 'Done' : 'Change amounts / VAT'}
                        </button>
                      )}
                    </div>
                    {!amountsShown && lines.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1.5">
                        {lines.some((l) => l.source === 'ai') ? 'Read as' : 'Split into'} {lines.length} parts (different VAT rates or categories).{' '}
                        <button type="button" className="text-purple-700 hover:underline" onClick={() => setAmountsOpen(true)}>Edit</button>
                      </p>
                    )}

                    {amountsShown && (
                      <div className="mt-3 space-y-3">
                        {vatFromLines ? (
                          <p className="text-xs text-gray-500">VAT comes from the lines below.</p>
                        ) : (
                          <div className="inline-flex rounded-md bg-gray-100 p-0.5 text-xs">
                            {(['vat20', 'none', 'manual', 'reclaim'] as VatMode[]).map((v) => (
                              <button key={v} type="button" onClick={() => applyVatMode(v)}
                                className={`px-2.5 py-1 rounded ${vatMode === v ? 'bg-purple-600 text-white font-medium' : 'text-gray-700 hover:bg-white'}`}>
                                {VAT_MODE_LABEL[v]}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">{vatMode === 'reclaim' ? 'Net — No VAT (£) *' : `Gross (£)${serviceOnlyEligible ? '' : ' *'}`}</label>
                            {vatMode === 'reclaim' ? (
                              <input type="number" step="0.01" min="0" className={inputCls} value={amountNet} onChange={(e) => onNetChange(e.target.value)} placeholder="e.g. 750.00 (excess)" />
                            ) : (
                              <input type="number" step="0.01" min="0" className={inputCls} value={amountGross} onChange={(e) => onGrossChange(e.target.value)} placeholder={serviceOnlyEligible ? 'Leave blank if no cost' : undefined} />
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">{vatMode === 'reclaim' ? 'Reclaimable VAT (£) *' : 'VAT (£)'}</label>
                            <input type="number" step="0.01" min="0"
                              className={`${inputCls} ${vatFromLines || (vatMode !== 'manual' && vatMode !== 'reclaim') ? 'bg-gray-100' : ''}`}
                              value={shownVat} onChange={(e) => onVatChange(e.target.value)}
                              disabled={vatFromLines || (vatMode !== 'manual' && vatMode !== 'reclaim')}
                              placeholder={vatMode === 'reclaim' ? 'e.g. 702.68' : undefined} />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">{vatMode === 'reclaim' ? 'Total (£)' : 'Net (£)'}</label>
                            {vatMode === 'reclaim' ? (
                              <input type="number" className={`${inputCls} bg-gray-100`} value={amountGross} disabled />
                            ) : (
                              <input type="number" step="0.01" min="0" className={`${inputCls} ${vatFromLines || vatMode === 'none' ? 'bg-gray-100' : ''}`}
                                value={shownNet} onChange={(e) => onNetChange(e.target.value)} disabled={vatFromLines || vatMode === 'none'} />
                            )}
                          </div>
                        </div>
                        {vatFromLines && <p className="text-xs text-gray-400">The total is what we owe and stays yours to set. VAT and net are the sum of the lines below.</p>}
                        {!vatFromLines && vatMode === 'vat20' && <p className="text-xs text-gray-400">20% VAT — enter gross or net, the other two fill in.</p>}
                        {!vatFromLines && vatMode === 'none' && <p className="text-xs text-gray-400">No VAT (e.g. a non-VAT-registered freelancer) — gross = net, no VAT reclaimed.</p>}
                        {!vatFromLines && vatMode === 'manual' && <p className="text-xs text-gray-400">Manual — enter all three figures exactly as shown on the receipt.</p>}
                        {vatMode === 'reclaim' && <p className="text-xs text-amber-600">Insurance-claim / VAT-only invoice: enter the No-VAT amount (the excess) + the reclaimable VAT. Pushed to Xero as a 3-line VAT-only entry (net @ No VAT, VAT base @ 20%, adjustment), so exactly £{amountVat || '0.00'} VAT is reclaimed.</p>}

                        {/* Cost lines. One invoice often covers several things — a
                            freelancer bills £325 that is really £250 of fee, £60 of
                            fuel and £15 of train. Without lines whichever category is
                            picked makes the rest quietly wrong, in the job's cost
                            buckets AND in the VAT (a header rate is a blend of what's
                            underneath it, and a blend is never a real rate). Lines
                            each carry their own category and VAT. The header stays
                            the invoice; lines just say how it breaks down. Which JOB
                            it lands on is the Jobs table, not lines. */}
                        {!isCredit && (linesAvailable || lines.length > 0) && (
                          lines.length === 0 ? (
                            <button type="button" onClick={addLine}
                              className="text-xs font-medium text-purple-700 hover:underline">
                              ＋ Split by VAT rate or category
                              <span className="font-normal text-gray-400"> (different rates or categories on one invoice)</span>
                            </button>
                          ) : (
                            <div className="border border-gray-200 rounded-md p-3 bg-gray-50">
                              {!linesAvailable && (
                                <p className="text-xs text-red-600 font-medium mb-2">
                                  A VAT-reclaim cost pushes its own three-line structure to Xero, so it can’t also be
                                  split into lines. Remove these lines, or switch the VAT handling back.
                                </p>
                              )}
                              <div className="flex items-baseline justify-between mb-2 gap-2 flex-wrap">
                                <span className="text-sm font-medium text-gray-700">
                                  Lines on this invoice <span className="font-normal text-gray-400">(amounts inc. VAT)</span>
                                  {lines.some((l) => l.source === 'ai') && (
                                    <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium bg-purple-50 text-purple-700 rounded align-middle"
                                      title="Read off the invoice by the AI — check it before saving">
                                      ✨ from receipt
                                    </span>
                                  )}
                                </span>
                                <span className={`text-xs ${linesBalanced ? 'text-gray-500' : 'text-red-600 font-medium'}`}>
                                  {gbp(linesGross)} of {gbp(headerGross)}
                                  {linesVat > 0 && <span className="text-gray-400"> · VAT {gbp(linesVat)}</span>}
                                </span>
                              </div>

                              <div className="space-y-2">
                                {lines.map((l, i) => (
                                  /* Two rows per line, not one: the form pane is only ~500px
                                     beside the receipt, and six controls in a single row there
                                     is unreadable. Description on top, the money underneath. */
                                  <div key={l.key} className="rounded border border-gray-200 bg-white p-2 space-y-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] text-gray-400 w-4 shrink-0">{i + 1}</span>
                                      <input
                                        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm"
                                        placeholder="What was this part of the invoice for?"
                                        value={l.description}
                                        onChange={(e) => patchLine(l.key, { description: e.target.value })}
                                      />
                                      <button type="button" onClick={() => removeLine(l.key)} title="Remove this line"
                                        className="px-1.5 text-sm text-gray-400 hover:text-red-600 shrink-0">✕</button>
                                    </div>
                                    <div className="flex items-center gap-2 pl-6 flex-wrap">
                                      <input
                                        type="number" step="0.01" inputMode="decimal"
                                        className="w-24 border border-gray-300 rounded px-2 py-1.5 text-sm text-right"
                                        placeholder="0.00" value={l.amount_gross}
                                        title="The amount on the invoice for this line, including any VAT"
                                        onChange={(e) => patchLine(l.key, { amount_gross: e.target.value })}
                                      />
                                      <select
                                        className="border border-gray-300 rounded px-1.5 py-1.5 text-sm"
                                        value={l.vatRate} title="How much of that amount is VAT"
                                        onChange={(e) => patchLine(l.key, { vatRate: e.target.value as LineVatRate })}
                                      >
                                        {LINE_VAT_RATES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                                      </select>
                                      {l.vatRate === 'manual' ? (
                                        <input
                                          type="number" step="0.01" inputMode="decimal"
                                          className="w-20 border border-gray-300 rounded px-2 py-1.5 text-sm text-right"
                                          placeholder="VAT" value={l.amount_vat}
                                          onChange={(e) => patchLine(l.key, { amount_vat: e.target.value })}
                                        />
                                      ) : (
                                        <span className="text-xs text-gray-400 w-20">
                                          {lineVat(l) > 0 ? `incl. ${gbp(lineVat(l))}` : 'no VAT'}
                                        </span>
                                      )}
                                      <select
                                        className="flex-1 min-w-[9rem] border border-gray-300 rounded px-1.5 py-1.5 text-sm"
                                        value={l.xero_account_code}
                                        onChange={(e) => patchLine(l.key, { xero_account_code: e.target.value })}
                                      >
                                        <option value="">Same category as the cost</option>
                                        {groups.map((group) => (
                                          <optgroup key={group} label={group}>
                                            {COST_CATEGORIES.filter((c) => c.group === group).map((c) => (
                                              <option key={c.xeroCode} value={c.xeroCode}>{c.label}</option>
                                            ))}
                                          </optgroup>
                                        ))}
                                      </select>
                                      <label className="flex items-center gap-1 text-xs text-gray-500 shrink-0"
                                        title="Crew paid this out of pocket and reclaims it — no Xero category records that">
                                        <input type="checkbox" checked={l.crew_fronted}
                                          onChange={(e) => patchLine(l.key, { crew_fronted: e.target.checked })} />
                                        fronted
                                      </label>
                                    </div>
                                  </div>
                                ))}
                              </div>

                              <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
                                <button type="button" onClick={addLine}
                                  className="text-xs font-medium text-purple-700 hover:underline">＋ Add another line</button>
                                <button type="button" onClick={() => { setLinesTouched(true); setLines([]); }}
                                  className="text-xs text-gray-400 hover:text-gray-600 hover:underline">Remove all lines</button>
                              </div>

                              {!linesBalanced && (
                                <p className="text-xs text-red-600 font-medium mt-2">
                                  {grossDiff > 0
                                    ? `The lines are ${gbp(grossDiff)} MORE than the invoice total.`
                                    : `${gbp(-grossDiff)} of the invoice isn’t on a line yet.`}{' '}
                                  This won’t save until it matches.
                                </p>
                              )}
                              <p className="text-[11px] text-gray-400 mt-1">
                                Each line’s amount is what’s printed on the invoice, VAT included; the rate says how much of
                                that is VAT. “Fronted” means the crew paid that line out of pocket and reclaims it.
                              </p>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>

                  {duplicates.length > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      Looks like this was already added: {duplicates.map((d) => (
                        <span key={d.id} className="block">
                          {gbp(Number(d.amount_gross))} from {d.supplier_name || 'this supplier'} on {fmtDate(d.cost_date)}
                          {d.uploaded_by_name ? `, added by ${d.uploaded_by_name}` : ''}{d.has_receipt ? '' : ' (no receipt attached)'}.{' '}
                          <a href={`/money/costs?cost=${d.id}`} target="_blank" rel="noreferrer" className="underline font-medium">Open it</a>
                        </span>
                      ))}
                      <span className="block text-amber-700 mt-0.5">Several on one day is normal (fuel); only save it if it&apos;s a different one.</span>
                    </div>
                  )}
                </div>

                {/* 3. What it's for */}
                <div className="space-y-3">
                  {sectionHead('What it’s for')}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Category</label>
                      <select className={inputCls} value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
                        <option value="">— select —</option>
                        {groups.map((group) => (
                          <optgroup key={group} label={group}>
                            {COST_CATEGORIES.filter((c) => c.group === group).map((c) => (
                              <option key={c.xeroCode} value={c.xeroCode}>{c.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Description</label>
                      <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this for?" />
                    </div>
                  </div>

                  {/* The van. For fuel, parking and the like on a job it comes from
                      the job; otherwise "+ Link a van" opens the picker in place. */}
                  {vehicleId ? (
                    <div className="flex items-center gap-2 flex-wrap rounded-md bg-gray-50 px-3 py-2 text-sm">
                      <span className="text-gray-500">Van</span>
                      <span className="font-medium text-gray-900">{vehicleLabel(selectedVehicle) || '(linked vehicle)'}</span>
                      {vanFromJob && <span className="text-xs text-gray-500">· from job {choices.find((c) => c.jobId === vanFromJob)?.hhJobNumber ? `#${choices.find((c) => c.jobId === vanFromJob)?.hhJobNumber}` : 'the job'}</span>}
                      <button type="button"
                        onClick={() => { setVehicleId(null); setVehicleSearch(''); setLogService(false); setVehicleRegNote(null); setVanFromJob(null); setVanRemoved(true); }}
                        className="ml-auto text-xs text-red-600 hover:underline">
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div>
                      {isVehicleCategory && jobVans && jobVans.vans.length > 1 && !vanPickerOpen && (
                        <div className="flex items-center gap-2 flex-wrap text-sm mb-1">
                          <span className="text-gray-600">Which van was it? This job had {jobVans.vans.length}:</span>
                          {jobVans.vans.map((v) => (
                            <button key={v.id} type="button"
                              onClick={() => { setVehicleId(v.id); setVanFromJob(jobVans.jobId); if (SERVICE_HISTORY_CATEGORY_CODES.has(categoryCode)) setLogService(true); }}
                              className="px-2 py-0.5 rounded border border-purple-200 bg-purple-50 text-purple-800 hover:bg-purple-100 text-xs font-medium">
                              {v.reg}
                            </button>
                          ))}
                        </div>
                      )}
                      {!vanPickerOpen ? (
                        <button type="button" onClick={() => setVanPickerOpen(true)} className="text-sm text-purple-700 hover:underline">+ Link a van</button>
                      ) : (
                        <div className="relative">
                          <input autoFocus className={inputCls} value={vehicleSearch}
                            onChange={(e) => setVehicleSearch(e.target.value)}
                            onFocus={() => setVehicleFocused(true)}
                            onBlur={() => setTimeout(() => { setVehicleFocused(false); if (!vehicleSearch.trim()) setVanPickerOpen(false); }, 150)}
                            placeholder="Search by reg" autoComplete="off" />
                          {vehicleFocused && (
                            <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                              {fleet.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-gray-400">Loading vehicles…</div>
                              ) : vehFiltered.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-gray-400">No match</div>
                              ) : vehFiltered.map((v) => (
                                <button key={v.id} type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault(); setVehicleId(v.id); setVehicleSearch(''); setVanPickerOpen(false); setVanFromJob(null);
                                    // Auto-tick the service-history offer at create, and in
                                    // edit when this pick ADDS the van link (no link + no
                                    // service record before). An edit that merely changes an
                                    // existing link stays opt-in.
                                    if (!isEdit || (!existing?.vehicle_id && !existing?.vehicle_service_log_id)) setLogService(true);
                                  }}
                                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
                                  {vehicleLabel(v)}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Service-history record — offered when a vehicle is linked, no
                      service record exists yet, and the category is a servicing/repair
                      event (create, or edit-mode retro-add). Fuel/parking/PCN are
                      excluded — they keep the reg link but never log to history. */}
                  {serviceLinkMissing && (
                    <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
                        <input type="checkbox" checked={logService} onChange={(e) => setLogService(e.target.checked)} className="rounded" />
                        Also add to {selectedVehicle?.reg || 'this vehicle'}&apos;s service history
                      </label>
                      {isEdit && !logService && (
                        <p className="text-xs text-amber-600">
                          This cost isn&apos;t in the vehicle&apos;s service history — tick above to add a service record when you save.
                        </p>
                      )}
                      {logService && (
                        <div className="space-y-3">
                          <div className="flex flex-wrap gap-1.5">
                            {(['service', 'repair', 'mot', 'insurance', 'tax', 'tyre', 'other'] as const).map((t) => (
                              <button key={t} type="button" onClick={() => setServiceType(t)}
                                className={`px-2.5 py-1 text-xs rounded-md border capitalize ${serviceType === t ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'}`}>
                                {t}
                              </button>
                            ))}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Mileage</label>
                              <input type="number" min="0" className={inputCls} value={serviceMileage} onChange={(e) => setServiceMileage(e.target.value)} placeholder="Odometer reading" />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Garage / workshop</label>
                              <input className={inputCls} value={serviceGarage} onChange={(e) => setServiceGarage(e.target.value)} placeholder={supplierName || 'Garage name'} />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Status</label>
                              <select className={inputCls} value={serviceStatus} onChange={(e) => setServiceStatus(e.target.value)}>
                                {['Done', 'Pending', 'Booked', 'Cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                            {(serviceType === 'mot' || serviceType === 'insurance' || serviceType === 'tax' || serviceType === 'service' || serviceType === 'repair') && (
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Next due date</label>
                                <input type="date" className={inputCls} value={serviceNextDueDate} onChange={(e) => setServiceNextDueDate(e.target.value)} />
                              </div>
                            )}
                            {(serviceType === 'service' || serviceType === 'repair') && (
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Next service mileage</label>
                                <input type="number" min="0" className={inputCls} value={serviceNextDueMileage} onChange={(e) => setServiceNextDueMileage(e.target.value)} placeholder="e.g. 90000" />
                              </div>
                            )}
                          </div>
                          <label className="flex items-start gap-2 text-xs text-gray-600">
                            <input type="checkbox" checked={applyToVehicle} onChange={(e) => setApplyToVehicle(e.target.checked)} className="rounded mt-0.5" />
                            <span>Update the vehicle&apos;s live figures (mileage, last/next service, due dates). Untick for a historical backfill.</span>
                          </label>
                          <p className="text-xs text-gray-400">
                            Records cost as net (ex VAT) £{amountNet || '0.00'}{receiptFile || existing?.receipt_r2_key ? ' · receipt attached to the service record too' : ''}.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 4. Jobs and who pays */}
                {isCredit ? (
                  <div className="space-y-2">
                    {sectionHead('Job')}
                    <p className="text-sm text-gray-700">
                      {existingRow?.hh_job_number ? `#${existingRow.hh_job_number}${existingRow.job_name ? ` ${existingRow.job_name}` : ''}` : existing?.job_id ? 'On the purchase’s job' : 'Not on a job (overheads)'}
                      <span className="block text-xs text-gray-400">A refund stays on its purchase&apos;s job, so it nets off there.</span>
                    </p>
                  </div>
                ) : (
                  <CostJobsTable
                    sectionRef={jobsRef}
                    gross={grossNum}
                    netRatio={netRatio}
                    choices={choices}
                    onChoices={setChoices}
                    whoPaysOf={whoPaysOf}
                    partOf={partOf}
                    amounts={jobAmounts}
                    plan={plan}
                    info={jobInfo}
                    wholeLocked={wholeLockedNote}
                    readOnly={jobsEditable ? null : splitState === 'failed'
                      ? 'Couldn’t load this cost’s jobs, so they’re left as they are. Close it and open it again to change them.'
                      : 'Loading the jobs…'}
                    freelancer={isFreelanceCategory ? {
                      person: flPerson, items: fw.items, tolerance: fw.tolerance, loading: fw.loading, error: fw.error,
                      ticked: flTicked, onToggle: toggleWork,
                      typed: flTyped,
                      onTyped: (key, value) => setFlTyped((prev) => {
                        const n = { ...prev };
                        if (value === undefined) delete n[key]; else n[key] = value;
                        return n;
                      }),
                      amounts: itemAmounts,
                      showInvoiced: flShowInvoiced, onShowInvoiced: setFlShowInvoiced,
                      onAsk: (text) => { setQuestionOpen(true); setQueryNote((q) => (q.trim() ? `${q.trim()}\n${text}` : text)); },
                    } : null}
                    suggestedJobNumber={suggestedJobNumber}
                    onDismissSuggestion={() => setSuggestedJobNumber(null)}
                  />
                )}

                {/* 5. Payment */}
                <div className="space-y-2">
                  {sectionHead('Payment')}
                  {isCredit ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Back to</label>
                        <select className={inputCls} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as CostPaymentMethod)}>
                          {[...PAID_BY.filter((m) => m.value !== 'reimburse_me'), ...LEGACY_METHODS].map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                          {![...PAID_BY, ...LEGACY_METHODS].some((m) => m.value === paymentMethod) && <option value={paymentMethod}>{METHOD_LABEL[paymentMethod] || paymentMethod}</option>}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Status</label>
                        <select className={inputCls} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as CostPaymentStatus)}>
                          {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </div>
                    </div>
                  ) : kind === 'bill' ? (
                    <div className="text-sm text-gray-700">
                      <span>Pay later{dueShown ? ` · due ${fmtDate(dueShown)}` : ''} · {PAYMENT_STATUSES.find((s) => s.value === paymentStatus)?.label.toLowerCase()}</span>{' '}
                      <button type="button" className="text-xs text-purple-700 hover:underline" onClick={() => setPaymentOpen(!paymentOpen)}>{paymentOpen ? 'Done' : 'Change'}</button>
                      {paymentOpen && (
                        <div className="mt-2 max-w-xs">
                          <label className="block text-xs text-gray-500 mb-1">Status</label>
                          <select className={inputCls} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as CostPaymentStatus)}>
                            {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                          <p className="text-xs text-gray-400 mt-1">The due date is under &quot;From the document&quot; (Edit details).</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-sm text-gray-600">Paid by</span>
                        <div className="inline-flex rounded-md bg-gray-100 p-0.5 text-sm">
                          {[...PAID_BY, ...LEGACY_METHODS.filter((m) => m.value === paymentMethod)].map((m) => (
                            <button key={m.value} type="button" onClick={() => setPaymentMethod(m.value)}
                              className={`px-3 py-1 rounded ${paymentMethod === m.value ? 'bg-purple-600 text-white font-medium' : 'text-gray-700 hover:bg-white'}`}>
                              {m.value === 'cot_card' && freshCardLast4 ? `Company card ••${freshCardLast4}` : m.label}
                              {LEGACY_METHODS.some((x) => x.value === m.value) ? ' (no longer offered)' : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* The old form switched a freelancer invoice to pay-later on
                          its own; "What is it?" decides now, so say so if it looks wrong. */}
                      {isFreelanceCategory && paymentMethod !== 'reimburse_me' && !isEdit && (
                        <p className="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1">
                          A freelancer&apos;s invoice is usually a bill we pay later, not a receipt.{' '}
                          <button type="button" className="underline font-medium" onClick={() => chooseKind('bill')}>Make it a bill</button>
                        </p>
                      )}
                      {paymentMethod === 'reimburse_me' && (
                        <p className="text-xs text-gray-500 mt-1">My own money: it saves for approval and is paid back to you as a bill made out to you.</p>
                      )}
                      {isLegacyMethod && (
                        <p className="text-xs text-gray-400 mt-1">Kept as it was saved. New costs are paid by company card, cash, Wise or your own money.</p>
                      )}
                      {paymentMethod === 'cot_card' && !freshCardLast4 && (
                        <p className="text-xs text-gray-500 italic mt-1">
                          No company card on file for you — ask an admin to add it in Settings → COT Card Register (enables Xero reconciliation matching).
                        </p>
                      )}
                      {isEdit && (
                        <div className="mt-1 text-xs text-gray-500">
                          Status: {PAYMENT_STATUSES.find((s) => s.value === paymentStatus)?.label}{' '}
                          <button type="button" className="text-purple-700 hover:underline" onClick={() => setPaymentOpen(!paymentOpen)}>{paymentOpen ? 'Done' : 'Change'}</button>
                          {paymentOpen && (
                            <select className={`${inputCls} mt-1 max-w-xs`} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as CostPaymentStatus)}>
                              {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {xeroKindMismatch && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      {xeroKind === 'banktransaction'
                        ? 'This cost is already in Xero as a paid Spend Money. Changing it to pay-later won’t turn it into a bill, and it can’t then be re-synced or batch-paid. Delete the Spend Money in Xero, then ask an admin to point this cost at the bill.'
                        : 'This cost is already in Xero as a bill. Changing it to a paid-now method won’t record a payment there — keep it pay-later and pay the bill (Mark paid or batch pay) instead.'}
                    </p>
                  )}
                </div>

                {/* Notes, and a question for the freelancer: out of the way until wanted. */}
                <div className="flex items-center gap-2 flex-wrap">
                  {!notesOpen && (
                    <button type="button" onClick={() => setNotesOpen(true)}
                      className="px-3 py-1 text-sm rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">+ Notes</button>
                  )}
                  {isFreelanceCategory && !alreadyApproved && !questionOpen && (
                    <button type="button" onClick={() => setQuestionOpen(true)}
                      className="px-3 py-1 text-sm rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">
                      + Question for {flPerson?.name || 'the freelancer'}
                    </button>
                  )}
                </div>
                {notesOpen && (
                  <div>
                    <div className="flex items-baseline justify-between">
                      <label className="block text-xs text-gray-500 mb-1">Notes</label>
                      <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => { setNotes(''); setNotesOpen(false); }}>Remove</button>
                    </div>
                    <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <p className="text-xs text-gray-400 mt-1">Staff only. Shows on this cost in OP; not sent to Xero or the freelancer.</p>
                  </div>
                )}
                {isFreelanceCategory && !alreadyApproved && questionOpen && (
                  <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
                    <div className="flex items-baseline justify-between">
                      <label className="block text-sm font-medium text-gray-800 mb-1">Ask {flPerson?.name || 'them'} before approving</label>
                      <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => { setQueryNote(''); setQuestionOpen(false); }}>Remove</button>
                    </div>
                    <textarea className={inputCls} rows={4} value={queryNote} onChange={(e) => setQueryNote(e.target.value)}
                      placeholder="e.g. The £80 train looks high. Can you send the ticket?" maxLength={2000} />
                    <p className="text-xs text-gray-500 mt-1">
                      Marks it Queried. They see this on their Earnings page in the portal, so word it for them. No email is sent: contact them yourself. Approving clears it.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50/60 sm:rounded-b-lg">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              {showForm && summaryBits.length > 0 && !serviceOnlySave && (
                <p className="text-sm font-medium text-gray-800">{summaryBits.join(' · ')}</p>
              )}
              {showForm && topWarning && (
                <p className={`text-xs mt-0.5 ${topWarning.tone === 'red' ? 'text-red-700' : 'text-amber-700'}`}>{topWarning.text}</p>
              )}
              {/* Xero transparency: paid costs sync automatically on save (Spend
                  Money); pay-later bills wait for approval before they post. */}
              {showForm && !isEdit && !serviceOnlySave && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {isBillMethod
                    ? 'Saves for approval; it goes to Xero as a bill once approved.'
                    : 'Save sends it to Xero as a paid transaction (Spend Money).'}
                  {recharged > 0 ? ' The client is charged the net with the markup, plus VAT, not the gross.' : ''}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={guardedClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
              {showForm && !isEdit && isBillMethod && !serviceOnlySave ? (
                <>
                  <button onClick={() => handleSave()} disabled={saving}
                    className={canApprove
                      ? 'px-4 py-2 text-sm text-purple-700 bg-white border border-purple-300 hover:bg-purple-50 rounded-md disabled:opacity-50'
                      : 'px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50'}>
                    {saving ? 'Saving…' : wantsService ? 'Save for approval + service record' : 'Save for approval'}
                  </button>
                  {canApprove && (
                    <button onClick={() => handleSave(true)} disabled={saving}
                      className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50"
                      title="Save this bill and approve it in one step, which sends it to Xero">
                      {saving ? 'Saving…' : 'Approve & send to Xero'}
                    </button>
                  )}
                </>
              ) : showForm && (
                <button onClick={() => handleSave()} disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
                  {saving ? 'Saving…' : isEdit ? (wantsService ? 'Save changes + service record' : 'Save changes') : serviceOnlySave ? 'Save service record' : wantsService ? 'Save + service record' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* "No work ticked: why?" Asked on save, answered with one click, and
            every answer but "Go back" saves (jon, Oct 2026). */}
        {unmatchedAsk && (
          <div className="fixed inset-0 z-[60] bg-black/30 flex items-center justify-center p-4" onClick={() => setUnmatchedAsk(null)}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-gray-900">No work ticked</h3>
              <p className="text-sm text-gray-600">
                Ticking the work an invoice covers is how we check the price, and it&apos;s what the freelancer sees in their portal. Why isn&apos;t any ticked?
              </p>
              <div className="space-y-2">
                <p className="text-xs text-gray-500">Save it anyway, because:</p>
                {UNMATCHED_REASONS.filter((r) => r.code !== 'person_not_in_op' || !flPerson).map((r) => (
                  <button key={r.code} type="button" onClick={() => handleSave(unmatchedAsk.approve, r.code)}
                    className="w-full text-left px-3 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50">
                    {r.label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setUnmatchedAsk(null)}
                className="w-full px-3 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md">
                {flPerson ? 'Go back and tick the work' : 'Go back and pick the freelancer'}
              </button>
            </div>
          </div>
        )}

        {/* Refund, from a page that doesn't run the refund flow itself. */}
        {showRefund && (
          <Suspense fallback={null}>
            <RecordRefundModal
              cost={null}
              initialFile={receiptFile}
              onClose={() => setShowRefund(false)}
              onSaved={(warnings) => {
                setShowRefund(false);
                if (warnings.length) alert(`Refund recorded.\n\n${warnings.join('\n\n')}`);
                onSaved(null);
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
