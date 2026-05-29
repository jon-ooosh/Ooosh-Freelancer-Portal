/**
 * CostCaptureModal — manual cost/receipt capture for the Cost Capture & Recharge
 * module. Creates a `costs` row via POST /api/costs.
 *
 * The Xero account picker reads the live chart of accounts (GET /api/costs/xero/
 * accounts) when Xero is configured; otherwise it degrades to a free-text
 * category. Receipt upload uses the generic attachment_only upload mode and
 * stores the returned R2 key on the cost.
 *
 * AI extraction (Claude vision) is a fast-follow — this is the manual path.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type {
  Cost,
  CostType,
  CostPaymentMethod,
  CostPaymentStatus,
  CostRechargeMode,
} from '../../../shared/types';

interface XeroAccount {
  AccountID: string;
  Code: string;
  Name: string;
  Type: string;
  Class?: string;
  Status?: string;
}

interface Props {
  onClose: () => void;
  onSaved: (cost: Cost) => void;
  presetJobId?: string | null;
  presetVehicleId?: string | null;
  presetIssueId?: string | null;
}

const COST_TYPES: { value: CostType; label: string }[] = [
  { value: 'overhead', label: 'Overhead' },
  { value: 'job', label: 'Job cost' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'stock', label: 'Stock' },
  { value: 'parts', label: 'Parts' },
  { value: 'freelancer_invoice', label: 'Freelancer invoice' },
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

export default function CostCaptureModal({ onClose, onSaved, presetJobId, presetVehicleId, presetIssueId }: Props) {
  const [supplierName, setSupplierName] = useState('');
  const [costDate, setCostDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amountGross, setAmountGross] = useState('');
  const [amountVat, setAmountVat] = useState('');
  const [amountNet, setAmountNet] = useState('');
  const [description, setDescription] = useState('');
  const [costType, setCostType] = useState<CostType>(presetVehicleId ? 'vehicle' : presetIssueId ? 'parts' : 'overhead');
  const [paymentMethod, setPaymentMethod] = useState<CostPaymentMethod>('cot_card');
  const [cardHolder, setCardHolder] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<CostPaymentStatus>('paid');
  const [rechargeMode, setRechargeMode] = useState<CostRechargeMode>('none');
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [xeroAccountCode, setXeroAccountCode] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  const [accounts, setAccounts] = useState<XeroAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Payment status follows method: 'not yet paid' → awaiting payment (a payable).
  useEffect(() => {
    if (paymentMethod === 'not_yet_paid') setPaymentStatus('awaiting_payment');
    else setPaymentStatus('paid');
  }, [paymentMethod]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load Xero chart of accounts for the category picker (graceful fallback).
  useEffect(() => {
    api.get<{ data: XeroAccount[] }>('/costs/xero/accounts')
      .then((r) => setAccounts((r.data || []).filter((a) => a.Status !== 'ARCHIVED')))
      .catch(() => setAccountsError(true));
  }, []);

  const handleAccountPick = useCallback((code: string) => {
    setXeroAccountCode(code);
    const acct = accounts?.find((a) => a.Code === code);
    if (acct) setCategory(acct.Name);
  }, [accounts]);

  const canRecharge = Boolean(presetJobId);

  async function handleSave() {
    setError('');
    if (!amountGross || Number(amountGross) <= 0) { setError('Gross amount is required.'); return; }
    setSaving(true);
    try {
      // 1. Upload the receipt first (attachment_only mode → R2 key), if present.
      let receiptKey: string | null = null;
      let receiptName: string | null = null;
      if (receiptFile) {
        const fd = new FormData();
        fd.append('file', receiptFile);
        fd.append('attachment_only', 'true');
        const up = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
        receiptKey = up.r2_key;
        receiptName = up.filename;
      }

      // 2. Create the cost.
      const payload: Record<string, unknown> = {
        supplier_name: supplierName || null,
        cost_date: costDate || null,
        amount_gross: amountGross ? Number(amountGross) : null,
        amount_vat: amountVat ? Number(amountVat) : null,
        amount_net: amountNet ? Number(amountNet) : null,
        description: description || null,
        category: category || null,
        xero_account_code: xeroAccountCode || null,
        cost_type: costType,
        payment_method: paymentMethod,
        cot_card_holder: paymentMethod === 'cot_card' ? cardHolder || null : null,
        cot_card_last4: paymentMethod === 'cot_card' ? cardLast4 || null : null,
        payment_status: paymentStatus,
        job_id: presetJobId || null,
        vehicle_id: presetVehicleId || null,
        platform_issue_id: presetIssueId || null,
        recharge_mode: canRecharge ? rechargeMode : 'none',
        recharge_amount: canRecharge && rechargeMode !== 'none' && rechargeAmount ? Number(rechargeAmount) : null,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
        status: 'confirmed',
        notes: notes || null,
      };
      const res = await api.post<{ data: Cost }>('/costs', payload);
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
          <h2 className="text-lg font-semibold text-gray-900">Capture Cost</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}

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

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Gross (£) *</label>
              <input type="number" step="0.01" min="0" className={inputCls} value={amountGross} onChange={(e) => setAmountGross(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">VAT (£)</label>
              <input type="number" step="0.01" min="0" className={inputCls} value={amountVat} onChange={(e) => setAmountVat(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Net (£)</label>
              <input type="number" step="0.01" min="0" className={inputCls} value={amountNet} onChange={(e) => setAmountNet(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this for?" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cost type</label>
              <select className={inputCls} value={costType} onChange={(e) => setCostType(e.target.value as CostType)}>
                {COST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Xero account</label>
              {accounts && !accountsError ? (
                <select className={inputCls} value={xeroAccountCode} onChange={(e) => handleAccountPick(e.target.value)}>
                  <option value="">— select —</option>
                  {accounts.map((a) => <option key={a.AccountID} value={a.Code}>{a.Code} · {a.Name}</option>)}
                </select>
              ) : (
                <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}
                  placeholder={accountsError ? 'Category (Xero unavailable)' : 'Category'} />
              )}
            </div>
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
                <input maxLength={4} className={inputCls} value={cardLast4} onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ''))} />
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Receipt</label>
            <input type="file" accept="image/*,application/pdf" className="text-sm"
              onChange={(e) => setReceiptFile(e.target.files?.[0] || null)} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : 'Save cost'}
          </button>
        </div>
      </div>
    </div>
  );
}
