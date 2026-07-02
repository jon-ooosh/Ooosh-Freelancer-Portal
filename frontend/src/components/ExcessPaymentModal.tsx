/**
 * ExcessPaymentModal — Slide panel for recording actions against an excess record.
 *
 * Supports: Record Payment, Record Claim, Reimburse, Waive, Roll Over, Move to different entity.
 */
import { useState, useRef, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../services/api';
import type { JobExcess, ExcessStatus } from '../../../shared/types';

interface OutstandingInvoice {
  id: number;
  number: string;
  description: string;
  amount: number;
  owing: number;
  date: string | null;
}

interface CrossJobGroup {
  hh_job_number: number;
  job_name: string | null;
  invoices: OutstandingInvoice[];
}

// HireHop bank accounts (id → label) for the confirmable bank field. Mirrors
// HH_BANK_IDS in backend services/hh-deposit.ts.
const HH_BANKS: Array<{ id: number; label: string }> = [
  { id: 265, label: 'Wise — Current Account (BACS)' },
  { id: 169, label: 'Worldpay (all cards except Amex)' },
  { id: 165, label: 'Amex' },
  { id: 267, label: 'Stripe GBP' },
  { id: 170, label: 'Lloyds Bank' },
  { id: 168, label: 'Till (Cash)' },
  { id: 173, label: 'PayPal' },
];
const PAYMENT_METHOD_TO_BANK: Record<string, number> = {
  wise_bacs: 265, worldpay: 169, amex: 165, stripe_gbp: 267, lloyds_bank: 170, till_cash: 168, paypal: 173,
};

/** Hire length in whole days from a job object, or undefined if dates missing.
 *  start = job_date||out_date, end = job_end||return_date (mirrors money.ts). */
export function computeHireDays(job: { job_date?: string | null; out_date?: string | null; job_end?: string | null; return_date?: string | null } | null | undefined): number | undefined {
  if (!job) return undefined;
  const start = job.job_date || job.out_date;
  const end = job.job_end || job.return_date;
  if (!start || !end) return undefined;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (isNaN(ms) || ms < 0) return undefined;
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

type ModalAction = 'payment' | 'claim' | 'reimburse' | 'waive' | 'rollover' | 'rollover_apply' | 'move' | 'edit_required' | 'unlink_deposit' | 'capture' | 'release' | 'record_preauth' | 'upload_receipt' | 'mark_externally_resolved';

const CAPTURE_METHODS = [
  { value: 'stripe_gbp', label: 'Stripe (online card pre-auth)' },
  { value: 'worldpay', label: 'Worldpay (card machine pre-auth)' },
  { value: 'amex', label: 'Amex (card machine pre-auth)' },
  { value: 'till_cash', label: 'Cash held' },
];

// Methods staff can record a manual pre-auth hold against. Card-machine methods
// (worldpay/amex/cash) are the common case; Stripe is offered for the rare manual
// online hold (capture then needs the PI — see record-preauth endpoint notes).
const PREAUTH_METHODS = [
  { value: 'worldpay', label: 'Worldpay (card machine pre-auth)' },
  { value: 'amex', label: 'Amex (card machine pre-auth)' },
  { value: 'till_cash', label: 'Cash held' },
  { value: 'stripe_gbp', label: 'Stripe (manual online hold)' },
];

interface BankDetails {
  type: 'uk' | 'international';
  accountHolder: string;
  sortCode?: string;
  accountNumber?: string;
  iban?: string;
  swiftBic?: string;
  bankCountry?: string;
}

interface ExcessPaymentModalProps {
  excess: JobExcess;
  onClose: () => void;
  onUpdated: () => void;
  initialAction?: ModalAction;
  /** Hire length in days — when short (< 4), a pre-auth hold is recommended
   *  over a captured payment, so we surface it first + badge it. */
  hireDays?: number;
}

const PAYMENT_METHODS = [
  { value: 'worldpay', label: 'Worldpay (all cards EXCEPT AMEX)' },
  { value: 'amex', label: 'Amex' },
  { value: 'stripe_gbp', label: 'Stripe GBP' },
  { value: 'wise_bacs', label: 'Wise - Current Account (BACS)' },
  { value: 'till_cash', label: 'Till (Cash)' },
  { value: 'paypal', label: 'Paypal' },
  { value: 'lloyds_bank', label: 'Lloyds Bank' },
  { value: 'rolled_over', label: 'Rolled Over from Previous Hire' },
];

const REIMBURSE_METHODS = [
  { value: 'worldpay', label: 'Worldpay (Card Refund)' },
  { value: 'amex', label: 'Amex (Card Refund)' },
  { value: 'stripe_gbp', label: 'Stripe GBP (Online Card Refund)' },
  { value: 'wise_bacs', label: 'Wise - Current Account (BACS)' },
  { value: 'till_cash', label: 'Till (Cash)' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'lloyds_bank', label: 'Lloyds Bank' },
];

function statusLabel(status: ExcessStatus): string {
  const labels: Record<string, string> = {
    not_required: 'Covered',  // covered by another driver's excess on this hire
    needed: 'Required',
    pending: 'Required',
    taken: 'Taken',
    partially_paid: 'Partially Paid',
    partial: 'Partially Paid', // legacy compat
    pre_auth: 'Pre-auth Held',
    released: 'Released',
    waived: 'Waived',
    fully_claimed: 'Fully Claimed',
    claimed: 'Fully Claimed', // legacy compat
    partially_reimbursed: 'Partially Reimbursed',
    reimbursed: 'Reimbursed',
    rolled_over: 'Rolled Over',
  };
  return labels[status] || status;
}

function statusColor(status: ExcessStatus): string {
  const colors: Record<string, string> = {
    not_required: 'bg-gray-100 text-gray-700',
    needed: 'bg-amber-100 text-amber-800',
    pending: 'bg-amber-100 text-amber-800',
    taken: 'bg-green-100 text-green-800',
    partially_paid: 'bg-yellow-100 text-yellow-800',
    partial: 'bg-yellow-100 text-yellow-800',
    pre_auth: 'bg-sky-100 text-sky-800',
    released: 'bg-gray-100 text-gray-600',
    waived: 'bg-blue-100 text-blue-800',
    fully_claimed: 'bg-red-100 text-red-800',
    claimed: 'bg-red-100 text-red-800',
    partially_reimbursed: 'bg-orange-100 text-orange-800',
    reimbursed: 'bg-emerald-100 text-emerald-800',
    rolled_over: 'bg-purple-100 text-purple-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-700';
}

export { statusLabel, statusColor };

export default function ExcessPaymentModal({ excess, onClose, onUpdated, initialAction, hireDays }: ExcessPaymentModalProps) {
  // Short hires (< 4 days) are typically covered by a pre-auth HOLD rather than
  // a captured payment — surface pre-auth first + badge it as recommended.
  const isShortHire = hireDays != null && hireDays > 0 && hireDays < 4;
  const [action, setAction] = useState<ModalAction | null>(initialAction || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Tracks whether we've made a change the parent needs to see. Lets us DEFER
  // the parent refresh (onUpdated) to close-time instead of calling it mid-flow
  // — calling onUpdated() while the modal is open reloads the parent's data and
  // tears the modal down (that's what made the joined-up receipt step "flash and
  // disappear"). Close affordances run handleClose, which fires onUpdated once.
  const [madeChange, setMadeChange] = useState(false);

  function handleClose() {
    if (madeChange) onUpdated();
    onClose();
  }

  // Payment form — uses absolute "total collected" semantics (not delta-add).
  // Default: full required amount (the most common case is "fully collected
  // now"). User can lower this to record a partial collection. Pre-existing
  // collected amount is shown as guidance below the field.
  const previousTaken = Number(excess.excess_amount_taken || 0);
  const requiredAmount = Number(excess.excess_amount_required || 0);
  const [payTotalCollected, setPayTotalCollected] = useState(
    requiredAmount > 0 ? requiredAmount.toFixed(2) : previousTaken.toFixed(2)
  );
  const [payMethod, setPayMethod] = useState('worldpay');
  const [payReference, setPayReference] = useState('');
  const [payPushToHH, setPayPushToHH] = useState(true);
  const [payHHPushError, setPayHHPushError] = useState<string | null>(null);
  // Soft-enforce reimburse-after-nibble: when staff tries to top up a record
  // already linked to a HireHop deposit chain (rolled forward from a previous
  // hire), backend returns 409 with this payload. We surface the warning +
  // require an explicit tick before re-submitting with the acknowledgement.
  const [chainBreakWarning, setChainBreakWarning] = useState<{
    message: string;
    current_collected: number;
    required: number;
    residual: number;
    suggestion_reason: string;
  } | null>(null);
  const [acknowledgeChainBreak, setAcknowledgeChainBreak] = useState(false);
  // Loud-fail guard: backend returns 422 when reimbursing via Stripe but the
  // record has no PaymentIntent to refund against. We surface the message +
  // require an explicit "already refunded in Stripe, record only" tick before
  // re-submitting with acknowledge_no_stripe_refund.
  const [noStripePiWarning, setNoStripePiWarning] = useState<string | null>(null);
  const [acknowledgeNoStripePi, setAcknowledgeNoStripePi] = useState(false);

  // Claim form
  const [claimAmount, setClaimAmount] = useState('');
  const [claimNotes, setClaimNotes] = useState('');
  const [claimInvoiceId, setClaimInvoiceId] = useState<number | null>(null);
  const [outstandingInvoices, setOutstandingInvoices] = useState<OutstandingInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState('');

  // Cross-job apply (CROSS-JOB-EXCESS-APPLY-SPEC): apply this excess to a
  // same-client invoice on ANOTHER job. targetHhJob is set when the chosen
  // invoice lives off-job (null = invoice on the excess's own job).
  const [crossJobOpen, setCrossJobOpen] = useState(false);
  const [crossJobData, setCrossJobData] = useState<CrossJobGroup[]>([]);
  const [loadingCrossJob, setLoadingCrossJob] = useState(false);
  const [crossJobError, setCrossJobError] = useState('');
  const [targetHhJob, setTargetHhJob] = useState<number | null>(null);
  const [manualJobNum, setManualJobNum] = useState('');
  const [manualJobResult, setManualJobResult] = useState<CrossJobGroup & { same_client: boolean } | null>(null);
  const [manualJobError, setManualJobError] = useState('');
  // Confirmable bank attribution for the application — defaults to the source
  // deposit's likely bank (mapped from payment_method); '' = let the server
  // resolve from the original deposit. Replaces the old hardcoded Worldpay.
  const [claimBank, setClaimBank] = useState<number | ''>('');

  // Lazy-load outstanding invoices when the claim action opens. We only fetch
  // for HH-linked excess records (no point asking HH for invoices on an OP-only
  // record). Skipping a fetch is fine — backend will validate and surface a
  // clear error if the claim is missing the invoice picker selection.
  const isHhLinked = Boolean(excess.hirehop_job_id);
  useEffect(() => {
    // Both claim and capture offer an invoice picker (capture's is optional —
    // atomic capture-and-apply). Fetch outstanding invoices for either.
    if ((action !== 'claim' && action !== 'capture') || !isHhLinked) return;
    let cancelled = false;
    setLoadingInvoices(true);
    setInvoicesError('');
    api.get<{ data: OutstandingInvoice[] }>(`/excess/${excess.id}/outstanding-invoices`)
      .then((r) => {
        if (cancelled) return;
        setOutstandingInvoices(r.data);
        // Auto-select if exactly one invoice — common case (claim only; capture
        // leaves it unselected since applying-to-invoice is opt-in there).
        if (r.data.length === 1 && action === 'claim') setClaimInvoiceId(r.data[0]!.id);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setInvoicesError(err.message || 'Failed to load invoices');
      })
      .finally(() => { if (!cancelled) setLoadingInvoices(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, isHhLinked]);

  // Default the confirmable bank from the source deposit's payment method (the
  // server still resolves authoritatively when '' is sent, but pre-filling a
  // concrete bank makes the attribution visible + correctable up front).
  useEffect(() => {
    if (action !== 'claim') return;
    const m = (excess as { payment_method?: string }).payment_method;
    setClaimBank(m && PAYMENT_METHOD_TO_BANK[m] != null ? PAYMENT_METHOD_TO_BANK[m] : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  // Lazy-load same-client cross-job invoices when the section is first opened.
  const loadCrossJobInvoices = () => {
    if (crossJobData.length > 0 || loadingCrossJob) return;
    setLoadingCrossJob(true);
    setCrossJobError('');
    api.get<{ data: { jobs: CrossJobGroup[] } }>(`/excess/${excess.id}/cross-job-invoices`)
      .then((r) => setCrossJobData(r.data.jobs || []))
      .catch((err: any) => setCrossJobError(err.message || 'Failed to load other jobs'))
      .finally(() => setLoadingCrossJob(false));
  };

  // Targeted "enter a job number" lookup.
  const lookupManualJob = () => {
    const n = parseInt(manualJobNum.trim(), 10);
    if (!n) { setManualJobError('Enter a job number'); return; }
    setManualJobError('');
    setManualJobResult(null);
    api.get<{ data: CrossJobGroup & { same_client: boolean } }>(`/excess/${excess.id}/job-invoices/${n}`)
      .then((r) => {
        if (!r.data.invoices || r.data.invoices.length === 0) {
          setManualJobError(`No outstanding invoices on job ${n}.`);
        } else {
          setManualJobResult(r.data);
        }
      })
      .catch((err: any) => setManualJobError(err.message || 'Lookup failed'));
  };

  // Select an invoice that lives on another job (sets both the invoice id and
  // the target job so the claim records the cross-job link). Clears any
  // this-job selection so only one invoice is ever chosen.
  const selectCrossJobInvoice = (hhJob: number, invId: number) => {
    setClaimInvoiceId(invId);
    setTargetHhJob(hhJob);
  };
  const selectOwnJobInvoice = (invId: number | null) => {
    setClaimInvoiceId(invId);
    setTargetHhJob(null);
  };

  // Available balance: same formula as amountHeld below (kept in sync). Used by
  // the claim form to show running balance and validate before submission.
  const claimAvailable = Number(excess.excess_amount_taken || 0)
    - Number(excess.claim_amount || 0)
    - Number(excess.reimbursement_amount || 0);

  // Pre-auth hold amount (migration 087). DISTINCT from `amountHeld` below, which
  // is the remaining balance of TAKEN money. `preAuthHeld` is money on a Stripe /
  // card-machine hold that hasn't been captured yet.
  const preAuthHeld = Number(excess.amount_held || 0);

  // Capture form — converts a held pre-auth into taken money. Default amount is
  // the full hold (most common: capture exactly what's needed for a known
  // charge). Method defaults to the record's payment_method (the channel the
  // hold was taken on) so Stripe holds capture via Stripe, card-machine holds
  // record passively.
  const [captureAmount, setCaptureAmount] = useState(preAuthHeld > 0 ? preAuthHeld.toFixed(2) : '');
  const captureDefaultMethod = excess.payment_method && CAPTURE_METHODS.some((m) => m.value === excess.payment_method)
    ? excess.payment_method
    : 'stripe_gbp';
  const [captureMethod, setCaptureMethod] = useState(captureDefaultMethod);
  const [captureInvoiceId, setCaptureInvoiceId] = useState<number | null>(null);
  const [captureReason, setCaptureReason] = useState('');
  const [captureNotes, setCaptureNotes] = useState('');
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);

  // Release form
  const [releaseReason, setReleaseReason] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  // Record-pre-auth form (manual hold entry — e.g. Worldpay card machine)
  const [preauthAmount, setPreauthAmount] = useState(requiredAmount > 0 ? requiredAmount.toFixed(2) : '');
  const [preauthMethod, setPreauthMethod] = useState('worldpay');
  const [preauthReference, setPreauthReference] = useState('');
  const [preauthExpiryDays, setPreauthExpiryDays] = useState('5');
  const [preauthNotes, setPreauthNotes] = useState('');

  // Receipt upload (card-machine receipt scan) — two paths: this device, or
  // "scan with phone" QR handoff (laptop shows QR, phone uploads, laptop polls).
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [receiptMode, setReceiptMode] = useState<'choose' | 'device' | 'qr'>('choose');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');

  // Bank details (captured during reimburse when method is a bank transfer)
  const [bankCapture, setBankCapture] = useState(false); // user has opted to enter/edit details
  const [bankType, setBankType] = useState<'uk' | 'international'>('uk');
  const [bankHolder, setBankHolder] = useState('');
  const [bankSortCode, setBankSortCode] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIban, setBankIban] = useState('');
  const [bankSwift, setBankSwift] = useState('');
  const [bankCountry, setBankCountry] = useState('');
  const [previousBank, setPreviousBank] = useState<{ data: BankDetails; last_used_at: string | null; source_hh_job: number | null } | null>(null);

  // Reimburse methods that are bank transfers → trigger the bank-details capture UI.
  const BANK_TRANSFER_METHODS = ['wise_bacs', 'lloyds_bank'];

  // Reimburse form
  // Default to the original payment method IF it's a real bank method we can refund
  // through. The original payment_method may be 'rolled_over' (carried forward from a
  // previous hire) — that's not a valid reimburse destination, so we fall back to
  // wise_bacs. Without this guard the <select> shows the first option visually but
  // the underlying state stays 'rolled_over' and the backend Zod schema rejects it.
  const amountHeld = Number(excess.excess_amount_taken || 0) - Number(excess.claim_amount || 0) - Number(excess.reimbursement_amount || 0);
  const [reimburseAmount, setReimburseAmount] = useState(amountHeld > 0 ? amountHeld.toFixed(2) : '');
  const validReimburseMethods = REIMBURSE_METHODS.map((m) => m.value);
  const initialReimburseMethod = excess.payment_method && validReimburseMethods.includes(excess.payment_method)
    ? excess.payment_method
    : 'wise_bacs';
  const [reimburseMethod, setReimburseMethod] = useState(initialReimburseMethod);
  // When refunding LESS than the held balance, classify the remainder: false =
  // still owed to the client (stays held), true = retained by Ooosh (booked as a
  // claim, record resolves). Defaults to "still owed" — the safe, reversible
  // choice. See backend reimburse handler for the held-vs-resolved split.
  const [retainResidual, setRetainResidual] = useState(false);
  const reimburseResidual = amountHeld - (parseFloat(reimburseAmount) || 0);

  // Waive form
  const [waiveReason, setWaiveReason] = useState('');

  // Mark Externally Resolved form (cleanup action — see backend route docstring)
  const [extResolvedAmount, setExtResolvedAmount] = useState(() => String(excess.excess_amount_required || ''));
  const [extResolvedMethod, setExtResolvedMethod] = useState<'stripe_gbp' | 'worldpay' | 'amex' | 'wise_bacs' | 'till_cash' | 'paypal' | 'lloyds_bank'>('stripe_gbp');
  const [extResolvedReference, setExtResolvedReference] = useState('');
  const [extResolvedReason, setExtResolvedReason] = useState('');

  // Edit required form
  const [editRequiredAmount, setEditRequiredAmount] = useState(
    excess.excess_amount_required != null ? Number(excess.excess_amount_required).toFixed(2) : ''
  );
  const [editRequiredReason, setEditRequiredReason] = useState(excess.excess_calculation_basis || '');

  // Rollover-apply form (separate from "Roll Over to Next Hire" which is the
  // outgoing-side action). This is the incoming-side: this excess record needs
  // collection, and the same client has rolled-over money sitting on a previous
  // hire's deposit. We auto-detect availability so staff don't have to navigate
  // Manage → Record Payment → "Rolled Over from Previous Hire" (which is
  // misleading UX — calling it a "payment" hides what's actually happening).
  interface RolloverAvailability {
    available: boolean;
    amount_available?: number;
    source_hh_job?: number | null;
    source_hh_deposit_id?: number;
    suggested_apply_amount?: number;
    source_excess_id?: string;
  }
  const [rolloverInfo, setRolloverInfo] = useState<RolloverAvailability | null>(null);
  const [rolloverApplyAmount, setRolloverApplyAmount] = useState('');

  // Look up rollover availability when the modal opens — only worth checking on
  // records that still need collection (otherwise the action is irrelevant).
  const needsCollection = ['needed', 'pending', 'partially_paid'].includes(excess.excess_status);
  useEffect(() => {
    if (!needsCollection) return;
    let cancelled = false;
    api.get<{ data: RolloverAvailability }>(`/excess/${excess.id}/available-rollover`)
      .then((r) => {
        if (cancelled) return;
        setRolloverInfo(r.data);
        if (r.data.available && r.data.suggested_apply_amount !== undefined) {
          setRolloverApplyAmount(Number(r.data.suggested_apply_amount).toFixed(2));
        }
      })
      .catch((err: any) => {
        // Non-fatal: rollover detection is a UX nicety. Log and move on.
        console.warn('[excess modal] Rollover availability check failed:', err.message);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCollection, excess.id]);

  // When reimbursing via a bank transfer, look up the client's previously-saved
  // bank details so staff can reuse them (with a "last used" staleness heads-up)
  // instead of re-typing. Admin/manager only on the backend; non-fatal if it 403s.
  useEffect(() => {
    if (action !== 'reimburse' || !BANK_TRANSFER_METHODS.includes(reimburseMethod)) return;
    let cancelled = false;
    api.get<{ data: BankDetails | null; available?: boolean; last_used_at: string | null; source_hh_job: number | null }>(
      `/excess/${excess.id}/previous-bank-details`
    )
      .then((r) => {
        if (cancelled || !r.data) return;
        setPreviousBank({ data: r.data, last_used_at: r.last_used_at, source_hh_job: r.source_hh_job });
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, reimburseMethod, excess.id]);

  // Poll the QR upload token — when the phone completes the upload, the token
  // flips to consumed; close the modal and refresh so the parent re-fetches the
  // now-attached receipt.
  useEffect(() => {
    if (!qrToken) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const r = await api.get<{ data: { consumed: boolean } }>(`/mobile-upload/${qrToken}`);
        if (cancelled) return;
        if (r.data.consumed) {
          clearInterval(interval);
          onUpdated();
          onClose();
        }
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrToken]);

  async function startQr() {
    setQrLoading(true);
    setQrError('');
    try {
      const r = await api.post<{ data: { token: string; url: string } }>(
        `/excess/${excess.id}/receipt-upload-token`, {}
      );
      setQrToken(r.data.token);
      setQrUrl(r.data.url);
      setReceiptMode('qr');
    } catch (err: any) {
      setQrError(err.message || 'Failed to generate QR code');
    } finally {
      setQrLoading(false);
    }
  }

  // Move form
  const [moveXeroId, setMoveXeroId] = useState('');
  const [moveXeroName, setMoveXeroName] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moveSearch, setMoveSearch] = useState('');
  const [moveResults, setMoveResults] = useState<Array<{ id: string; name: string; subtitle: string; type: string }>>([]);
  const [moveSearching, setMoveSearching] = useState(false);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError('');
    try {
      switch (action) {
        case 'payment': {
          const totalCollected = parseFloat(payTotalCollected);
          if (isNaN(totalCollected) || totalCollected < 0) {
            throw new Error('Enter a valid total collected amount');
          }
          let resp: { data: any; hh_push_error?: string | null; idempotent?: boolean };
          try {
            resp = await api.post<{ data: any; hh_push_error?: string | null; idempotent?: boolean }>(
              `/excess/${excess.id}/payment`,
              {
                total_collected: totalCollected,
                method: payMethod,
                reference: payReference || null,
                push_to_hirehop: payPushToHH,
                acknowledge_chain_break: acknowledgeChainBreak || undefined,
              }
            );
          } catch (e) {
            // Chain-break 409: surface the warning, force an explicit ack
            // before re-submit. Don't blow the modal away.
            const err = e as { status?: number; code?: string; details?: Record<string, unknown> };
            if (err.status === 409 && err.code === 'chain_break_warning' && err.details) {
              setChainBreakWarning({
                message: (err as unknown as { message: string }).message || 'Chain-break warning',
                current_collected: Number(err.details.current_collected || 0),
                required: Number(err.details.required || 0),
                residual: Number(err.details.residual || 0),
                suggestion_reason: String(err.details.suggestion_reason || ''),
              });
              setLoading(false);
              return;
            }
            throw e;
          }
          if (resp.hh_push_error) {
            // OP saved successfully but HH push failed. Surface the error and
            // keep the modal open so staff can decide what to do (manual link,
            // retry by re-submitting, etc.). The OP record is already correct.
            setPayHHPushError(resp.hh_push_error);
            // Defer the parent refresh to close (madeChange) — calling onUpdated()
            // here unmounts the modal on the Money tab (loadData → loading spinner)
            // before staff can read this banner.
            setMadeChange(true);
            setLoading(false);
            return;
          }
          break;
        }
        case 'claim': {
          const claimAmountNum = parseFloat(claimAmount);
          if (isNaN(claimAmountNum) || claimAmountNum <= 0) {
            throw new Error('Enter a valid claim amount');
          }
          if (claimAmountNum > claimAvailable + 0.005) {
            throw new Error(`Claim amount exceeds available balance (£${claimAvailable.toFixed(2)})`);
          }
          if (isHhLinked && !claimInvoiceId) {
            throw new Error('Pick a HireHop invoice to apply the claim against');
          }
          await api.post(`/excess/${excess.id}/claim`, {
            amount: claimAmountNum,
            invoice_id: claimInvoiceId,
            notes: claimNotes || null,
            ...(targetHhJob != null ? { target_hh_job: targetHhJob } : {}),
            ...(claimBank !== '' ? { bank: claimBank } : {}),
          });
          break;
        }
        case 'reimburse': {
          // Assemble bank details only when the method is a bank transfer AND the
          // staff member has entered/confirmed them. Otherwise send null so the
          // backend leaves any stored details untouched (just stamps last_used).
          let bankDetails: BankDetails | null = null;
          if (BANK_TRANSFER_METHODS.includes(reimburseMethod) && bankCapture) {
            if (!bankHolder.trim()) throw new Error('Enter the account holder name');
            if (bankType === 'uk') {
              if (!bankSortCode.trim() || !bankAccountNumber.trim()) {
                throw new Error('Enter the sort code and account number');
              }
            } else {
              if (!bankIban.trim()) throw new Error('Enter the IBAN');
            }
            bankDetails = {
              type: bankType,
              accountHolder: bankHolder.trim(),
              ...(bankType === 'uk'
                ? { sortCode: bankSortCode.trim(), accountNumber: bankAccountNumber.trim() }
                : { iban: bankIban.trim(), swiftBic: bankSwift.trim() || undefined, bankCountry: bankCountry.trim() || undefined }),
            };
          }
          let resp: { data: any; warning?: string };
          try {
            resp = await api.post<{ data: any; warning?: string }>(
              `/excess/${excess.id}/reimburse`,
              {
                amount: parseFloat(reimburseAmount),
                method: reimburseMethod,
                bank_details: bankDetails,
                // Only meaningful when a residual remains (backend guards anyway).
                retain_residual: reimburseResidual > 0.005 ? retainResidual : false,
                // Explicit "already refunded in Stripe — record only" override
                // for the no-PaymentIntent loud-fail (see noStripePiWarning).
                acknowledge_no_stripe_refund: acknowledgeNoStripePi,
              }
            );
          } catch (err: any) {
            // No-PaymentIntent loud fail: surface as a warning + acknowledgement
            // tick rather than a dead-end error, so staff can proceed record-only.
            if (err?.status === 422 && /No Stripe PaymentIntent/i.test(err?.message || '')) {
              setNoStripePiWarning(err.message);
              setLoading(false);
              return;
            }
            throw err;
          }
          if (resp.warning) {
            setError(resp.warning);
            setMadeChange(true); // refresh on close, not mid-flow (see handleClose)
            setLoading(false);
            return;
          }
          break;
        }
        case 'waive':
          await api.post(`/excess/${excess.id}/waive`, {
            reason: waiveReason,
          });
          break;
        case 'mark_externally_resolved': {
          const parsed = parseFloat(extResolvedAmount);
          if (isNaN(parsed) || parsed < 0.01) {
            throw new Error('Enter a valid amount (£0.01 or more)');
          }
          if (!extResolvedReason.trim()) {
            throw new Error('Reason is required — please explain why this record is being marked externally resolved');
          }
          await api.post(`/excess/${excess.id}/mark-externally-resolved`, {
            amount: parsed,
            method: extResolvedMethod,
            reference: extResolvedReference.trim() || null,
            reason: extResolvedReason.trim(),
          });
          break;
        }
        case 'rollover':
          await api.put(`/excess/${excess.id}`, {
            excess_status: 'rolled_over',
          });
          break;
        case 'rollover_apply': {
          // Incoming-side: apply the client's rolled-over balance from a
          // previous hire to this record. Posts to the existing payment
          // endpoint with method='rolled_over' — backend's rollover linkage
          // copies the source HH deposit ID forward and flips the previous
          // record to 'rolled_over' (terminal). Total-collected semantics:
          // we send the new TOTAL (previous taken + applied), not just the
          // delta.
          const applyAmount = parseFloat(rolloverApplyAmount);
          if (isNaN(applyAmount) || applyAmount <= 0) {
            throw new Error('Enter a valid amount to apply');
          }
          if (rolloverInfo?.amount_available && applyAmount > rolloverInfo.amount_available + 0.005) {
            throw new Error(`Amount exceeds available rollover balance (£${rolloverInfo.amount_available.toFixed(2)})`);
          }
          const newTotal = previousTaken + applyAmount;
          await api.post(`/excess/${excess.id}/payment`, {
            total_collected: newTotal,
            method: 'rolled_over',
            reference: null,
            push_to_hirehop: false, // No HH push — no money moves; backend handles linkage + HH note
          });
          break;
        }
        case 'move':
          await api.post(`/excess/${excess.id}/move`, {
            xero_contact_id: moveXeroId,
            xero_contact_name: moveXeroName,
            reason: moveReason || undefined,
          });
          break;
        case 'edit_required': {
          const parsed = parseFloat(editRequiredAmount);
          if (isNaN(parsed) || parsed < 0) {
            throw new Error('Please enter a valid amount');
          }
          await api.put(`/excess/${excess.id}`, {
            excess_amount_required: parsed,
            excess_calculation_basis: editRequiredReason.trim() || null,
          });
          break;
        }
        case 'unlink_deposit':
          await api.post(`/excess/${excess.id}/unlink-deposit`, {});
          break;
        case 'capture': {
          const captureAmountNum = parseFloat(captureAmount);
          if (isNaN(captureAmountNum) || captureAmountNum <= 0) {
            throw new Error('Enter a valid capture amount');
          }
          if (captureAmountNum > preAuthHeld + 0.005) {
            throw new Error(`Capture amount exceeds held amount (£${preAuthHeld.toFixed(2)})`);
          }
          const resp = await api.post<{ data: any; warning?: string }>(
            `/excess/${excess.id}/capture`,
            {
              amount: captureAmountNum,
              method: captureMethod,
              invoice_id: captureInvoiceId,
              reason: captureReason || null,
              notes: captureNotes || null,
            }
          );
          if (resp.warning) {
            // Capture + deposit succeeded but apply-to-invoice failed (or a
            // card-machine receipt is outstanding). Surface and keep the modal
            // open — the money is correctly tracked, just needs a follow-up.
            setCaptureWarning(resp.warning);
            setMadeChange(true); // refresh on close, not mid-flow (see handleClose)
            setLoading(false);
            return;
          }
          break;
        }
        case 'release':
          await api.post(`/excess/${excess.id}/release`, {
            reason: releaseReason || null,
            notes: releaseNotes || null,
          });
          break;
        case 'record_preauth': {
          const amt = parseFloat(preauthAmount);
          if (isNaN(amt) || amt <= 0) throw new Error('Enter a valid hold amount');
          const days = parseInt(preauthExpiryDays, 10);
          await api.post(`/excess/${excess.id}/record-preauth`, {
            amount: amt,
            method: preauthMethod,
            reference: preauthReference || null,
            expires_in_days: isNaN(days) ? 5 : days,
            notes: preauthNotes || null,
          });
          // Joined-up flow: card-machine holds need a receipt. Advance straight
          // to the receipt step instead of closing, so staff aren't sent back
          // into Manage to find it. DON'T call onUpdated() here — that reloads
          // the parent and tears the modal down (the "flash and disappear" bug).
          // madeChange ensures the parent refreshes when the modal finally closes.
          if (preauthMethod !== 'stripe_gbp') {
            setMadeChange(true);
            setAction('upload_receipt');
            setReceiptMode('choose');
            setError('');
            setLoading(false);
            return;
          }
          break;
        }
        case 'upload_receipt': {
          if (!receiptFile) throw new Error('Choose a receipt scan to upload');
          setReceiptUploading(true);
          const fd = new FormData();
          fd.append('file', receiptFile);
          fd.append('attachment_only', 'true');
          const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
          await api.post(`/excess/${excess.id}/receipt`, { receipt_url: up.r2_key });
          setReceiptUploading(false);
          break;
        }
      }
      onUpdated();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Action failed');
    } finally {
      setLoading(false);
      setReceiptUploading(false);
    }
  }

  // Available actions based on current status
  const availableActions: { action: ModalAction; label: string; icon: string; recommended?: boolean }[] = [];
  const s = excess.excess_status;

  // Rollover-apply lands at the TOP when available — most natural action when
  // staff have just confirmed a hire and the client already has rolled-over
  // money on file. No money moves; we just apply that balance to this record.
  if (needsCollection && rolloverInfo?.available) {
    availableActions.push({ action: 'rollover_apply', label: 'Apply Rolled Over Excess', icon: '↻' });
  }
  // Pre-auth hold available from a clean "needed" state with no money/hold yet.
  // For SHORT hires it's the recommended route, so push it FIRST + badge it.
  const preAuthAvailable = (s === 'needed' || s === 'pending') && preAuthHeld === 0 && Number(excess.excess_amount_taken || 0) === 0;
  if (preAuthAvailable && isShortHire) {
    availableActions.push({ action: 'record_preauth', label: 'Record Pre-Auth Hold', icon: '◫', recommended: true });
  }
  if (s === 'needed' || s === 'pending' || s === 'partially_paid') {
    availableActions.push({ action: 'payment', label: 'Record Excess Payment', icon: '£' });
  }
  // Non-short hires (or when it wasn't surfaced first): the pre-auth option
  // still appears here in its usual position.
  if (preAuthAvailable && !isShortHire) {
    availableActions.push({ action: 'record_preauth', label: 'Record Pre-Auth Hold', icon: '◫' });
  }
  // Pre-auth holds: capture (→ taken). For held money you can't claim/reimburse,
  // you capture it first (migration 087). Capture supports atomic
  // capture-and-apply-to-invoice for the common "capture exactly the damage" case.
  if (s === 'pre_auth' && preAuthHeld > 0) {
    availableActions.push({ action: 'capture', label: 'Capture (claim from hold)', icon: '£' });
    // "Release" only makes sense for Stripe holds, where cancelling the
    // PaymentIntent genuinely voids the hold via the API. Card-machine
    // (Worldpay/Amex/cash) holds are controlled by the acquirer — we CAN'T
    // release them, they auto-void on the card company's clock. Showing a
    // "Release" button there is misleading, so hide it for those.
    if (excess.payment_method === 'stripe_gbp') {
      availableActions.push({ action: 'release', label: 'Release Hold (Stripe)', icon: '○' });
    }
  }
  if ((s === 'taken' || s === 'partially_paid') && amountHeld > 0) {
    availableActions.push({ action: 'claim', label: 'Apply to Invoice (claim)', icon: '!' });
    availableActions.push({ action: 'reimburse', label: 'Reimburse', icon: '<' });
    availableActions.push({ action: 'rollover', label: 'Roll Over to Next Hire', icon: '>' });
  }
  // Multi-event model: even after partial reimbursement, more claims can still
  // be applied as long as held balance remains. Same for reimbursing the
  // remainder of a partially-claimed deposit.
  if ((s === 'fully_claimed' || s === 'partially_reimbursed') && amountHeld > 0) {
    availableActions.push({ action: 'claim', label: 'Apply to Invoice (claim)', icon: '!' });
    availableActions.push({ action: 'reimburse', label: 'Reimburse Remainder', icon: '<' });
  }
  // Amend the required excess figure — available whenever the record isn't in a
  // terminal state. Primary case: insurance referral comes back with a revised
  // excess after the hire form has already been submitted.
  if (s !== 'waived' && s !== 'reimbursed' && s !== 'rolled_over' && s !== 'not_required' && s !== 'released') {
    availableActions.push({ action: 'edit_required', label: 'Edit Required Amount', icon: '✎' });
  }
  if (s === 'needed' || s === 'pending') {
    availableActions.push({ action: 'waive', label: 'Waive Excess', icon: '~' });
    // Cleanup action: money flowed in and back out of OP's awareness (e.g.
    // post-PR-630 cleanup of records where staff refunded in HH before the
    // auto-reconciliation existed). Only offered when the record looks like
    // "nothing happened" — backend gate also enforces this. Less prominent
    // than the normal record-payment / reimburse flow on purpose.
    const noActivity =
      Number(excess.excess_amount_taken || 0) < 0.005 &&
      Number(excess.amount_held || 0) < 0.005 &&
      Number(excess.claim_amount || 0) < 0.005 &&
      Number(excess.reimbursement_amount || 0) < 0.005 &&
      !excess.hh_deposit_id;
    if (noActivity) {
      availableActions.push({ action: 'mark_externally_resolved', label: 'Mark as Externally Resolved (cleanup)', icon: '✓' });
    }
  }
  // Card-machine receipt scan outstanding → offer upload (non-blocking to-do).
  if (excess.receipt_required && !excess.receipt_uploaded_at) {
    availableActions.push({ action: 'upload_receipt', label: 'Upload Receipt Scan', icon: '⎙' });
  }
  availableActions.push({ action: 'move', label: 'Move to Different Entity', icon: '>' });

  // Unlink HH deposit — only when a record is linked. Covers the case where
  // a HireHop deposit was wrongly classified as excess (e.g. Stripe URL with
  // "xs" in its path triggered the keyword match) and staff need to undo it.
  // Backend resets amount_taken to 0 and recomputes status.
  if (excess.hh_deposit_id) {
    availableActions.push({ action: 'unlink_deposit', label: 'Unlink HireHop Deposit', icon: '⊘' });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Insurance Excess</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {excess.driver_name || 'Unknown driver'}
                {excess.vehicle_reg && ` — ${excess.vehicle_reg}`}
                {excess.hirehop_job_name && ` — ${excess.hirehop_job_name}`}
              </p>
            </div>
            <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-gray-500">Required</p>
              <p className="text-lg font-semibold text-gray-900">
                {excess.excess_amount_required != null ? `£${Number(excess.excess_amount_required).toFixed(2)}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">{preAuthHeld > 0 ? 'Held' : 'Collected'}</p>
              <p className={`text-lg font-semibold ${preAuthHeld > 0 ? 'text-sky-700' : 'text-green-700'}`}>
                {preAuthHeld > 0
                  ? `£${preAuthHeld.toFixed(2)}`
                  : `£${Number(excess.excess_amount_taken || 0).toFixed(2)}`}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Status</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(excess.excess_status)}`}>
                {statusLabel(excess.excess_status)}
              </span>
            </div>
          </div>
          {/* Pre-auth hold: show expiry countdown so staff capture or release before
              Stripe / the acquirer auto-voids at the 5-day mark. */}
          {excess.excess_status === 'pre_auth' && excess.held_expires_at && (
            <div className="mt-3 px-3 py-2 bg-sky-50 border border-sky-200 rounded-md">
              <p className="text-xs text-sky-800">
                {(() => {
                  const expires = new Date(excess.held_expires_at);
                  const daysLeft = Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  const dateStr = expires.toLocaleDateString('en-GB');
                  if (daysLeft <= 0) return `Hold expired ${dateStr} — likely already auto-released by Stripe. Verify before capturing.`;
                  if (daysLeft === 1) return `Hold expires tomorrow (${dateStr}) — capture or release today.`;
                  return `Hold expires in ${daysLeft} days (${dateStr}). Capture what you need or release the rest before it auto-voids.`;
                })()}
              </p>
            </div>
          )}
          {excess.excess_status === 'released' && (Number(excess.amount_released || 0) > 0) && (
            <div className="mt-3 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
              <p className="text-xs text-gray-600">
                £{Number(excess.amount_released).toFixed(2)} released without capture
                {excess.released_at && ` on ${new Date(excess.released_at).toLocaleDateString('en-GB')}`}.
              </p>
            </div>
          )}
          {excess.receipt_required && !excess.receipt_uploaded_at && (
            <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
              <p className="text-xs text-amber-800">
                <span className="font-medium">Receipt scan outstanding</span> — this excess was taken/held on a
                card machine. Upload the receipt scan for audit (not blocking). Use the “Upload Receipt Scan” action.
              </p>
            </div>
          )}
          {excess.dispute_status && (
            <div className={`mt-3 px-3 py-2 rounded-md border ${excess.dispute_status === 'open' || excess.dispute_status === 'lost' ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
              <p className={`text-xs ${excess.dispute_status === 'open' || excess.dispute_status === 'lost' ? 'text-red-800' : 'text-gray-600'}`}>
                <span className="font-medium">
                  {excess.dispute_status === 'open' ? '⚠ Chargeback open' : `Chargeback ${excess.dispute_status}`}
                </span>
                {excess.dispute_status === 'open'
                  ? ' — a Stripe dispute is live on this excess. Respond in the Stripe dashboard before the evidence deadline.'
                  : excess.disputed_at ? ` — recorded ${new Date(excess.disputed_at).toLocaleDateString('en-GB')}.` : '.'}
              </p>
            </div>
          )}
          {excess.dispatch_override && (
            <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
              <p className="text-xs text-amber-700">
                <span className="font-medium">Dispatch override active</span>
                {excess.dispatch_override_reason && ` — ${excess.dispatch_override_reason}`}
              </p>
            </div>
          )}
          {excess.suggested_collection_method === 'pre_auth' && excess.excess_status === 'pending' && (
            <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
              <p className="text-xs text-blue-700">
                Short hire — pre-authorisation suggested to save card fees
              </p>
            </div>
          )}
        </div>

        {/* Nibble banner — appears when this excess has been partly claimed
            but not fully resolved. Surfaces the operational decision rather
            than letting staff drift into a chain-broken state at rollover. */}
        {!action && (() => {
          const claimed = Number(excess.claim_amount || 0);
          const taken = Number(excess.excess_amount_taken || 0);
          const reimbursed = Number(excess.reimbursement_amount || 0);
          const residual = Math.max(0, taken - claimed - reimbursed);
          const status = excess.excess_status;
          const terminal = ['waived', 'reimbursed', 'rolled_over', 'released', 'fully_claimed', 'not_required'];
          const isNibbled = claimed > 0.005 && !terminal.includes(status) && residual > 0.005;
          if (!isNibbled) return null;
          const required = Number(excess.excess_amount_required || 0);
          return (
            <div className="px-6 pt-4">
              <div className="px-3 py-3 text-xs bg-amber-50 border border-amber-300 rounded-md text-amber-900 space-y-2">
                <div className="font-semibold">Excess partly claimed — resolve before close-out</div>
                <div className="grid grid-cols-3 gap-2 text-[11px] bg-white/60 rounded px-2 py-1.5">
                  <div><span className="text-gray-600">Claimed</span><br/><strong>£{claimed.toFixed(2)}</strong></div>
                  <div><span className="text-gray-600">Reimbursed</span><br/><strong>£{reimbursed.toFixed(2)}</strong></div>
                  <div><span className="text-gray-600">Residual</span><br/><strong>£{residual.toFixed(2)}</strong></div>
                </div>
                <p>
                  Pick one of: <em>Reimburse residual</em> to send the £{residual.toFixed(2)} back,
                  {required > taken + 0.005 && <> <em>Top up to required</em> (collect the shortfall),</>}
                  {' '}or <em>Roll forward</em> as-is (next hire sees £{residual.toFixed(2)} only).
                </p>
                <p className="italic text-amber-800">
                  Leaving the record unresolved here means future rollovers only forward £{residual.toFixed(2)} — and any top-up after rollover breaks the HireHop chain.
                </p>
              </div>
            </div>
          );
        })()}

        {/* Action selection */}
        {!action && (
          <div className="px-6 py-4">
            <p className="text-sm font-medium text-gray-700 mb-3">Choose an action:</p>
            <div className="space-y-2">
              {availableActions.map((a) => (
                <button
                  key={a.action}
                  onClick={() => setAction(a.action)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    a.recommended
                      ? 'border-emerald-300 bg-emerald-50 hover:border-emerald-400 hover:bg-emerald-100'
                      : 'border-gray-200 hover:border-ooosh-300 hover:bg-ooosh-50'
                  }`}
                >
                  <span className={`inline-block w-6 text-center mr-2 font-mono ${a.recommended ? 'text-emerald-600' : 'text-gray-400'}`}>{a.icon}</span>
                  <span className="text-sm font-medium text-gray-900">{a.label}</span>
                  {a.recommended && (
                    <span className="ml-2 inline-block text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-100 border border-emerald-200 rounded-full px-2 py-0.5">
                      Recommended · short hire
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Action forms */}
        {action && (
          <div className="px-6 py-4">
            <button
              onClick={() => { setAction(null); setError(''); setReceiptMode('choose'); setQrToken(null); setQrUrl(null); setChainBreakWarning(null); setAcknowledgeChainBreak(false); }}
              className="text-xs text-gray-500 hover:text-gray-700 mb-3 flex items-center gap-1"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              Back to actions
            </button>

            {action === 'payment' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Record Payment</h3>
                {chainBreakWarning && (
                  <div className="px-3 py-3 text-xs bg-amber-50 border border-amber-300 rounded-md text-amber-900 space-y-2">
                    <div className="font-semibold">Chain-break warning — rolled-forward excess</div>
                    <p>{chainBreakWarning.message}</p>
                    <div className="grid grid-cols-3 gap-2 text-[11px] bg-white/60 rounded px-2 py-1.5">
                      <div><span className="text-gray-600">Current</span><br/><strong>£{chainBreakWarning.current_collected.toFixed(2)}</strong></div>
                      <div><span className="text-gray-600">Required</span><br/><strong>£{chainBreakWarning.required.toFixed(2)}</strong></div>
                      <div><span className="text-gray-600">Residual</span><br/><strong>£{chainBreakWarning.residual.toFixed(2)}</strong></div>
                    </div>
                    <p className="italic">{chainBreakWarning.suggestion_reason}</p>
                    <label className="flex items-start gap-2 cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={acknowledgeChainBreak}
                        onChange={(e) => setAcknowledgeChainBreak(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span className="text-amber-900">
                        I understand — the top-up will be saved in OP but <strong>won't be tied to the HireHop chain</strong>. Future rollovers will only forward the original amount.
                      </span>
                    </label>
                  </div>
                )}
                {payHHPushError && (
                  <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-800">
                    <div className="font-semibold mb-1">Saved in OP — HireHop push failed</div>
                    <div>{payHHPushError}</div>
                    <div className="mt-1 text-amber-700">
                      The excess record is correct in OP. Record the deposit manually in HireHop and use Manage &gt; Link to HH to reconcile.
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Total collected</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      value={payTotalCollected}
                      onChange={(e) => setPayTotalCollected(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {previousTaken > 0
                      ? <>Currently collected: <span className="font-medium">£{previousTaken.toFixed(2)}</span>. Required: £{requiredAmount.toFixed(2)}. Setting this saves the new total — not adding to it.</>
                      : <>Required: £{requiredAmount.toFixed(2)}. Enter the total amount you've collected (usually the full required amount).</>
                    }
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reference (optional)</label>
                  <input
                    type="text"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    placeholder="Stripe ID, transfer ref, etc."
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={payPushToHH}
                    onChange={(e) => setPayPushToHH(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Also create deposit in HireHop
                </label>
              </div>
            )}

            {action === 'claim' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Apply to HireHop Invoice</h3>
                <p className="text-xs text-gray-500">
                  Available balance: <span className="font-medium">£{claimAvailable.toFixed(2)}</span>
                  {Number(excess.claim_amount || 0) > 0 && (
                    <> · Already claimed: £{Number(excess.claim_amount || 0).toFixed(2)}</>
                  )}
                </p>

                {/* Invoice picker — HH-linked records only. The deposit gets
                    applied to the chosen invoice. The invoice's line item carries
                    the right Xero nominal (Vehicle damage / Misc / extra hire /
                    cleaning / etc.) so claims against different categories all
                    route correctly without OP needing to know about nominals. */}
                {isHhLinked && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Apply to invoice (this job)</label>
                    {loadingInvoices ? (
                      <div className="text-xs text-gray-500 py-2">Loading outstanding invoices...</div>
                    ) : invoicesError ? (
                      <div className="text-xs text-red-600 py-2">{invoicesError}</div>
                    ) : outstandingInvoices.length === 0 ? (
                      <div className="text-xs bg-amber-50 border border-amber-200 rounded-md p-3 text-amber-900">
                        <strong>No outstanding invoices on this HireHop job.</strong>
                        <br />
                        Create the invoice in HireHop first (with the appropriate nominal — e.g. Vehicle damage, Misc income, extra hire), or apply to another of this client's jobs below.
                      </div>
                    ) : (
                      <select
                        value={targetHhJob == null ? (claimInvoiceId ?? '') : ''}
                        onChange={(e) => selectOwnJobInvoice(e.target.value ? Number(e.target.value) : null)}
                        className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                      >
                        <option value="">-- Pick an invoice --</option>
                        {outstandingInvoices.map((inv) => (
                          <option key={inv.id} value={inv.id}>
                            {inv.number} · £{inv.owing.toFixed(2)} owing · {inv.description.substring(0, 60)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {/* Cross-job apply (same client) — CROSS-JOB-EXCESS-APPLY-SPEC.
                    Scoped to the same client (the correctness + size boundary). */}
                {isHhLinked && (
                  <div className="border border-gray-200 rounded-md">
                    <button
                      type="button"
                      onClick={() => { const next = !crossJobOpen; setCrossJobOpen(next); if (next) loadCrossJobInvoices(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <span>Apply to another job (same client)</span>
                      <span className="text-gray-400">{crossJobOpen ? '▾' : '▸'}</span>
                    </button>
                    {crossJobOpen && (
                      <div className="px-3 pb-3 space-y-3 border-t border-gray-100 pt-3">
                        {loadingCrossJob ? (
                          <div className="text-xs text-gray-500">Loading this client's other jobs…</div>
                        ) : crossJobError ? (
                          <div className="text-xs text-red-600">{crossJobError}</div>
                        ) : crossJobData.length === 0 ? (
                          <div className="text-xs text-gray-500">No other jobs with an outstanding balance for this client. Use the job-number lookup below if you know the job.</div>
                        ) : (
                          <div className="space-y-2">
                            {crossJobData.map((grp) => (
                              <div key={grp.hh_job_number}>
                                <div className="text-xs font-semibold text-gray-700">#{grp.hh_job_number}{grp.job_name ? ` — ${grp.job_name}` : ''}</div>
                                {grp.invoices.map((inv) => (
                                  <label key={inv.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                                    <input
                                      type="radio"
                                      name="crossJobInvoice"
                                      checked={targetHhJob === grp.hh_job_number && claimInvoiceId === inv.id}
                                      onChange={() => selectCrossJobInvoice(grp.hh_job_number, inv.id)}
                                    />
                                    <span>{inv.number} · £{inv.owing.toFixed(2)} owing · {inv.description.substring(0, 50)}</span>
                                  </label>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="pt-1">
                          <label className="block text-xs font-medium text-gray-600 mb-1">…or enter a job number</label>
                          <div className="flex gap-2">
                            <input
                              type="number"
                              value={manualJobNum}
                              onChange={(e) => setManualJobNum(e.target.value)}
                              placeholder="e.g. 15278"
                              className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5"
                            />
                            <button type="button" onClick={lookupManualJob} className="px-3 py-1.5 text-xs font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md">Look up</button>
                          </div>
                          {manualJobError && <div className="text-xs text-red-600 mt-1">{manualJobError}</div>}
                          {manualJobResult && (
                            <div className="mt-2 space-y-1">
                              {!manualJobResult.same_client && (
                                <div className="text-xs bg-red-50 border border-red-200 rounded p-2 text-red-700">⚠ Different client — applying one client's excess to another's invoice is almost always wrong. A manager override is required.</div>
                              )}
                              <div className="text-xs font-semibold text-gray-700">#{manualJobResult.hh_job_number}{manualJobResult.job_name ? ` — ${manualJobResult.job_name}` : ''}</div>
                              {manualJobResult.invoices.map((inv) => (
                                <label key={inv.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name="crossJobInvoice"
                                    checked={targetHhJob === manualJobResult.hh_job_number && claimInvoiceId === inv.id}
                                    onChange={() => selectCrossJobInvoice(manualJobResult.hh_job_number, inv.id)}
                                  />
                                  <span>{inv.number} · £{inv.owing.toFixed(2)} owing · {inv.description.substring(0, 50)}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Confirmable bank attribution — defaults to the source deposit's
                    likely bank; the server resolves authoritatively if left on
                    "Auto". Replaces the old hardcoded Worldpay (which mis-attributed
                    e.g. a Wise-collected excess). */}
                {isHhLinked && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Bank attribution (HireHop/Xero)</label>
                    <select
                      value={claimBank}
                      onChange={(e) => setClaimBank(e.target.value ? Number(e.target.value) : '')}
                      className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                    >
                      <option value="">Auto — resolve from original deposit</option>
                      {HH_BANKS.map((b) => (
                        <option key={b.id} value={b.id}>{b.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-400 mt-1">No cash moves — this only sets which bank the reallocation is attributed to. Confirm it matches how the excess was originally collected.</p>
                  </div>
                )}

                {targetHhJob != null && (
                  <div className="text-xs bg-blue-50 border border-blue-200 rounded p-2 text-blue-800">
                    Applying to an invoice on <strong>job #{targetHhJob}</strong> (different job, same client). Job #{targetHhJob} will read it as settled; this excess records the claim.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Claim amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      max={claimAvailable}
                      value={claimAmount}
                      onChange={(e) => setClaimAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
                  <textarea
                    value={claimNotes}
                    onChange={(e) => setClaimNotes(e.target.value)}
                    placeholder="e.g. Underfuelled — full tank £120"
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                {isHhLinked && outstandingInvoices.length > 0 && (
                  <p className="text-xs text-gray-500 italic">
                    The invoice's line items determine the Xero nominal. Multiple claims are allowed — the remaining balance stays available for further nibbles or eventual reimbursement.
                  </p>
                )}
              </div>
            )}

            {action === 'reimburse' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Reimburse Excess</h3>
                <p className="text-xs text-gray-500">
                  Amount available to reimburse: £{amountHeld.toFixed(2)}
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reimburse Amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      max={amountHeld}
                      value={reimburseAmount}
                      onChange={(e) => setReimburseAmount(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                  <select
                    value={reimburseMethod}
                    onChange={(e) => setReimburseMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {REIMBURSE_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* No-PaymentIntent loud fail: OP can't fire the Stripe refund
                    because this record has no PI stored. Staff must refund in the
                    Stripe dashboard and tick to record it, rather than OP silently
                    recording a refund that never reaches Stripe. */}
                {noStripePiWarning && reimburseMethod === 'stripe_gbp' && (
                  <div className="border border-amber-300 bg-amber-50 rounded-md p-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-900">
                      OP can’t refund this in Stripe automatically
                    </p>
                    <p className="text-xs text-amber-800">{noStripePiWarning}</p>
                    <label className="flex items-start gap-2 text-xs text-amber-900 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acknowledgeNoStripePi}
                        onChange={(e) => setAcknowledgeNoStripePi(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        I’ve <strong>already refunded this in the Stripe dashboard</strong> —
                        record it in OP only (no Stripe API refund will be sent).
                      </span>
                    </label>
                  </div>
                )}

                {/* Residual handling — only when refunding less than the held
                    balance. Forces a conscious choice so the remainder doesn't
                    sit as phantom-held (the job 14871 bug). */}
                {reimburseResidual > 0.005 && (
                  <div className="border border-amber-200 bg-amber-50 rounded-md p-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-900">
                      £{reimburseResidual.toFixed(2)} will remain after this refund. What happens to it?
                    </p>
                    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="radio"
                        name="residual"
                        checked={!retainResidual}
                        onChange={() => setRetainResidual(false)}
                        className="mt-0.5"
                      />
                      <span>
                        <strong>Still owed to the client</strong> — keep it held and refund later.
                        Record stays <em>Partially Reimbursed</em>.
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="radio"
                        name="residual"
                        checked={retainResidual}
                        onChange={() => setRetainResidual(true)}
                        className="mt-0.5"
                      />
                      <span>
                        <strong>Retained by Ooosh</strong> (damage / admin) — booked as a claim,
                        nothing left held. Record resolves to <em>Reimbursed</em>.
                      </span>
                    </label>
                  </div>
                )}

                {/* Bank details — only for bank-transfer methods. Stored encrypted,
                    scoped to this record. Reuse-from-previous offered when the
                    client has details on a prior hire (with staleness heads-up). */}
                {BANK_TRANSFER_METHODS.includes(reimburseMethod) && (
                  <div className="border border-gray-200 rounded-md p-3 space-y-3 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-700">Client bank details</span>
                      <span className="text-[10px] text-gray-400">encrypted at rest</span>
                    </div>

                    {/* Reuse-from-previous offer */}
                    {previousBank && !bankCapture && (
                      <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-800 space-y-1">
                        <div>
                          Saved details on file for this client
                          {previousBank.source_hh_job ? <> (from hire #{previousBank.source_hh_job})</> : null}.
                        </div>
                        {previousBank.last_used_at && (
                          <div className="text-blue-600">
                            Last used {new Date(previousBank.last_used_at).toLocaleDateString('en-GB')} — confirm they're still current with the client.
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            const d = previousBank.data;
                            setBankType(d.type);
                            setBankHolder(d.accountHolder || '');
                            setBankSortCode(d.sortCode || '');
                            setBankAccountNumber(d.accountNumber || '');
                            setBankIban(d.iban || '');
                            setBankSwift(d.swiftBic || '');
                            setBankCountry(d.bankCountry || '');
                            setBankCapture(true);
                          }}
                          className="mt-1 px-2 py-1 text-xs font-medium text-blue-700 bg-white border border-blue-300 rounded hover:bg-blue-100"
                        >
                          Reuse these details
                        </button>
                      </div>
                    )}

                    {!bankCapture ? (
                      <button
                        type="button"
                        onClick={() => setBankCapture(true)}
                        className="text-xs font-medium text-ooosh-600 hover:text-ooosh-700"
                      >
                        + Enter bank details
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setBankType('uk')}
                            className={`flex-1 px-2 py-1 text-xs rounded border ${bankType === 'uk' ? 'bg-ooosh-50 border-ooosh-300 text-ooosh-700 font-medium' : 'border-gray-300 text-gray-600'}`}
                          >UK</button>
                          <button
                            type="button"
                            onClick={() => setBankType('international')}
                            className={`flex-1 px-2 py-1 text-xs rounded border ${bankType === 'international' ? 'bg-ooosh-50 border-ooosh-300 text-ooosh-700 font-medium' : 'border-gray-300 text-gray-600'}`}
                          >International</button>
                        </div>
                        <input
                          type="text"
                          value={bankHolder}
                          onChange={(e) => setBankHolder(e.target.value)}
                          placeholder="Account holder name"
                          className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                        />
                        {bankType === 'uk' ? (
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              type="text"
                              value={bankSortCode}
                              onChange={(e) => setBankSortCode(e.target.value)}
                              placeholder="Sort code"
                              className="text-sm border border-gray-300 rounded-md px-3 py-2"
                            />
                            <input
                              type="text"
                              value={bankAccountNumber}
                              onChange={(e) => setBankAccountNumber(e.target.value)}
                              placeholder="Account number"
                              className="text-sm border border-gray-300 rounded-md px-3 py-2"
                            />
                          </div>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={bankIban}
                              onChange={(e) => setBankIban(e.target.value)}
                              placeholder="IBAN"
                              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                            />
                            <div className="grid grid-cols-2 gap-2">
                              <input
                                type="text"
                                value={bankSwift}
                                onChange={(e) => setBankSwift(e.target.value)}
                                placeholder="SWIFT / BIC"
                                className="text-sm border border-gray-300 rounded-md px-3 py-2"
                              />
                              <input
                                type="text"
                                value={bankCountry}
                                onChange={(e) => setBankCountry(e.target.value)}
                                placeholder="Bank country"
                                className="text-sm border border-gray-300 rounded-md px-3 py-2"
                              />
                            </div>
                          </>
                        )}
                        <p className="text-[10px] text-gray-400">
                          Stored encrypted against this hire. Leave the "Enter bank details" step skipped to reimburse without recording them.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {action === 'waive' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Waive Excess</h3>
                <p className="text-xs text-red-600">This will permanently mark this excess as not required.</p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                  <textarea
                    value={waiveReason}
                    onChange={(e) => setWaiveReason(e.target.value)}
                    placeholder="Why is this excess being waived?"
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'mark_externally_resolved' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Mark as Externally Resolved</h3>
                <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-900">
                  <p className="font-semibold mb-1">Cleanup action — not for normal flows.</p>
                  <p>
                    Use this when money has already flowed in <strong>and back out</strong> of OP's
                    awareness (e.g. a hire that was collected and refunded directly in HireHop
                    or Stripe before OP's auto-reconciliation existed). This single step records
                    both the collection and the reimbursement in OP and flips the record to{' '}
                    <strong>Reimbursed</strong>. Nothing is pushed to HireHop — the assumption is
                    HireHop already reflects the truth.
                  </p>
                  <p className="mt-1">For normal collection use <em>Record Payment</em>; for normal reimbursement use <em>Reimburse</em>.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Amount £</label>
                  <input
                    type="number"
                    step="0.01"
                    value={extResolvedAmount}
                    onChange={(e) => setExtResolvedAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
                  <select
                    value={extResolvedMethod}
                    onChange={(e) => setExtResolvedMethod(e.target.value as typeof extResolvedMethod)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="stripe_gbp">Stripe GBP</option>
                    <option value="worldpay">Worldpay</option>
                    <option value="amex">Amex</option>
                    <option value="wise_bacs">Wise (BACS)</option>
                    <option value="lloyds_bank">Lloyds Bank</option>
                    <option value="till_cash">Cash</option>
                    <option value="paypal">PayPal</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Reference (optional)</label>
                  <input
                    type="text"
                    value={extResolvedReference}
                    onChange={(e) => setExtResolvedReference(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g. Stripe charge id, HH deposit #"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Reason <span className="text-red-600">*</span></label>
                  <textarea
                    value={extResolvedReason}
                    onChange={(e) => setExtResolvedReason(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    placeholder="Why is this being marked externally resolved? (e.g. 'HH-side refund pre-dating auto-reconciliation')"
                  />
                </div>
              </div>
            )}

            {action === 'edit_required' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Edit Required Amount</h3>
                <p className="text-xs text-gray-500">
                  Use this when an insurance referral returns a revised excess, or to correct the required figure on this record.
                  The amount already collected is not changed.
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Required Amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editRequiredAmount}
                      onChange={(e) => setEditRequiredAmount(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason / Calculation Basis</label>
                  <textarea
                    value={editRequiredReason}
                    onChange={(e) => setEditRequiredReason(e.target.value)}
                    placeholder="e.g. Insurer referral — 6 pts, SP30 + IN10, excess raised to £1,800"
                    rows={3}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    Stored on this excess record as the calculation basis — helps later staff understand why.
                  </p>
                </div>
                {excess.excess_amount_taken != null && Number(excess.excess_amount_taken) > 0 && (
                  <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-xs text-blue-700">
                      £{Number(excess.excess_amount_taken).toFixed(2)} has already been collected against this record —
                      adjusting the required amount may surface a new outstanding balance.
                    </p>
                  </div>
                )}
              </div>
            )}

            {action === 'rollover' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Roll Over to Next Hire</h3>
                <p className="text-xs text-gray-500">
                  Mark £{Number(excess.excess_amount_taken || 0).toFixed(2)} as held on account for the client's next hire.
                  This amount will appear as a credit on their next excess requirement.
                </p>
              </div>
            )}

            {action === 'rollover_apply' && rolloverInfo?.available && (() => {
              const available = Number(rolloverInfo.amount_available || 0);
              const required = Number(excess.excess_amount_required || 0);
              // Source has been nibbled when the available rollover comes in
              // under the new hire's required figure. Flag the shortfall so
              // staff know what they're forwarding.
              const shortfall = required > available + 0.005 ? required - available : 0;
              return (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Apply Rolled Over Excess</h3>
                <div className="text-xs bg-purple-50 border border-purple-200 rounded-md p-3 text-purple-900">
                  <strong>£{available.toFixed(2)}</strong> available
                  {rolloverInfo.source_hh_job ? <> from previous hire <strong>#{rolloverInfo.source_hh_job}</strong></> : ' from a previous hire'}.
                  <br />
                  <span className="text-purple-700">No money moves — the existing deposit on the previous hire is being earmarked for this hire.</span>
                </div>
                {shortfall > 0 && (
                  <div className="text-xs bg-amber-50 border border-amber-300 rounded-md p-3 text-amber-900">
                    <strong>Heads up — source was partly claimed.</strong> The previous hire's excess
                    has been nibbled (claim or partial reimbursement), so only{' '}
                    <strong>£{available.toFixed(2)}</strong> rolls forward against the
                    <strong> £{required.toFixed(2)}</strong> required here — a shortfall of{' '}
                    <strong>£{shortfall.toFixed(2)}</strong>.
                    Apply this amount AND top up the residual separately if you need full cover,
                    OR proceed with the under-cover (insurance gap noted).
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Amount to apply</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={rolloverInfo.amount_available}
                      value={rolloverApplyAmount}
                      onChange={(e) => setRolloverApplyAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Pre-filled with the lesser of (required £{required.toFixed(2)}) and (available £{available.toFixed(2)}).
                  </p>
                </div>
              </div>
              );
            })()}

            {action === 'move' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Move to Different Entity</h3>
                <p className="text-xs text-gray-500">
                  Reassign this excess to a different client (e.g. management company paying instead of band).
                </p>
                <div className="relative">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Search Organisation or Person</label>
                  {moveXeroName ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                      <span className="text-sm text-gray-900 flex-1">{moveXeroName}</span>
                      <button
                        type="button"
                        onClick={() => { setMoveXeroName(''); setMoveXeroId(''); setMoveSearch(''); }}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={moveSearch}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMoveSearch(val);
                          if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
                          if (val.length >= 2) {
                            setMoveSearching(true);
                            moveTimerRef.current = setTimeout(async () => {
                              try {
                                const data = await api.get<{ results: Array<{ id: string; name: string; subtitle: string; type: string }> }>(`/search?q=${encodeURIComponent(val)}&limit=8`);
                                setMoveResults(data.results.filter(r => r.type === 'organisation' || r.type === 'person'));
                              } catch { setMoveResults([]); }
                              setMoveSearching(false);
                            }, 300);
                          } else {
                            setMoveResults([]);
                          }
                        }}
                        placeholder="Type to search..."
                        className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                      />
                      {(moveResults.length > 0 || moveSearching) && (
                        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                          {moveSearching && <p className="px-3 py-2 text-xs text-gray-400">Searching...</p>}
                          {moveResults.map(r => (
                            <button
                              key={`${r.type}-${r.id}`}
                              type="button"
                              onClick={() => {
                                setMoveXeroName(r.name);
                                setMoveXeroId(r.id);
                                setMoveSearch('');
                                setMoveResults([]);
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                            >
                              <span className="text-sm text-gray-900">{r.name}</span>
                              <span className="text-xs text-gray-400 ml-2">
                                {r.type === 'organisation' ? 'Org' : 'Person'}
                                {r.subtitle && ` · ${r.subtitle}`}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
                  <input
                    type="text"
                    value={moveReason}
                    onChange={(e) => setMoveReason(e.target.value)}
                    placeholder="Why is this being moved?"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'capture' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Capture Pre-Auth</h3>
                {captureWarning && (
                  <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-800">
                    <div className="font-semibold mb-1">Captured — follow-up needed</div>
                    <div>{captureWarning}</div>
                  </div>
                )}
                <div className="px-3 py-2 bg-sky-50 border border-sky-200 rounded-md text-xs text-sky-800">
                  £{preAuthHeld.toFixed(2)} is on hold. Capturing is <strong>one-shot</strong> — whatever you
                  don't capture is released automatically (Stripe / the card machine voids the rest).
                  You can't capture again from this hold afterwards.
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Amount to capture</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      value={captureAmount}
                      onChange={(e) => setCaptureAmount(e.target.value)}
                      className="w-full text-sm border border-gray-300 rounded-md pl-7 pr-3 py-2"
                    />
                  </div>
                  {parseFloat(captureAmount) > 0 && parseFloat(captureAmount) < preAuthHeld && (
                    <p className="mt-1 text-xs text-gray-500">
                      £{(preAuthHeld - parseFloat(captureAmount)).toFixed(2)} will be released.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hold channel</label>
                  <select
                    value={captureMethod}
                    onChange={(e) => setCaptureMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {CAPTURE_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    {captureMethod === 'stripe_gbp'
                      ? 'OP captures via the Stripe API automatically.'
                      : 'Capture the amount on the card machine, then record it here. The rest releases on the acquirer\'s clock.'}
                  </p>
                </div>
                {isHhLinked && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Apply to invoice (optional)
                    </label>
                    {loadingInvoices ? (
                      <p className="text-xs text-gray-500">Loading invoices…</p>
                    ) : invoicesError ? (
                      <p className="text-xs text-red-600">{invoicesError}</p>
                    ) : outstandingInvoices.length === 0 ? (
                      <p className="text-xs text-gray-500">
                        No outstanding invoices. Capture now and apply later via Claim, or create the
                        invoice in HireHop first.
                      </p>
                    ) : (
                      <select
                        value={captureInvoiceId ?? ''}
                        onChange={(e) => setCaptureInvoiceId(e.target.value ? Number(e.target.value) : null)}
                        className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                      >
                        <option value="">Don't apply yet — just capture</option>
                        {outstandingInvoices.map((inv) => (
                          <option key={inv.id} value={inv.id}>
                            {inv.number} · £{inv.owing.toFixed(2)} owing
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="mt-1 text-xs text-gray-500">
                      Applying earmarks the captured money against a HireHop invoice in one step. Leave
                      unset to capture into the account and decide later.
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                  <input
                    type="text"
                    value={captureReason}
                    onChange={(e) => setCaptureReason(e.target.value)}
                    placeholder="e.g. Underfuelling, damage to nearside panel"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
                  <textarea
                    value={captureNotes}
                    onChange={(e) => setCaptureNotes(e.target.value)}
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'release' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Release Hold</h3>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-xs text-gray-700">
                  Releases the full £{preAuthHeld.toFixed(2)} hold without capturing any of it. No money
                  moves.
                  {excess.payment_method === 'stripe_gbp'
                    ? ' OP voids the Stripe hold immediately.'
                    : ' The card machine hold expires on the acquirer\'s clock — this just records that we\'re not claiming it.'}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
                  <input
                    type="text"
                    value={releaseReason}
                    onChange={(e) => setReleaseReason(e.target.value)}
                    placeholder="e.g. Van returned clean, no charges"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
                  <textarea
                    value={releaseNotes}
                    onChange={(e) => setReleaseNotes(e.target.value)}
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'record_preauth' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Record Pre-Auth Hold</h3>
                <div className="px-3 py-2 bg-sky-50 border border-sky-200 rounded-md text-xs text-sky-800">
                  Logs a pre-authorisation <strong>hold</strong> — money on hold, not in our account.
                  No HireHop deposit is created now; that happens when you capture the hold.
                  The record moves to <strong>Pre-auth Held</strong> and you can capture or release it later.
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hold amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      value={preauthAmount}
                      onChange={(e) => setPreauthAmount(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                  {requiredAmount > 0 && (
                    <p className="mt-1 text-xs text-gray-500">Required: £{requiredAmount.toFixed(2)}.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                  <select
                    value={preauthMethod}
                    onChange={(e) => setPreauthMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {PREAUTH_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  {preauthMethod !== 'stripe_gbp' && (
                    <p className="mt-1 text-xs text-gray-500">
                      Card-machine hold — you'll be asked for a receipt scan (audit to-do, not blocking).
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Auth ref (optional)</label>
                    <input
                      type="text"
                      value={preauthReference}
                      onChange={(e) => setPreauthReference(e.target.value)}
                      placeholder="Terminal auth code"
                      className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Expires (days)</label>
                    <input
                      type="number"
                      min="1"
                      max="30"
                      value={preauthExpiryDays}
                      onChange={(e) => setPreauthExpiryDays(e.target.value)}
                      className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
                  <textarea
                    value={preauthNotes}
                    onChange={(e) => setPreauthNotes(e.target.value)}
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'upload_receipt' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Upload Receipt Scan</h3>
                <p className="text-xs text-gray-500">
                  Attach the card-machine receipt for this excess (audit record). Clears the outstanding to-do.
                </p>

                {receiptMode === 'choose' && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={startQr}
                      disabled={qrLoading}
                      className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-ooosh-300 hover:bg-ooosh-50 disabled:opacity-50"
                    >
                      <span className="text-sm font-medium text-gray-900">📱 Scan with phone</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        {qrLoading ? 'Generating QR…' : 'Show a QR code, photograph the receipt on your phone'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setReceiptMode('device')}
                      className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-ooosh-300 hover:bg-ooosh-50"
                    >
                      <span className="text-sm font-medium text-gray-900">💻 Upload from this device</span>
                      <span className="block text-xs text-gray-500 mt-0.5">Choose a file already saved here</span>
                    </button>
                    {qrError && <p className="text-xs text-red-600">{qrError}</p>}
                  </div>
                )}

                {receiptMode === 'device' && (
                  <div className="space-y-2">
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      capture="environment"
                      onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                      className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 file:mr-3 file:px-3 file:py-1 file:rounded file:border-0 file:bg-ooosh-50 file:text-ooosh-700"
                    />
                    {receiptUploading && <p className="text-xs text-gray-500">Uploading…</p>}
                    <button type="button" onClick={() => { setReceiptMode('choose'); setReceiptFile(null); }} className="text-xs text-gray-500 hover:text-gray-700">
                      ← Back
                    </button>
                  </div>
                )}

                {receiptMode === 'qr' && qrUrl && (
                  <div className="flex flex-col items-center text-center space-y-3 py-2">
                    <div className="bg-white p-3 rounded-lg border border-gray-200">
                      <QRCodeSVG value={qrUrl} size={180} />
                    </div>
                    <p className="text-sm text-gray-700">Scan with your phone camera, then photograph the receipt.</p>
                    <p className="text-xs text-gray-400 flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
                      Waiting for the upload from your phone…
                    </p>
                    <button type="button" onClick={() => { setReceiptMode('choose'); setQrToken(null); setQrUrl(null); }} className="text-xs text-gray-500 hover:text-gray-700">
                      ← Back
                    </button>
                  </div>
                )}
              </div>
            )}

            {action === 'unlink_deposit' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Unlink HireHop Deposit</h3>
                <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800 space-y-1">
                  <p>
                    This record is linked to HireHop deposit <strong>#{excess.hh_deposit_id}</strong>.
                    Use this when the deposit was wrongly classified as excess (e.g. a Stripe URL containing "xs" in its path).
                  </p>
                  <p className="mt-2">
                    Unlinking will:
                  </p>
                  <ul className="list-disc list-inside ml-2 space-y-0.5">
                    <li>Clear the HireHop link on this record</li>
                    <li>Reset Collected to £0.00 on this record</li>
                    <li>Recompute the status (likely back to Needed)</li>
                  </ul>
                  <p className="mt-2">
                    The HireHop deposit itself is <strong>not touched</strong> — it stays in HireHop as a hire payment. You may still want to fix its description/memo on the HireHop side so the classifier doesn't re-match it on the next Money tab load.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <p className="mt-3 text-xs text-red-600">{error}</p>
            )}

            <div className="mt-4 flex gap-2">
              {/* Confirm is hidden on the receipt step unless a file is staged on
                  this device — the QR path completes via the phone + poll, and the
                  choose screen has nothing to confirm yet. */}
              {!(action === 'upload_receipt' && receiptMode !== 'device') && (
                <button
                  onClick={handleSubmit}
                  // Chain-break warning forces an explicit ack tick before Confirm fires.
                  disabled={loading || (action === 'payment' && !!chainBreakWarning && !acknowledgeChainBreak)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50"
                >
                  {loading ? 'Processing...' : 'Confirm'}
                </button>
              )}
              <button
                onClick={handleClose}
                className={`px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md ${action === 'upload_receipt' && receiptMode !== 'device' ? 'flex-1' : ''}`}
              >
                {action === 'upload_receipt' && receiptMode !== 'device' ? 'Close' : 'Cancel'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
