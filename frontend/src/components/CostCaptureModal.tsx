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
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { Cost, CostType, CostPaymentMethod, CostPaymentStatus, CostRechargeMode } from '../../../shared/types';

interface Props {
  onClose: () => void;
  onSaved: (cost: Cost) => void;
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

const PAYMENT_METHODS: { value: CostPaymentMethod; label: string }[] = [
  { value: 'cot_card', label: 'Company card (COT)' },
  { value: 'petty_cash', label: 'Petty cash' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'reimburse_me', label: 'Reimburse me' },
  { value: 'not_yet_paid', label: 'Not yet paid (bill to pay)' },
  { value: 'other', label: 'Other' },
];

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

export default function CostCaptureModal({ onClose, onSaved, existing, presetJobId, presetVehicleId, presetIssueId }: Props) {
  const existingRow = existing as ExistingRow;
  const { user } = useAuthStore();
  const fullName = user ? `${user.first_name} ${user.last_name}`.trim() : '';
  const isEdit = Boolean(existing);

  // ── Form state ───────────────────────────────────────────────────────────
  const [supplierName, setSupplierName] = useState(existing?.supplier_name || '');
  const [costDate, setCostDate] = useState(() => (existing?.cost_date ? existing.cost_date.slice(0, 10) : new Date().toISOString().slice(0, 10)));
  const [amountGross, setAmountGross] = useState(existing?.amount_gross != null ? String(existing.amount_gross) : '');
  const [amountVat, setAmountVat] = useState(existing?.amount_vat != null ? String(existing.amount_vat) : '');
  const [amountNet, setAmountNet] = useState(existing?.amount_net != null ? String(existing.amount_net) : '');
  const [assumeVat20, setAssumeVat20] = useState(!isEdit);
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
  const [notes, setNotes] = useState(existing?.notes || '');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [receiptIsPdf, setReceiptIsPdf] = useState(false);

  const [saving, setSaving] = useState(false);
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
    setPaymentStatus(paymentMethod === 'not_yet_paid' ? 'awaiting_payment' : 'paid');
  }, [paymentMethod, isEdit]);

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
    if (assumeVat20 && v !== '') {
      const gross = parseFloat(v);
      if (!isNaN(gross)) {
        const net = round2(gross / 1.2);
        setAmountNet(net.toFixed(2));
        setAmountVat(round2(gross - net).toFixed(2));
      }
    }
  };
  const onNetChange = (v: string) => {
    setAmountNet(v);
    if (assumeVat20 && v !== '') {
      const net = parseFloat(v);
      if (!isNaN(net)) {
        const vat = round2(net * 0.2);
        setAmountVat(vat.toFixed(2));
        setAmountGross(round2(net + vat).toFixed(2));
      }
    }
  };

  const viewExistingReceipt = useCallback(async () => {
    if (!existing?.receipt_r2_key) return;
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(existing.receipt_r2_key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { setError('Could not open the saved receipt.'); }
  }, [existing]);

  const canRecharge = Boolean(linkedJobId);

  async function handleSave() {
    setError('');
    if (!amountGross || Number(amountGross) <= 0) { setError('Gross amount is required.'); return; }
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
      const payload: Record<string, unknown> = {
        supplier_name: supplierName || null,
        cost_date: costDate || null,
        amount_gross: amountGross ? Number(amountGross) : null,
        amount_vat: amountVat ? Number(amountVat) : null,
        amount_net: amountNet ? Number(amountNet) : null,
        description: description || null,
        category: cat?.label || null,
        xero_account_code: cat?.xeroCode || null,
        cost_type: cat?.costType || 'overhead',
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        recharge_mode: canRecharge ? rechargeMode : 'none',
        recharge_amount: canRecharge && rechargeMode !== 'none' && rechargeAmount ? Number(rechargeAmount) : null,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
        notes: notes || null,
        // Always send job_id so edit-mode can change/clear the link.
        job_id: linkedJobId || null,
      };
      if (!isEdit) {
        payload.vehicle_id = presetVehicleId || null;
        payload.platform_issue_id = presetIssueId || null;
        payload.status = 'confirmed';
      }

      const res = isEdit
        ? await api.patch<{ data: Cost }>(`/costs/${existing!.id}`, payload)
        : await api.post<{ data: Cost }>('/costs', payload);
      onSaved(res.data);
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
          {/* LEFT: receipt pane */}
          <div className="px-6 py-4 border-b md:border-b-0 md:border-r border-gray-100 md:overflow-y-auto" style={leftPaneStyle}>
            <label className="block text-sm font-medium text-gray-700 mb-2">Receipt</label>
            <input type="file" accept="image/*,application/pdf" className="text-sm mb-3"
              onChange={(e) => setReceiptFile(e.target.files?.[0] || null)} />
            {receiptPreview && !receiptIsPdf && (
              <img src={receiptPreview} alt="Receipt preview" onClick={() => window.open(receiptPreview, '_blank')}
                className="w-full max-h-[60vh] object-contain rounded border border-gray-200 cursor-zoom-in bg-white" />
            )}
            {receiptPreview && receiptIsPdf && (
              <embed src={receiptPreview} type="application/pdf" className="w-full h-[60vh] rounded border border-gray-200" />
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
                  onChange={(e) => setSupplierName(e.target.value)}
                  onFocus={() => setSupplierFocused(true)}
                  onBlur={() => setTimeout(() => setSupplierFocused(false), 150)}
                  placeholder="e.g. TTS360, Shell" autoComplete="off" />
                {supplierFocused && supplierSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                    {supplierSuggestions.map((s) => (
                      <button key={s.ContactID} type="button"
                        onMouseDown={(e) => { e.preventDefault(); setSupplierName(s.Name); setSupplierSuggestions([]); }}
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
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-700">Amounts</span>
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  <input type="checkbox" checked={assumeVat20} onChange={(e) => setAssumeVat20(e.target.checked)} />
                  Auto 20% VAT
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Gross (£) *</label>
                  <input type="number" step="0.01" min="0" className={inputCls} value={amountGross} onChange={(e) => onGrossChange(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">VAT (£)</label>
                  <input type="number" step="0.01" min="0" className={`${inputCls} ${assumeVat20 ? 'bg-gray-100' : ''}`}
                    value={amountVat} onChange={(e) => setAmountVat(e.target.value)} disabled={assumeVat20} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Net (£)</label>
                  <input type="number" step="0.01" min="0" className={inputCls} value={amountNet} onChange={(e) => onNetChange(e.target.value)} />
                </div>
              </div>
              {assumeVat20 && <p className="text-xs text-gray-400 mt-1">Enter gross or net — the other two fill in. Untick to edit all three.</p>}
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
                <select className={inputCls} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as CostPaymentMethod)}>
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment status</label>
                <select className={inputCls} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as CostPaymentStatus)}>
                  {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {paymentMethod === 'cot_card' && (
              <p className="text-xs text-gray-500 italic">
                Stamped automatically as {fullName || 'you'} · card ending {user?.cot_card_last4 ? `····${user.cot_card_last4}` : '— set in Profile to enable reconciliation matching'}
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">Recharge amount (£)</label>
                    <input type="number" step="0.01" min="0" className={inputCls} value={rechargeAmount} onChange={(e) => setRechargeAmount(e.target.value)} />
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

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save cost'}
          </button>
        </div>
      </div>
    </div>
  );
}
