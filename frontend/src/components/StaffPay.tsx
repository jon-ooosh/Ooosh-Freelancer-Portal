/**
 * Salary and pension — the two append-only histories on the Employment tab.
 *
 * Both follow the same rule and it is the point of the feature: a change is a
 * NEW ROW, never an edit. "What were they on, and from when" is the question
 * these exist to answer — a single current figure loses the half that matters,
 * and for pension, auto-enrolment gives those dates legal weight.
 *
 * `staff_salary_history` and its endpoints have existed since migration 206
 * with nothing calling them. This is the surface that was missing, not the
 * storage.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

interface SalaryRow {
  id: string;
  annual_amount: string;
  effective_from: string;
  reason: string | null;
}

interface PensionRow {
  id: string;
  is_member: boolean;
  scheme_name: string | null;
  employee_percent: string | null;
  employer_percent: string | null;
  effective_from: string;
  reason: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function money(n: string | number): string {
  return `£${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

export default function StaffPay({ personId, personName, onSaved, onError }: {
  personId: string;
  personName: string;
  onSaved: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [salary, setSalary] = useState<SalaryRow[]>([]);
  const [pension, setPension] = useState<PensionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [addingSalary, setAddingSalary] = useState(false);
  const [amount, setAmount] = useState('');
  const [salaryFrom, setSalaryFrom] = useState('');
  const [salaryReason, setSalaryReason] = useState('');

  const [addingPension, setAddingPension] = useState(false);
  const [isMember, setIsMember] = useState(true);
  const [scheme, setScheme] = useState('');
  const [empPct, setEmpPct] = useState('');
  const [erPct, setErPct] = useState('');
  const [pensionFrom, setPensionFrom] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    const [s, p] = await Promise.allSettled([
      api.get<{ data: SalaryRow[] }>(`/staff-calendar/employees/${personId}/salary`),
      api.get<{ data: PensionRow[] }>(`/staff-calendar/employees/${personId}/pension`),
    ]);
    if (s.status === 'fulfilled') setSalary(s.value.data);
    else setLoadError(s.reason instanceof Error ? s.reason.message : 'Could not load salary');
    if (p.status === 'fulfilled') setPension(p.value.data);
    setLoading(false);
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  async function addSalary() {
    if (!amount.trim() || !salaryFrom) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/salary`, {
        annualAmount: Number(amount),
        effectiveFrom: salaryFrom,
        reason: salaryReason.trim() || null,
      });
      setAmount(''); setSalaryFrom(''); setSalaryReason(''); setAddingSalary(false);
      await load();
      await onSaved(`Salary recorded for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record the salary');
    } finally { setSaving(false); }
  }

  async function addPension() {
    if (!pensionFrom) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/pension`, {
        isMember,
        schemeName: scheme.trim() || null,
        employeePercent: empPct.trim() ? Number(empPct) : null,
        employerPercent: erPct.trim() ? Number(erPct) : null,
        effectiveFrom: pensionFrom,
      });
      setScheme(''); setEmpPct(''); setErPct(''); setPensionFrom(''); setAddingPension(false);
      await load();
      await onSaved(`Pension recorded for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record the pension change');
    } finally { setSaving(false); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading pay…</p>;

  const current = salary[0];
  const currentPension = pension[0];

  return (
    <div className="space-y-6">
      {loadError && (
        <p className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">{loadError}</p>
      )}

      {/* ── Salary ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Salary</h3>
          {current ? (
            <span className="text-sm text-gray-900">
              <strong>{money(current.annual_amount)}</strong> a year
              <span className="text-gray-500"> since {fmtDate(current.effective_from)}</span>
            </span>
          ) : (
            <span className="text-sm text-amber-700">Not recorded</span>
          )}
          {!addingSalary && (
            <button onClick={() => setAddingSalary(true)} className="ml-auto text-xs text-ooosh-600 hover:underline">
              Record a change
            </button>
          )}
        </div>

        {addingSalary && (
          <div className="flex flex-wrap items-end gap-3 mb-3 p-3 rounded bg-gray-50 border border-gray-200">
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Annual salary</span>
              <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal" placeholder="32000"
                className="w-32 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Effective from</span>
              <input type="date" value={salaryFrom} onChange={e => setSalaryFrom(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm flex-1 min-w-[12rem]">
              <span className="block text-xs text-gray-600 mb-1">Why</span>
              <input value={salaryReason} onChange={e => setSalaryReason(e.target.value)}
                placeholder="e.g. Agreed at review"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <button onClick={() => void addSalary()} disabled={saving || !amount.trim() || !salaryFrom}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
              {saving ? 'Saving…' : 'Record'}
            </button>
            <button onClick={() => setAddingSalary(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        )}

        {salary.length === 0 ? (
          <p className="text-sm text-gray-400">No salary history. Past figures can be added with their own dates.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                <th className="py-1 font-medium">From</th>
                <th className="py-1 font-medium">Amount</th>
                <th className="py-1 font-medium">Change</th>
                <th className="py-1 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {salary.map((row, i) => {
                // The previous row in a DESC list is the NEXT one down.
                const prev = salary[i + 1];
                const delta = prev ? Number(row.annual_amount) - Number(prev.annual_amount) : null;
                return (
                  <tr key={row.id}>
                    <td className="py-1.5 text-gray-900">{fmtDate(row.effective_from)}</td>
                    <td className="py-1.5 text-gray-900">{money(row.annual_amount)}</td>
                    <td className="py-1.5">
                      {delta === null ? <span className="text-gray-400">—</span>
                        : delta === 0 ? <span className="text-gray-500">no change</span>
                        : <span className={delta > 0 ? 'text-emerald-700' : 'text-red-700'}>
                            {delta > 0 ? '+' : '−'}{money(Math.abs(delta))}
                            <span className="text-gray-500">
                              {' '}({((delta / Number(prev!.annual_amount)) * 100).toFixed(1)}%)
                            </span>
                          </span>}
                    </td>
                    <td className="py-1.5 text-gray-600">{row.reason || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pension ────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Pension</h3>
          {currentPension ? (
            currentPension.is_member ? (
              <span className="text-sm text-gray-900">
                {currentPension.employee_percent ?? '—'}% employee · {currentPension.employer_percent ?? '—'}% employer
                {currentPension.scheme_name && <span className="text-gray-500"> · {currentPension.scheme_name}</span>}
              </span>
            ) : (
              <span className="text-sm text-gray-600">Opted out since {fmtDate(currentPension.effective_from)}</span>
            )
          ) : (
            <span className="text-sm text-amber-700">Not recorded</span>
          )}
          {!addingPension && (
            <button onClick={() => setAddingPension(true)} className="ml-auto text-xs text-ooosh-600 hover:underline">
              Record a change
            </button>
          )}
        </div>

        {addingPension && (
          <div className="flex flex-wrap items-end gap-3 mb-3 p-3 rounded bg-gray-50 border border-gray-200">
            <label className="text-sm inline-flex items-center gap-1.5 text-gray-700">
              <input type="checkbox" checked={isMember} onChange={e => setIsMember(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-gray-300" />
              In the scheme
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Employee %</span>
              <input value={empPct} onChange={e => setEmpPct(e.target.value.replace(/[^\d.]/g, ''))}
                disabled={!isMember} inputMode="decimal" placeholder="5"
                className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Employer %</span>
              <input value={erPct} onChange={e => setErPct(e.target.value.replace(/[^\d.]/g, ''))}
                disabled={!isMember} inputMode="decimal" placeholder="3"
                className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Scheme</span>
              <input value={scheme} onChange={e => setScheme(e.target.value)} disabled={!isMember}
                placeholder="e.g. NEST"
                className="w-36 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">From</span>
              <input type="date" value={pensionFrom} onChange={e => setPensionFrom(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <button onClick={() => void addPension()} disabled={saving || !pensionFrom}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
              {saving ? 'Saving…' : 'Record'}
            </button>
            <button onClick={() => setAddingPension(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        )}

        {pension.length === 0 ? (
          <p className="text-sm text-gray-400">
            No pension history. Opting out is worth recording too — “no row” and “opted out on a date”
            are different facts, and only the second is evidence.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {pension.map(row => (
              <li key={row.id} className="py-1.5 flex flex-wrap gap-x-3">
                <span className="text-gray-900 w-28">{fmtDate(row.effective_from)}</span>
                <span className="text-gray-900">
                  {row.is_member
                    ? `${row.employee_percent ?? '—'}% / ${row.employer_percent ?? '—'}%`
                    : 'Opted out'}
                </span>
                {row.scheme_name && <span className="text-gray-500">{row.scheme_name}</span>}
                {row.reason && <span className="text-gray-500">{row.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
