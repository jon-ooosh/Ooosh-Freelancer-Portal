/**
 * Cash forecast settings (admin only): the target and overdraft, Stripe and
 * YouLend, each card's terms and repayment plan, and the accounts that make up
 * "cash in the bank". docs/CASHFLOW-FORECAST-SPEC.md §2, §5.6.
 */
import { useEffect, useState } from 'react';
import ModalShell from '../ModalShell';
import { api } from '../../services/api';
import type { Account, Card, CashflowSettings, CostCardMethod } from '../../lib/cashflow';
import { COST_CARD_METHOD_LABELS, WEEKDAYS, gbp, ordinal } from '../../lib/cashflow';

const inputCls = 'rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500';
const num = (s: string): number | null => {
  const t = s.replace(/[£,%\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const pct = (fraction: number | null | undefined, dp = 2) => (fraction === null || fraction === undefined ? '' : String(Math.round(fraction * 100 * 10 ** dp) / 10 ** dp));

interface CardDraft {
  id: string | null;
  name: string;
  monthlyRatePct: string;
  statementDay: string;
  paymentDay: string;
  creditLimit: string;
  plan: Card['plan'];
  minPct: string;
  fixedAmount: string;
  fixedEvery: 'week' | 'month';
  fixedWeekday: string;
  typicalMonthlySpend: string;
  costPaymentMethod: CostCardMethod | '';
  receiptsMonthly: number;
  receiptsCount: number;
}

const cardDraft = (c: Card | null): CardDraft => ({
  id: c?.id || null, name: c?.name || '', monthlyRatePct: c ? pct(c.monthlyRate, 3) : '0',
  statementDay: str(c?.statementDay), paymentDay: str(c?.paymentDay), creditLimit: str(c?.creditLimit),
  plan: c?.plan || 'full', minPct: str(c?.minPct), fixedAmount: str(c?.fixedAmount),
  fixedEvery: c?.fixedEvery || 'week', fixedWeekday: str(c?.fixedWeekday ?? 1), typicalMonthlySpend: str(c?.typicalMonthlySpend),
  costPaymentMethod: c?.costPaymentMethod || '', receiptsMonthly: c?.receiptsMonthly ?? 0, receiptsCount: c?.receiptsCount ?? 0,
});

export default function CashflowSettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [measured, setMeasured] = useState<{ share: number | null; payments: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Array<{ likelihood: string; booked: number; lost: number }>>([]);
  const [minSample, setMinSample] = useState(20);
  const [suggestTransfer, setSuggestTransfer] = useState(true);
  const [cards, setCards] = useState<Card[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [card, setCard] = useState<CardDraft | null>(null);
  const [newAccount, setNewAccount] = useState({ name: '', kind: 'bank' as Account['kind'] });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const loadAll = async () => {
    try {
      const [s, c, a] = await Promise.all([
        api.get<{ data: {
          settings: CashflowSettings; measuredStripeShare: { share: number | null; payments: number };
          outcomes: Array<{ likelihood: string; booked: number; lost: number }>; minSample: number;
        } }>('/cashflow/settings'),
        api.get<{ data: Card[] }>('/cashflow/cards?all=1'),
        api.get<{ data: Account[] }>('/cashflow/accounts?all=1'),
      ]);
      const v = s.data.settings;
      setSettings({
        targetFloor: str(v.targetFloor), overdraftLimit: str(v.overdraftLimit), excessRefundDays: str(v.excessRefundDays),
        stripeSharePct: pct(v.stripeShare, 0), stripeFeePct: pct(v.stripeFeeRate), stripePayoutDays: str(v.stripePayoutDays),
        youlendRatePct: pct(v.youlendRate, 0), youlendRemaining: str(v.youlendRemaining), youlendAsOf: v.youlendAsOf || '',
        weightProvisionalPct: pct(v.weightProvisional, 0), weightHotPct: pct(v.weightHot, 0), weightWarmPct: pct(v.weightWarm, 0),
        weightColdPct: pct(v.weightCold, 0), weightUnsetPct: pct(v.weightUnset, 0), likelyThresholdPct: pct(v.likelyThreshold, 0),
      });
      setMeasured(s.data.measuredStripeShare);
      setOutcomes(s.data.outcomes || []);
      setMinSample(s.data.minSample || 20);
      setSuggestTransfer(v.suggestBankTransfer);
      setCards(c.data);
      setAccounts(a.data);
    } catch (e) {
      setError((e as Error).message || 'Could not load the settings.');
    }
  };

  useEffect(() => { loadAll(); }, []);

  const saveSettings = async () => {
    if (!settings) return;
    setError(null);
    const n = (k: string) => num(settings[k]);
    const frac = (k: string) => { const v = n(k); return v === null || Number.isNaN(v) ? v : v / 100; };
    const body: Record<string, unknown> = {
      targetFloor: n('targetFloor'), overdraftLimit: n('overdraftLimit'), excessRefundDays: n('excessRefundDays'),
      stripeShare: n('stripeSharePct') !== null ? (n('stripeSharePct') as number) / 100 : null,
      stripeFeeRate: n('stripeFeePct') !== null ? (n('stripeFeePct') as number) / 100 : null,
      stripePayoutDays: n('stripePayoutDays'),
      youlendRate: n('youlendRatePct') !== null ? (n('youlendRatePct') as number) / 100 : null,
      youlendRemaining: n('youlendRemaining'), youlendAsOf: settings.youlendAsOf || null,
      weightProvisional: frac('weightProvisionalPct'), weightHot: frac('weightHotPct'), weightWarm: frac('weightWarmPct'),
      weightCold: frac('weightColdPct'), weightUnset: frac('weightUnsetPct'), likelyThreshold: frac('likelyThresholdPct'),
      suggestBankTransfer: suggestTransfer,
    };
    for (const [k, v] of Object.entries(body)) {
      if (k === 'youlendAsOf' || k === 'suggestBankTransfer') continue;
      if (v === null) { setError('Every figure needs a value.'); return; }
      if (Number.isNaN(v)) { setError('One of the figures isn\'t a number.'); return; }
    }
    try {
      await api.put('/cashflow/settings', body);
      setChanged(true);
      setSaved('Saved');
      setTimeout(() => setSaved(null), 2000);
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    }
  };

  const saveCard = async () => {
    if (!card) return;
    setError(null);
    const rate = num(card.monthlyRatePct);
    const body = {
      name: card.name.trim(),
      monthlyRate: rate === null || Number.isNaN(rate) ? 0 : rate / 100,
      statementDay: num(card.statementDay), paymentDay: num(card.paymentDay), creditLimit: num(card.creditLimit),
      plan: card.plan,
      minPct: num(card.minPct),
      fixedAmount: card.plan === 'fixed' ? num(card.fixedAmount) : null,
      fixedEvery: card.plan === 'fixed' ? card.fixedEvery : null,
      fixedWeekday: card.plan === 'fixed' && card.fixedEvery === 'week' ? num(card.fixedWeekday) : null,
      typicalMonthlySpend: num(card.typicalMonthlySpend),
      costPaymentMethod: card.costPaymentMethod || null,
    };
    if (!body.name) { setError('Give the card a name.'); return; }
    if (Object.values(body).some((v) => typeof v === 'number' && Number.isNaN(v))) { setError('One of the figures isn\'t a number.'); return; }
    try {
      if (card.id) await api.put(`/cashflow/cards/${card.id}`, body);
      else await api.post('/cashflow/cards', body);
      setCard(null);
      setChanged(true);
      await loadAll();
    } catch (e) {
      setError((e as Error).message || 'Could not save the card.');
    }
  };

  const toggleCardActive = async (c: Card) => {
    try {
      await api.put(`/cashflow/cards/${c.id}`, {
        name: c.name, monthlyRate: c.monthlyRate, statementDay: c.statementDay, paymentDay: c.paymentDay, creditLimit: c.creditLimit,
        plan: c.plan, minPct: c.minPct, fixedAmount: c.fixedAmount, fixedEvery: c.fixedEvery, fixedWeekday: c.fixedWeekday,
        typicalMonthlySpend: c.typicalMonthlySpend, costPaymentMethod: c.costPaymentMethod, isActive: !c.isActive,
      });
      setChanged(true);
      await loadAll();
    } catch (e) {
      setError((e as Error).message || 'Could not save the card.');
    }
  };

  const patchAccount = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.patch(`/cashflow/accounts/${id}`, body);
      setChanged(true);
      await loadAll();
    } catch (e) {
      setError((e as Error).message || 'Could not save the account.');
    }
  };

  const addAccount = async () => {
    if (!newAccount.name.trim()) return;
    try {
      await api.post('/cashflow/accounts', { name: newAccount.name.trim(), kind: newAccount.kind });
      setNewAccount({ name: '', kind: 'bank' });
      setChanged(true);
      await loadAll();
    } catch (e) {
      setError((e as Error).message || 'Could not add the account.');
    }
  };

  const close = () => { if (changed) onChanged(); onClose(); };
  const field = (key: string, label: string, hint?: string, suffix?: string, type = 'text') => (
    <label className="text-sm">
      <span className="block text-gray-700 mb-1">{label}</span>
      <span className="flex items-center gap-1">
        <input type={type} inputMode={type === 'text' ? 'decimal' : undefined} value={settings?.[key] ?? ''}
          onChange={(e) => setSettings((s) => (s ? { ...s, [key]: e.target.value } : s))} className={`${inputCls} w-full ${type === 'text' ? 'text-right' : ''}`} />
        {suffix && <span className="text-gray-500 text-xs">{suffix}</span>}
      </span>
      {hint && <span className="block text-[11px] text-gray-500 mt-0.5">{hint}</span>}
    </label>
  );

  return (
    <ModalShell title="Cash forecast settings" onClose={close} width="max-w-3xl">
      {!settings && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {settings && (
        <div className="space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">The lines on the chart</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('targetFloor', 'Target (£)', 'Amber below this')}
              {field('overdraftLimit', 'Overdraft limit (£)', 'Red below minus this')}
              {field('excessRefundDays', 'Excess refunded after', 'Days after the van is back', 'days')}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Stripe and YouLend</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('stripeSharePct', 'Share of money in via Stripe', measured?.share !== null && measured?.share !== undefined
                ? `Last 90 days in OP: ${Math.round(measured.share * 100)}% (${measured.payments} payments)` : undefined, '%')}
              {field('stripePayoutDays', 'Spendable after', 'Working days from payment to bank', 'days')}
              {field('stripeFeePct', 'Stripe fee', 'Only used if Stripe\'s own figures can\'t be read', '%')}
              {field('youlendRatePct', 'YouLend withholding', undefined, '%')}
              {field('youlendRemaining', 'YouLend still owed (£)', 'From the YouLend statement — update monthly')}
              {field('youlendAsOf', 'As of', undefined, undefined, 'date')}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
              <input type="checkbox" checked={suggestTransfer} onChange={(e) => setSuggestTransfer(e.target.checked)} />
              Suggest asking for bank transfer instead of card when a week dips (keeps YouLend's cut and Stripe's fee in hand)
            </label>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Enquiries — how likely they are to book</h3>
            <p className="text-xs text-gray-600 mb-2">
              Each enquiry is weighted by what actually happened to enquiries with the same likelihood over the last 24 months, once there are {minSample} to learn from.
              Below that, and always for provisional, these figures are used.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
              {field('weightProvisionalPct', 'Provisional', undefined, '%')}
              {field('weightHotPct', 'Hot', undefined, '%')}
              {field('weightWarmPct', 'Warm', undefined, '%')}
              {field('weightColdPct', 'Cold', undefined, '%')}
              {field('weightUnsetPct', 'Not set', undefined, '%')}
              {field('likelyThresholdPct', '"Likely" from', undefined, '%')}
            </div>
            <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left font-semibold px-3 py-1.5">Last 24 months</th>
                    <th className="text-right font-semibold px-3 py-1.5">Booked</th>
                    <th className="text-right font-semibold px-3 py-1.5">Lost</th>
                    <th className="text-right font-semibold px-3 py-1.5">Booked %</th>
                    <th className="text-left font-semibold px-3 py-1.5">Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(['hot', 'warm', 'cold', 'unset'] as const).map((l) => {
                    const o = outcomes.find((x) => x.likelihood === l);
                    const decided = o ? o.booked + o.lost : 0;
                    return (
                      <tr key={l}>
                        <td className="px-3 py-1.5 text-gray-800">{l === 'unset' ? 'No likelihood set' : l[0].toUpperCase() + l.slice(1)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{o?.booked ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{o?.lost ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{decided ? `${Math.round(((o?.booked ?? 0) / decided) * 100)}%` : '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600">{decided >= minSample ? 'learned' : 'figure above'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">"Lost" leaves out quotes lost because they booked their other option. Booked-then-cancelled counts as booked.</p>
          </section>

          <div className="flex items-center justify-end gap-3">
            {saved && <span className="text-sm text-green-700">{saved}</span>}
            <button type="button" onClick={saveSettings} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">Save these</button>
          </div>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-900">Cards</h3>
              {!card && <button type="button" onClick={() => setCard(cardDraft(null))} className="text-sm text-ooosh-700 hover:underline">+ Add a card</button>}
            </div>
            {!card && (
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {cards.map((c) => (
                  <div key={c.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${c.isActive ? '' : 'opacity-50'}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-600">
                        {c.monthlyRate > 0 ? `${(c.monthlyRate * 100).toFixed(2)}% a month` : 'no interest'}
                        {c.creditLimit !== null && ` · limit ${gbp(c.creditLimit)}`}
                        {' · '}
                        {c.plan === 'full' && `paid in full on the ${ordinal(c.paymentDay)}`}
                        {c.plan === 'minimum' && `minimum ${c.minPct}% on the ${ordinal(c.paymentDay)}`}
                        {c.plan === 'fixed' && `${gbp(c.fixedAmount)} every ${c.fixedEvery === 'week' ? WEEKDAYS[(c.fixedWeekday || 1) - 1] : `month on the ${ordinal(c.paymentDay)}`}`}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button type="button" onClick={() => setCard(cardDraft(c))} className="text-xs text-ooosh-700 hover:underline">Edit</button>
                      <button type="button" onClick={() => toggleCardActive(c)} className="text-xs text-gray-500 hover:underline">{c.isActive ? 'Stop counting' : 'Count again'}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {card && (
              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <label className="text-sm col-span-2">
                    <span className="block text-gray-700 mb-1">Name</span>
                    <input value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} className={`${inputCls} w-full`} />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Interest a month</span>
                    <span className="flex items-center gap-1"><input inputMode="decimal" value={card.monthlyRatePct} onChange={(e) => setCard({ ...card, monthlyRatePct: e.target.value })} className={`${inputCls} w-full text-right`} /><span className="text-xs text-gray-500">%</span></span>
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Credit limit (£)</span>
                    <input inputMode="decimal" value={card.creditLimit} onChange={(e) => setCard({ ...card, creditLimit: e.target.value })} className={`${inputCls} w-full text-right`} />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Statement day</span>
                    <input inputMode="numeric" value={card.statementDay} onChange={(e) => setCard({ ...card, statementDay: e.target.value })} className={`${inputCls} w-full text-right`} placeholder="1–31" />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Payment due day</span>
                    <input inputMode="numeric" value={card.paymentDay} onChange={(e) => setCard({ ...card, paymentDay: e.target.value })} className={`${inputCls} w-full text-right`} placeholder="1–31" />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Minimum payment</span>
                    <span className="flex items-center gap-1"><input inputMode="decimal" value={card.minPct} onChange={(e) => setCard({ ...card, minPct: e.target.value })} className={`${inputCls} w-full text-right`} /><span className="text-xs text-gray-500">%</span></span>
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-700 mb-1">Typical spend a month (£)</span>
                    <input inputMode="decimal" value={card.typicalMonthlySpend} onChange={(e) => setCard({ ...card, typicalMonthlySpend: e.target.value })}
                      className={`${inputCls} w-full text-right`} placeholder={card.costPaymentMethod && card.receiptsCount > 0 ? String(Math.round(card.receiptsMonthly)) : ''} />
                  </label>
                </div>
                <div className="text-sm">
                  <span className="block text-gray-700 mb-1">Receipts in Costs paid by</span>
                  <select value={card.costPaymentMethod} onChange={(e) => setCard({ ...card, costPaymentMethod: e.target.value as CostCardMethod | '' })} className={inputCls}>
                    <option value="">— not linked —</option>
                    {(Object.keys(COST_CARD_METHOD_LABELS) as CostCardMethod[]).map((m) => <option key={m} value={m}>{COST_CARD_METHOD_LABELS[m]}</option>)}
                  </select>
                  <span className="block text-[11px] text-gray-500 mt-1">
                    A receipt logged on this card after Monday's check-in raises its balance straight away.
                    {card.costPaymentMethod && card.id && (card.receiptsCount > 0
                      ? <> Last 90 days of receipts: <b>{gbp(card.receiptsMonthly)} a month</b> ({card.receiptsCount} receipts) — used as the typical spend while the box above is empty. It only counts what was logged, so it runs low.</>
                      : <> No receipts logged on it in the last 90 days.</>)}
                  </span>
                </div>
                <div className="text-sm">
                  <span className="block text-gray-700 mb-1">How it's paid</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={card.plan} onChange={(e) => setCard({ ...card, plan: e.target.value as Card['plan'] })} className={inputCls}>
                      <option value="full">In full on the due day</option>
                      <option value="minimum">The minimum on the due day</option>
                      <option value="fixed">A fixed amount</option>
                    </select>
                    {card.plan === 'fixed' && (
                      <>
                        <input inputMode="decimal" value={card.fixedAmount} onChange={(e) => setCard({ ...card, fixedAmount: e.target.value })} className={`${inputCls} w-24 text-right`} placeholder="£" />
                        <select value={card.fixedEvery} onChange={(e) => setCard({ ...card, fixedEvery: e.target.value as 'week' | 'month' })} className={inputCls}>
                          <option value="week">every week, on</option>
                          <option value="month">every month, on the due day</option>
                        </select>
                        {card.fixedEvery === 'week' && (
                          <select value={card.fixedWeekday} onChange={(e) => setCard({ ...card, fixedWeekday: e.target.value })} className={inputCls}>
                            {WEEKDAYS.map((d, i) => <option key={d} value={String(i + 1)}>{d}</option>)}
                          </select>
                        )}
                      </>
                    )}
                  </div>
                  <span className="block text-[11px] text-gray-500 mt-1">
                    A fixed plan is topped up on the due day if the month's payments fall short of the minimum. "In full" pays the last statement, or the typical spend once a month has passed.
                  </span>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setCard(null)} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Cancel</button>
                  <button type="button" onClick={saveCard} className="px-3 py-1.5 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">Save card</button>
                </div>
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Accounts in "cash in the bank"</h3>
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {accounts.map((a) => {
                const active = a.isActive;
                return (
                  <div key={a.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${active ? '' : 'opacity-50'}`}>
                    <p className="text-sm text-gray-900">{a.name} <span className="text-xs text-gray-500">· {a.kind}</span>{a.isMain && <span className="ml-1.5 text-[10px] font-semibold text-ooosh-700 bg-ooosh-50 rounded px-1.5 py-0.5">main</span>}</p>
                    <div className="flex gap-2 shrink-0">
                      {!a.isMain && active && <button type="button" onClick={() => patchAccount(a.id, { isMain: true })} className="text-xs text-gray-500 hover:underline">Make main</button>}
                      <button type="button" onClick={() => patchAccount(a.id, { isActive: !active })} className="text-xs text-gray-500 hover:underline">{active ? 'Stop counting' : 'Count again'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <input value={newAccount.name} onChange={(e) => setNewAccount((n) => ({ ...n, name: e.target.value }))} placeholder="New account name" className={inputCls} />
              <select value={newAccount.kind} onChange={(e) => setNewAccount((n) => ({ ...n, kind: e.target.value as Account['kind'] }))} className={inputCls}>
                <option value="bank">Bank</option>
                <option value="savings">Savings</option>
                <option value="cash">Cash</option>
              </select>
              <button type="button" onClick={addAccount} className="text-sm text-ooosh-700 hover:underline">+ Add</button>
            </div>
          </section>
        </div>
      )}
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </ModalShell>
  );
}
