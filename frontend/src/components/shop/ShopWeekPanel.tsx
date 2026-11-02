/**
 * ShopWeekPanel — the till's "This week" tab (SHOP-SALES-SPEC.md §12, step 9).
 *
 * Two questions, both about one Mon–Sun week:
 *   1. What did the week take? By payment method, with refunds, and "their
 *      bill" sales kept apart because no money changed hands.
 *   2. Does the week's shop job in HireHop still match what the till put on
 *      it? The result of the last balance check (the 15-minute scan stores
 *      it), with "Check now" to re-run it on demand.
 *
 * The shop job's number is shown as text only, never linked: anyone who opens
 * it in HireHop is one status change away from releasing a week of stock
 * (spec §2.1).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { tenderLabel } from '../../lib/shopTenders';
import { useAuthStore } from '../../hooks/useAuthStore';
import ShopWeekClose from './ShopWeekClose';

interface TenderTotals { tender: string; sales: number; taken: number; refunded: number; net: number }

interface WeekSummary {
  periodStart: string;
  periodEnd: string;
  byTender: TenderTotals[];
  taken: number;
  refunded: number;
  net: number;
  onTheirBill: { sales: number; net: number };
  notPushed: number;
}

interface ShopCheck {
  checkedAt: string;
  ok: boolean;
  status: number | null;
  invoiced: boolean;
  goods: { expected: number; actual: number | null; ok: boolean | null };
  money: { expected: number; actual: number | null; ok: boolean | null } | null;
  problems: string[];
}

interface WeekData {
  /** Monday of the current week (UK) — so a linked week knows where "now" is. */
  thisWeek: string;
  summary: WeekSummary;
  period: {
    id: string;
    hh_job_number: number | null;
    invoiced_at: string | null;
    last_checked_at: string | null;
    last_check_ok: boolean | null;
    last_check: ShopCheck | null;
    hh_invoice_number: string | null;
    close_state: 'drafted' | 'approved' | 'allocated' | 'completed' | null;
    closed_at: string | null;
  } | null;
}

const money = (n: number) => `£${n.toFixed(2)}`;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export default function ShopWeekPanel() {
  const { user } = useAuthStore();
  // `?start=YYYY-MM-DD` opens a given week — the Monday close email links here.
  const [searchParams] = useSearchParams();
  const linkedStart = searchParams.get('start');
  const [start, setStart] = useState<string | null>(
    linkedStart && /^\d{4}-\d{2}-\d{2}$/.test(linkedStart) ? linkedStart : null,
  );                                                              // null = this week
  const [thisWeek, setThisWeek] = useState<string | null>(null);
  const [data, setData] = useState<WeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback((s: string | null) => {
    setError(null);
    api.get<{ data: WeekData }>(`/shop/week${s ? `?start=${s}` : ''}`)
      .then(r => {
        setData(r.data);
        setThisWeek(r.data.thisWeek);
      })
      .catch((e: any) => setError(e?.body?.error || e?.message || 'Could not load that week.'));
  }, []);

  useEffect(() => { load(start); }, [load, start]);

  const checkNow = async () => {
    if (!data?.period?.id) return;
    setChecking(true);
    setError(null);
    try {
      await api.post(`/shop/week/${data.period.id}/check`, {});
      load(start);
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not run the check.');
    } finally {
      setChecking(false);
    }
  };

  if (!data) {
    return error
      ? <p className="text-sm text-red-700">{error}</p>
      : <p className="text-xs text-gray-400">Loading…</p>;
  }

  const { summary, period } = data;
  const check = period?.last_check ?? null;
  const isThisWeek = thisWeek != null && summary.periodStart >= thisWeek;

  return (
    <div className="space-y-4">
      {/* Week picker */}
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={() => setStart(addDays(summary.periodStart, -7))}
          className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100"
          aria-label="Previous week"
        >
          ←
        </button>
        <span className="font-semibold text-gray-900">
          {fmtDay(summary.periodStart)} – {fmtDay(summary.periodEnd)}
        </span>
        <button
          onClick={() => setStart(addDays(summary.periodStart, 7))}
          disabled={isThisWeek}
          className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
          aria-label="Next week"
        >
          →
        </button>
        {!isThisWeek && (
          <button onClick={() => setStart(null)} className="text-xs text-ooosh-600 hover:underline">
            This week
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Takings */}
        <div className="rounded border border-gray-200 p-3">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Takings</h3>
          {summary.byTender.length === 0 ? (
            <p className="text-sm text-gray-400">No money taken this week.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1 font-medium">Paid by</th>
                  <th className="py-1 text-right font-medium">Sales</th>
                  <th className="py-1 text-right font-medium">Taken</th>
                  <th className="py-1 text-right font-medium">Refunded</th>
                  <th className="py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {summary.byTender.map(t => (
                  <tr key={t.tender}>
                    <td className="py-1.5">{tenderLabel(t.tender)}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-500">{t.sales}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(t.taken)}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-500">
                      {t.refunded ? `−${money(t.refunded)}` : '—'}
                    </td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{money(t.net)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1.5">Total</td>
                  <td />
                  <td className="py-1.5 text-right tabular-nums">{money(summary.taken)}</td>
                  <td className="py-1.5 text-right tabular-nums">{summary.refunded ? `−${money(summary.refunded)}` : '—'}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(summary.net)}</td>
                </tr>
              </tbody>
            </table>
          )}
          {summary.onTheirBill.sales > 0 && (
            <p className="mt-2 text-xs text-gray-600">
              Plus {money(summary.onTheirBill.net)} put on bands&rsquo; bills ({summary.onTheirBill.sales}{' '}
              sale{summary.onTheirBill.sales === 1 ? '' : 's'}) — sold, but no money taken.
            </p>
          )}
          {summary.notPushed > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {summary.notPushed} of these {summary.notPushed === 1 ? 'hasn’t' : 'haven’t'} reached HireHop yet.
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-400">
            Everything rung up this week, walk-ins and bands&rsquo; jobs alike, inc VAT.
          </p>
        </div>

        {/* Balance check */}
        <div className={`rounded border p-3 ${
          !check ? 'border-gray-200' : check.ok ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'
        }`}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-700">
              Shop job{period?.hh_job_number ? ` ${period.hh_job_number}` : ''} vs the till
            </h3>
            {period?.id && (
              <button
                onClick={checkNow}
                disabled={checking}
                className="text-xs font-medium text-ooosh-600 hover:underline disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>

          {!period?.hh_job_number ? (
            <p className="text-sm text-gray-500">No shop job for this week, so nothing to check.</p>
          ) : !check ? (
            <p className="text-sm text-gray-500">Not checked yet — the scan runs every 15 minutes.</p>
          ) : (
            <>
              <p className={`mb-2 text-sm font-medium ${check.ok ? 'text-green-800' : 'text-red-800'}`}>
                {check.ok ? 'Balanced.' : 'Doesn’t match.'}
                <span className="font-normal text-gray-500"> Checked {ago(period.last_checked_at)}.</span>
              </p>
              <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
                <dt />
                <dd className="text-right text-gray-500">Till</dd>
                <dd className="text-right text-gray-500">HireHop</dd>
                <dt className="text-gray-600">Goods (ex VAT)</dt>
                <dd className="text-right tabular-nums">{money(check.goods.expected)}</dd>
                <dd className={`text-right tabular-nums ${check.goods.ok === false ? 'font-semibold text-red-700' : ''}`}>
                  {check.goods.actual == null ? '?' : money(check.goods.actual)}
                </dd>
                <dt className="text-gray-600">Money held</dt>
                {check.money ? (
                  <>
                    <dd className="text-right tabular-nums">{money(check.money.expected)}</dd>
                    <dd className={`text-right tabular-nums ${check.money.ok === false ? 'font-semibold text-red-700' : ''}`}>
                      {check.money.actual == null ? '?' : money(check.money.actual)}
                    </dd>
                  </>
                ) : (
                  <dd className="col-span-2 text-right text-gray-500">not checked once invoiced</dd>
                )}
              </dl>
              {check.problems.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-red-800">
                  {check.problems.map(p => <li key={p}>{p}</li>)}
                </ul>
              )}
              {period.invoiced_at && (
                <p className="mt-2 text-xs text-gray-600">
                  Invoiced — spotted {ago(period.invoiced_at)}. Refunds on this week now need a credit note by hand.
                </p>
              )}
              <p className="mt-2 text-[11px] text-gray-400">
                Goods and money are compared with what the till itself put on the job. Can&rsquo;t see a sale
                line checked in by mistake — never check sale lines in.
              </p>
            </>
          )}
        </div>
      </div>

      {/* The weekly close (§20) — a finished week with a job, admin only. */}
      {user?.role === 'admin' && period?.hh_job_number && !isThisWeek && thisWeek != null && (
        <ShopWeekClose
          key={period.id}
          periodId={period.id}
          closeState={period.close_state}
          invoiceNumber={period.hh_invoice_number}
          closedAt={period.closed_at}
          onChanged={() => load(start)}
        />
      )}
    </div>
  );
}
