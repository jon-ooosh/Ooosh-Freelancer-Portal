/**
 * The phone receipt page (/receipt) — one question per screen, for snapping a
 * receipt where it happened: nearly always a paper fuel or parking receipt
 * (docs/design/cost-capture-redesign/DECISIONS.md, PR 3). Staff only, every
 * staff role; full screen, no menus, so it can live on a phone's home screen
 * like Quick Log.
 *
 *   1. Snap the receipt. "Waiting for a receipt" (company-card costs of mine
 *      with no receipt: what the Wednesday chaser is about) sits above the
 *      camera; tap one to attach the photo to it. This replaced /my-receipts.
 *   2. Is this right? Receipt / Bill / Refund, then what the AI read, each row
 *      tappable to change. A receipt that looks already added offers "attach
 *      the photo to it instead".
 *   3. Which job? No job first, then the jobs that had a van out that day
 *      (the van whose reg is on the receipt first), then a search.
 *   4. Who pays, the van, how it was paid → Save.
 *   5. Done → snap another.
 *
 * It is the laptop form's rules with fewer words: who pays defaults through
 * costJobs.ts defaultWhoPays(), the save is planSplit()'s one-job answer, the
 * van on the day is vansOnDate(), the AI read is receiptRead.ts. Anything the
 * phone doesn't do (a freelancer's invoice, several jobs, lines, a VAT reclaim)
 * hands the photo to the full form ("Open the full form").
 *
 * The network at a petrol station is unreliable: reads and uploads are asked
 * again when no reply came (retryOnNoReply); the save itself is NEVER re-sent
 * blind. When it got no reply the page looks for its own photo on a cost first,
 * and only offers "Try again" once it knows the save didn't land.
 */
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isNoReply } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { COST_CATEGORIES } from '../components/CostCaptureModal';
import {
  type ExtractedReceipt, amountsFromRead, preparePhoto, readErrorMessage, readReceipt, retryOnNoReply, uploadReceiptFile,
} from '../components/costs/receiptRead';
import {
  type JobChoice, type WhoPays, type VanRow, defaultWhoPays, jobLabel, newChoice, num, parseJobSearchName, planSplit, vansOnDate,
} from '../components/costs/costJobs';
import { useJobInfo } from '../components/costs/useJobInfo';
import { ukToday, ukDatePlus } from '../lib/ukDate';
import type { CostPaymentMethod } from '../../../shared/types';

const CostCaptureModal = lazy(() => import('../components/CostCaptureModal'));
const RecordRefundModal = lazy(() => import('../components/RecordRefundModal'));

type Step = 'snap' | 'attach' | 'check' | 'job' | 'pay' | 'done';
type Kind = 'receipt' | 'bill';
type VatMode = 'vat20' | 'none' | 'manual';

interface WaitingCost { id: string; supplier_name: string | null; description: string | null; amount_gross: number | string | null; cost_date: string | null }
interface Duplicate { id: string; supplier_name: string | null; amount_gross: number; cost_date: string | null; has_receipt: boolean; receipt_r2_key?: string | null; uploaded_by_name: string | null; description?: string | null }
interface VanJob {
  id: string; hh_job_number: number | null; job_name: string | null; client: string | null;
  recharge_running_costs: boolean; vans: VanRow[]; reg_match: boolean; on_day: boolean; distance: number;
}
interface PickedJob { jobId: string; hhJobNumber: number | null; jobName: string | null; vanRows?: VanRow[] }
interface JobSuggestion { id: string; type: string; name: string; subtitle?: string }
type FleetLite = { id: string; reg: string; make?: string | null; model?: string | null };

const STEP_NO: Partial<Record<Step, number>> = { snap: 1, check: 2, job: 3, pay: 4 };
const PAID_BY: { value: CostPaymentMethod; label: string }[] = [
  { value: 'cot_card', label: 'Company card' },
  { value: 'petty_cash', label: 'Cash' },
  { value: 'wise', label: 'Wise' },
  { value: 'reimburse_me', label: 'Me' },
];
const WHO_PAYS: { v: WhoPays; label: string; help: string }[] = [
  { v: 'quote', label: 'Already in quote', help: 'Client has already been charged for this' },
  { v: 'charge', label: 'Charge to client', help: 'Not in quote: recharged with the markup after the hire' },
  { v: 'ours', label: 'We cover it', help: 'Not in quote, but we\'re not recharging the client' },
];
const STALE_COST_DAYS = 120; // as the laptop form (and cost-receipt-extract.ts STALE_MS)

const gbp = (n: number) => `£${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const normReg = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
const pence = (v: number | string | null | undefined) => Math.round(num(v) * 100);
function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (Number.isNaN(dt.getTime())) return ymd;
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const bigBtn = 'w-full h-[52px] rounded-xl text-base font-semibold disabled:opacity-50';
const primary = `${bigBtn} bg-purple-600 text-white active:bg-purple-700`;
const secondary = `${bigBtn} bg-white text-purple-700 border border-purple-300 active:bg-purple-50`;
const input = 'w-full border border-gray-300 rounded-lg px-3 py-3 text-base focus:ring-2 focus:ring-purple-500 focus:border-purple-500';

export default function ReceiptCapturePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [step, setStep] = useState<Step>('snap');
  const [cardLast4, setCardLast4] = useState<string | null | undefined>(user?.cot_card_last4);

  // ── The photo ──
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [waiting, setWaiting] = useState<WaitingCost[]>([]);
  // "Nothing waiting" only once we know: a slow phone mustn't say it while still asking.
  const [waitingLoaded, setWaitingLoaded] = useState(false);
  const [attachTo, setAttachTo] = useState<WaitingCost | Duplicate | null>(null);

  // ── What it says ──
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const [read, setRead] = useState<ExtractedReceipt | null>(null);
  const [kind, setKind] = useState<Kind>('receipt');
  const [supplier, setSupplier] = useState('');
  const [xeroContactId, setXeroContactId] = useState<string | null>(null);
  const [supplierSuggestion, setSupplierSuggestion] = useState<{ printed: string; name: string; xero_contact_id: string } | null>(null);
  const [costDate, setCostDate] = useState(ukToday());
  const [gross, setGross] = useState('');
  const [vatMode, setVatMode] = useState<VatMode>('vat20');
  const [vat, setVat] = useState('');
  const [categoryCode, setCategoryCode] = useState('');
  const [description, setDescription] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [dupDismissed, setDupDismissed] = useState(false);

  // ── Which job ──
  const [job, setJob] = useState<PickedJob | null>(null);
  const [vanJobs, setVanJobs] = useState<VanJob[] | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PickedJob[]>([]);
  const [suggested, setSuggested] = useState<PickedJob | null>(null);

  // ── Who pays, the van, paid by ──
  const [whoPays, setWhoPays] = useState<WhoPays | null>(null);
  const [part, setPart] = useState('');
  const [partOpen, setPartOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  // Where the van came from: the reg on the receipt, the job on the day, or a person.
  const [vanSource, setVanSource] = useState<'reg' | 'job' | 'user' | null>(null);
  const [vanPicker, setVanPicker] = useState(false);
  const [fleet, setFleet] = useState<FleetLite[]>([]);
  const [jobVanRows, setJobVanRows] = useState<VanRow[]>([]);
  const [paidBy, setPaidBy] = useState<CostPaymentMethod>('cot_card');

  // ── Saving ──
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneText, setDoneText] = useState('');
  const [fullForm, setFullForm] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const uploaded = useRef<{ forFile: File; r2_key: string; filename: string } | null>(null);

  const cat = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode);
  const isFreelance = cat?.costType === 'freelancer_invoice';
  const isVehicleCost = cat?.costType === 'vehicle';
  const grossNum = round2(num(gross));
  const vatNum = vatMode === 'vat20' ? round2(grossNum - round2(grossNum / 1.2)) : vatMode === 'none' ? 0 : round2(num(vat));
  const netNum = round2(grossNum - vatNum);

  // The uploader's card, read fresh (an admin may have added it since login).
  useEffect(() => {
    api.get<{ cot_card_last4?: string | null }>('/auth/me').then((r) => setCardLast4(r?.cot_card_last4 ?? null)).catch(() => {});
    api.get<{ data: FleetLite[] }>('/vehicles/fleet').then((r) => setFleet(r.data || [])).catch(() => {});
  }, []);

  // "Waiting for a receipt": my company-card costs with no receipt (the chaser's list).
  const loadWaiting = () => {
    retryOnNoReply(() => api.get<{ data: WaitingCost[] }>('/costs?missing_receipt=1&mine=1'))
      .then((r) => setWaiting(r.data || []))
      .catch(() => setWaiting([]))
      .finally(() => setWaitingLoaded(true));
  };
  useEffect(loadWaiting, []);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function onPicked(picked: File | null) {
    if (!picked) return;
    setError('');
    setPreparing(true);
    const ready = await preparePhoto(picked);
    setPreparing(false);
    setFile(ready);
    uploaded.current = null;
  }

  function resetAll() {
    setStep('snap'); setFile(null); setAttachTo(null); setRead(null); setReadError(''); setKind('receipt');
    setSupplier(''); setXeroContactId(null); setSupplierSuggestion(null); setCostDate(ukToday()); setGross('');
    setVatMode('vat20'); setVat(''); setCategoryCode(''); setDescription(''); setInvoiceNumber(''); setEditing(null);
    setDuplicates([]); setDupDismissed(false); setJob(null); setVanJobs(null); setSearch(''); setResults([]);
    setSuggested(null); setWhoPays(null); setPart(''); setPartOpen(false); setVehicleId(null); setVanSource(null);
    setVanPicker(false); setJobVanRows([]); setPaidBy('cot_card'); setError(''); setDoneText(''); uploaded.current = null;
    loadWaiting();
  }

  // ── Step 1 → 2: read it ──
  async function usePhoto() {
    if (!file) return;
    if (attachTo) { setStep('attach'); return; }
    setStep('check');
    setReading(true);
    setReadError('');
    try {
      const ex = await readReceipt(file);
      setRead(ex);
      if (ex.supplier) setSupplier(ex.supplier);
      if (ex.xero_contact_id) setXeroContactId(ex.xero_contact_id);
      setSupplierSuggestion(ex.supplier_suggestion && ex.supplier ? { printed: ex.supplier, ...ex.supplier_suggestion } : null);
      if (ex.cost_date) setCostDate(ex.cost_date);
      if (ex.invoice_number) setInvoiceNumber(ex.invoice_number);
      if (ex.description) setDescription(ex.description);
      if (ex.category_code) setCategoryCode(ex.category_code);
      const a = amountsFromRead(ex);
      if (a) { setGross(a.gross); setVatMode(a.vatMode); setVat(a.vat); }
      // Our plate on the receipt: link the van (the Who pays screen can change it).
      // Receipt / Bill stays the person's answer (DECISIONS.md), whatever the AI saw.
      if (ex.vehicle_reg) {
        const v = fleet.find((f) => normReg(f.reg) === normReg(ex.vehicle_reg as string));
        if (v) { setVehicleId(v.id); setVanSource('reg'); }
      }
    } catch (e) {
      setReadError(readErrorMessage(e));
      setEditing('all');
    } finally {
      setReading(false);
    }
  }

  // A reg read before the fleet list arrived.
  useEffect(() => {
    if (vehicleId || vanSource === 'user' || !read?.vehicle_reg || !fleet.length) return;
    const v = fleet.find((f) => normReg(f.reg) === normReg(read.vehicle_reg as string));
    if (v) { setVehicleId(v.id); setVanSource('reg'); }
  }, [fleet, read, vehicleId, vanSource]);

  // Already added? The laptop's check (same amount, day and supplier), plus any
  // of MY receipt-less costs for the same amount on the same day, whatever the
  // supplier was typed as: those are the ones "attach instead" is for.
  useEffect(() => {
    if (step !== 'check' || !(grossNum > 0) || !costDate) { setDuplicates([]); return; }
    const t = setTimeout(async () => {
      const mine: Duplicate[] = waiting
        .filter((w) => pence(w.amount_gross) === pence(grossNum) && (w.cost_date || '').slice(0, 10) === costDate)
        .map((w) => ({ id: w.id, supplier_name: w.supplier_name, amount_gross: num(w.amount_gross), cost_date: w.cost_date, has_receipt: false, uploaded_by_name: null, description: w.description }));
      let found: Duplicate[] = [];
      if (supplier.trim()) {
        try {
          const params = new URLSearchParams({ amount_gross: grossNum.toFixed(2), cost_date: costDate, supplier_name: supplier.trim() });
          if (xeroContactId) params.set('xero_contact_id', xeroContactId);
          found = (await api.get<{ data: { duplicates: Duplicate[] } }>(`/costs/check-duplicate?${params}`)).data.duplicates || [];
        } catch { /* a warning only */ }
      }
      const byId = new Map<string, Duplicate>();
      for (const d of [...mine, ...found]) if (!byId.has(d.id)) byId.set(d.id, d);
      setDuplicates([...byId.values()]);
    }, 500);
    return () => clearTimeout(t);
  }, [step, grossNum, costDate, supplier, xeroContactId, waiting]);

  // ── Step 3: the jobs with a van out that day ──
  useEffect(() => {
    if (step !== 'job') return;
    const params = new URLSearchParams({ date: costDate });
    if (read?.vehicle_reg) params.set('reg', read.vehicle_reg);
    retryOnNoReply(() => api.get<{ data: VanJob[] }>(`/costs/van-jobs?${params}`))
      .then((r) => setVanJobs(r.data || []))
      .catch(() => setVanJobs([]));
    // The job number printed on it, if any.
    const n = read?.job_number?.replace(/\D/g, '');
    if (n) {
      api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(n)}&limit=10`)
        .then((r) => {
          const j = (r.results || []).find((x) => x.type === 'job' && parseJobSearchName(x.name).hhJobNumber === Number(n));
          setSuggested(j ? { jobId: j.id, ...parseJobSearchName(j.name) } : null);
        })
        .catch(() => setSuggested(null));
    }
  }, [step, costDate, read]);

  // Search: jobs by number / name / client, and jobs whose van reg matches.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const [jobs, vans] = await Promise.all([
        api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(q)}&limit=10`).catch(() => ({ results: [] as JobSuggestion[] })),
        normReg(q).length >= 3
          ? api.get<{ data: VanJob[] }>(`/costs/van-jobs?${new URLSearchParams({ date: costDate, search: q })}`).catch(() => ({ data: [] as VanJob[] }))
          : Promise.resolve({ data: [] as VanJob[] }),
      ]);
      if (cancelled) return;
      const out = new Map<string, PickedJob>();
      for (const v of vans.data || []) out.set(v.id, { jobId: v.id, hhJobNumber: v.hh_job_number, jobName: v.job_name, vanRows: v.vans });
      for (const j of (jobs.results || []).filter((x) => x.type === 'job').slice(0, 8)) {
        if (!out.has(j.id)) out.set(j.id, { jobId: j.id, ...parseJobSearchName(j.name) });
      }
      setResults([...out.values()]);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, costDate]);

  // The picked job's vans, on the receipt's day (after any swap).
  useEffect(() => {
    if (!job) { setJobVanRows([]); return; }
    if (job.vanRows) { setJobVanRows(job.vanRows); return; }
    let cancelled = false;
    Promise.all([
      api.get<{ data: VanRow[] }>(`/assignments?job_id=${job.jobId}&limit=100`).catch(() => ({ data: [] as VanRow[] })),
      job.hhJobNumber ? api.get<{ data: VanRow[] }>(`/assignments?hirehop_job_id=${job.hhJobNumber}&limit=100`).catch(() => ({ data: [] as VanRow[] })) : Promise.resolve({ data: [] as VanRow[] }),
    ]).then(([a, b]) => { if (!cancelled) setJobVanRows([...(a.data || []), ...(b.data || [])]); });
    return () => { cancelled = true; };
  }, [job]);
  const jobVans = useMemo(() => vansOnDate(jobVanRows, costDate), [jobVanRows, costDate]);
  useEffect(() => {
    // One van on the job that day, for a vehicle cost: it's that van (unless a
    // person chose, or the reg on the receipt already said).
    if (vanSource === 'user' || vanSource === 'reg' || !isVehicleCost || jobVans.length !== 1) return;
    setVehicleId(jobVans[0].id);
    setVanSource('job');
  }, [jobVans, isVehicleCost, vanSource]);

  // A different job: a van that only came from the last job goes with it.
  function pickJob(j: PickedJob | null) {
    if (vanSource === 'job') { setVehicleId(null); setVanSource(null); }
    setJob(j); setWhoPays(null); setPartOpen(false); setPart(''); setStep('pay');
  }

  // ── Step 4: who pays, by the laptop's rule ──
  const info = useJobInfo(job ? [job.jobId] : [], null);
  const ji = job ? info[job.jobId] : undefined;
  const choice: JobChoice | null = job ? {
    ...newChoice({ jobId: job.jobId, hhJobNumber: job.hhJobNumber, jobName: job.jobName }, true),
    whoPays: whoPays ?? 'quote', touched: whoPays != null, part: partOpen ? part : '', partOpen,
  } : null;
  const effectiveWhoPays: WhoPays | null = choice ? (whoPays ?? defaultWhoPays({
    freelance: false, categoryCode,
    rechargesRunningCosts: ji?.loaded ? ji.rechargesRunningCosts : undefined,
    hasQuotes: ji?.loaded ? ji.hasQuotes : undefined,
  })) : null;

  async function attachPhoto(target: WaitingCost | Duplicate) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const up = await uploadReceiptFile(file);
      // Attaching the same photo twice is harmless, so this one may be asked again.
      await retryOnNoReply(() => api.patch(`/costs/${target.id}`, { receipt_r2_key: up.r2_key, receipt_filename: up.filename }));
      // Off the waiting list at once: the reload after "Snap another" can be slow
      // on a phone, and the old list must not offer it again.
      setWaiting((prev) => prev.filter((w) => w.id !== target.id));
      setDoneText(`Receipt attached to ${gbp(num(target.amount_gross))}${target.supplier_name ? ` ${target.supplier_name}` : ''}${target.cost_date ? `, ${fmtDay(target.cost_date)}` : ''}.`);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn\'t attach it.');
    } finally {
      setBusy(false);
    }
  }

  function checkReady(): string {
    if (!(grossNum > 0)) return 'Say how much it was.';
    if (!categoryCode) return 'Say what it was for (the category).';
    if (vatMode === 'manual' && (vatNum < 0 || vatNum > grossNum)) return 'The VAT can\'t be more than the total.';
    return '';
  }

  async function save() {
    if (!file) return;
    const problem = checkReady();
    if (problem) { setError(problem); return; }
    if (effectiveWhoPays === 'charge' && partOpen && !(num(part) > 0)) { setError('Say how much to charge the client, or choose "Charge all of it".'); return; }
    setBusy(true); setError('');
    let up: { r2_key: string; filename: string } | null = null;
    try {
      // The photo once per photo: a retried save reuses the upload.
      up = uploaded.current?.forFile === file ? uploaded.current : null;
      if (!up) {
        const u = await uploadReceiptFile(file);
        uploaded.current = { forFile: file, ...u };
        up = u;
      }
      const plan = planSplit(grossNum, choice ? [choice] : [], new Map(), false, () => effectiveWhoPays ?? 'quote');
      const bill = kind === 'bill' || paidBy === 'reimburse_me';
      // The AI's lines (a receipt with two VAT rates) ride along only while the
      // amounts are still as it read them; the server refuses lines that don't add up.
      const asRead = read ? amountsFromRead(read) : null;
      const aiLines = read?.lines?.length && asRead && pence(asRead.gross) === pence(grossNum) && asRead.vatMode === vatMode
        && (vatMode !== 'manual' || pence(asRead.vat) === pence(vatNum)) ? read.lines : null;
      const payload: Record<string, unknown> = {
        supplier_name: supplier.trim() || null,
        xero_contact_id: xeroContactId,
        cost_date: costDate || null,
        amount_gross: grossNum,
        amount_vat: vatNum,
        amount_net: netNum,
        vat_treatment: 'standard',
        invoice_number: invoiceNumber.trim() || null,
        due_date_override: kind === 'bill' ? (read?.due_date || null) : null,
        description: description.trim() || null,
        category: cat?.label || null,
        xero_account_code: cat?.xeroCode || null,
        cost_type: cat?.costType || 'overhead',
        payment_method: kind === 'bill' ? 'not_yet_paid' : paidBy,
        payment_status: bill ? 'awaiting_payment' : 'paid',
        receipt_r2_key: up.r2_key,
        receipt_filename: up.filename,
        supporting_documents: [],
        vehicle_id: vehicleId,
        job_id: plan.jobId,
        status: 'confirmed',
        ...(plan.costLevel ? {
          cost_intent: plan.costLevel.cost_intent,
          recharge_mode: plan.costLevel.recharge_mode,
          recharge_amount: plan.costLevel.recharge_amount,
        } : {}),
        ...(aiLines ? {
          lines: aiLines.map((l) => ({
            description: l.description || null, amount_gross: l.amount_gross, amount_vat: l.amount_vat,
            xero_account_code: l.category_code || null, crew_fronted: false, source: 'ai',
          })),
        } : {}),
      };
      // The save is sent ONCE. See below for a lost reply.
      await api.post('/costs', payload);
      finishSaved(plan.jobId);
    } catch (e) {
      if (isNoReply(e) && up) {
        // No reply: it may well have saved. Look for this photo on a cost
        // before offering to send it again.
        const landed = await savedAlready(up.r2_key);
        if (landed) { finishSaved(job?.jobId ?? null); return; }
        setError('That didn\'t go through: the connection dropped and nothing was saved. Try again.');
      } else {
        setError(e instanceof Error ? e.message : 'Couldn\'t save it.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function savedAlready(key: string): Promise<boolean> {
    for (const pause of [2500, 5000]) {
      await new Promise((r) => setTimeout(r, pause));
      try {
        const params = new URLSearchParams({ receipt_r2_key: key });
        const r = await retryOnNoReply(() => api.get<{ data: { duplicates: Duplicate[] } }>(`/costs/check-duplicate?${params}`));
        if ((r.data.duplicates || []).some((d) => d.receipt_r2_key === key)) return true;
      } catch { /* keep looking */ }
    }
    return false;
  }

  function finishSaved(jobId: string | null) {
    const j = jobId && job ? jobLabel(job) : null;
    const charged = effectiveWhoPays === 'charge' && job;
    setDoneText(`${gbp(grossNum)}${supplier ? ` ${supplier}` : ''} saved${j ? ` on ${j}` : ', to overheads'}${charged ? ', to charge the client' : ''}.`);
    setStep('done');
  }

  const stepNo = STEP_NO[step];
  const back = () => {
    setError('');
    if (step === 'check' || step === 'attach') setStep('snap');
    else if (step === 'job') setStep('check');
    else if (step === 'pay') setStep('job');
    else navigate('/quick');
  };
  const futureDate = costDate > ukDatePlus(7);
  const staleDate = costDate < ukDatePlus(-STALE_COST_DAYS);
  const groups = Array.from(new Set(COST_CATEGORIES.map((c) => c.group)));
  const vanReg = fleet.find((f) => f.id === vehicleId)?.reg || jobVans.find((v) => v.id === vehicleId)?.reg || null;
  const visibleDup = !dupDismissed ? duplicates[0] : undefined;

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="px-3 h-14 flex items-center gap-2">
          <button type="button" onClick={back} aria-label="Back" className="w-11 h-11 -ml-1 text-2xl text-slate-600">‹</button>
          <h1 className="flex-1 font-semibold text-slate-800 truncate">
            {step === 'snap' ? 'Snap the receipt' : step === 'attach' ? 'Attach the receipt' : step === 'check' ? 'Is this right?'
              : step === 'job' ? 'Which job?' : step === 'pay' ? 'Who pays?' : 'Done'}
          </h1>
          {stepNo && <span className="text-xs text-slate-400">{stepNo} of 4</span>}
          <button type="button" onClick={() => navigate('/quick')} aria-label="Close" className="w-11 h-11 text-xl text-slate-400">&times;</button>
        </div>
        {stepNo && <div className="h-1 bg-slate-100"><div className="h-1 bg-purple-600 transition-all" style={{ width: `${stepNo * 25}%` }} /></div>}
      </header>

      <main className="flex-1 w-full max-w-md mx-auto px-4 py-4 space-y-4">
        {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

        {/* 1. Snap */}
        {step === 'snap' && (
          <>
            {!file && waiting.length > 0 && (
              <section className="bg-white rounded-xl border border-slate-200">
                <h2 className="px-4 pt-3 pb-1 text-sm font-semibold text-slate-700">Waiting for a receipt ({waiting.length})</h2>
                <p className="px-4 text-xs text-slate-500 pb-2">Company-card purchases with no receipt yet. Tap one, then snap its receipt.</p>
                <ul className="divide-y divide-slate-100">
                  {waiting.map((w) => (
                    <li key={w.id}>
                      <button type="button" onClick={() => setAttachTo(attachTo?.id === w.id ? null : w)}
                        className={`w-full min-h-[52px] px-4 py-2 flex items-center gap-3 text-left ${attachTo?.id === w.id ? 'bg-purple-50' : ''}`}>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-slate-800 truncate">{w.supplier_name || w.description || 'Purchase'}</span>
                          <span className="block text-xs text-slate-500">{fmtDay(w.cost_date)}</span>
                        </span>
                        <span className="text-sm font-semibold tabular-nums">{gbp(num(w.amount_gross))}</span>
                        <span className={`w-5 h-5 rounded-full border-2 ${attachTo?.id === w.id ? 'border-purple-600 bg-purple-600' : 'border-slate-300'}`} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {attachTo && !file && (
              <p className="text-sm text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                Snap the receipt for {gbp(num(attachTo.amount_gross))} {attachTo.supplier_name || ''}, {fmtDay(attachTo.cost_date)}.
              </p>
            )}

            {preparing && <p className="text-sm text-slate-500 text-center py-8">Getting the photo ready…</p>}
            {!preparing && file && (
              <div className="space-y-3">
                {preview
                  ? <img src={preview} alt="The receipt" className="w-full max-h-[55vh] object-contain rounded-xl bg-white border border-slate-200" />
                  : <div className="rounded-xl bg-white border border-slate-200 px-4 py-10 text-center text-slate-600">📄 {file.name}</div>}
                <button type="button" onClick={usePhoto} className={primary}>Use this photo</button>
                <label className={`${secondary} flex items-center justify-center cursor-pointer`}>
                  Retake
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; void onPicked(f); }} />
                </label>
              </div>
            )}
            {!preparing && !file && (
              <div className="space-y-3">
                {/* A labelled button, not a bare file input (money-excess rules). */}
                <label className={`${primary} flex items-center justify-center gap-2 cursor-pointer`}>
                  📷 Take a photo
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; void onPicked(f); }} />
                </label>
                <label className={`${secondary} flex items-center justify-center cursor-pointer`}>
                  Choose a photo or PDF
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; void onPicked(f); }} />
                </label>
                {waitingLoaded && waiting.length === 0 && <p className="text-xs text-center text-slate-400">Nothing waiting for a receipt. Snap a new one.</p>}
              </div>
            )}
          </>
        )}

        {/* Attach the photo to a cost that's waiting for it */}
        {step === 'attach' && attachTo && (
          <div className="space-y-4">
            {preview && <img src={preview} alt="The receipt" className="w-full max-h-[45vh] object-contain rounded-xl bg-white border border-slate-200" />}
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
              <div className="text-xs text-slate-500">Attach it to</div>
              <div className="text-base font-semibold text-slate-800">{gbp(num(attachTo.amount_gross))} {attachTo.supplier_name || attachTo.description || ''}</div>
              <div className="text-sm text-slate-500">{fmtDay(attachTo.cost_date)}</div>
            </div>
            <button type="button" disabled={busy} onClick={() => attachPhoto(attachTo)} className={primary}>{busy ? 'Attaching…' : 'Attach receipt'}</button>
          </div>
        )}

        {/* 2. Is this right? */}
        {step === 'check' && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-1 bg-white rounded-xl border border-slate-200 p-1">
              {([['receipt', 'Receipt'], ['bill', 'Bill'], ['refund', 'Refund']] as const).map(([k, label]) => (
                <button key={k} type="button"
                  onClick={() => {
                    if (k === 'refund') { setRefundOpen(true); return; }
                    setKind(k);
                    if (k === 'bill') setPaidBy('not_yet_paid'); else if (paidBy === 'not_yet_paid') setPaidBy('cot_card');
                  }}
                  className={`h-11 rounded-lg text-sm font-medium ${kind === k ? 'bg-purple-600 text-white' : 'text-slate-700'}`}>
                  {label}
                </button>
              ))}
            </div>

            {reading && <p className="text-sm text-slate-500 text-center py-6">✨ Reading the receipt…</p>}
            {readError && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Couldn&apos;t read it ({readError}). Fill it in below.</p>}
            {read && read.confidence !== 'high' && (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">The AI wasn&apos;t sure of everything on this one. Check each line against the receipt.</p>
            )}

            {!reading && (
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                <Row label="Supplier" value={supplier || '—'} open={editing === 'supplier' || editing === 'all'} onOpen={() => setEditing('supplier')}>
                  <input className={input} value={supplier} autoFocus={editing === 'supplier'}
                    onChange={(e) => { setSupplier(e.target.value); setXeroContactId(null); setSupplierSuggestion(null); }} placeholder="e.g. Shell" />
                </Row>
                {supplierSuggestion && supplierSuggestion.name !== supplier && (
                  <div className="px-4 py-3 text-sm text-amber-800 bg-amber-50">
                    Xero has <strong>{supplierSuggestion.name}</strong>. Same supplier?
                    <div className="mt-2 flex gap-2">
                      <button type="button" className="flex-1 h-11 rounded-lg bg-white border border-amber-300"
                        onClick={() => {
                          const s = supplierSuggestion;
                          setSupplierSuggestion(null); setSupplier(s.name); setXeroContactId(s.xero_contact_id);
                          // Remembered, so this letterhead maps straight through next time.
                          api.post('/costs/supplier-alias', { printed_name: s.printed, xero_contact_id: s.xero_contact_id, xero_name: s.name }).catch(() => {});
                        }}>Yes</button>
                      <button type="button" className="flex-1 h-11 rounded-lg bg-white border border-amber-300" onClick={() => setSupplierSuggestion(null)}>No, different</button>
                    </div>
                  </div>
                )}
                <Row label="Date" value={fmtDay(costDate)} warn={futureDate || staleDate} open={editing === 'date' || editing === 'all'} onOpen={() => setEditing('date')}>
                  <input type="date" className={input} value={costDate} onChange={(e) => setCostDate(e.target.value)} />
                </Row>
                {(futureDate || staleDate) && (
                  <p className="px-4 py-2 text-xs text-amber-700">
                    {futureDate ? 'That date is in the future. Check the day and month.' : `That's over ${Math.round(STALE_COST_DAYS / 30)} months ago. Check the year.`}
                  </p>
                )}
                <Row label="Amount" value={grossNum > 0 ? `${gbp(grossNum)}${vatNum > 0 ? ` · VAT ${gbp(vatNum)}` : ' · no VAT'}` : '—'}
                  open={editing === 'amount' || editing === 'all'} onOpen={() => setEditing('amount')}>
                  <div className="space-y-2">
                    <input type="number" inputMode="decimal" step="0.01" min="0" className={input} value={gross}
                      onChange={(e) => setGross(e.target.value)} placeholder="Total paid, VAT included" />
                    <div className="grid grid-cols-3 gap-1 bg-slate-100 rounded-lg p-1">
                      {([['vat20', '20% VAT'], ['none', 'No VAT'], ['manual', 'Other']] as const).map(([m, label]) => (
                        <button key={m} type="button" onClick={() => { setVatMode(m); if (m === 'manual' && !vat) setVat(vatNum.toFixed(2)); }}
                          className={`h-10 rounded-md text-sm ${vatMode === m ? 'bg-purple-600 text-white' : 'text-slate-700'}`}>{label}</button>
                      ))}
                    </div>
                    {vatMode === 'manual' && (
                      <input type="number" inputMode="decimal" step="0.01" min="0" className={input} value={vat}
                        onChange={(e) => setVat(e.target.value)} placeholder="VAT on the receipt" />
                    )}
                  </div>
                </Row>
                <Row label="What for" value={cat?.label || '—'} warn={!categoryCode} open={editing === 'category' || editing === 'all'} onOpen={() => setEditing('category')}>
                  <select className={input} value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
                    <option value="">Choose…</option>
                    {groups.map((g) => (
                      <optgroup key={g} label={g}>
                        {COST_CATEGORIES.filter((c) => c.group === g).map((c) => <option key={c.xeroCode} value={c.xeroCode}>{c.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </Row>
              </div>
            )}

            {visibleDup && (
              visibleDup.has_receipt ? (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
                  Looks like this was already added: {gbp(num(visibleDup.amount_gross))} {visibleDup.supplier_name || ''}, {fmtDay(visibleDup.cost_date)}
                  {visibleDup.uploaded_by_name ? `, by ${visibleDup.uploaded_by_name}` : ''}, with a receipt. Only carry on if this is a different one.
                </div>
              ) : (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 space-y-2">
                  <div>Looks like this receipt was already added ({gbp(num(visibleDup.amount_gross))} {visibleDup.supplier_name || visibleDup.description || ''}, {fmtDay(visibleDup.cost_date)}), with no photo yet. Attach the photo to it instead?</div>
                  <button type="button" disabled={busy} className={primary} onClick={() => attachPhoto(visibleDup)}>{busy ? 'Attaching…' : 'Attach the photo to it'}</button>
                  <button type="button" className={secondary} onClick={() => setDupDismissed(true)}>No, it&apos;s a different one</button>
                </div>
              )
            )}

            {isFreelance ? (
              <div className="rounded-xl bg-white border border-slate-200 px-4 py-3 space-y-3">
                <p className="text-sm text-slate-700">This looks like a freelancer&apos;s invoice. Those are matched to their booked work on the full form.</p>
                <button type="button" className={primary} onClick={() => setFullForm(true)}>Open the full form</button>
              </div>
            ) : !reading && (
              <button type="button" className={primary}
                onClick={() => { const p = checkReady(); if (p) { setError(p); return; } setError(''); setEditing(null); setStep('job'); }}>
                Looks right
              </button>
            )}
            {!isFreelance && !reading && (
              <button type="button" onClick={() => setFullForm(true)} className="w-full text-sm text-purple-700 py-2">
                Several jobs, lines or a VAT reclaim? Open the full form
              </button>
            )}
          </div>
        )}

        {/* 3. Which job? */}
        {step === 'job' && (
          <div className="space-y-3">
            <input className={input} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job, client or van reg" />
            {search.trim().length >= 2 ? (
              <ul className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {results.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No match yet</li>}
                {results.map((r) => (
                  <li key={r.jobId}>
                    <button type="button" onClick={() => pickJob(r)}
                      className="w-full min-h-[52px] px-4 py-2 text-left text-sm text-slate-800">{jobLabel(r)}</button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <button type="button" onClick={() => pickJob(null)}
                  className="w-full min-h-[52px] px-4 py-3 bg-white rounded-xl border border-slate-200 text-left">
                  <span className="block text-sm font-semibold text-slate-800">No job, goes to overheads</span>
                </button>
                {suggested && (
                  <button type="button" onClick={() => pickJob(suggested)}
                    className="w-full min-h-[52px] px-4 py-3 bg-purple-50 rounded-xl border border-purple-200 text-left">
                    <span className="block text-xs text-purple-700">On the receipt</span>
                    <span className="block text-sm font-semibold text-slate-800">{jobLabel(suggested)}</span>
                  </button>
                )}
                <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Vans out around {fmtDay(costDate)}</h2>
                {vanJobs === null && <p className="text-sm text-slate-400">Loading…</p>}
                {vanJobs?.length === 0 && <p className="text-sm text-slate-400">No vans out then. Search for the job above.</p>}
                <ul className="space-y-2">
                  {vanJobs?.map((v) => (
                    <li key={v.id}>
                      <button type="button"
                        onClick={() => pickJob({ jobId: v.id, hhJobNumber: v.hh_job_number, jobName: v.job_name, vanRows: v.vans })}
                        className={`w-full min-h-[52px] px-4 py-3 rounded-xl border text-left ${v.reg_match ? 'bg-purple-50 border-purple-200' : 'bg-white border-slate-200'}`}>
                        <span className="block text-sm font-semibold text-slate-800">{jobLabel({ hhJobNumber: v.hh_job_number, jobName: v.job_name })}</span>
                        <span className="block text-xs text-slate-500">
                          {[...new Set(v.vans.map((x) => x.vehicle_reg).filter(Boolean))].join(', ')}
                          {v.client ? ` · ${v.client}` : ''}
                          {v.recharge_running_costs ? ' · recharges fuel' : ''}
                          {v.reg_match ? ' · reg on the receipt' : v.on_day ? '' : ' · near that day'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* 4. Who pays? */}
        {step === 'pay' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
              <div className="text-base font-semibold text-slate-800">{gbp(grossNum)} {supplier}</div>
              <div className="text-sm text-slate-500">{fmtDay(costDate)} · {cat?.label}</div>
              <div className="text-sm text-slate-700 mt-1">{job ? jobLabel(job) : 'No job: overheads'}</div>
            </div>

            {job && (
              <div className="space-y-2">
                {WHO_PAYS.map((o) => {
                  const on = effectiveWhoPays === o.v;
                  return (
                    <button key={o.v} type="button" onClick={() => { setWhoPays(o.v); if (o.v !== 'charge') { setPartOpen(false); setPart(''); } }}
                      className={`w-full min-h-[60px] px-4 py-3 rounded-xl border text-left ${on ? 'bg-purple-50 border-purple-500 ring-1 ring-purple-500' : 'bg-white border-slate-200'}`}>
                      <span className="block text-base font-semibold text-slate-800">{o.label}</span>
                      <span className="block text-xs text-slate-500">{o.help}{o.v === 'charge' && ji?.rechargesRunningCosts ? '. This job recharges its running costs.' : ''}</span>
                    </button>
                  );
                })}
                {effectiveWhoPays === 'charge' && (
                  partOpen ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-600">Charge £</span>
                      <input type="number" inputMode="decimal" step="0.01" min="0" className={input} value={part}
                        onChange={(e) => { setPart(e.target.value); setWhoPays('charge'); }} placeholder={`up to ${netNum.toFixed(2)} before VAT`} />
                      <button type="button" className="text-sm text-purple-700 whitespace-nowrap" onClick={() => { setPartOpen(false); setPart(''); }}>All of it</button>
                    </div>
                  ) : (
                    <button type="button" className="text-sm text-purple-700" onClick={() => { setPartOpen(true); setWhoPays('charge'); }}>Only part of it?</button>
                  )
                )}
              </div>
            )}

            {/* The van: from the job on the day for a vehicle cost; otherwise only if linked. */}
            {(isVehicleCost || vehicleId) && (
              <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-500">Van</span>
                  <span className="flex-1 text-sm font-semibold text-slate-800">{vanReg || 'None'}</span>
                  <button type="button" className="text-sm text-purple-700 h-11 px-2" onClick={() => setVanPicker(!vanPicker)}>{vanPicker ? 'Done' : 'Change'}</button>
                </div>
                {!vehicleId && jobVans.length > 1 && !vanPicker && (
                  <div className="flex flex-wrap gap-2">
                    <span className="w-full text-xs text-slate-500">Which van was it?</span>
                    {jobVans.map((v) => (
                      <button key={v.id} type="button" onClick={() => { setVehicleId(v.id); setVanSource('user'); }}
                        className="h-11 px-4 rounded-lg border border-purple-200 bg-purple-50 text-purple-800 text-sm font-medium">{v.reg}</button>
                    ))}
                  </div>
                )}
                {vanPicker && (
                  <select className={input} value={vehicleId || ''} onChange={(e) => { setVehicleId(e.target.value || null); setVanSource('user'); setVanPicker(false); }}>
                    <option value="">No van</option>
                    {jobVans.length > 0 && (
                      <optgroup label="On this job">
                        {jobVans.map((v) => <option key={`j-${v.id}`} value={v.id}>{v.reg}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="All vans">
                      {fleet.map((v) => <option key={v.id} value={v.id}>{v.reg}{v.make || v.model ? ` — ${[v.make, v.model].filter(Boolean).join(' ')}` : ''}</option>)}
                    </optgroup>
                  </select>
                )}
              </div>
            )}

            {kind === 'receipt' ? (
              <div>
                <div className="text-sm text-slate-600 mb-1">Paid by</div>
                <div className="grid grid-cols-2 gap-2">
                  {PAID_BY.map((m) => (
                    <button key={m.value} type="button" onClick={() => setPaidBy(m.value)}
                      className={`h-12 rounded-xl border text-sm font-medium ${paidBy === m.value ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                      {m.value === 'cot_card' && cardLast4 ? `Card ••${cardLast4}` : m.label}
                    </button>
                  ))}
                </div>
                {paidBy === 'reimburse_me' && <p className="text-xs text-slate-500 mt-1">Your own money: it&apos;s saved for approval and paid back to you.</p>}
                {paidBy === 'cot_card' && !cardLast4 && <p className="text-xs text-slate-500 mt-1">No company card on file for you. Ask an admin to add it in Settings.</p>}
              </div>
            ) : (
              <p className="text-sm text-slate-700 bg-white rounded-xl border border-slate-200 px-4 py-3">
                Pay later{read?.due_date ? ` · due ${fmtDay(read.due_date)}` : ' · due on the supplier\'s terms'}. It&apos;s saved for approval.
              </p>
            )}

            <button type="button" disabled={busy} onClick={save} className={primary}>
              {busy ? 'Saving…' : kind === 'bill' || paidBy === 'reimburse_me' ? 'Save for approval' : 'Save receipt'}
            </button>
            {kind === 'receipt' && paidBy !== 'reimburse_me' && (
              <p className="text-xs text-center text-slate-400">It goes to Xero as a paid transaction when you save.</p>
            )}
          </div>
        )}

        {/* 5. Done */}
        {step === 'done' && (
          <div className="text-center space-y-4 pt-8">
            <div className="mx-auto w-16 h-16 rounded-full bg-green-100 text-green-700 text-3xl flex items-center justify-center">✓</div>
            <p className="text-base text-slate-800">{doneText}</p>
            <button type="button" onClick={resetAll} className={primary}>📷 Snap another receipt</button>
            <button type="button" onClick={() => navigate('/quick')} className={secondary}>Back to Quick Log</button>
          </div>
        )}
      </main>

      {/* The full form, with the photo handed over (the AI reads it again there). */}
      {fullForm && (
        <Suspense fallback={null}>
          <CostCaptureModal
            initialFile={file}
            initialKind={kind}
            onClose={() => setFullForm(false)}
            onSaved={() => { setFullForm(false); setDoneText('Saved.'); setStep('done'); }}
            onRecordRefund={() => { setFullForm(false); setRefundOpen(true); }}
          />
        </Suspense>
      )}
      {refundOpen && (
        <Suspense fallback={null}>
          <RecordRefundModal
            cost={null}
            initialFile={file}
            onClose={() => setRefundOpen(false)}
            onSaved={(warnings) => {
              setRefundOpen(false);
              setDoneText(`Refund recorded.${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
              setStep('done');
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/** One line of "Is this right?": the value, tap to change it in place. */
function Row({ label, value, open, onOpen, warn, children }: {
  label: string; value: string; open: boolean; onOpen: () => void; warn?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      {open ? (
        <div>
          <div className="text-xs text-slate-500 mb-1">{label}</div>
          {children}
        </div>
      ) : (
        <button type="button" onClick={onOpen} className="w-full min-h-[44px] flex items-center gap-3 text-left">
          <span className="w-20 shrink-0 text-xs text-slate-500">{label}</span>
          <span className={`flex-1 text-base ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</span>
          <span className="text-slate-300">›</span>
        </button>
      )}
    </div>
  );
}
