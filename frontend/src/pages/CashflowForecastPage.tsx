/**
 * Money › Cash forecast — admin only (docs/CASHFLOW-FORECAST-SPEC.md).
 *
 * Phase 1: the committed line. Where the cash is today, what's coming in from
 * booked jobs, what's going out (Xero bills, planned items, van HP, cards,
 * excess refunds, Stripe's fee and YouLend), by week for 13 weeks and by day
 * for the next 14. Every figure is computed by the backend; this page shows it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { FixAction, FlowItem, Forecast, PileItem, RowKey, XeroBillRow } from '../lib/cashflow';
import { gbp, monthYear, shortDate } from '../lib/cashflow';
import ForecastChart from '../components/cashflow/ForecastChart';
import ForecastTable, { type CellRef } from '../components/cashflow/ForecastTable';
import CheckInModal from '../components/cashflow/CheckInModal';
import PlannedItemsModal from '../components/cashflow/PlannedItemsModal';
import BillsModal from '../components/cashflow/BillsModal';
import CashflowSettingsModal from '../components/cashflow/CashflowSettingsModal';

type Modal = null | 'check-in' | 'planned' | 'bills' | 'settings';

function Tile({ label, children, tone = 'plain' }: { label: string; children: React.ReactNode; tone?: 'plain' | 'amber' | 'red' }) {
  const toneCls = tone === 'amber' ? 'border-amber-200 bg-amber-50' : tone === 'red' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white';
  return (
    <div className={`rounded-xl border p-4 ${toneCls}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      {children}
    </div>
  );
}

/** A table row's name — the committed rows come from the forecast; the enquiry rows are the page's own. */
function rowLabel(forecast: Forecast, key: RowKey | 'all'): string {
  if (key === 'all') return 'everything';
  if (key === 'pipeline_likely') return 'Likely enquiries (weighted)';
  if (key === 'pipeline_possible') return 'Possible enquiries (weighted)';
  return forecast.rows.find((r) => r.key === key)?.label || key;
}

/** "What would fix it" — rules from the backend (cashflow-pipeline.ts buildFixList), shown as they come. */
function FixPanel({ forecast, onBills }: { forecast: Forecast; onBills: () => void }) {
  const dip = forecast.dip;
  const target = forecast.settings.targetFloor;
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">What would fix it</h2>
      {!dip ? (
        <p className="text-sm text-green-800 mt-2">No week in the next 13 dips below your {gbp(target)} target on booked money alone.</p>
      ) : (
        <>
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Week of <b>{shortDate(dip.start)}</b> closes at <b>{gbp(dip.closing)}</b> — the first below your {gbp(target)} target. These would lift it:
          </div>
          {forecast.fixList.length === 0 && <p className="text-sm text-gray-600 mt-2">Nothing OP can see would move it — look at planned items and bills.</p>}
          <ol className="mt-1 divide-y divide-gray-100">
            {forecast.fixList.map((a: FixAction, i) => (
              <li key={a.key} className="py-2.5 flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-ooosh-50 text-ooosh-700 text-[11px] font-bold grid place-items-center">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900">{a.title}</p>
                    {a.amount !== null ? <span className="text-sm font-bold tabular-nums text-green-700 whitespace-nowrap">+{gbp(a.amount)}</span>
                      : <span className="text-xs text-gray-400">info</span>}
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5">{a.detail}</p>
                  {a.links.length > 0 && (
                    <p className="text-xs mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                      {a.links.map((l, k) => (l.jobId
                        ? <Link key={k} to={`/jobs/${l.jobId}`} className="text-ooosh-700 hover:underline">{l.label}</Link>
                        : l.billId ? <button key={k} type="button" onClick={onBills} className="text-ooosh-700 hover:underline">{l.label}</button>
                          : <span key={k} className="text-gray-600">{l.label}</span>))}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="text-[11px] text-gray-400 mt-2 border-t border-gray-100 pt-2">Rules, not guesses. Never suggests delaying an excess refund or money owed to a client.</p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs text-gray-600 tabular-nums">
      <span className="truncate">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function CashflowForecastPage() {
  const role = useAuthStore((s) => s.user?.role);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [byDay, setByDay] = useState(false);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [instalmentBill, setInstalmentBill] = useState<XeroBillRow | null>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ data: Forecast }>(`/cashflow/forecast${fresh ? '?fresh=1' : ''}`);
      setForecast(r.data);
    } catch (e) {
      setError((e as Error).message || 'Could not build the forecast.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (role === 'admin') load(); }, [role, load]);

  const periods = useMemo(() => (forecast ? (byDay ? forecast.days : forecast.weeks) : []), [forecast, byDay]);

  const drillItems: FlowItem[] = useMemo(() => {
    if (!forecast || !selected || !periods[selected.period]) return [];
    const p = periods[selected.period];
    return forecast.items.filter((i) => i.date >= p.start && i.date <= p.end && (selected.row === 'all' ? !i.tier : i.row === selected.row));
  }, [forecast, selected, periods]);

  if (role !== 'admin') {
    return <div className="p-6 text-sm text-gray-600">The cash forecast is for admins only.</div>;
  }

  const settings = forecast?.settings;
  const limit = settings ? -Math.abs(settings.overdraftLimit) : -22000;
  const target = settings?.targetFloor ?? 0;
  const tone = (v: number): 'plain' | 'amber' | 'red' => (v < limit ? 'red' : v < target ? 'amber' : 'plain');
  const lowWeek = forecast?.lowest.week;
  const lowDay = forecast?.lowest.day;
  const committedIn = forecast?.weeks.reduce((s, w) => s + w.totalIn, 0) ?? 0;
  const committedOut = forecast?.weeks.reduce((s, w) => s + w.totalOut, 0) ?? 0;

  const openLink = (link: FlowItem['link']) => {
    if (!link) return;
    if (link.type === 'planned') setModal('planned');
    else if (link.type === 'xero_bill') setModal('bills');
    else if (link.type === 'card' || link.type === 'settings') setModal('settings');
  };
  const linkFor = (item: { link?: FlowItem['link'] }) => {
    const l = item.link;
    if (!l) return null;
    if (l.type === 'job' && l.id) return <Link to={`/jobs/${l.id}`} className="text-ooosh-700 hover:underline">Job</Link>;
    if (l.type === 'vehicle' && l.id) return <Link to={`/vehicles/fleet/${l.id}`} className="text-ooosh-700 hover:underline">Van</Link>;
    const word = l.type === 'planned' ? 'Planned items' : l.type === 'xero_bill' ? 'Xero bills' : 'Settings';
    return <button type="button" onClick={() => openLink(l)} className="text-ooosh-700 hover:underline">{word}</button>;
  };

  const pile = (title: string, items: PileItem[], note: string, extra?: React.ReactNode) => (items.length === 0 ? null : (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-gray-900">{title} · {gbp(items.reduce((s, i) => s + Math.abs(i.amount), 0))}</h3>
        {extra}
      </div>
      <p className="text-xs text-gray-500 mb-2">{note}</p>
      <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
        {items.map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <div className="min-w-0">
              <p className="text-gray-900 truncate">{i.label}</p>
              <p className="text-[11px] text-gray-500 truncate">{i.detail}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="tabular-nums">{gbp(Math.abs(i.amount), true)}</span>
              <span className="text-xs">{linkFor(i)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  ));

  const toggleOverdueBalances = async (v: boolean) => {
    try {
      await api.put('/cashflow/settings', { countOverdueBalances: v });
      await load();
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Cash forecast <span className="ml-1 align-middle text-[11px] font-semibold text-violet-800 bg-violet-100 rounded-full px-2 py-0.5">Admin</span>
          </h1>
          <p className="text-sm text-gray-600 mt-0.5">
            Next 13 weeks · {forecast?.checkIn.asOf
              ? <>balances confirmed <span className={forecast.checkIn.stale ? 'text-amber-700 font-semibold' : 'text-green-700 font-semibold'}>{shortDate(forecast.checkIn.asOf, true)}</span></>
              : 'no balances yet'}
            {loading && <span className="ml-2 text-gray-400">Updating…</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setModal('bills')} className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Xero bills</button>
          <button type="button" onClick={() => setModal('planned')} className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Planned items</button>
          <button type="button" onClick={() => setModal('settings')} className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Settings</button>
          <button type="button" onClick={() => load(true)} className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50" title="Re-read Xero and Stripe now">Refresh</button>
          <button type="button" onClick={() => setModal('check-in')} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">Monday check-in</button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {!forecast && !error && <p className="text-sm text-gray-500">Building the forecast…</p>}

      {forecast && settings && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Cash in the bank">
              <p className="text-2xl font-bold tabular-nums mt-1">{gbp(forecast.opening.total)}</p>
              <div className="mt-2 space-y-0.5">
                {forecast.opening.accounts.map((a) => (
                  <Line key={a.id} label={`${a.name}${a.source === 'stripe_live' || a.source === 'wise_live' ? ' (live)' : ''}`} value={a.balance === null ? 'not typed' : gbp(a.balance)} />
                ))}
              </div>
            </Tile>
            <Tile label="Cash that's yours">
              <p className="text-2xl font-bold tabular-nums mt-1">{gbp(forecast.yours.total)}</p>
              <div className="mt-2 space-y-0.5">
                <Line label="Excess held (client money)" value={`−${gbp(forecast.yours.excessHeld)}`} />
                <Line label="Refunds owed" value={`−${gbp(forecast.yours.refundsOwed)}`} />
                <Line label={`VAT${forecast.yours.vatDue ? ` due ${shortDate(forecast.yours.vatDue)}` : ' (add it in Planned items)'}`} value={`−${gbp(forecast.yours.vatOwed)}`} />
              </div>
              <p className="text-[11px] text-gray-500 mt-1.5">Plus {gbp(forecast.yours.depositsOnFutureJobs)} of deposits on jobs not started (kept, so not taken off).</p>
            </Tile>
            <Tile label="Lowest point · next 13 weeks" tone={lowWeek ? tone(lowWeek.closing) : 'plain'}>
              <p className={`text-2xl font-bold tabular-nums mt-1 ${lowWeek && lowWeek.closing < target ? 'text-amber-800' : ''} ${lowWeek && lowWeek.closing < limit ? 'text-red-700' : ''}`}>
                {lowWeek ? gbp(lowWeek.closing) : '—'}
              </p>
              {lowWeek && (
                <p className="text-xs text-gray-700 mt-1">
                  Week of <b>{shortDate(lowWeek.start)}</b>
                  {lowWeek.closing < target ? ` — below your ${gbp(target)} target` : ''}
                  {lowWeek.closing >= limit ? `, ${gbp(lowWeek.closing - limit)} above the overdraft limit.` : ' — past the overdraft limit.'}
                </p>
              )}
              {lowWeek && (() => {
                const w = forecast.weeks.find((x) => x.start === lowWeek.start);
                return w && w.closingLikely - w.closing > 0.5
                  ? <p className="text-xs text-gray-700 mt-1">With likely enquiries: <b>{gbp(w.closingLikely)}</b>.</p> : null;
              })()}
              {lowDay && lowWeek && lowDay.closing < lowWeek.closing - 0.5 && (
                <p className="text-xs text-gray-700 mt-1">Inside the next fortnight it dips to <b>{gbp(lowDay.closing)}</b> on {shortDate(lowDay.date, true)}.</p>
              )}
            </Tile>
            <Tile label="Next 13 weeks · booked">
              <p className="text-lg font-bold tabular-nums mt-1 text-green-700">+{gbp(committedIn)} in</p>
              <p className="text-lg font-bold tabular-nums text-red-700">{gbp(committedOut)} out</p>
              <p className="text-[11px] text-gray-500 mt-1">
                YouLend takes {gbp(forecast.youlend.withheldInForecast)} of it; {gbp(forecast.youlend.remainingAtEnd)} left after.
              </p>
              {forecast.pipeline.enquiries > 0 && (
                <p className="text-[11px] text-gray-500 mt-1">
                  Plus {gbp(forecast.pipeline.likely)} likely and {gbp(forecast.pipeline.possible)} possible from {forecast.pipeline.enquiries} enquiries (weighted).
                </p>
              )}
            </Tile>
          </div>

          {forecast.warnings.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {forecast.warnings.map((w) => (
                <div key={w.code} className="text-xs px-2.5 py-1.5 rounded-md border border-amber-200 bg-amber-50 text-amber-900">
                  ⚠ {w.message}
                  {w.code === 'overdue_bills' && <button type="button" onClick={() => setModal('bills')} className="ml-1 font-semibold underline">Check them</button>}
                  {(w.code === 'no_check_in' || w.code === 'stale_check_in' || w.code === 'missing_balance') && <button type="button" onClick={() => setModal('check-in')} className="ml-1 font-semibold underline">Check in</button>}
                  {w.code === 'planned_mismatch' && <button type="button" onClick={() => setModal('planned')} className="ml-1 font-semibold underline">Look</button>}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
          <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Closing balance {byDay ? 'by day' : 'by week'}</h2>
                <p className="text-xs text-gray-500">All counted cash pooled. The line is booked money only; the shaded band adds enquiries, weighted by their chance of booking.</p>
              </div>
              <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
                <button type="button" onClick={() => { setByDay(false); setSelected(null); }} className={`px-3 py-1 rounded-md ${!byDay ? 'bg-ooosh-600 text-white' : 'text-gray-700'}`}>13 weeks</button>
                <button type="button" onClick={() => { setByDay(true); setSelected(null); }} className={`px-3 py-1 rounded-md ${byDay ? 'bg-ooosh-600 text-white' : 'text-gray-700'}`}>Next 14 days</button>
              </div>
            </div>
            <ForecastChart
              points={periods.map((p) => ({ date: p.start, closing: p.closing, closingLikely: p.closingLikely, closingPossible: p.closingPossible }))}
              target={target}
              overdraftLimit={settings.overdraftLimit}
              selected={selected?.period ?? null}
              onSelect={(i) => setSelected({ period: i, row: 'all' })}
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600 mt-1">
              <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 bg-ooosh-600" />Booked</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 bg-[#bae0fd]" />+ likely enquiries</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 bg-[#e0effe]" />+ possible</span>
            </div>
            {!byDay && (
              <p className="text-[11px] text-gray-500 mt-1">
                The far weeks always look worse: only jobs already booked are counted, while rent, HP and payroll are known months ahead. Act on the next four weeks; further out, read the band.
              </p>
            )}
          </div>
          <FixPanel forecast={forecast} onBills={() => setModal('bills')} />
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-gray-900">{byDay ? 'Day by day' : 'Week by week'}</h2>
            <p className="text-xs text-gray-500 mb-2">
              Click a figure to see what's behind it. Money in lands on the last day it's due, plus {forecast.stripe.payoutDays} working days for Stripe; money out on the first.
              <span className="text-violet-700"> Purple</span> is client money (excess).
            </p>
            <ForecastTable forecast={forecast} periods={periods} byDay={byDay} target={target} limit={limit} selected={selected} onSelect={setSelected} />
          </div>

          {selected && periods[selected.period] && (
            <div className="rounded-xl border border-ooosh-200 bg-white p-4">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  {byDay ? shortDate(periods[selected.period].start, true) : `Week of ${shortDate(periods[selected.period].start)}`}
                  {' · '}
                  {rowLabel(forecast, selected.row)}
                  {' · '}
                  <span className="tabular-nums">{gbp(drillItems.reduce((s, i) => s + i.amount, 0), true)}</span>
                </h3>
                <button type="button" onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:underline">Close</button>
              </div>
              {drillItems.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing lands here.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-xs text-gray-500">
                      <tr>
                        <th className="text-left font-semibold px-2 py-1">When</th>
                        <th className="text-left font-semibold px-2 py-1">What</th>
                        <th className="text-left font-semibold px-2 py-1">Detail</th>
                        <th className="text-right font-semibold px-2 py-1">Amount</th>
                        <th className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {drillItems.map((i, k) => (
                        <tr key={`${i.date}-${i.row}-${k}`}>
                          <td className="px-2 py-1.5 whitespace-nowrap text-gray-700">{shortDate(i.date, true)}</td>
                          <td className={`px-2 py-1.5 ${i.clientMoney ? 'text-violet-700' : 'text-gray-900'}`}>
                            {i.label}
                            {selected.row === 'all' && <span className="block text-[11px] text-gray-400">{rowLabel(forecast, i.row)}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-xs text-gray-600">
                            {i.detail}
                            {i.windowTo && <span className="block text-[11px] text-gray-400">due by {shortDate(i.windowTo, true)}{i.windowFrom ? ` — could come any day from ${shortDate(i.windowFrom)}` : ''}</span>}
                          </td>
                          <td className={`px-2 py-1.5 text-right tabular-nums whitespace-nowrap ${i.amount < 0 ? 'text-gray-900' : 'text-green-700'}`}>{gbp(i.amount, true)}</td>
                          <td className="px-2 py-1.5 text-right text-xs">{linkFor(i)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {pile('Overdue client balances', forecast.piles.overdueBalances,
              settings.countOverdueBalances ? 'Counted from next week.' : 'Hires that should already have paid. Not in the line until chased.',
              <label className="flex items-center gap-1.5 text-xs text-gray-700">
                <input type="checkbox" checked={settings.countOverdueBalances} onChange={(e) => toggleOverdueBalances(e.target.checked)} />
                Count from next week
              </label>)}
            {forecast.piles.overdueBills.length > 0 && (
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Overdue Xero bills · {gbp(forecast.piles.overdueBills.reduce((s, b) => s + b.amount, 0))}</h3>
                <p className="text-xs text-gray-500 mt-1">
                  {forecast.piles.overdueBills.length} bill{forecast.piles.overdueBills.length === 1 ? '' : 's'} past due in Xero.
                  {settings.countOverdueBills ? ' Counted from next week.' : ' Not in the line until checked — some are paid and not reconciled, some are being paid in instalments.'}
                </p>
                <button type="button" onClick={() => setModal('bills')} className="mt-2 px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Go through them</button>
              </div>
            )}
            {pile('Excess still held on old hires', forecast.piles.staleExcess, 'The van came back over 30 days ago. Not in the line — check whether it is owed back or kept for damage.')}
            {pile('No date to place', forecast.piles.noDate, 'These have no hire dates, so the forecast can\'t put them in a week.')}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Cards</h3>
              <div className="space-y-3">
                {forecast.cards.map((c) => (
                  <div key={c.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-600 tabular-nums">
                        {c.balance === null ? 'no balance yet — check in' : <>owed {gbp(c.balance)}{c.headroom !== null && <> · <b>{gbp(c.headroom)}</b> free of {gbp(c.creditLimit)}</>}{c.interestThisMonth > 0 && <> · ≈{gbp(c.interestThisMonth)} interest a month</>}</>}
                      </p>
                    </div>
                    {c.balance !== null && c.weeklyBalances.length > 0 && (
                      <div className="mt-1 flex gap-0.5 items-end h-8" title="Balance owed at the end of each week">
                        {c.weeklyBalances.map((b, i) => {
                          const max = Math.max(...c.weeklyBalances.map((x) => x || 0), 1);
                          return <div key={i} className="flex-1 bg-violet-200 rounded-sm" style={{ height: `${Math.max(4, ((b || 0) / max) * 100)}%` }} title={`${shortDate(forecast.weeks[i]?.start)}: ${gbp(b)}`} />;
                        })}
                      </div>
                    )}
                    {c.balance !== null && c.loggedSince !== 0 && (
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Includes {gbp(c.loggedSince, true)} from {c.loggedSinceCount} receipt{c.loggedSinceCount === 1 ? '' : 's'} logged since Monday's {gbp(c.checkInBalance)}.
                      </p>
                    )}
                    {c.costPaymentMethod && (
                      <p className="text-[11px] mt-0.5">
                        {c.check
                          ? c.check.spent > 1
                            ? <span className={c.check.explained !== null && c.check.explained < 0.8 ? 'text-amber-800' : 'text-gray-600'}>
                                Check-ins {shortDate(c.check.from)}–{shortDate(c.check.to)}: about <b>{gbp(c.check.spent)}</b> went on the card; receipts logged explain <b>{gbp(c.check.receipts)}</b>
                                {c.check.explained !== null && <> ({Math.round(c.check.explained * 100)}%)</>}.
                                <span className="text-gray-400"> Assumes the planned payments were made ({gbp(c.check.assumedPayments)}).</span>
                              </span>
                            : <span className="text-gray-500">Check-ins {shortDate(c.check.from)}–{shortDate(c.check.to)}: the balance fell by more than the planned payments — paid extra, or a payment we don't know about.</span>
                          : <span className="text-gray-400">The receipts check starts once there are two Monday check-ins a week apart.</span>}
                      </p>
                    )}
                    {c.balance !== null && (
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {c.spendSource === 'typed' && <>New spending: {gbp(c.typicalMonthlySpend)} a month (typed in Settings).</>}
                        {c.spendSource === 'receipts' && <>New spending: {gbp(c.typicalMonthlySpend)} a month, from {c.receiptsCount} receipts logged in the last 90 days — runs low if some aren't logged.</>}
                        {c.spendSource === 'none' && <>Assumes no new spending — {c.costPaymentMethod ? 'no receipts logged on it lately' : 'link it to its receipts or type a typical spend'} in Settings.</>}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">YouLend</h3>
              <div className="space-y-1">
                <Line label={`Still owed${forecast.youlend.asOf ? ` (as of ${shortDate(forecast.youlend.asOf)})` : ''}`} value={gbp(forecast.youlend.remaining)} />
                <Line label={`Taken from Stripe takings in these 13 weeks (${Math.round(forecast.youlend.rate * 100)}%)`} value={gbp(forecast.youlend.withheldInForecast)} />
                <Line label="Left at the end of the forecast" value={gbp(forecast.youlend.remainingAtEnd)} />
              </div>
              <p className="text-xs text-gray-700 mt-2">
                {forecast.youlend.paidOffOn
                  ? <>Paid off around <b>{shortDate(forecast.youlend.paidOffOn)}</b>.</>
                  : forecast.youlend.estimatedPayoff && forecast.youlend.estimatedPayoff <= `${Number(forecast.today.slice(0, 4)) + 3}${forecast.today.slice(4)}`
                    ? <>At the booked takings alone, paid off around <b>{monthYear(forecast.youlend.estimatedPayoff)}</b> — pessimistic, because new bookings will add to it.</>
                    : 'Not paid off within the forecast. The booked takings alone are too few to say when — new bookings will bring the date in.'}
              </p>
              <p className="text-[11px] text-gray-500 mt-2">
                Stripe fee {(forecast.stripe.feeRate * 100).toFixed(2)}% ({forecast.stripe.feeRateSource === 'stripe' ? 'from Stripe, last 90 days' : 'from Settings'}) · {Math.round(forecast.stripe.share * 100)}% of money in assumed through Stripe.
                {!forecast.stripe.live && ' Stripe isn\'t read live — its balance comes from the check-in.'}
              </p>
            </div>
          </div>
        </>
      )}

      {modal === 'check-in' && <CheckInModal onClose={() => setModal(null)} onSaved={() => { setModal(null); load(true); }} />}
      {modal === 'planned' && (
        <PlannedItemsModal
          notes={forecast?.planned || []}
          startWithBill={instalmentBill}
          onClose={() => { setModal(null); setInstalmentBill(null); }}
          onChanged={() => load()}
        />
      )}
      {modal === 'bills' && settings && (
        <BillsModal
          countOverdue={settings.countOverdueBills}
          onClose={() => setModal(null)}
          onChanged={() => load()}
          onInstalments={(b) => { setInstalmentBill(b); setModal('planned'); load(); }}
        />
      )}
      {modal === 'settings' && <CashflowSettingsModal onClose={() => setModal(null)} onChanged={() => load()} />}
    </div>
  );
}
