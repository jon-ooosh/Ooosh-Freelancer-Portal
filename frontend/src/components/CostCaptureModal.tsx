/**
 * CostCaptureModal — capture or edit a cost/receipt for the Cost Capture &
 * Recharge module. Creates (POST) or updates (PATCH) a `costs` row.
 *
 * One plain-English "What's this cost for?" picker drives both the Xero account
 * code and the internal cost_type (staff never see codes or accountant terms).
 * Receipt is at the top (AI extraction — fast-follow — will fill the rest from
 * it). Net/VAT/Gross auto-calculate at 20% (toggle off to edit manually).
 */
import { useState, useEffect, useCallback } from 'react';
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

// Single source of truth for the staff-facing category picker. Each choice maps
// to a Xero account code (for the eventual push) + an internal cost_type (for
// filtering/reporting). Staff see only `label`. Keep in step with
// STAFF_COST_ACCOUNT_CODES in backend routes/costs.ts.
const COST_CATEGORIES: { label: string; xeroCode: string; costType: CostType }[] = [
  { label: 'Freelance crew invoices', xeroCode: '320', costType: 'freelancer_invoice' },
  { label: 'Crew travel (taxis, trains, etc.)', xeroCode: '325', costType: 'job' },
  { label: 'Sub-hire of equipment', xeroCode: '326', costType: 'job' },
  { label: 'Vehicle servicing & upkeep', xeroCode: '406', costType: 'vehicle' },
  { label: 'Vehicle repairs (bodywork, glass)', xeroCode: '409', costType: 'vehicle' },
  { label: 'Fuel', xeroCode: '410', costType: 'vehicle' },
  { label: 'Parking', xeroCode: '411', costType: 'vehicle' },
  { label: 'Parking fines / PCNs', xeroCode: '399', costType: 'vehicle' },
  { label: 'Equipment repairs & spares', xeroCode: '473', costType: 'parts' },
  { label: 'New equipment (backline, staging)', xeroCode: '764', costType: 'stock' },
  { label: 'Shop stock', xeroCode: '310', costType: 'stock' },
  { label: 'Postage / courier', xeroCode: '425', costType: 'overhead' },
  { label: 'Office supplies (milk, cleaning)', xeroCode: '494', costType: 'overhead' },
  { label: 'Office equipment', xeroCode: '710', costType: 'overhead' },
  { label: 'Computer equipment', xeroCode: '720', costType: 'overhead' },
  { label: 'Something else', xeroCode: '429', costType: 'overhead' },
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

const LAST4_KEY = 'ooosh_cot_last4';
const round2 = (n: number) => Math.round(n * 100) / 100;

export default function CostCaptureModal({ onClose, onSaved, existing, presetJobId, presetVehicleId, presetIssueId }: Props) {
  const { user } = useAuthStore();
  const fullName = user ? `${user.first_name} ${user.last_name}`.trim() : '';
  const isEdit = Boolean(existing);

  const [supplierName, setSupplierName] = useState(existing?.supplier_name || '');
  const [costDate, setCostDate] = useState(() => (existing?.cost_date ? existing.cost_date.slice(0, 10) : new Date().toISOString().slice(0, 10)));
  const [amountGross, setAmountGross] = useState(existing?.amount_gross != null ? String(existing.amount_gross) : '');
  const [amountVat, setAmountVat] = useState(existing?.amount_vat != null ? String(existing.amount_vat) : '');
  const [amountNet, setAmountNet] = useState(existing?.amount_net != null ? String(existing.amount_net) : '');
  const [assumeVat20, setAssumeVat20] = useState(!isEdit); // don't clobber existing amounts on edit
  const [description, setDescription] = useState(existing?.description || '');
  // Category selected by Xero code; derive label + cost_type from the map.
  const [categoryCode, setCategoryCode] = useState(existing?.xero_account_code || (presetVehicleId ? '406' : presetIssueId ? '473' : ''));
  const [paymentMethod, setPaymentMethod] = useState<CostPaymentMethod>(existing?.payment_method || 'cot_card');
  const [cardHolder, setCardHolder] = useState(existing?.cot_card_holder || fullName);
  const [cardLast4, setCardLast4] = useState(existing?.cot_card_last4 || localStorage.getItem(LAST4_KEY) || '');
  const [paymentStatus, setPaymentStatus] = useState<CostPaymentStatus>(existing?.payment_status || 'paid');
  const [rechargeMode, setRechargeMode] = useState<CostRechargeMode>(existing?.recharge_mode || 'none');
  const [rechargeAmount, setRechargeAmount] = useState(existing?.recharge_amount != null ? String(existing.recharge_amount) : '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [receiptIsPdf, setReceiptIsPdf] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 'not yet paid' is a payable. Only auto-drive status when not editing an
  // existing record (so we don't stomp a manually-set status on edit).
  useEffect(() => {
    if (isEdit) return;
    setPaymentStatus(paymentMethod === 'not_yet_paid' ? 'awaiting_payment' : 'paid');
  }, [paymentMethod, isEdit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Receipt preview for a newly-selected file (object URL, revoked on change).
  useEffect(() => {
    if (!receiptFile) { setReceiptPreview(null); setReceiptIsPdf(false); return; }
    const url = URL.createObjectURL(receiptFile);
    setReceiptPreview(url);
    setReceiptIsPdf(receiptFile.type === 'application/pdf');
    return () => URL.revokeObjectURL(url);
  }, [receiptFile]);

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
    } catch {
      setError('Could not open the saved receipt.');
    }
  }, [existing]);

  const canRecharge = Boolean(presetJobId || existing?.job_id);

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

      if (paymentMethod === 'cot_card' && cardLast4) localStorage.setItem(LAST4_KEY, cardLast4);

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
        cot_card_holder: paymentMethod === 'cot_card' ? cardHolder || null : null,
        cot_card_last4: paymentMethod === 'cot_card' ? cardLast4 || null : null,
        payment_status: paymentStatus,
        recharge_mode: canRecharge ? rechargeMode : 'none',
        recharge_amount: canRecharge && rechargeMode !== 'none' && rechargeAmount ? Number(rechargeAmount) : null,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
        notes: notes || null,
      };
      if (!isEdit) {
        payload.job_id = presetJobId || null;
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{isEdit ? 'Edit Cost' : 'Capture Cost'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}

          {/* Receipt first — AI extraction (fast-follow) will fill the rest from it */}
          <div className="bg-gray-50 border border-dashed border-gray-300 rounded-md p-3">
            <label className="block text-sm font-medium text-gray-700 mb-2">Receipt</label>
            <input type="file" accept="image/*,application/pdf" className="text-sm mb-2"
              onChange={(e) => setReceiptFile(e.target.files?.[0] || null)} />
            {receiptPreview && !receiptIsPdf && (
              <img src={receiptPreview} alt="Receipt preview" onClick={() => window.open(receiptPreview, '_blank')}
                className="w-full max-h-64 object-contain rounded border border-gray-200 cursor-zoom-in bg-white" />
            )}
            {receiptPreview && receiptIsPdf && (
              <embed src={receiptPreview} type="application/pdf" className="w-full h-64 rounded border border-gray-200" />
            )}
            {!receiptFile && existing?.receipt_filename && (
              <div className="text-sm text-gray-600 flex items-center gap-2">
                <span>📄 {existing.receipt_filename}</span>
                <button type="button" onClick={viewExistingReceipt} className="text-purple-700 hover:underline">View</button>
                <span className="text-gray-400">· choose a file above to replace</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
              <input className={inputCls} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. TTS360, Shell" />
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
            <label className="block text-sm font-medium text-gray-700 mb-1">What's this cost for?</label>
            <select className={inputCls} value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              <option value="">— select —</option>
              {COST_CATEGORIES.map((c) => <option key={c.xeroCode} value={c.xeroCode}>{c.label}</option>)}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Card holder</label>
                <input className={inputCls} value={cardHolder} onChange={(e) => setCardHolder(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Card last 4</label>
                <input maxLength={4} className={inputCls} value={cardLast4} onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ''))}
                  placeholder="remembered for next time" />
              </div>
            </div>
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
