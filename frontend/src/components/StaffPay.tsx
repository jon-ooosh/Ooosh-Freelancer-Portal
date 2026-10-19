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
import { Card, Pill, btnPrimary, btnSecondary, btnQuiet } from './StaffCard';

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

  const field = 'w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white disabled:bg-gray-100';
  const big = 'text-[32px] leading-none font-semibold tracking-[-0.02em] tabular-nums text-gray-900';

  return (
    <div className="space-y-4">
      {loadError && (
        <p className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">{loadError}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* ── Salary ─────────────────────────────────────────────────── */}
        <Card title="Salary"
          action={!addingSalary && <button onClick={() => setAddingSalary(true)} className={btnSecondary}>Record a change</button>}>
          {current ? (
            <div className="mb-1">
              <span className={big}>{money(current.annual_amount)}</span>
              <span className="text-[15px] text-gray-700 ml-1.5">a year</span>
              <div className="text-xs text-gray-500 mt-2">since {fmtDate(current.effective_from)}{current.reason ? ` · ${current.reason}` : ''}</div>
            </div>
          ) : (
            <Pill tone="warn">Not recorded</Pill>
          )}

          {addingSalary && (
            <div className="mt-4 p-4 rounded-xl border border-ooosh-200 bg-ooosh-50/40 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Annual salary (£)</span>
                  <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal" placeholder="32000" className={field} />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Effective from</span>
                  <input type="date" value={salaryFrom} onChange={e => setSalaryFrom(e.target.value)} className={field} />
                </label>
              </div>
              <label className="block text-sm">
                <span className="block text-xs text-gray-600 mb-1">Why</span>
                <input value={salaryReason} onChange={e => setSalaryReason(e.target.value)}
                  placeholder="e.g. Agreed at review" className={field} />
              </label>
              <div className="flex items-center gap-3">
                <button onClick={() => void addSalary()} disabled={saving || !amount.trim() || !salaryFrom} className={btnPrimary}>
                  {saving ? 'Saving…' : 'Record'}
                </button>
                <button onClick={() => setAddingSalary(false)} className={btnQuiet}>Cancel</button>
              </div>
            </div>
          )}

          {salary.length === 0 ? (
            <p className="text-sm text-gray-400 mt-3">No salary history. Past figures can be added with their own dates.</p>
          ) : (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-ooosh-700 hover:underline select-none">
                History ({salary.length})
              </summary>
              <ul className="mt-2">
                {salary.map((row, i) => {
                  // The previous row in a DESC list is the NEXT one down.
                  const prev = salary[i + 1];
                  const delta = prev ? Number(row.annual_amount) - Number(prev.annual_amount) : null;
                  return (
                    <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 border-t border-gray-100">
                      <span className="text-[13px] text-gray-500 w-24 shrink-0">{fmtDate(row.effective_from)}</span>
                      <span className="text-[15px] text-gray-900 tabular-nums">{money(row.annual_amount)}</span>
                      {delta !== null && delta !== 0 && (
                        <span className={`text-[13px] ${delta > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                          {delta > 0 ? '+' : '−'}{money(Math.abs(delta))}
                          <span className="text-gray-500"> ({((delta / Number(prev!.annual_amount)) * 100).toFixed(1)}%)</span>
                        </span>
                      )}
                      {row.reason && <span className="text-[13px] text-gray-500 w-full sm:w-auto sm:ml-auto">{row.reason}</span>}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </Card>

        {/* ── Pension ────────────────────────────────────────────────── */}
        <Card title="Pension"
          action={!addingPension && <button onClick={() => setAddingPension(true)} className={btnSecondary}>Record a change</button>}>
          {currentPension ? (
            currentPension.is_member ? (
              <div className="mb-1">
                <span className={big}>{currentPension.employee_percent ?? '—'}%</span>
                <span className="text-[15px] text-gray-700 ml-1.5">them</span>
                <span className={`${big} ml-4`}>{currentPension.employer_percent ?? '—'}%</span>
                <span className="text-[15px] text-gray-700 ml-1.5">us</span>
                <div className="text-xs text-gray-500 mt-2">
                  {currentPension.scheme_name ? `${currentPension.scheme_name} · ` : ''}since {fmtDate(currentPension.effective_from)}
                </div>
              </div>
            ) : (
              <Pill tone="muted">Opted out since {fmtDate(currentPension.effective_from)}</Pill>
            )
          ) : (
            <Pill tone="warn">Not recorded</Pill>
          )}

          {addingPension && (
            <div className="mt-4 p-4 rounded-xl border border-ooosh-200 bg-ooosh-50/40 space-y-3">
              <label className="text-sm inline-flex items-center gap-2 text-gray-800">
                <input type="checkbox" checked={isMember} onChange={e => setIsMember(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300" />
                In the scheme
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Employee %</span>
                  <input value={empPct} onChange={e => setEmpPct(e.target.value.replace(/[^\d.]/g, ''))}
                    disabled={!isMember} inputMode="decimal" placeholder="5" className={field} />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Employer %</span>
                  <input value={erPct} onChange={e => setErPct(e.target.value.replace(/[^\d.]/g, ''))}
                    disabled={!isMember} inputMode="decimal" placeholder="3" className={field} />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Scheme</span>
                  <input value={scheme} onChange={e => setScheme(e.target.value)} disabled={!isMember}
                    placeholder="e.g. NEST" className={field} />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">From</span>
                  <input type="date" value={pensionFrom} onChange={e => setPensionFrom(e.target.value)} className={field} />
                </label>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => void addPension()} disabled={saving || !pensionFrom} className={btnPrimary}>
                  {saving ? 'Saving…' : 'Record'}
                </button>
                <button onClick={() => setAddingPension(false)} className={btnQuiet}>Cancel</button>
              </div>
            </div>
          )}

          {pension.length === 0 ? (
            <p className="text-sm text-gray-400 mt-3">
              No pension history. Opting out is worth recording too — “no row” and “opted out on a date”
              are different facts, and only the second is evidence.
            </p>
          ) : (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-ooosh-700 hover:underline select-none">
                History ({pension.length})
              </summary>
              <ul className="mt-2">
                {pension.map(row => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-2.5 border-t border-gray-100">
                    <span className="text-[13px] text-gray-500 w-24 shrink-0">{fmtDate(row.effective_from)}</span>
                    <span className="text-[15px] text-gray-900">
                      {row.is_member
                        ? `${row.employee_percent ?? '—'}% / ${row.employer_percent ?? '—'}%`
                        : 'Opted out'}
                    </span>
                    {row.scheme_name && <span className="text-[13px] text-gray-500">{row.scheme_name}</span>}
                    {row.reason && <span className="text-[13px] text-gray-500">{row.reason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      </div>
    </div>
  );
}
