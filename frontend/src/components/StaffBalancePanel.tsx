import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * The explainable balance (Staff Calendar, Phase B). See spec §0.2.
 *
 * A derived balance only beats a stored one if you can SEE the working. Click
 * the number, get every entry that produced it — dated, attributed, and with
 * corrections shown alongside what they reversed rather than in place of it.
 * That is what stops "but I definitely had three days left" becoming an
 * argument nobody can settle.
 *
 * Nothing here computes a balance. It renders what the API returns; the sum
 * lives in services/staff-balance.ts and nowhere else.
 */

interface LedgerEntry {
  id: string;
  account: 'holiday' | 'overtime';
  leaveYear: number;
  entryType: string;
  minutes: number;
  effectiveDate: string;
  sourceType: string | null;
  reversesEntryId: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}
interface BalancePayload {
  personId: string;
  account: 'holiday' | 'overtime';
  leaveYear: number;
  balanceMinutes: number;
  creditedMinutes: number;
  debitedMinutes: number;
  nominalDayMinutes: number | null;
  entryCount: number;
  entries: LedgerEntry[];
}
interface EntitlementPreview {
  totalMinutes: number;
  rawMinutes: number;
  isPartYear: boolean;
  weeks: number;
  nominalDayMinutes: number | null;
  weeklyMinutes: number | null;
  segments: { from: string; to: string; days: number; weeklyMinutes: number; minutes: number }[];
}

const ENTRY_LABELS: Record<string, string> = {
  entitlement: 'Entitlement',
  adjustment: 'Adjustment',
  booking: 'Booked off',
  cancellation: 'Cancelled booking',
  correction: 'Correction',
  carry_over: 'Carried over',
  accrual: 'Overtime banked',
  spend_toil: 'Taken as time off',
  spend_paid: 'Paid out',
  year_end_cashout: 'Year-end cash-out',
};

function fmtH(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  const h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}
function fmtDays(min: number, nominalDay: number | null): string | null {
  if (!nominalDay || nominalDay <= 0) return null;
  return `${(min / nominalDay).toFixed(1)} days`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export default function StaffBalancePanel({ personId, canManage, year }: {
  personId: string; canManage: boolean; year: number;
}) {
  const [account, setAccount] = useState<'holiday' | 'overtime'>('holiday');
  const [data, setData] = useState<BalancePayload | null>(null);
  const [preview, setPreview] = useState<EntitlementPreview | null>(null);
  const [showEntries, setShowEntries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ data: BalancePayload }>(
        `/staff-calendar/employees/${personId}/balance?account=${account}&year=${year}`);
      setData(res.data);
      if (canManage && account === 'holiday') {
        const p = await api.get<{ data: EntitlementPreview }>(
          `/staff-calendar/employees/${personId}/entitlement-preview?year=${year}`);
        setPreview(p.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the balance');
    }
  }, [personId, account, year, canManage]);

  useEffect(() => { void load(); }, [load]);

  async function grant() {
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: { postedMinutes: number; reason: string } }>(
        `/staff-calendar/employees/${personId}/entitlement`, { year });
      // Zero posted is the NORMAL case: the 06:05 scheduler grants entitlement
      // daily, so by the time anybody presses this it is usually already done.
      // "Nothing posted" read as a failure; say what is actually true.
      setNotice(res.data.postedMinutes === 0
        ? `Checked — their ${year} entitlement was already correct, so nothing changed.`
        : `${res.data.reason}: ${fmtH(res.data.postedMinutes)} posted.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to grant the entitlement');
    } finally { setBusy(false); }
  }

  async function reverse(entry: LedgerEntry) {
    const note = prompt(`Why are you reversing this ${ENTRY_LABELS[entry.entryType] ?? entry.entryType} of ${fmtH(entry.minutes)}?`);
    if (!note) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/staff-calendar/ledger/${entry.id}/reverse`, { note });
      setNotice('Entry reversed. Both rows stay on the record.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reverse the entry');
    } finally { setBusy(false); }
  }

  if (!data) {
    return <div className="text-sm text-gray-500">{error ?? 'Loading balance…'}</div>;
  }

  const days = fmtDays(data.balanceMinutes, data.nominalDayMinutes);
  const outOfDate = preview && preview.totalMinutes !== null &&
    data.entries.filter(e => e.sourceType === 'system').reduce((s, e) => s + e.minutes, 0) !== preview.totalMinutes;
  const reversedIds = new Set(data.entries.map(e => e.reversesEntryId).filter(Boolean) as string[]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-medium text-gray-900">Balances {year}</h3>
        <div className="flex rounded border border-gray-300 overflow-hidden text-xs">
          {(['holiday', 'overtime'] as const).map(a => (
            <button key={a} onClick={() => { setAccount(a); setShowEntries(false); }}
              className={`px-2.5 py-1 ${account === a ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
              {a === 'holiday' ? 'Holiday' : 'Overtime bank'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mb-3 p-2.5 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-3 p-2.5 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}

      <div className="p-3 rounded border border-gray-200 bg-white">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-2xl font-semibold text-gray-900 tabular-nums">{fmtH(data.balanceMinutes)}</span>
          {days && <span className="text-sm text-gray-600">{days}</span>}
          <span className="text-xs text-gray-500">
            {fmtH(data.creditedMinutes)} in · {fmtH(data.debitedMinutes)} used
          </span>
          <button onClick={() => setShowEntries(v => !v)}
            className="ml-auto text-xs text-ooosh-600 hover:underline">
            {showEntries ? 'Hide working' : `Show working (${data.entryCount})`}
          </button>
        </div>

        {account === 'holiday' && data.nominalDayMinutes ? (
          <p className="mt-1.5 text-xs text-gray-500">
            Days are this person&apos;s own average day ({fmtH(data.nominalDayMinutes)}), so the
            figure is comparable in hours even where day lengths differ.
          </p>
        ) : null}

        {showEntries && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            {data.entries.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nothing on the ledger yet{canManage && account === 'holiday' ? ' — grant the entitlement below.' : '.'}
              </p>
            ) : (
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-medium py-1 pr-3">Date</th>
                    <th className="text-left font-medium py-1 pr-3">What</th>
                    <th className="text-right font-medium py-1 pr-3">Minutes</th>
                    <th className="text-left font-medium py-1 pr-3">Note</th>
                    {canManage && <th className="py-1" />}
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map(e => {
                    const isReversal = e.reversesEntryId !== null;
                    const wasReversed = reversedIds.has(e.id);
                    return (
                      <tr key={e.id} className={`border-t border-gray-100 ${wasReversed ? 'text-gray-400' : ''}`}>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(e.effectiveDate)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          {ENTRY_LABELS[e.entryType] ?? e.entryType}
                          {isReversal && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-800">reversal</span>}
                          {wasReversed && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-500">reversed</span>}
                        </td>
                        <td className={`py-1.5 pr-3 text-right tabular-nums ${
                          wasReversed ? '' : e.minutes < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                          {e.minutes > 0 ? '+' : ''}{e.minutes}
                          <span className="text-gray-400 ml-1">({fmtH(e.minutes)})</span>
                        </td>
                        <td className="py-1.5 pr-3">
                          {e.note}
                          {e.createdByName && <span className="text-gray-400"> — {e.createdByName}</span>}
                        </td>
                        {canManage && (
                          <td className="py-1.5 text-right">
                            {!wasReversed && !isReversal && (
                              <button onClick={() => void reverse(e)} disabled={busy}
                                className="text-ooosh-600 hover:underline disabled:opacity-40">Reverse</button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-gray-300 font-medium">
                    <td className="py-1.5 pr-3" colSpan={2}>Balance</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {data.balanceMinutes} <span className="text-gray-500">({fmtH(data.balanceMinutes)})</span>
                    </td>
                    <td colSpan={canManage ? 2 : 1} />
                  </tr>
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-gray-400">
              Entries can never be edited or deleted — a mistake is undone by a reversal, and
              both rows stay visible.
            </p>
          </div>
        )}
      </div>

      {canManage && (
        <AdjustmentForm personId={personId} account={account} year={year}
          onDone={async (msg) => { setError(null); setNotice(msg); await load(); }} />
      )}

      {canManage && account === 'holiday' && preview && (
        <div className="mt-3 p-3 rounded border border-gray-200 bg-gray-50/60">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-medium text-gray-900">Entitlement for {year}</h4>
            <button onClick={() => void grant()} disabled={busy || preview.totalMinutes === 0}
              className="px-2.5 py-1 text-xs rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
              {busy ? 'Working…' : outOfDate ? 'Update entitlement' : 'Grant entitlement'}
            </button>
          </div>

          {preview.totalMinutes === 0 ? (
            <p className="mt-1 text-sm text-amber-700">
              No working hours set for {year}, so there is nothing to work an entitlement out from.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-gray-700">
                {preview.weeks} weeks ={' '}
                <span className="font-medium">{fmtH(preview.totalMinutes)}</span>
                {preview.nominalDayMinutes && <> ({fmtDays(preview.totalMinutes, preview.nominalDayMinutes)})</>}
                {preview.isPartYear && <span className="text-gray-500"> · pro-rated, rounded up to the half day</span>}
              </p>
              {preview.segments.length > 1 && (
                <ul className="mt-1.5 text-xs text-gray-600 space-y-0.5">
                  {preview.segments.map((s, i) => (
                    <li key={i}>
                      {fmtDate(s.from)} → {fmtDate(s.to)} · {s.days} days at {fmtH(s.weeklyMinutes)}/week
                      {' = '}{fmtH(Math.round(s.minutes))}
                    </li>
                  ))}
                </ul>
              )}
              {outOfDate && (
                <p className="mt-1.5 text-xs text-amber-700">
                  Their hours have changed since this was granted — updating posts only the difference.
                </p>
              )}
            </>
          )}

          {/* The result, WHERE THE BUTTON IS. It also renders at the top of the
              panel, which is ~90 lines of JSX and a whole ledger table away —
              so pressing this read as "nothing happened" when in fact it had
              worked and said so, off-screen. Feedback belongs next to the thing
              that caused it. */}
          {notice && (
            <p className="mt-2 text-xs font-medium text-emerald-700" role="status">{notice}</p>
          )}
          {error && (
            <p className="mt-2 text-xs font-medium text-red-700" role="alert">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A manual adjustment — hours added to or taken off a balance by an admin,
 * with a reason (Oct 2026). For what no flow owns: a balance brought across
 * from BrightHR, an agreed one-off. Bookings, overtime and pay-outs are never
 * typed in here; they go through the flows that own them.
 *
 * Posts to the existing POST /employees/:personId/ledger as an 'adjustment',
 * source 'manual'. The note is shown to the person on their own My Time, so it
 * is required and should say why in words they will recognise. A mistake is
 * undone with Reverse in the working above, never by editing.
 */
function AdjustmentForm({ personId, account, year, onDone }: {
  personId: string; account: 'holiday' | 'overtime'; year: number;
  onDone: (msg: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [hours, setHours] = useState('0');
  const [mins, setMins] = useState('0');
  // The year being looked at, so it lands on that year's balance. Today if
  // that is this year; otherwise 1 January of it.
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const [date, setDate] = useState(today.getFullYear() === year ? todayIso : `${year}-01-01`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minutes = (Number(hours) || 0) * 60 + (Number(mins) || 0);
  const label = account === 'holiday' ? 'holiday' : 'overtime bank';

  async function save() {
    setErr(null);
    if (minutes <= 0) { setErr('Enter how much.'); return; }
    if (!note.trim()) { setErr('Say why — they will see this note.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setErr('Pick a date.'); return; }
    const signed = direction * minutes;
    if (!confirm(`${direction > 0 ? 'Add' : 'Take off'} ${fmtH(minutes)} ${direction > 0 ? 'to' : 'from'} their ${date.slice(0, 4)} ${label}?`)) return;
    setBusy(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/ledger`, {
        account, leaveYear: Number(date.slice(0, 4)), entryType: 'adjustment',
        minutes: signed, effectiveDate: date, note: note.trim(),
      });
      setOpen(false); setHours('0'); setMins('0'); setNote('');
      await onDone(`Adjustment of ${signed > 0 ? '+' : ''}${fmtH(signed)} posted to their ${label}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to post the adjustment');
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 text-xs text-ooosh-600 hover:underline">
        + Add an adjustment to their {label}
      </button>
    );
  }

  return (
    <div className="mt-3 p-3 rounded border border-gray-200 bg-gray-50/60 text-sm">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="font-medium text-gray-900">Adjust their {label}</h4>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        For a balance brought across or an agreed one-off. Holiday booked, overtime worked and pay-outs
        go through their own forms, not here.
      </p>
      <div className="flex flex-wrap items-end gap-2 mb-2">
        <select value={direction} onChange={e => setDirection(Number(e.target.value) as 1 | -1)}
          className="px-2 py-1.5 border border-gray-300 rounded bg-white">
          <option value={1}>Add</option>
          <option value={-1}>Take off</option>
        </select>
        <label className="text-xs text-gray-600">
          <span className="block mb-0.5">Hours</span>
          <input type="number" min={0} max={500} value={hours} onChange={e => setHours(e.target.value)}
            className="w-20 px-2 py-1.5 border border-gray-300 rounded bg-white text-sm" />
        </label>
        <label className="text-xs text-gray-600">
          <span className="block mb-0.5">Minutes</span>
          <select value={mins} onChange={e => setMins(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded bg-white text-sm">
            {Array.from({ length: 12 }, (_, i) => String(i * 5)).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">
          <span className="block mb-0.5">Dated</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded bg-white text-sm" />
        </label>
      </div>
      <label className="block text-xs text-gray-600 mb-2">
        <span className="block mb-0.5">Why — they will see this on their My Time</span>
        <input value={note} onChange={e => setNote(e.target.value)} maxLength={500}
          placeholder="e.g. Overtime from April 2025, brought across from BrightHR"
          className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm" />
      </label>
      {err && <p className="mb-2 text-xs font-medium text-red-700" role="alert">{err}</p>}
      <button onClick={() => void save()} disabled={busy}
        className="px-3 py-1.5 text-xs rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
        {busy ? 'Posting…' : `Post ${direction > 0 ? '+' : '−'}${fmtH(minutes)}`}
      </button>
    </div>
  );
}
