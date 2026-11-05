/**
 * The Monday check-in: today's real balance of every account and what's owed on
 * every card. The forecast starts from these figures, because Xero lags reality
 * (docs/CASHFLOW-FORECAST-SPEC.md §3). Stripe is read live when the key allows.
 */
import { useEffect, useState } from 'react';
import ModalShell from '../ModalShell';
import { api } from '../../services/api';
import type { Account, Card } from '../../lib/cashflow';
import { gbp, shortDate } from '../../lib/cashflow';

interface CheckInData {
  today: string;
  accounts: Account[];
  cards: Card[];
  stripe: { live: true; available: number; pending: number } | { live: false; reason?: string };
  wise: { live: true; gbp: number; others: Array<{ currency: string; value: number }> } | { live: false; reason?: string };
}

const toInput = (n: number | null) => (n === null ? '' : String(n));
const parseMoney = (s: string): number | null => {
  const t = s.replace(/[£,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export default function CheckInModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<CheckInData | null>(null);
  const [asOf, setAsOf] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ data: CheckInData }>('/cashflow/check-in')
      .then((r) => {
        setData(r.data);
        setAsOf(r.data.today);
        const v: Record<string, string> = {};
        for (const a of r.data.accounts) v[`a:${a.id}`] = toInput(a.balance);
        for (const c of r.data.cards) v[`c:${c.id}`] = toInput(c.balance);
        setValues(v);
      })
      .catch((e: Error) => setError(e.message || 'Could not load the balances.'));
  }, []);

  const stripeLive = data?.stripe.live === true;
  const wiseLive = data?.wise.live === true;
  /** Accounts OP reads itself — nothing to type for these. */
  const isLive = (kind: string) => (kind === 'stripe' && stripeLive) || (kind === 'wise' && wiseLive);
  const typedAccounts = (data?.accounts || []).filter((a) => !isLive(a.kind));

  const save = async () => {
    if (!data) return;
    const accounts: Array<{ id: string; balance: number }> = [];
    const cards: Array<{ id: string; balance: number }> = [];
    for (const a of typedAccounts) {
      const n = parseMoney(values[`a:${a.id}`] || '');
      if (n === null) continue;
      if (Number.isNaN(n)) { setError(`${a.name}: that isn't an amount.`); return; }
      accounts.push({ id: a.id, balance: n });
    }
    for (const c of data.cards) {
      const n = parseMoney(values[`c:${c.id}`] || '');
      if (n === null) continue;
      if (Number.isNaN(n)) { setError(`${c.name}: that isn't an amount.`); return; }
      cards.push({ id: c.id, balance: Math.abs(n) });
    }
    if (accounts.length + cards.length === 0) { setError('Type at least one balance.'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.post('/cashflow/check-in', { asOf, accounts, cards });
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
      setSaving(false);
    }
  };

  const input = (key: string) => (
    <input inputMode="decimal" value={values[key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      className="w-32 rounded border border-gray-300 px-2 py-1.5 text-sm text-right tabular-nums focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
      placeholder="0.00" />
  );

  return (
    <ModalShell title="Monday check-in" subtitle="Today's real balances — from the bank apps, not Xero." onClose={onClose} width="max-w-lg">
      {!data && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {data && (
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-gray-700">Balances as of</span>
            <input type="date" value={asOf} max={data.today} onChange={(e) => setAsOf(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Accounts</p>
            <div className="divide-y divide-gray-100">
              {data.accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-900">{a.name}{a.isMain && <span className="ml-1.5 text-[10px] font-semibold text-ooosh-700 bg-ooosh-50 rounded px-1.5 py-0.5">main</span>}</p>
                    <p className="text-[11px] text-gray-500">
                      {isLive(a.kind)
                        ? `Read live from ${a.kind === 'stripe' ? 'Stripe' : 'Wise'} — nothing to type`
                        : a.balance !== null ? `Last: ${gbp(a.balance, true)} on ${shortDate(a.asOf)}` : 'Not typed yet'}
                    </p>
                  </div>
                  {a.kind === 'stripe' && data.stripe.live
                    ? <span className="text-sm tabular-nums text-gray-700">{gbp(data.stripe.available, true)} <span className="text-[11px] text-gray-500">+ {gbp(data.stripe.pending, true)} pending</span></span>
                    : a.kind === 'wise' && data.wise.live
                      ? <span className="text-sm tabular-nums text-gray-700">{gbp(data.wise.gbp, true)}{data.wise.others.length > 0 && <span className="block text-[11px] text-gray-500 text-right">+ {data.wise.others.map((o) => `${o.value.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${o.currency}`).join(', ')} (not counted)</span>}</span>
                      : input(`a:${a.id}`)}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">An overdrawn account is a minus figure (e.g. −1500).</p>
            {data.stripe.live === false && (
              <p className="text-[11px] text-amber-700 mt-1">Stripe can't be read live ({data.stripe.reason}) — type its balance.</p>
            )}
            {data.wise.live === false && data.accounts.some((a) => a.kind === 'wise') && (
              <p className="text-[11px] text-gray-500 mt-1">Wise isn't read live ({data.wise.reason}) — type its balance.</p>
            )}
          </div>

          {data.cards.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Cards — what's owed</p>
              <div className="divide-y divide-gray-100">
                {data.cards.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="text-sm text-gray-900">{c.name}</p>
                      <p className="text-[11px] text-gray-500">{c.balance !== null ? `Last: ${gbp(c.balance, true)} on ${shortDate(c.asOf)}` : 'Not typed yet'}</p>
                    </div>
                    {input(`c:${c.id}`)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={save} disabled={saving}
              className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save balances'}
            </button>
          </div>
        </div>
      )}
      {!data && error && <p className="text-sm text-red-600">{error}</p>}
    </ModalShell>
  );
}
