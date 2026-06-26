/**
 * CostCaptureModal — capture or edit a cost/receipt for the Cost Capture &
 * Recharge module. Creates (POST) or updates (PATCH) a `costs` row.
 *
 * Layout: two panes on md+ (receipt left, form right, draggable divider that
 * remembers width). Stacks on mobile. Click backdrop or press Esc to close.
 *
 * The "What's this cost for?" picker groups options under headings and drives
 * both the Xero account code and the internal cost_type (staff never see codes
 * or accountant terms). Supplier field autocompletes from existing Xero
 * contacts so we don't accumulate typo-duplicates.
 *
 * Net / VAT / Gross auto-calculate at 20% (toggle off to edit manually).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { hasManagerRole } from '../lib/roles';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { Cost, CostType, CostPaymentMethod, CostPaymentStatus, CostRechargeMode, CostIntent } from '../../../shared/types';

interface Props {
  onClose: () => void;
  // null when a vehicle service record was saved with no cost (service-only).
  onSaved: (cost: Cost | null) => void;
  // When set + the user ticked "covers multiple jobs", called instead of onSaved
  // so the parent can open the allocation/split modal for the new cost.
  onSavedAndSplit?: (cost: Cost) => void;
  existing?: Cost | null;
  presetJobId?: string | null;
  presetVehicleId?: string | null;
  presetIssueId?: string | null;
}

// Single source of truth for the staff-facing category picker. Each choice
// maps to a Xero account code (for the eventual push) + an internal cost_type
// (for filtering/reporting). Staff see only `label`, grouped under `group`.
// Keep in step with STAFF_COST_ACCOUNT_CODES in backend routes/costs.ts.
const COST_CATEGORIES: { group: string; label: string; xeroCode: string; costType: CostType }[] = [
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
const PAYMENT_METHODS: { group: string; value: CostPaymentMethod; label: string }[] = [
  { group: 'Paid already', value: 'cot_card',        label: 'Company card (COT)' },
  { group: 'Paid already', value: 'amex',            label: 'Amex card' },
  { group: 'Paid already', value: 'lloyds_cc',       label: 'Lloyds credit card' },
  { group: 'Paid already', value: 'petty_cash',      label: 'Petty cash' },
  { group: 'Paid already', value: 'paypal',          label: 'PayPal' },
  { group: 'Paid already', value: 'wise',            label: 'Wise bank transfer' },
  { group: 'Paid already', value: 'lloyds_transfer', label: 'Lloyds bank transfer' },
  { group: 'Pay later',    value: 'not_yet_paid',    label: 'Supplier bill (pay later)' },
  { group: 'Pay later',    value: 'reimburse_me',    label: 'Reimburse me (pay later)' },
];
const PAYMENT_METHOD_GROUPS = Array.from(new Set(PAYMENT_METHODS.map((m) => m.group)));
// Keep in step with BILL_METHODS in backend routes/costs.ts + cost-xero-push.ts.
const BILL_METHODS: CostPaymentMethod[] = ['not_yet_paid', 'reimburse_me'];

// 'reclaim' = non-standard "VAT-only" invoice (insurance claim): enter the
// No-VAT amount (the excess) as Net + the reclaimable VAT; gross = net + vat.
// Pushed to Xero as the 3-line VAT-only structure (vat_treatment='reclaim_split').
type VatMode = 'vat20' | 'none' | 'manual' | 'reclaim';

const PAYMENT_STATUSES: { value: CostPaymentStatus; label: string }[] = [
  { value: 'paid', label: 'Paid' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
  { value: 'awaiting_invoice', label: 'Awaiting invoice' },
];

const SPLIT_KEY = 'ooosh_cost_modal_split_pct';
const round2 = (n: number) => Math.round(n * 100) / 100;

interface XeroContactLite { ContactID: string; Name: string }
interface JobSuggestion { id: string; type: string; name: string; subtitle?: string }
type ExistingRow = (Cost & { hh_job_number?: number | null; job_name?: string | null }) | null | undefined;

export default function CostCaptureModal({ onClose, onSaved, onSavedAndSplit, existing, presetJobId, presetVehicleId, presetIssueId }: Props) {
  const existingRow = existing as ExistingRow;
  const { user } = useAuthStore();
  const isEdit = Boolean(existing);

  // ── Form state ───────────────────────────────────────────────────────────
  const [supplierName, setSupplierName] = useState(existing?.supplier_name || '');
  // Xero contact id of a picked supplier suggestion — lets terms resolve by
  // stable id + seed from Xero. Cleared when the name is hand-edited (the id no
  // longer matches what's typed).
  const [xeroContactId, setXeroContactId] = useState<string | null>(existing?.xero_contact_id || null);
  const [costDate, setCostDate] = useState(() => (existing?.cost_date ? existing.cost_date.slice(0, 10) : new Date().toISOString().slice(0, 10)));
  const [invoiceNumber, setInvoiceNumber] = useState(existing?.invoice_number || '');
  // De-dup: warn if this supplier+invoice number was already captured.
  const [invoiceDup, setInvoiceDup] = useState<{ id: string; cost_date: string | null; amount_gross: number | null; payment_status: string } | null>(null);
  const [amountGross, setAmountGross] = useState(existing?.amount_gross != null ? String(existing.amount_gross) : '');
  const [amountVat, setAmountVat] = useState(existing?.amount_vat != null ? String(existing.amount_vat) : '');
  const [amountNet, setAmountNet] = useState(existing?.amount_net != null ? String(existing.amount_net) : '');
  // VAT handling: 20% (auto gross↔net), No VAT (net=gross, vat=0), or Manual
  // (edit all three). Default driven by category / AI; never assume 20% silently.
  const inferVatMode = (): VatMode => {
    if (!isEdit) return 'vat20';
    if (existing?.vat_treatment === 'reclaim_split') return 'reclaim';
    const g = Number(existing?.amount_gross || 0);
    const v = Number(existing?.amount_vat || 0);
    const n = Number(existing?.amount_net || 0);
    if (v <= 0 && (n === 0 || Math.abs(n - g) < 0.005)) return 'none';
    if (n > 0 && Math.abs(v - n * 0.2) < 0.02) return 'vat20';
    return 'manual';
  };
  const [vatMode, setVatMode] = useState<VatMode>(inferVatMode);
  const [vatTouched, setVatTouched] = useState(isEdit);
  const [paymentTouched, setPaymentTouched] = useState(isEdit);
  const [description, setDescription] = useState(existing?.description || '');

  // Job link (needed to enable recharge). Pre-fill from existing cost or preset.
  const initialJobLabel = existingRow?.hh_job_number
    ? `#${existingRow.hh_job_number}${existingRow.job_name ? ' – ' + existingRow.job_name : ''}`
    : existingRow?.job_id ? '(linked job)' : '';
  const [linkedJobId, setLinkedJobId] = useState<string | null>(existing?.job_id || presetJobId || null);
  const [linkedJobLabel, setLinkedJobLabel] = useState<string>(initialJobLabel);
  const [jobSearch, setJobSearch] = useState('');
  const [jobSuggestions, setJobSuggestions] = useState<JobSuggestion[]>([]);
  const [jobFocused, setJobFocused] = useState(false);
  const [categoryCode, setCategoryCode] = useState(existing?.xero_account_code || (presetVehicleId ? '406' : presetIssueId ? '473' : ''));
  const [paymentMethod, setPaymentMethod] = useState<CostPaymentMethod>(existing?.payment_method || 'cot_card');
  const [paymentStatus, setPaymentStatus] = useState<CostPaymentStatus>(existing?.payment_status || 'paid');
  const [rechargeMode, setRechargeMode] = useState<CostRechargeMode>(existing?.recharge_mode || 'none');
  const [rechargeAmount, setRechargeAmount] = useState(existing?.recharge_amount != null ? String(existing.recharge_amount) : '');
  // Intent: only meaningful when a job is linked. Seed from the existing cost,
  // inferring for legacy rows (recharge flagged → extra, else part of a quote).
  const [costIntent, setCostIntent] = useState<CostIntent>(
    existing?.cost_intent || (existing?.recharge_mode && existing.recharge_mode !== 'none' ? 'extra' : 'quote_actual'),
  );
  const [intentTouched, setIntentTouched] = useState(isEdit);
  const [notes, setNotes] = useState(existing?.notes || '');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string>('');
  const [aiPrefilled, setAiPrefilled] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [receiptIsPdf, setReceiptIsPdf] = useState(false);
  // AI-spotted job number (suggestion only — staff confirm to link).
  const [suggestedJobNumber, setSuggestedJobNumber] = useState<string | null>(null);
  const [linkingSuggestion, setLinkingSuggestion] = useState(false);
  // Compact quote-vs-actuals summary shown when a job is linked.
  const [jobSummary, setJobSummary] = useState<{ quotedCost: number; clientQuoted: number; actuals: number; extra: number } | null>(null);

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
  const [splitAfterSave, setSplitAfterSave] = useState(false);
  const [error, setError] = useState('');

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

  // Invoice-number de-dup — debounced; warns if this supplier+invoice number was
  // already captured (non-blocking). Skips while editing the same cost.
  useEffect(() => {
    const num = invoiceNumber.trim();
    if (!num) { setInvoiceDup(null); return; }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ invoice_number: num, supplier_name: supplierName.trim() });
        if (existing?.id) params.set('exclude_id', existing.id);
        const r = await api.get<{ data: { duplicate: boolean; match: typeof invoiceDup } }>(`/costs/check-invoice?${params}`);
        setInvoiceDup(r.data.duplicate ? r.data.match : null);
      } catch { setInvoiceDup(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [invoiceNumber, supplierName, existing?.id]);

  // Fleet list (small, ~20 vans) — fetched once for the vehicle picker, filtered
  // client-side. Active vehicles only.
  useEffect(() => {
    api.get<{ data: FleetLite[] }>('/vehicles/fleet')
      .then((r) => setFleet(r.data || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Job picker — debounced search against the global /api/search, filtered to type='job'.
  useEffect(() => {
    if (jobSearch.trim().length < 2) { setJobSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(jobSearch.trim())}&limit=10`);
        setJobSuggestions((r.results || []).filter((x) => x.type === 'job').slice(0, 8));
      } catch { setJobSuggestions([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [jobSearch]);

  // When a job is linked, pull its quotes + existing costs to (a) default the
  // intent — "part of the quote" if the job carries a quote, else "extra" — and
  // (b) show the compact quoted-vs-actuals comparison so staff can judge whether
  // a cost is covered by the quote or genuinely above-and-beyond.
  useEffect(() => {
    if (!linkedJobId) { setJobSummary(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [quotesRes, costsRes] = await Promise.all([
          api.get<{ data: Array<{ freelancer_fee: number | null; freelancer_fee_rounded: number | null; client_fee: number | null; status: string | null }> }>(`/quotes?job_id=${linkedJobId}`).catch(() => ({ data: [] })),
          api.get<{ data: Array<{ id: string; amount_gross: number | null; cost_intent: string | null }> }>(`/costs/by-job/${linkedJobId}`).catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        const quotes = (quotesRes.data || []).filter((q) => q.status !== 'cancelled');
        const num = (n: number | null | undefined) => Number(n || 0);
        const quotedCost = quotes.reduce((s, q) => s + num(q.freelancer_fee_rounded ?? q.freelancer_fee), 0);
        const clientQuoted = quotes.reduce((s, q) => s + num(q.client_fee), 0);
        const costs = (costsRes.data || []).filter((c) => c.id !== existing?.id);
        const actuals = costs.filter((c) => c.cost_intent === 'quote_actual').reduce((s, c) => s + num(c.amount_gross), 0);
        const extra = costs.filter((c) => c.cost_intent === 'extra').reduce((s, c) => s + num(c.amount_gross), 0);
        setJobSummary({ quotedCost, clientQuoted, actuals, extra });
        if (!intentTouched) setCostIntent(quotes.length > 0 ? 'quote_actual' : 'extra');
      } catch { /* leave defaults */ }
    })();
    return () => { cancelled = true; };
  }, [linkedJobId, intentTouched, existing?.id]);

  // Confirm an AI-spotted job number → resolve it to a real job and link it.
  async function linkSuggestedJob() {
    if (!suggestedJobNumber) return;
    setLinkingSuggestion(true);
    try {
      const r = await api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(suggestedJobNumber)}&limit=10`);
      const job = (r.results || []).find((x) => x.type === 'job'
        && (x.name?.includes(suggestedJobNumber) || x.subtitle?.includes(suggestedJobNumber)));
      if (job) {
        setLinkedJobId(job.id);
        setLinkedJobLabel(job.name);
        setSuggestedJobNumber(null);
      } else {
        setError(`Couldn't find job #${suggestedJobNumber} — search for it manually below.`);
      }
    } catch {
      setError('Job lookup failed — search for it manually below.');
    } finally {
      setLinkingSuggestion(false);
    }
  }

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

  // Category-driven defaults: a freelance crew invoice is usually NOT VAT-bearing
  // and paid later; most other supplier costs carry 20% VAT and are paid now.
  // Applied until the user overrides each control (and never in edit mode).
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
    if (!paymentTouched) setPaymentMethod(isFreelance ? 'not_yet_paid' : 'cot_card');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryCode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
  async function extractReceipt() {
    if (!receiptFile) return;
    setExtracting(true);
    setExtractError('');
    setAiPrefilled(false);
    try {
      const fd = new FormData();
      fd.append('file', receiptFile);
      const res = await api.upload<{
        data: {
          supplier: string | null;
          cost_date: string | null;
          amount_gross: number | null;
          amount_vat: number | null;
          amount_net: number | null;
          vat_treatment: 'standard' | 'no_vat';
          invoice_number: string | null;
          job_number: string | null;
          description: string | null;
          category_code: string | null;
          confidence: 'high' | 'medium' | 'low';
          supplier_matched?: { from: string; to: string };
        };
      }>('/costs/extract', fd);
      const ex = res.data;
      if (ex.supplier) setSupplierName(ex.supplier);
      if (ex.cost_date) setCostDate(ex.cost_date);
      if (ex.invoice_number) setInvoiceNumber(ex.invoice_number);
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
      setSuggestedJobNumber(!linkedJobId && ex.job_number ? ex.job_number.replace(/\D/g, '') || null : null);
      setAiPrefilled(true);
      setAiConfidence(ex.confidence);
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

  const viewExistingReceipt = useCallback(async () => {
    if (!existing?.receipt_r2_key) return;
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(existing.receipt_r2_key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { setError('Could not open the saved receipt.'); }
  }, [existing]);

  // Recharge is only possible on a job-linked cost that's flagged "extra" — a
  // quote_actual cost is already billed via its quote.
  const canRecharge = Boolean(linkedJobId) && costIntent === 'extra';

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

  async function handleSave(approveOnSave = false) {
    setError('');
    if (vatMode === 'reclaim') {
      if (!amountNet || Number(amountNet) <= 0) { setError('Enter the No-VAT (net) amount, e.g. the excess.'); return; }
      if (!amountVat || Number(amountVat) <= 0) { setError('Enter the reclaimable VAT amount.'); return; }
    } else if (!amountGross || Number(amountGross) <= 0) {
      if (!serviceOnlyEligible) { setError('Gross amount is required.'); return; }
    }
    // A cost row needs a category — it's the Xero account code, and the push
    // fails without it. Service-record-only saves (no cost amount) are exempt.
    const savingServiceOnly = serviceOnlyEligible
      && (vatMode === 'reclaim' ? !(Number(amountNet) > 0) : !(Number(amountGross) > 0));
    if (!savingServiceOnly && !categoryCode) {
      setError('Pick "What\'s this cost for?" — it sets the Xero category, and the push to Xero fails without it.');
      return;
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
      // cot_card_holder + cot_card_last4 are stamped server-side from the
      // uploader's user record — staff don't enter them on the modal.

      const cat = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode);

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
      const noAmount = vatMode === 'reclaim' ? Number(amountNet) <= 0 : Number(amountGross) <= 0;
      if (serviceOnlyEligible && noAmount) {
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
        description: description || null,
        category: cat?.label || null,
        xero_account_code: cat?.xeroCode || null,
        cost_type: cat?.costType || 'overhead',
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        recharge_mode: canRecharge ? rechargeMode : 'none',
        recharge_amount: canRecharge && rechargeMode !== 'none' && rechargeAmount ? Number(rechargeAmount) : null,
        cost_intent: linkedJobId ? costIntent : null,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
        notes: notes || null,
        // Always send job_id + vehicle_id so edit-mode can change/clear the links.
        job_id: linkedJobId || null,
        vehicle_id: vehicleId || null,
      };
      if (!isEdit) {
        payload.platform_issue_id = presetIssueId || null;
        payload.status = 'confirmed';
        // One-click "Approve & save" — backend honours it only for a payable +
        // an approver (admin/manager), and fires the bill push on approval.
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
      if (splitAfterSave && !isEdit && onSavedAndSplit && res.data) {
        onSavedAndSplit(res.data);
      } else {
        onSaved(res.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cost');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500';
  const groups = Array.from(new Set(COST_CATEGORIES.map((c) => c.group)));
  const leftPaneStyle: React.CSSProperties = isDesktop ? { width: `${leftPct}%` } : {};

  return (
    <div className="fixed inset-0 bg-black/40 flex items-stretch sm:items-start justify-center z-50 sm:overflow-y-auto sm:p-4" onClick={onClose}>
      <div className="bg-white shadow-xl w-full max-h-screen sm:max-w-5xl sm:my-4 sm:rounded-lg sm:max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{isEdit ? 'Edit Cost' : 'Capture Cost'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div ref={containerRef} className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          {/* LEFT: receipt pane — single scroll: a non-scrolling header over a
              flex-fill preview area (the PDF/image scrolls inside that area). */}
          <div className="px-6 py-4 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col md:min-h-0" style={leftPaneStyle}>
            <label className="block text-sm font-medium text-gray-700 mb-2">Receipt</label>
            <input type="file" accept="image/*,application/pdf" className="text-sm mb-3"
              onChange={(e) => {
                setReceiptFile(e.target.files?.[0] || null);
                setAiPrefilled(false);
                setAiConfidence(null);
                setExtractError('');
                setSuggestedJobNumber(null);
              }} />
            {receiptFile && !isEdit && (
              <div className="mb-3">
                <button type="button" onClick={extractReceipt} disabled={extracting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg shadow-sm ring-1 ring-purple-300 disabled:opacity-50">
                  <span className="text-lg">✨</span>
                  {extracting ? 'Reading receipt…' : 'Auto-fill from receipt (AI)'}
                </button>
                {!aiPrefilled && !extracting && !extractError && (
                  <p className="mt-1.5 text-xs text-center text-gray-500">Reads the supplier, amounts, VAT &amp; category for you.</p>
                )}
                {aiPrefilled && (
                  <div className={`mt-2 px-3 py-2 text-xs rounded-md border ${
                    aiConfidence === 'high' ? 'bg-green-50 border-green-200 text-green-800'
                      : aiConfidence === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-800'
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}>
                    Pre-filled from receipt (confidence: <strong>{aiConfidence}</strong>) — please check and correct anything wrong before saving.
                  </div>
                )}
                {suggestedJobNumber && !linkedJobId && (
                  <button type="button" onClick={linkSuggestedJob} disabled={linkingSuggestion}
                    className="mt-2 w-full px-3 py-2 text-xs text-left rounded-md border border-purple-200 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-50">
                    📎 Looks like <strong>job #{suggestedJobNumber}</strong> on this invoice — {linkingSuggestion ? 'linking…' : 'tap to link it'}
                  </button>
                )}
                {extractError && (
                  <div className="mt-2 px-3 py-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-md">
                    {extractError}
                  </div>
                )}
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
                  <span className="text-gray-400">· choose a file above to replace</span>
                </div>
              )}
              {!receiptFile && !existing?.receipt_filename && (
                <div className="text-sm text-gray-400 italic">No receipt attached yet — choose a file above.</div>
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

          {/* RIGHT: form pane */}
          <div className="flex-1 px-6 py-4 space-y-4 md:overflow-y-auto">
            {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                <input className={inputCls} value={supplierName}
                  onChange={(e) => { setSupplierName(e.target.value); setXeroContactId(null); }}
                  onFocus={() => setSupplierFocused(true)}
                  onBlur={() => setTimeout(() => setSupplierFocused(false), 150)}
                  placeholder="e.g. TTS360, Shell" autoComplete="off" />
                {supplierFocused && supplierSuggestions.length > 0 && (
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input type="date" className={inputCls} value={costDate} onChange={(e) => setCostDate(e.target.value)} />
                {costDate && costDate > new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) && (
                  <p className="text-xs text-amber-600 mt-1">⚠️ This date is in the future — is that right? Receipt dates are usually today or earlier (UK day/month).</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Invoice number <span className="text-gray-400 font-normal">(optional — de-dup key)</span>
              </label>
              <input className={inputCls} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="e.g. INV-10472 (leave blank for fuel/till receipts)" />
              {invoiceDup && (
                <p className="text-xs text-amber-600 mt-1">
                  ⚠ Already captured: a cost with this invoice number{supplierName.trim() ? ` for ${supplierName.trim()}` : ''} exists
                  {invoiceDup.amount_gross != null ? ` (£${Number(invoiceDup.amount_gross).toFixed(2)}` : ''}{invoiceDup.cost_date ? `, ${new Date(invoiceDup.cost_date).toLocaleDateString('en-GB')}` : ''}{invoiceDup.amount_gross != null ? ', ' + invoiceDup.payment_status.replace(/_/g, ' ') + ')' : ''}. Check you're not submitting it twice.
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                <span className="text-sm font-medium text-gray-700">Amounts</span>
                <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
                  {([
                    { v: 'vat20' as VatMode, label: '20% VAT' },
                    { v: 'none' as VatMode, label: 'No VAT' },
                    { v: 'manual' as VatMode, label: 'Manual' },
                    { v: 'reclaim' as VatMode, label: 'VAT reclaim' },
                  ]).map((o, i) => (
                    <button key={o.v} type="button" onClick={() => applyVatMode(o.v)}
                      className={`px-2.5 py-1 ${i > 0 ? 'border-l border-gray-300' : ''} ${
                        vatMode === o.v ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                    className={`${inputCls} ${vatMode !== 'manual' && vatMode !== 'reclaim' ? 'bg-gray-100' : ''}`}
                    value={amountVat} onChange={(e) => onVatChange(e.target.value)}
                    disabled={vatMode !== 'manual' && vatMode !== 'reclaim'}
                    placeholder={vatMode === 'reclaim' ? 'e.g. 702.68' : undefined} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{vatMode === 'reclaim' ? 'Total (£)' : 'Net (£)'}</label>
                  {vatMode === 'reclaim' ? (
                    <input type="number" className={`${inputCls} bg-gray-100`} value={amountGross} disabled />
                  ) : (
                    <input type="number" step="0.01" min="0" className={`${inputCls} ${vatMode === 'none' ? 'bg-gray-100' : ''}`}
                      value={amountNet} onChange={(e) => onNetChange(e.target.value)} disabled={vatMode === 'none'} />
                  )}
                </div>
              </div>
              {vatMode === 'vat20' && <p className="text-xs text-gray-400 mt-1">20% VAT — enter gross or net, the other two fill in.</p>}
              {vatMode === 'none' && <p className="text-xs text-gray-400 mt-1">No VAT (e.g. a non-VAT-registered freelancer) — gross = net, no VAT reclaimed.</p>}
              {vatMode === 'manual' && <p className="text-xs text-gray-400 mt-1">Manual — enter all three figures exactly as shown on the receipt.</p>}
              {vatMode === 'reclaim' && <p className="text-xs text-amber-600 mt-1">Insurance-claim / VAT-only invoice: enter the No-VAT amount (the excess) + the reclaimable VAT. Pushed to Xero as a 3-line VAT-only entry (net @ No VAT, VAT base @ 20%, adjustment), so exactly £{amountVat || '0.00'} VAT is reclaimed.</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this for?" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Link to job <span className="text-gray-400 font-normal">(optional — needed to recharge)</span>
              </label>
              {linkedJobId ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-3 py-1.5 text-sm bg-purple-50 text-purple-700 rounded-md border border-purple-200">
                    {linkedJobLabel || '(linked job)'}
                  </span>
                  <button type="button"
                    onClick={() => { setLinkedJobId(null); setLinkedJobLabel(''); setJobSearch(''); setJobSuggestions([]); }}
                    className="text-xs text-red-600 hover:underline">
                    Remove link
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <input className={inputCls} value={jobSearch}
                    onChange={(e) => setJobSearch(e.target.value)}
                    onFocus={() => setJobFocused(true)}
                    onBlur={() => setTimeout(() => setJobFocused(false), 150)}
                    placeholder="Search by job number or name" autoComplete="off" />
                  {jobFocused && jobSuggestions.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                      {jobSuggestions.map((s) => (
                        <button key={s.id} type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setLinkedJobId(s.id);
                            setLinkedJobLabel(s.name);
                            setJobSearch('');
                            setJobSuggestions([]);
                          }}
                          className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
                          {s.name}{s.subtitle ? <span className="text-gray-400"> · {s.subtitle}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {linkedJobId && jobSummary && (jobSummary.clientQuoted > 0 || jobSummary.quotedCost > 0 || jobSummary.actuals > 0 || jobSummary.extra > 0) && (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-0.5">
                <div className="font-medium text-gray-700">This job so far</div>
                {jobSummary.clientQuoted > 0 && <div>Quoted to client: <strong>£{jobSummary.clientQuoted.toFixed(2)}</strong>{jobSummary.quotedCost > 0 && <span className="text-gray-400"> (our cost est. £{jobSummary.quotedCost.toFixed(2)})</span>}</div>}
                <div>Costs logged against the quote: <strong>£{jobSummary.actuals.toFixed(2)}</strong>{jobSummary.extra > 0 && <span> · extras: <strong>£{jobSummary.extra.toFixed(2)}</strong></span>}</div>
                <div className="text-gray-400">Use this to decide if this cost is covered by the quote (Part of the quote) or above-and-beyond (Extra).</div>
              </div>
            )}

            {/* Vehicle link — optional. Picking a van offers a one-step service-history record. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vehicle <span className="text-gray-400 font-normal">(optional — link this cost to a van)</span>
              </label>
              {vehicleId ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-3 py-1.5 text-sm bg-purple-50 text-purple-700 rounded-md border border-purple-200">
                    {vehicleLabel(selectedVehicle) || '(linked vehicle)'}
                  </span>
                  <button type="button"
                    onClick={() => { setVehicleId(null); setVehicleSearch(''); setLogService(false); }}
                    className="text-xs text-red-600 hover:underline">
                    Remove link
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <input className={inputCls} value={vehicleSearch}
                    onChange={(e) => setVehicleSearch(e.target.value)}
                    onFocus={() => setVehicleFocused(true)}
                    onBlur={() => setTimeout(() => setVehicleFocused(false), 150)}
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
                            e.preventDefault(); setVehicleId(v.id); setVehicleSearch('');
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What's this cost for?</label>
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment method</label>
                <select className={inputCls} value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value as CostPaymentMethod); setPaymentTouched(true); }}>
                  {PAYMENT_METHOD_GROUPS.map((g) => (
                    <optgroup key={g} label={g}>
                      {PAYMENT_METHODS.filter((m) => m.group === g).map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment status</label>
                <select className={inputCls} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as CostPaymentStatus)}>
                  {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {paymentMethod === 'cot_card' && !user?.cot_card_last4 && (
              <p className="text-xs text-gray-500 italic">
                No company card on file for you — ask an admin to add it in Settings → COT Card Register (enables Xero reconciliation matching).
              </p>
            )}

            {linkedJobId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Is this part of a quote?</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: 'quote_actual' as CostIntent, label: 'Part of the quote', sub: "Actual against the job's quote — not recharged" },
                    { v: 'extra' as CostIntent, label: 'Extra', sub: 'Above-and-beyond — can recharge the client' },
                  ]).map((o) => (
                    <button key={o.v} type="button"
                      onClick={() => { setCostIntent(o.v); setIntentTouched(true); }}
                      className={`text-left px-3 py-2 rounded-md border text-sm ${
                        costIntent === o.v ? 'border-purple-500 bg-purple-50 ring-1 ring-purple-500' : 'border-gray-300 hover:bg-gray-50'
                      }`}>
                      <div className="font-medium text-gray-800">{o.label}</div>
                      <div className="text-xs text-gray-500">{o.sub}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {linkedJobId && costIntent === 'quote_actual' && (
              <p className="text-xs text-gray-500 italic">
                Already billed to the client via the quote — no recharge. It'll show as an actual against the job on the Money tab.
              </p>
            )}

            {canRecharge && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Recharge to client</label>
                  <select className={inputCls} value={rechargeMode} onChange={(e) => setRechargeMode(e.target.value as CostRechargeMode)}>
                    <option value="none">No recharge</option>
                    <option value="full">Full</option>
                    <option value="partial">Partial</option>
                  </select>
                </div>
                {rechargeMode === 'partial' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Recharge amount (£, net of VAT)</label>
                    <input type="number" step="0.01" min="0" className={inputCls} value={rechargeAmount} onChange={(e) => setRechargeAmount(e.target.value)} />
                    <p className="text-xs text-gray-400 mt-1">VAT will be added when this is billed via HireHop.</p>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-200">
          {!isEdit && onSavedAndSplit ? (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer" title="One invoice covering several jobs — split the amount across them after saving">
              <input type="checkbox" checked={splitAfterSave} onChange={(e) => setSplitAfterSave(e.target.checked)} />
              Split across multiple jobs
            </label>
          ) : <span />}
          <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          {!isEdit && paymentStatus !== 'paid' && hasManagerRole(user?.role) && (
            <button onClick={() => handleSave(true)} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-700 rounded-md disabled:opacity-50"
              title="Save this bill and approve it in one step (skips the separate approve step)">
              {saving ? 'Saving…' : 'Approve & save'}
            </button>
          )}
          <button onClick={() => handleSave()} disabled={saving}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? (wantsService ? 'Save changes + service record' : 'Save changes') : serviceOnlyEligible && (vatMode === 'reclaim' ? Number(amountNet) <= 0 : Number(amountGross) <= 0) ? 'Save service record' : wantsService ? 'Save cost + service record' : 'Save cost'}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
