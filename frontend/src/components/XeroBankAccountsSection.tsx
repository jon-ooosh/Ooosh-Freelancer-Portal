/**
 * XeroBankAccountsSection — admin maps OP payment methods → Xero bank accounts.
 *
 * Settings page section. For each paid-now instrument (card / transfer / cash)
 * the admin picks the Xero bank account that money for that method posts to.
 * Used both for the Spend Money push (paid-now costs) AND for recording a
 * payment against a bill when a pay-later cost is marked paid by that method.
 * Stored in system_settings under category `xero_bank_accounts`.
 *
 * Unmapped methods: cost-xero-push leaves the cost on a calm "Not synced"
 * advisory (visible in /money/costs with a Push now button once mapped).
 */
import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface BankAccount { AccountID: string; Code: string | null; Name: string; Last4: string | null }
interface SystemSetting { key: string; value: string | null; label: string }

const ORDER = [
  { key: 'xero_bank_cot_card',        hint: 'Company card (COT)' },
  { key: 'xero_bank_amex',            hint: 'Amex card' },
  { key: 'xero_bank_lloyds_cc',       hint: 'Lloyds credit card' },
  { key: 'xero_bank_petty_cash',      hint: 'Petty cash' },
  { key: 'xero_bank_paypal',          hint: 'PayPal' },
  { key: 'xero_bank_wise',            hint: 'Wise bank transfer' },
  { key: 'xero_bank_lloyds_transfer', hint: 'Lloyds bank transfer' },
];

export default function XeroBankAccountsSection() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [xeroAvailable, setXeroAvailable] = useState<boolean | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [accountsRes, settingsRes] = await Promise.all([
        api.get<{ data: BankAccount[] }>('/costs/xero/bank-accounts').catch(() => ({ data: [] })),
        api.get<{ data: SystemSetting[] }>('/system-settings?category=xero_bank_accounts'),
      ]);
      setAccounts(accountsRes.data);
      setXeroAvailable(accountsRes.data.length > 0);
      setSettings(settingsRes.data);
      const vals: Record<string, string> = {};
      for (const s of settingsRes.data) vals[s.key] = s.value ?? '';
      setEdit(vals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Xero bank accounts');
    } finally {
      setLoading(false);
    }
  }

  function hasChanges(): boolean {
    return settings.some((s) => (s.value ?? '') !== (edit[s.key] ?? ''));
  }
  function cancel() {
    const vals: Record<string, string> = {};
    for (const s of settings) vals[s.key] = s.value ?? '';
    setEdit(vals);
    setEditing(false);
    setError(''); setSuccess('');
  }
  async function save() {
    setSaving(true); setError(''); setSuccess('');
    try {
      const changed: Record<string, string | null> = {};
      for (const s of settings) {
        const next = edit[s.key] ?? '';
        if (next !== (s.value ?? '')) changed[s.key] = next || null;
      }
      if (Object.keys(changed).length === 0) { setEditing(false); return; }
      await api.put('/system-settings', { settings: changed });
      setSuccess('Bank account mapping saved.');
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  const settingsByKey = new Map(settings.map((s) => [s.key, s]));

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Xero Bank Accounts</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Map each payment instrument to a Xero bank account. Paid-now costs push as Spend Money there;
            bill payments (supplier bills, staff reimbursements) post against it when marked paid — both
            ready for one-click reconciliation against the bank feed.
          </p>
        </div>
        {!editing ? (
          <button onClick={() => setEditing(true)} disabled={xeroAvailable === false}
            className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 disabled:opacity-40">
            Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={cancel} disabled={saving}
              className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 disabled:opacity-50">Cancel</button>
            <button onClick={save} disabled={saving || !hasChanges()}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {xeroAvailable === false && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
          Couldn't reach Xero (or no bank accounts returned). Check the connection and reload.
        </div>
      )}
      {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}
      {success && <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">{success}</div>}

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        {ORDER.map((row) => {
          const setting = settingsByKey.get(row.key);
          const currentID = edit[row.key] ?? '';
          const currentAcct = accounts.find((a) => a.AccountID === currentID);
          return (
            <div key={row.key} className="flex items-center justify-between gap-4 py-1">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-700">{setting?.label || row.hint}</p>
              </div>
              <div className="flex-1 min-w-0 text-right">
                {!editing ? (
                  currentAcct
                    ? <span className="text-sm text-gray-900">
                        {currentAcct.Name}
                        {currentAcct.Last4 && <span className="text-gray-400"> · ····{currentAcct.Last4}</span>}
                      </span>
                    : <span className="text-sm text-gray-400 italic">— not set —</span>
                ) : (
                  <select className="w-full max-w-xs border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500"
                    value={currentID} onChange={(e) => setEdit({ ...edit, [row.key]: e.target.value })}>
                    <option value="">— not set —</option>
                    {accounts.map((a) => (
                      <option key={a.AccountID} value={a.AccountID}>
                        {a.Name}{a.Last4 ? ` · ····${a.Last4}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
