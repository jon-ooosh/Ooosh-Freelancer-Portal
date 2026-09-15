import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

/**
 * Absence — sickness, parental leave, return-to-work (Phase D).
 * See docs/STAFF-CALENDAR-SPEC.md §7.
 *
 * ADMIN ONLY. Absence type and reason are special-category data under UK GDPR
 * (§0.5) and the API refuses this page's endpoints to anyone else — this gate
 * is the second lock, not the only one.
 *
 * The page is ordered by what needs doing: anything outstanding first (open
 * absences, return-to-work overdue), then the report, then the record.
 */

type AbsenceType =
  | 'sickness' | 'maternity' | 'paternity' | 'shared_parental' | 'adoption'
  | 'bereavement' | 'compassionate' | 'goodwill' | 'jury_service'
  | 'medical_appointment' | 'other';

type Portion = 'full' | 'am' | 'pm' | 'hours';
type FitToReturn = 'yes' | 'yes_with_adjustments' | 'no';

interface AbsenceDay {
  date: string; minutes: number; portion: Portion;
  startTime: string | null; endTime: string | null;
}
interface Absence {
  id: string;
  personId: string;
  personName: string;
  absenceType: AbsenceType;
  startDate: string;
  endDate: string | null;
  isOpen: boolean;
  status: 'active' | 'cancelled';
  deductsAllowance: boolean;
  totalMinutes: number | null;
  workingDays: number | null;
  reasonCategory: string | null;
  notes: string | null;
  selfCertified: boolean;
  fitNoteReceived: boolean;
  fitNoteExpiry: string | null;
  sspQualifying: boolean | null;
  rtwRequired: boolean;
  rtwDate: string | null;
  rtwCompletedAt: string | null;
  rtwByName: string | null;
  rtwFitToReturn: FitToReturn | null;
  rtwAdjustments: string | null;
  rtwNotes: string | null;
  cancellationReason: string | null;
  days: AbsenceDay[];
}
interface ReclaimCandidate {
  dayId: string; date: string; minutes: number; portion: Portion; leaveType: string;
}
interface RtwOutstanding {
  id: string; personId: string; personName: string;
  endDate: string; daysWaiting: number; chasedAt: string | null;
}
interface ReportRow {
  personId: string; personName: string;
  spells: number; days: number; minutes: number;
  recentSpells: number; flagged: boolean;
  openAbsence: boolean; rtwOutstanding: number;
}
interface RosterRow {
  personId: string;
  name: string;
  preferredName: string | null;
  /** The roster is a union of logins and employment records; only the latter
   *  can hold an absence, because everything hangs off staff_employment. */
  employment: { status: string } | null;
}

const TYPE_LABELS: Record<AbsenceType, string> = {
  sickness: 'Sickness',
  maternity: 'Maternity',
  paternity: 'Paternity',
  shared_parental: 'Shared parental',
  adoption: 'Adoption',
  bereavement: 'Bereavement',
  compassionate: 'Compassionate',
  goodwill: 'Goodwill',
  jury_service: 'Jury service',
  medical_appointment: 'Appointment',
  other: 'Other',
};

const FIT_LABELS: Record<FitToReturn, string> = {
  yes: 'Fit to return',
  yes_with_adjustments: 'Fit, with adjustments',
  no: 'Not fit to return',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtH(min: number | null): string {
  if (min === null || min === undefined) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
const TODAY = new Date().toISOString().slice(0, 10);
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return Number.isNaN(dt.getTime()) ? iso : dt.toISOString().slice(0, 10);
}

export default function StaffAbsencePage() {
  const role = useAuthStore(s => s.user?.role);
  const isAdmin = role === 'admin';

  const [absences, setAbsences] = useState<Absence[]>([]);
  const [rtwOutstanding, setRtwOutstanding] = useState<RtwOutstanding[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState('');

  const reportFrom = useMemo(() => addMonths(TODAY, -12), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [abs, rep, ros] = await Promise.all([
        api.get<{ data: Absence[]; rtwOutstanding: RtwOutstanding[] }>(
          `/staff-calendar/absences${personFilter ? `?personId=${personFilter}` : ''}`),
        api.get<{ data: ReportRow[] }>(
          `/staff-calendar/absence-report?from=${reportFrom}&to=${TODAY}`),
        api.get<{ data: RosterRow[] }>('/staff-calendar/roster'),
      ]);
      setAbsences(abs.data);
      setRtwOutstanding(abs.rtwOutstanding ?? []);
      setReport(rep.data);
      setRoster(ros.data.filter(r => r.personId && r.employment));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load absences');
    } finally {
      setLoading(false);
    }
  }, [personFilter, reportFrom]);

  useEffect(() => { void load(); }, [load]);

  const openAbsences = absences.filter(a => a.isOpen);
  const flagged = report.filter(r => r.flagged);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="p-4 rounded border border-amber-200 bg-amber-50 text-sm text-amber-800">
          Absence records are admin only.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Absence</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Sickness, parental leave and return-to-work. Admin only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/staff/admin"
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Staff</Link>
          <Link to="/staff/calendar"
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Calendar</Link>
          <button onClick={() => setAdding(true)}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">
            Record an absence
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}

      {adding && (
        <AddAbsence roster={roster} onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); void load(); }} onError={setError} />
      )}

      {/* ── What needs doing ───────────────────────────────────────────────── */}
      {rtwOutstanding.length > 0 && (
        <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900 mb-2">
            Return-to-work outstanding ({rtwOutstanding.length})
          </h2>
          <ul className="space-y-1 text-sm text-amber-900">
            {rtwOutstanding.map(r => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.personName}</span>
                <span className="text-amber-700">
                  back {fmtDate(r.endDate)} · {r.daysWaiting} day{r.daysWaiting === 1 ? '' : 's'} ago
                </span>
                {r.chasedAt && <span className="text-xs text-amber-600">(chased)</span>}
                <button onClick={() => setOpenId(r.id)}
                  className="text-xs px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-100">
                  Record it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openAbsences.length > 0 && (
        <section className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4">
          <h2 className="text-sm font-semibold text-rose-900 mb-2">
            Still off ({openAbsences.length})
          </h2>
          <ul className="space-y-1 text-sm text-rose-900">
            {openAbsences.map(a => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.personName}</span>
                <span className="text-rose-700">
                  {TYPE_LABELS[a.absenceType]} since {fmtDate(a.startDate)} · {a.days.length} day
                  {a.days.length === 1 ? '' : 's'} so far
                </span>
                <button onClick={() => setOpenId(a.id)}
                  className="text-xs px-2 py-0.5 rounded border border-rose-400 hover:bg-rose-100">
                  Close it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── The report (spec §7.6) ─────────────────────────────────────────── */}
      <section className="mb-5 rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Sickness, last 12 months</h2>
          <span className="text-xs text-gray-500">
            Spells matter more than days — five one-day absences is a different signal
            from one five-day absence
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left font-medium px-4 py-2">Person</th>
                <th className="text-right font-medium px-4 py-2">Spells</th>
                <th className="text-right font-medium px-4 py-2">Days</th>
                <th className="text-right font-medium px-4 py-2">Time</th>
                <th className="text-left font-medium px-4 py-2">Flag</th>
              </tr>
            </thead>
            <tbody>
              {report.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  No sickness recorded.
                </td></tr>
              )}
              {report.map(r => (
                <tr key={r.personId} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-900">{r.personName}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{r.spells}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{r.days}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{fmtH(r.minutes)}</td>
                  <td className="px-4 py-2">
                    {r.flagged && (
                      <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                        {r.recentSpells} spells recently
                      </span>
                    )}
                    {r.rtwOutstanding > 0 && (
                      <span className="ml-1 text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                        RTW due
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {flagged.length > 0 && (
          <div className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">
            A flag is a prompt for a conversation, not a finding. Default: 3 spells in 3 months.
          </div>
        )}
      </section>

      {/* ── The record ─────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">All absences</h2>
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
            className="px-2 py-1 text-sm rounded border border-gray-300">
            <option value="">Everyone</option>
            {roster.map(r => (
              <option key={r.personId} value={r.personId}>{r.preferredName || r.name}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-sm text-gray-500">Loading…</div>
        ) : absences.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-400">Nothing recorded.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {absences.map(a => (
              <AbsenceRow key={a.id} absence={a}
                expanded={openId === a.id}
                onToggle={() => setOpenId(openId === a.id ? null : a.id)}
                onChanged={load} onError={setError} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── One absence ─────────────────────────────────────────────────────────────

function AbsenceRow({ absence, expanded, onToggle, onChanged, onError }: {
  absence: Absence;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const a = absence;
  const range = a.endDate && a.endDate !== a.startDate
    ? `${fmtDate(a.startDate)} – ${fmtDate(a.endDate)}`
    : fmtDate(a.startDate);

  return (
    <li className={a.status === 'cancelled' ? 'opacity-50' : ''}>
      <button onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-gray-900">{a.personName}</span>
        <span className="text-sm text-gray-600">{TYPE_LABELS[a.absenceType]}</span>
        <span className="text-sm text-gray-500">{range}</span>
        {a.isOpen && (
          <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800">Still off</span>
        )}
        {a.deductsAllowance && (
          <span className="text-xs px-2 py-0.5 rounded bg-sky-100 text-sky-800">Deducts allowance</span>
        )}
        {a.status === 'cancelled' && (
          <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600">Cancelled</span>
        )}
        {!a.isOpen && a.rtwRequired && !a.rtwCompletedAt && a.status === 'active' && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">RTW due</span>
        )}
        <span className="ml-auto text-sm text-gray-500">
          {a.totalMinutes !== null ? fmtH(a.totalMinutes) : `${a.days.length} day${a.days.length === 1 ? '' : 's'}`}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 bg-gray-50/60 border-t border-gray-100 pt-3">
          <AbsenceDetail a={a} />
          {a.status === 'active' && (
            <AbsenceActions a={a} onChanged={onChanged} onError={onError} />
          )}
          {a.status === 'cancelled' && a.cancellationReason && (
            <p className="text-sm text-gray-500">Cancelled — {a.cancellationReason}</p>
          )}
        </div>
      )}
    </li>
  );
}

function AbsenceDetail({ a }: { a: Absence }) {
  return (
    <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      <Row label="Days charged">
        {a.days.length === 0 ? '— not started yet' : a.days.map(d => (
          <span key={d.date} className="inline-block mr-2">
            {fmtDate(d.date)}
            {d.portion !== 'full' && (
              <span className="text-gray-500">
                {' '}({d.portion === 'hours' ? `${d.startTime}–${d.endTime}` : d.portion.toUpperCase()})
              </span>
            )}
          </span>
        ))}
      </Row>
      {a.workingDays !== null && <Row label="Working days">{a.workingDays}</Row>}
      {a.reasonCategory && <Row label="Reason">{a.reasonCategory}</Row>}
      {a.notes && <Row label="Notes">{a.notes}</Row>}
      <Row label="Self-certified">{a.selfCertified ? 'Yes' : 'No'}</Row>
      <Row label="Fit note">
        {a.fitNoteReceived ? `Received${a.fitNoteExpiry ? `, expires ${fmtDate(a.fitNoteExpiry)}` : ''}` : 'Not received'}
      </Row>
      {a.sspQualifying !== null && (
        <Row label="SSP qualifying">
          {a.sspQualifying ? 'Flagged for payroll' : 'No'}
        </Row>
      )}
      {a.rtwCompletedAt && (
        <>
          <Row label="Return to work">
            {a.rtwFitToReturn ? FIT_LABELS[a.rtwFitToReturn] : '—'}
            {a.rtwDate && <span className="text-gray-500"> · {fmtDate(a.rtwDate)}</span>}
            {a.rtwByName && <span className="text-gray-500"> · {a.rtwByName}</span>}
          </Row>
          {a.rtwAdjustments && <Row label="Adjustments">{a.rtwAdjustments}</Row>}
          {a.rtwNotes && <Row label="RTW notes">{a.rtwNotes}</Row>}
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-gray-800">{children}</div>
    </div>
  );
}

function AbsenceActions({ a, onChanged, onError }: {
  a: Absence;
  onChanged: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [closing, setClosing] = useState(false);
  const [endDate, setEndDate] = useState(TODAY);
  const [rtwOpen, setRtwOpen] = useState(false);
  const [reclaim, setReclaim] = useState<ReclaimCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Reclaim candidates are fetched on demand rather than with the list: they
  // are only meaningful once someone is looking at this absence.
  const loadReclaim = useCallback(async () => {
    try {
      const r = await api.get<{ reclaimCandidates: ReclaimCandidate[] }>(`/staff-calendar/absences/${a.id}`);
      setReclaim(r.reclaimCandidates ?? []);
      setPicked((r.reclaimCandidates ?? []).map(c => c.dayId));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to check for booked holiday');
    }
  }, [a.id, onError]);

  useEffect(() => { void loadReclaim(); }, [loadReclaim]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await onChanged(); }
    catch (err) { onError(err instanceof Error ? err.message : 'That did not work'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {/* Sickness during booked holiday (§7.4) — offered, never applied for you. */}
      {reclaim && reclaim.length > 0 && (
        <div className="rounded border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm text-sky-900 mb-2">
            This overlaps {reclaim.length} booked {reclaim.length === 1 ? 'day' : 'days'} of leave
            ({reclaim.map(c => fmtDate(c.date)).join(', ')}). Give them back to the allowance?
          </p>
          <div className="space-y-1 mb-2">
            {reclaim.map(c => (
              <label key={c.dayId} className="flex items-center gap-2 text-sm text-sky-900">
                <input type="checkbox" checked={picked.includes(c.dayId)}
                  onChange={e => setPicked(p =>
                    e.target.checked ? [...p, c.dayId] : p.filter(x => x !== c.dayId))} />
                {fmtDate(c.date)} · {fmtH(c.minutes)} · {c.leaveType === 'toil' ? 'TOIL' : 'holiday'}
              </label>
            ))}
          </div>
          <button disabled={busy || picked.length === 0}
            onClick={() => act(async () => {
              await api.post(`/staff-calendar/absences/${a.id}/reclaim`, { dayIds: picked });
              setReclaim([]);
            })}
            className="px-3 py-1.5 text-sm rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
            Reclaim {picked.length} day{picked.length === 1 ? '' : 's'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {a.isOpen && !closing && (
          <button onClick={() => setClosing(true)}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">
            Close this absence
          </button>
        )}
        {!a.isOpen && a.rtwRequired && !a.rtwCompletedAt && !rtwOpen && (
          <button onClick={() => setRtwOpen(true)}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">
            Record return to work
          </button>
        )}
        <button disabled={busy}
          onClick={() => {
            const reason = window.prompt('Why is this being cancelled? (kept on the record)');
            if (!reason) return;
            void act(() => api.post(`/staff-calendar/absences/${a.id}/cancel`, { reason }));
          }}
          className="px-3 py-1.5 text-sm rounded border border-red-200 text-red-700 bg-white hover:bg-red-50">
          Cancel
        </button>
      </div>

      {closing && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-gray-200 bg-white p-3">
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Last day off</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300" />
          </label>
          <button disabled={busy}
            onClick={() => act(async () => {
              await api.post(`/staff-calendar/absences/${a.id}/close`, { endDate });
              setClosing(false);
            })}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            Close
          </button>
          <button onClick={() => setClosing(false)}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
        </div>
      )}

      {rtwOpen && (
        <RtwForm absenceId={a.id} onDone={() => { setRtwOpen(false); void onChanged(); }}
          onClose={() => setRtwOpen(false)} onError={onError} />
      )}
    </div>
  );
}

// ── Return to work (spec §7.3) ──────────────────────────────────────────────

function RtwForm({ absenceId, onDone, onClose, onError }: {
  absenceId: string;
  onDone: () => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [rtwDate, setRtwDate] = useState(TODAY);
  const [fitToReturn, setFit] = useState<FitToReturn>('yes');
  const [adjustments, setAdjustments] = useState('');
  const [notes, setNotes] = useState('');
  const [fitNoteReceived, setFitNote] = useState(false);
  const [fitNoteExpiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.post(`/staff-calendar/absences/${absenceId}/rtw`, {
        rtwDate, fitToReturn,
        adjustments: adjustments || null,
        notes: notes || null,
        fitNoteReceived,
        fitNoteExpiry: fitNoteExpiry || null,
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save the return to work');
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Return-to-work conversation</h3>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Conversation date</span>
          <input type="date" value={rtwDate} onChange={e => setRtwDate(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Fit to return?</span>
          <select value={fitToReturn} onChange={e => setFit(e.target.value as FitToReturn)}
            className="w-full px-2 py-1.5 rounded border border-gray-300">
            <option value="yes">Yes</option>
            <option value="yes_with_adjustments">Yes, with adjustments</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>
      {fitToReturn !== 'yes' && (
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
            Adjustments needed
          </span>
          <textarea value={adjustments} onChange={e => setAdjustments(e.target.value)} rows={2}
            className="w-full px-2 py-1.5 rounded border border-gray-300"
            placeholder="Lighter duties, phased return, altered hours…" />
        </label>
      )}
      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Notes</span>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          className="w-full px-2 py-1.5 rounded border border-gray-300" />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={fitNoteReceived} onChange={e => setFitNote(e.target.checked)} />
          Fit note received
        </label>
        {fitNoteReceived && (
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Expires</span>
            <input type="date" value={fitNoteExpiry} onChange={e => setExpiry(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300" />
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void save()}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
          Save
        </button>
        <button onClick={onClose}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
      </div>
    </div>
  );
}

// ── Recording one ───────────────────────────────────────────────────────────

function AddAbsence({ roster, onClose, onSaved, onError }: {
  roster: RosterRow[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [personId, setPersonId] = useState('');
  const [absenceType, setType] = useState<AbsenceType>('sickness');
  const [startDate, setStart] = useState(TODAY);
  const [ongoing, setOngoing] = useState(true);
  const [endDate, setEnd] = useState(TODAY);
  const [portion, setPortion] = useState<Portion>('full');
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('15:00');
  const [deductsAllowance, setDeducts] = useState(false);
  const [reasonCategory, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [selfCertified, setSelfCert] = useState(false);
  const [sspQualifying, setSsp] = useState(false);
  const [busy, setBusy] = useState(false);

  const timed = portion === 'hours';

  async function save() {
    if (!personId) { onError('Pick who this is for'); return; }
    setBusy(true);
    try {
      await api.post('/staff-calendar/absences', {
        personId, absenceType, startDate,
        endDate: timed ? startDate : (ongoing && portion === 'full' ? null : endDate),
        portion,
        ...(timed ? { startTime, endTime } : {}),
        deductsAllowance,
        reasonCategory: reasonCategory || null,
        notes: notes || null,
        selfCertified,
        sspQualifying: absenceType === 'sickness' ? sspQualifying : null,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record the absence');
    } finally { setBusy(false); }
  }

  return (
    <div className="mb-5 rounded-lg border border-ooosh-200 bg-ooosh-50/40 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">Record an absence</h2>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Who</span>
          <select value={personId} onChange={e => setPersonId(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            <option value="">Pick someone…</option>
            {roster.map(r => (
              <option key={r.personId} value={r.personId}>{r.preferredName || r.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Type</span>
          <select value={absenceType} onChange={e => setType(e.target.value as AbsenceType)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            {(Object.keys(TYPE_LABELS) as AbsenceType[]).map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">How much</span>
          <select value={portion} onChange={e => setPortion(e.target.value as Portion)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            <option value="full">Whole days</option>
            <option value="am">Morning</option>
            <option value="pm">Afternoon</option>
            <option value="hours">A set period</option>
          </select>
        </label>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
            {timed ? 'Date' : 'First day off'}
          </span>
          <input type="date" value={startDate} onChange={e => setStart(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
        </label>
        {timed ? (
          <>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">From</span>
              <input type="time" step={300} value={startTime} onChange={e => setStartTime(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">To</span>
              <input type="time" step={300} value={endTime} onChange={e => setEndTime(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
            </label>
          </>
        ) : (
          <>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Last day off</span>
              <input type="date" value={endDate} disabled={ongoing}
                onChange={e => setEnd(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white disabled:bg-gray-100" />
            </label>
            {/* Only whole days can be open-ended: an absence with no end date
                has no day rows to read a portion back from, so the catch-up
                assumes whole days and the API refuses the rest. */}
            <label className="flex items-end gap-2 text-sm text-gray-700 pb-1.5">
              <input type="checkbox" checked={ongoing && portion === 'full'}
                disabled={portion !== 'full'}
                onChange={e => setOngoing(e.target.checked)} />
              <span className={portion !== 'full' ? 'text-gray-400' : ''}>
                Still off — no end date yet
              </span>
            </label>
          </>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
            Reason category <span className="normal-case text-gray-400">(admin only)</span>
          </span>
          <input value={reasonCategory} onChange={e => setReason(e.target.value)}
            placeholder="e.g. respiratory, musculoskeletal"
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
            Notes <span className="normal-case text-gray-400">(admin only)</span>
          </span>
          <input value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-sm text-gray-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={selfCertified} onChange={e => setSelfCert(e.target.checked)} />
          Self-certified
        </label>
        {absenceType === 'sickness' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sspQualifying} onChange={e => setSsp(e.target.checked)} />
            Flag as SSP qualifying for payroll
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={deductsAllowance} onChange={e => setDeducts(e.target.checked)} />
          Deduct from holiday allowance
        </label>
      </div>
      <p className="text-xs text-gray-500">
        Sickness, bereavement and goodwill do not come out of holiday — leave that unticked
        unless this is the odd case that should.
      </p>

      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void save()}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
          Record it
        </button>
        <button onClick={onClose}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
