import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import StaffRecordFiles from '../components/StaffRecordFiles';
import StaffKeyData from '../components/StaffKeyData';
import StaffReviews, { type ReviewPerson } from '../components/StaffReviews';
import StaffPay from '../components/StaffPay';
import StaffAttention, { type AttentionItem } from '../components/StaffAttention';
import StaffPersonOverview from '../components/StaffPersonOverview';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import StaffBalancePanel from '../components/StaffBalancePanel';
import LeaveApprovals from '../components/LeaveApprovals';
import PayrollReportPanel from '../components/PayrollReportPanel';
import MyTimePage from './MyTimePage';
import { Card, InfoRow, Pill, btnPrimary, btnSecondary, btnQuiet } from '../components/StaffCard';

/**
 * Staff — the single surface for everyone who works here (Staff Calendar).
 * See docs/STAFF-CALENDAR-SPEC.md §3.1–3.2 and §10.
 *
 * WHAT BELONGS HERE: facts about a person who works here — their login and
 * role, their company card, their contracted hours, their holiday policy, and
 * (later) salary, reviews and absence. Configuration that merely concerns
 * staff — email service, gate codes, thresholds — stays in Settings. Without
 * that line this page becomes the next dumping ground.
 *
 * THE LIST IS A UNION. Accounts and employment records are different sets and
 * neither contains the other: service and test logins are not employees, and
 * an employee can exist before their login does. Each row says what it has and
 * what it is missing rather than quietly omitting anyone.
 *
 * TWO TIERS, deliberately. The page opens at manager level because the account
 * half replaces the Team Members list in Settings, which managers could already
 * reach — moving it must not quietly take that away. Employment, hours and card
 * details are admin-only and the API omits them entirely for anyone else, so
 * they are absent from the response rather than hidden in the browser.
 */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin', manager: 'Manager', weekend_manager: 'Weekend Manager',
  staff: 'Staff', general_assistant: 'General Assistant', freelancer: 'Freelancer',
};
const ROLE_COLOURS: Record<string, string> = {
  admin: 'bg-red-100 text-red-800',
  manager: 'bg-blue-100 text-blue-800',
  weekend_manager: 'bg-purple-100 text-purple-800',
  staff: 'bg-emerald-100 text-emerald-800',
  general_assistant: 'bg-amber-100 text-amber-800',
  freelancer: 'bg-gray-100 text-gray-700',
};

interface RosterRow {
  personId: string;
  userId: string | null;
  name: string;
  preferredName: string | null;
  pronouns: string | null;
  email: string | null;
  avatarUrl: string | null;
  account: { role: string; isActive: boolean; hhUserId: number | null } | null;
  employment: {
    status: string; startDate: string; endDate: string | null;
    jobTitle: string | null; department: string | null;
    bankHolidayPolicy: 'use_allowance' | 'granted' | null;
    entitlementWeeks: string | null;
    probationEndDate: string | null;
    noticePeriodDays: number | null;
  } | null;
  weeklyMinutes: number | null;
  hasPattern: boolean;
  cotCard: {
    last4: string | null; label: string | null;
    agreementStatus: string | null; agreementCompletedAt: string | null;
  } | null;
}
interface PatternDay {
  cycle_week: number; weekday: number; is_working: boolean;
  start_time: string | null; end_time: string | null; break_minutes: number; minutes: number;
  /** A regular agreed home day (spec §19, mig 269). Absent from an older backend. */
  at_home?: boolean;
}
interface Pattern {
  id: string; effective_from: string; effective_to: string | null;
  cycle_weeks: number; notes: string | null; days: PatternDay[]; weeklyMinutes: number;
}
interface PersonSearchRow { id: string; first_name: string; last_name: string; email: string | null }
interface DraftDay {
  weekday: number; cycleWeek: number; isWorking: boolean;
  startTime: string; endTime: string; breakMinutes: number;
  atHome?: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmt(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  const h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}
function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function dayMinutes(d: DraftDay): number {
  if (!d.isWorking || !d.startTime || !d.endTime) return 0;
  return toMin(d.endTime) - toMin(d.startTime) - (d.breakMinutes || 0);
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
/** Trim float noise: 28 stays 28, 22.4 stays 22.4, 22.400000000000002 does not. */
function fmtDays(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function blankDays(cycleWeeks: number): DraftDay[] {
  const out: DraftDay[] = [];
  for (let w = 1; w <= cycleWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      out.push({ weekday: d, cycleWeek: w, isWorking: d < 5, startTime: '09:00', endTime: '17:00', breakMinutes: 60 });
    }
  }
  return out;
}

/**
 * Company-wide default where a person has no explicit bank holiday policy.
 * Current Ooosh policy: bank holidays are ordinary working days — anyone
 * wanting one off books holiday or TOIL (spec §5.1). Becomes the
 * staff.bank_holidays_policy system setting in Phase B; the per-person
 * override already beats whatever that ends up saying.
 */
const COMPANY_BANK_HOLIDAY_DEFAULT = 'use_allowance';
const BH_LABEL: Record<string, string> = {
  use_allowance: 'Normal working days — book holiday or TOIL to take one off',
  granted: 'Given as paid leave, on top of their allowance',
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function StaffAdminPage() {
  const role = useAuthStore(s => s.user?.role);
  const isAdmin = role === 'admin';
  const isManager = hasManagerRole(role);

  const [rows, setRows] = useState<RosterRow[]>([]);

  // The open person and tab live in the URL, not in state. That is what lets a
  // notification link straight to "Will's reviews" instead of dropping the
  // reader on a list — and Back behaves.
  const [params, setParams] = useSearchParams();
  const openPersonId = params.get('person');
  const activeTab = params.get('tab') || 'overview';

  const openPerson = useCallback((personId: string, tab?: string) => {
    const next = new URLSearchParams(params);
    next.set('person', personId);
    if (tab) next.set('tab', tab); else next.delete('tab');
    setParams(next);
  }, [params, setParams]);

  const closePerson = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('person');
    next.delete('tab');
    setParams(next);
  }, [params, setParams]);

  const setTab = useCallback((tab: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    setParams(next, { replace: true });
  }, [params, setParams]);

  // Bumped after every save so the derived attention list re-runs.
  const [attentionKey, setAttentionKey] = useState(0);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: RosterRow[] }>('/staff-calendar/roster');
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the staff list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isManager) void load(); }, [isManager, load]);

  // Fetched HERE, not in the panel: the same list also draws the roster flags
  // and the person view's attention box, and a deep link straight to a person
  // never renders the panel at all.
  useEffect(() => {
    if (!isAdmin) { setAttentionLoading(false); return; }
    let cancelled = false;
    setAttentionError(null);
    api.get<{ data: AttentionItem[] }>('/staff-calendar/attention')
      .then(res => { if (!cancelled) setAttention(res.data); })
      .catch(err => {
        if (!cancelled) setAttentionError(err instanceof Error ? err.message : 'Could not load the attention list');
      })
      .finally(() => { if (!cancelled) setAttentionLoading(false); });
    return () => { cancelled = true; };
  }, [isAdmin, attentionKey]);

  const announce = useCallback(async (msg: string) => {
    setNotice(msg);
    setError(null);
    setAttentionKey(k => k + 1);
    await load();
  }, [load]);

  // Everyone a review action could be owned by. Built from the roster the page
  // already loaded rather than a second fetch, and it MUST include people who
  // aren't the reviewee: "what should Ooosh do differently?" produces actions
  // the company owes, and those go on whoever is responsible (§6.2).
  const actionOwners = useMemo<ReviewPerson[]>(
    () => rows
      .filter(r => r.employment?.status !== 'left')
      .map(r => ({ personId: r.personId, name: r.preferredName || r.name })),
    [rows]
  );

  const visible = useMemo(
    () => rows.filter(r => showLeft || r.employment?.status !== 'left'),
    [rows, showLeft]
  );
  const employees = visible.filter(r => r.employment !== null);
  const others = visible.filter(r => r.employment === null);

  if (!isManager) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Staff</h1>
        <p className="text-sm text-gray-600">
          Staff records are restricted. You can still see who&apos;s in on the{' '}
          <Link to="/staff/calendar" className="text-ooosh-600 hover:underline">staff calendar</Link>.
        </p>
      </div>
    );
  }

  const openRow = openPersonId ? rows.find(r => r.personId === openPersonId) : undefined;

  if (openRow) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl">
        {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
        {notice && <div className="mb-4 p-3 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}
        <PersonView
          row={openRow}
          isAdmin={isAdmin}
          people={actionOwners}
          tab={activeTab}
          attention={attention.filter(a => a.personId === openRow.personId)}
          onTab={setTab}
          onBack={closePerson}
          onSaved={announce}
          onError={setError}
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-semibold text-gray-900">Staff</h1>
        <div className="flex items-center gap-4">
          {/* Absence lives on its own page: it is admin-only special-category
              data (§0.5), and this page is manager-tier for the account section. */}
          {isAdmin && (
            <Link to="/staff/absence" className="text-sm text-ooosh-600 hover:underline">Absence →</Link>
          )}
          <Link to="/staff/calendar" className="text-sm text-ooosh-600 hover:underline">View calendar →</Link>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Logins, roles, company cards and working hours — everyone who works here in one place.
        {isAdmin && ' Hours are stored against a date range, so changing them opens a new period rather than rewriting the old one.'}
      </p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 p-3 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {isAdmin && (
          <AddEmployee
            existing={rows.filter(r => r.employment).map(r => r.personId)}
            onAdded={announce}
            onError={setError}
          />
        )}
        <AddUser onAdded={announce} onError={setError} />
        <label className="ml-auto text-xs text-gray-600 inline-flex items-center gap-1.5">
          <input type="checkbox" checked={showLeft} onChange={e => setShowLeft(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-gray-300" />
          Show people who have left
        </label>
      </div>

      {isAdmin && <LeaveApprovals />}
      {/* Admin only: it is everyone's pay and sickness in one table. */}
      {isAdmin && <PayrollReportPanel />}

      {isAdmin && (
        <div className="mb-5">
          <StaffAttention
            items={attention}
            loading={attentionLoading}
            loadError={attentionError}
            onOpenPerson={openPerson}
            onLinkLogin={() => { /* the unlinked login lives in Other accounts below */ }}
          />
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500 py-6">Loading…</div>
      ) : (
        <>
          <RosterTable title="Employees" rows={employees} isAdmin={isAdmin}
            attention={attention} onOpen={openPerson}
            empty={isAdmin ? 'Nobody set up as an employee yet.' : undefined} />

          {others.length > 0 && (
            <RosterTable
              title="Other accounts"
              rows={others}
              isAdmin={isAdmin}
              attention={attention}
              onOpen={openPerson}
              hint="Logins that aren't employees — service accounts, test logins, freelancer access."
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The roster: one lean row per person, flags rather than data.
 *
 * The old card expanded into six stacked panels, so scanning seven people
 * meant opening seven walls. A row now carries only what you compare ACROSS
 * people — hours and next review — plus coloured flags drawn from the same
 * derived attention list as the panel above, so the two can never disagree.
 */
function RosterTable({ title, rows, isAdmin, attention, hint, empty, onOpen }: {
  title: string; rows: RosterRow[]; isAdmin: boolean;
  attention: AttentionItem[];
  hint?: string; empty?: string;
  onOpen: (personId: string, tab?: string) => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{rows.length}</span>
        {hint && <span className="text-xs text-gray-500">— {hint}</span>}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-3">{empty || 'Nobody here.'}</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {rows.map(row => {
            const flags = attention.filter(a => a.personId === row.personId);
            const left = row.employment?.status === 'left';
            return (
              <div key={row.personId}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-gray-100 last:border-b-0 ${left ? 'opacity-70' : ''}`}>
                <span className="w-8 h-8 rounded-full bg-ooosh-50 text-ooosh-700 text-xs font-semibold flex items-center justify-center shrink-0">
                  {initials(row)}
                </span>

                <span className="min-w-[12rem]">
                  <button onClick={() => onOpen(row.personId)}
                    className="block text-sm font-medium text-gray-900 hover:text-ooosh-700 hover:underline text-left">
                    {row.preferredName || row.name}
                    {row.pronouns && <span className="ml-1 text-xs font-normal text-gray-500">({row.pronouns})</span>}
                  </button>
                  <span className="block text-xs text-gray-500">
                    {row.employment?.jobTitle || row.email || 'no email'}
                  </span>
                </span>

                {row.account ? (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${ROLE_COLOURS[row.account.role] || 'bg-gray-100 text-gray-700'}`}>
                    {ROLE_LABELS[row.account.role] || row.account.role}
                  </span>
                ) : (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">No login</span>
                )}
                {row.account && !row.account.isActive && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 shrink-0">Inactive</span>
                )}
                {left && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 shrink-0">Left</span>}

                <span className="flex flex-wrap gap-1.5">
                  {flags.slice(0, 3).map(f => (
                    <button key={f.id} onClick={() => onOpen(row.personId, f.tab ?? undefined)}
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full hover:underline ${
                        f.severity === 'urgent' ? 'bg-red-100 text-red-800'
                          : f.severity === 'soon' ? 'bg-amber-100 text-amber-800'
                          : 'bg-gray-100 text-gray-600'}`}>
                      {f.label}
                    </button>
                  ))}
                  {flags.length > 3 && (
                    <span className="text-[11px] text-gray-500">+{flags.length - 3} more</span>
                  )}
                </span>

                {isAdmin && row.employment && (
                  <span className="ml-auto text-xs text-gray-600 shrink-0 w-24 text-right">
                    {row.hasPattern ? `${fmt(row.weeklyMinutes ?? 0)}/wk` : <span className="text-amber-700">no hours</span>}
                  </span>
                )}

                <button onClick={() => onOpen(row.personId)}
                  className={`text-xs font-medium text-ooosh-600 hover:text-ooosh-800 hover:underline shrink-0 ${isAdmin && row.employment ? '' : 'ml-auto'}`}>
                  Open
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function initials(row: RosterRow): string {
  const source = (row.preferredName || row.name || row.email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const PERSON_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'employment', label: 'Employment' },
  { id: 'time', label: 'Time off' },
  { id: 'records', label: 'Records' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'access', label: 'Access' },
] as const;

/**
 * One person, five tabs.
 *
 * The same six panels as before, but one at a time: Records and Reviews are
 * the admin-only halves of the staff-records module, Access is the login and
 * company card, Employment is the contract and hours. Overview is read-only
 * on purpose — see StaffPersonOverview.
 */
function PersonView({ row, isAdmin, people, tab, attention, onTab, onBack, onSaved, onError }: {
  row: RosterRow; isAdmin: boolean; people: ReviewPerson[];
  tab: string; attention: AttentionItem[];
  onTab: (tab: string) => void; onBack: () => void;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  // Records and Reviews hold passports, NI numbers and private review notes.
  // A manager reaching this page sees the person, not those tabs.
  // Time off reads that person's leave and overtime, which only an admin may
  // list for somebody else — and only an employee has any.
  const tabs = PERSON_TABS.filter(x =>
    (isAdmin || (x.id !== 'records' && x.id !== 'reviews' && x.id !== 'time'))
    && (x.id !== 'time' || !!row.employment));
  const active = tabs.some(x => x.id === tab) ? tab : 'overview';
  const urgent = attention.filter(a => a.severity === 'urgent').length;

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-600 hover:text-gray-900 mb-3">← Staff</button>

      <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-wrap items-center gap-4 mb-4">
        <span className="w-12 h-12 rounded-full bg-ooosh-50 text-ooosh-700 text-base font-semibold flex items-center justify-center shrink-0">
          {initials(row)}
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900">
            {row.preferredName || row.name}
            {row.pronouns && <span className="ml-2 text-sm font-normal text-gray-500">({row.pronouns})</span>}
          </h1>
          <p className="text-sm text-gray-600 mt-0.5">
            {row.employment?.jobTitle || 'No job title'}
            {row.employment?.startDate && ` · since ${fmtDate(row.employment.startDate)}`}
            {isAdmin && row.hasPattern && ` · ${fmt(row.weeklyMinutes ?? 0)}/week`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {row.account && (
            <span className={`text-xs px-2 py-1 rounded ${ROLE_COLOURS[row.account.role] || 'bg-gray-100 text-gray-700'}`}>
              {ROLE_LABELS[row.account.role] || row.account.role}
            </span>
          )}
          {urgent > 0 && (
            <span className="text-xs font-semibold text-red-800 bg-red-100 rounded-full px-2 py-1">
              {urgent} need{urgent === 1 ? 's' : ''} attention
            </span>
          )}
        </div>
      </div>

      {/* The grey rule is an inset shadow, not a border: with a border the
          tabs' -mb-px overlap spilled one pixel below the scroll box, and an
          overflow-x-auto box then grows a vertical scrollbar for it — the
          little up/down arrows beside the tabs. */}
      <div className="flex gap-1 mb-4 overflow-x-auto scrollbar-hide shadow-[inset_0_-1px_0_#e5e7eb]">
        {tabs.map(x => (
          <button key={x.id} onClick={() => onTab(x.id)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 ${
              active === x.id
                ? 'font-semibold text-ooosh-700 border-ooosh-600'
                : 'text-gray-600 border-transparent hover:text-gray-900'}`}>
            {x.label}
          </button>
        ))}
      </div>

      {/* Overview reads two ADMIN-ONLY endpoints. This page is manager-tier
          for the account section, so a manager rendering it would meet a 403
          dressed up as a load failure. Give them the plain facts instead. */}
      {active === 'overview' && !isAdmin && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Email</dt>
              <dd className="text-sm mt-0.5 text-gray-900">{row.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Role</dt>
              <dd className="text-sm mt-0.5 text-gray-900">
                {row.account ? (ROLE_LABELS[row.account.role] || row.account.role) : 'No login'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Job title</dt>
              <dd className="text-sm mt-0.5 text-gray-900">{row.employment?.jobTitle || '—'}</dd>
            </div>
          </dl>
          <p className="text-xs text-gray-500 mt-3">
            Records, reviews and hours are admin-only.
          </p>
        </div>
      )}

      {active === 'overview' && isAdmin && (
        <StaffPersonOverview
          personId={row.personId}
          personName={row.name}
          hours={isAdmin && row.hasPattern ? `${fmt(row.weeklyMinutes ?? 0)} / week` : null}
          attention={attention}
          onOpenTab={onTab}
        />
      )}

      {/* The same page staff see as Me › My Time, for this person — keyed so
          moving between people starts clean. Approve / Decline sit on
          whatever is still waiting. */}
      {active === 'time' && isAdmin && row.employment && (
        <MyTimePage key={row.personId} personId={row.personId} />
      )}

      {active === 'employment' && (
        isAdmin
          ? (row.employment
              ? (
                <div className="space-y-4">
                  <EmploymentSection row={row} onSaved={onSaved} onError={onError} />
                  {/* Salary and pension: employment TERMS, so they belong here
                      rather than with the documents on Records. */}
                  <StaffPay personId={row.personId} personName={row.name}
                    onSaved={onSaved} onError={onError} />
                  {/* The ledger behind the Time off figures — the entitlement
                      button and manual adjustments live here. Last, because it
                      is the working rather than the answer. */}
                  <Card title="Holiday and overtime — the working"
                    subtitle="Every entry behind the figures on Time off, the yearly allowance, and adjustments">
                    <StaffBalancePanel personId={row.personId} canManage year={new Date().getFullYear()} />
                  </Card>
                </div>
              )
              : <NotAnEmployee />)
          : <p className="text-sm text-gray-500">Employment details are admin-only.</p>
      )}

      {active === 'records' && isAdmin && (
        <div className="space-y-4">
          <StaffKeyData personId={row.personId} personName={row.name} onSaved={onSaved} onError={onError} />
          <StaffRecordFiles personId={row.personId} personName={row.name} onError={onError} />
        </div>
      )}

      {active === 'reviews' && isAdmin && (
        row.employment
          ? <StaffReviews personId={row.personId} personName={row.name} people={people}
              onSaved={onSaved} onError={onError} />
          : <NotAnEmployee />
      )}

      {active === 'access' && (
        <div className="space-y-4">
          <AccountSection row={row} isAdmin={isAdmin} onSaved={onSaved} onError={onError} />
          {isAdmin && <CotCardSection row={row} onSaved={onSaved} onError={onError} />}
        </div>
      )}
    </div>
  );
}

function NotAnEmployee() {
  return (
    <div className="p-3 rounded border border-dashed border-gray-300 text-sm text-gray-500">
      Not an employee — no working hours or holiday allowance. Use “Add employee” above if
      that&apos;s wrong.
    </div>
  );
}

// ── Account (manager tier) ──────────────────────────────────────────────────

function AccountSection({ row, isAdmin, onSaved, onError }: {
  row: RosterRow; isAdmin: boolean;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(row.name.split(' ')[0] ?? '');
  const [last, setLast] = useState(row.name.split(' ').slice(1).join(' '));
  const [email, setEmail] = useState(row.email ?? '');
  const [role, setRole] = useState(row.account?.role ?? 'staff');
  const [hhId, setHhId] = useState(row.account?.hhUserId != null ? String(row.account.hhUserId) : '');
  const [saving, setSaving] = useState(false);

  if (!row.account) {
    return <NoLogin row={row} isAdmin={isAdmin} onSaved={onSaved} onError={onError} />;
  }
  const userId = row.userId!;

  async function save() {
    setSaving(true);
    try {
      await api.put(`/users/${userId}`, {
        first_name: first.trim(), last_name: last.trim(),
        email: email.trim().toLowerCase(), role,
        hh_user_id: hhId.trim() === '' ? null : Number(hhId),
      });
      setEditing(false);
      await onSaved('Account updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update the account');
    } finally { setSaving(false); }
  }

  async function deactivate() {
    if (!confirm(`Deactivate ${row.name}? They will be signed out within 15 minutes and cannot log back in.`)) return;
    try {
      await api.put(`/users/${userId}`, { is_active: false });
      await onSaved(`${row.name} deactivated.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to deactivate');
    }
  }

  async function reactivate() {
    try {
      await api.put(`/users/${userId}`, { is_active: true });
      await onSaved(`${row.name} reactivated.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to reactivate');
    }
  }

  async function resetPassword() {
    const pw = prompt(`New password for ${row.name} (minimum 8 characters):`);
    if (!pw) return;
    if (pw.length < 8) { onError('Password must be at least 8 characters.'); return; }
    try {
      await api.post(`/users/${userId}/force-password`, { new_password: pw });
      await onSaved(`Password reset for ${row.name}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to reset the password');
    }
  }

  if (!editing) {
    return (
      <Card title="Login and role" subtitle="How they sign in to OP, and what they can see"
        action={<button onClick={() => setEditing(true)} className={btnSecondary}>Edit</button>}>
        <dl>
          <InfoRow label="Email">{row.email || <span className="text-gray-400">—</span>}</InfoRow>
          <InfoRow label="Role">{ROLE_LABELS[row.account.role] || row.account.role}</InfoRow>
          <InfoRow label="HireHop user ID">{row.account.hhUserId ?? <span className="text-gray-400">—</span>}</InfoRow>
          <InfoRow label="Status">
            {row.account.isActive ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Deactivated</Pill>}
          </InfoRow>
        </dl>
        {/* The two irreversible-feeling actions sit apart from Edit, at the
            foot, so neither is one stray click from the button people use. */}
        <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-gray-100">
          {isAdmin && (
            <button onClick={() => void resetPassword()} className="text-sm font-medium text-ooosh-700 hover:underline">
              Reset password
            </button>
          )}
          {row.account.isActive
            ? <button onClick={() => void deactivate()} className="text-sm font-medium text-red-600 hover:underline">Deactivate login</button>
            : <button onClick={() => void reactivate()} className="text-sm font-medium text-emerald-700 hover:underline">Reactivate login</button>}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Edit login and role" className="border-ooosh-200"
      action={<button onClick={() => setEditing(false)} className={btnQuiet}>Cancel</button>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Field label="First name" value={first} onChange={setFirst} />
        <Field label="Last name" value={last} onChange={setLast} />
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Role</span>
          <select value={role} onChange={e => setRole(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">HireHop user ID</span>
          <input value={hhId} onChange={e => setHhId(e.target.value)} inputMode="numeric"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
          <span className="block text-xs text-gray-500 mt-1">Sets the manager on HH jobs this user creates.</span>
        </label>
      </div>
      <button onClick={() => void save()} disabled={saving} className={btnPrimary}>
        {saving ? 'Saving…' : 'Save account'}
      </button>
    </Card>
  );
}

// ── COT card (admin) ────────────────────────────────────────────────────────

function CotCardSection({ row, onSaved, onError }: {
  row: RosterRow; onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [last4, setLast4] = useState(row.cotCard?.last4 ?? '');
  const [label, setLabel] = useState(row.cotCard?.label ?? '');
  const [saving, setSaving] = useState(false);

  if (!row.userId) return null;
  const dirty = last4 !== (row.cotCard?.last4 ?? '') || label !== (row.cotCard?.label ?? '');

  async function save() {
    if (last4 && !/^\d{4}$/.test(last4)) { onError('Card last 4 must be exactly 4 digits.'); return; }
    setSaving(true);
    try {
      await api.patch(`/users/${row.userId}/cot-card`, {
        cot_card_last4: last4 || null,
        cot_card_label: label.trim() || null,
      });
      await onSaved(`Company card updated for ${row.name}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save the card');
    } finally { setSaving(false); }
  }

  return (
    <Card title="Company card"
      subtitle="Cost capture stamps the holder and last 4 from here — staff never type card details"
      action={
        row.cotCard?.agreementCompletedAt
          ? <Pill tone="ok">Agreement signed {new Date(row.cotCard.agreementCompletedAt).toLocaleDateString('en-GB')}</Pill>
          : row.cotCard?.agreementStatus ? <Pill tone="warn">Agreement outstanding</Pill>
          : <Pill tone="muted">No agreement assigned</Pill>
      }>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Last 4 digits</span>
          <input value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="1234" inputMode="numeric"
            className="w-28 px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Label</span>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. COT"
            className="w-44 px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
        </label>
        <button onClick={() => void save()} disabled={saving || !dirty} className={btnPrimary}>
          {saving ? 'Saving…' : 'Save card'}
        </button>
      </div>
    </Card>
  );
}

// ── Employment + hours (admin) ──────────────────────────────────────────────

function EmploymentSection({ row, onSaved, onError }: {
  row: RosterRow; onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Pattern[] }>(`/staff-calendar/employees/${row.personId}/patterns`);
      setPatterns(res.data);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load working hours');
    } finally { setLoaded(true); }
  }, [row.personId, onError]);

  useEffect(() => { void load(); }, [load]);

  const current = patterns.find(p => p.effective_to === null) ?? patterns[0];
  // Days-per-week for the allowance converter below. Null when no pattern
  // exists, because "28 days" is meaningless until we know what a week is.
  const workingDaysPerWeek = current
    ? current.days.filter(d => d.is_working).length / (current.cycle_weeks || 1)
    : null;

  return (
    <div className="space-y-4">
      <EmploymentDetails row={row} workingDaysPerWeek={workingDaysPerWeek} onSaved={onSaved} onError={onError} />
      <Card title="Working hours"
        subtitle={current
          ? `${fmt(current.weeklyMinutes)} a week · ${fmtDays(workingDaysPerWeek ?? 0)} day${workingDaysPerWeek === 1 ? '' : 's'} · since ${fmtDate(current.effective_from)}`
          : undefined}>
        {!loaded ? (
          <div className="text-sm text-gray-500">Loading hours…</div>
        ) : (
          <div className="space-y-4">
            <PatternHistory patterns={patterns} />
            <PatternEditor personId={row.personId} seed={current}
              onSaved={async (msg) => { await load(); await onSaved(msg); }} onError={onError} />
          </div>
        )}
      </Card>
    </div>
  );
}

function EmploymentDetails({ row, workingDaysPerWeek, onSaved, onError }: {
  row: RosterRow; workingDaysPerWeek: number | null;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const emp = row.employment!;
  const [editing, setEditing] = useState(false);
  const [startDate, setStartDate] = useState(emp.startDate);
  const [endDate, setEndDate] = useState(emp.endDate ?? '');
  const [status, setStatus] = useState(emp.status);
  const [jobTitle, setJobTitle] = useState(emp.jobTitle ?? '');
  const [department, setDepartment] = useState(emp.department ?? '');
  const [bankHolidays, setBankHolidays] = useState<string>(emp.bankHolidayPolicy ?? '');
  const [preferredName, setPreferredName] = useState(row.preferredName ?? '');
  const [pronouns, setPronouns] = useState(row.pronouns ?? '');
  const [probationEnd, setProbationEnd] = useState(emp.probationEndDate ?? '');
  const [noticeDays, setNoticeDays] = useState(
    emp.noticePeriodDays != null ? String(emp.noticePeriodDays) : '');
  const [entitlement, setEntitlement] = useState(emp.entitlementWeeks ?? '');
  const [entitlementDays, setEntitlementDays] = useState(
    emp.entitlementWeeks != null && workingDaysPerWeek
      ? fmtDays(Number(emp.entitlementWeeks) * workingDaysPerWeek)
      : ''
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/staff-calendar/employees/${row.personId}`, {
        startDate,
        endDate: endDate || null,
        employmentStatus: status === 'left' ? 'left' : 'employed',
        jobTitle: jobTitle || null,
        department: department || null,
        bankHolidayPolicy: bankHolidays === '' ? null : bankHolidays,
        entitlementWeeks: entitlement === '' ? null : Number(entitlement),
        probationEndDate: probationEnd || null,
        noticePeriodDays: noticeDays === '' ? null : Number(noticeDays),
        preferredName,
        pronouns,
      });
      setEditing(false);
      await onSaved('Employment details saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save employment details');
    } finally { setSaving(false); }
  }

  const effectiveBh = emp.bankHolidayPolicy ?? COMPANY_BANK_HOLIDAY_DEFAULT;

  if (!editing) {
    const probationDays = emp.probationEndDate
      ? Math.ceil((Date.parse(emp.probationEndDate + 'T00:00:00Z') - Date.now()) / 86400000)
      : null;
    return (
      <Card title="Employment"
        action={<button onClick={() => {
          // Re-derive the days now: this card mounts before the working hours
          // have loaded, so the first guess was made without a week to
          // convert against and left the days box blank.
          setEntitlementDays(emp.entitlementWeeks != null && workingDaysPerWeek
            ? fmtDays(Number(emp.entitlementWeeks) * workingDaysPerWeek) : '');
          setEditing(true);
        }} className={btnSecondary}>Edit</button>}>
        <dl className="grid grid-cols-1 lg:grid-cols-2 gap-x-10">
          <div>
            <InfoRow label="Known as">
              {row.preferredName || <span className="text-gray-400">{row.name.split(' ')[0]}</span>}
              {row.pronouns && <span className="text-gray-500 text-sm"> ({row.pronouns})</span>}
            </InfoRow>
            <InfoRow label="Job title">{emp.jobTitle || <span className="text-gray-400">—</span>}</InfoRow>
            <InfoRow label="Department">{emp.department || <span className="text-gray-400">—</span>}</InfoRow>
            <InfoRow label="Started">{fmtDate(emp.startDate)}</InfoRow>
            {emp.status === 'left' && (
              <InfoRow label="Left">
                <Pill tone="muted">{emp.endDate ? fmtDate(emp.endDate) : 'Left'}</Pill>
              </InfoRow>
            )}
          </div>
          <div>
            <InfoRow label="Holiday allowance">
              {workingDaysPerWeek
                ? <>{fmtDays(Number(emp.entitlementWeeks ?? 5.6) * workingDaysPerWeek)} days
                    <span className="text-gray-500 text-sm"> · {emp.entitlementWeeks != null ? `${emp.entitlementWeeks} weeks` : '5.6 weeks, statutory'}</span></>
                : (emp.entitlementWeeks != null ? `${emp.entitlementWeeks} weeks` : '5.6 weeks (statutory)')}
            </InfoRow>
            <InfoRow label="Bank holidays">
              {effectiveBh === 'granted' ? 'Given on top' : 'Booked from allowance'}
              {emp.bankHolidayPolicy === null && <span className="text-gray-500 text-sm"> · company default</span>}
            </InfoRow>
            <InfoRow label="Probation">
              {emp.probationEndDate
                ? (probationDays! < 0
                    ? <Pill tone="ok">Passed {fmtDate(emp.probationEndDate)}</Pill>
                    : <>Ends {fmtDate(emp.probationEndDate)}{' '}
                        <Pill tone={probationDays! <= 30 ? 'warn' : 'muted'}>{probationDays} days</Pill></>)
                : <span className="text-gray-400">—</span>}
            </InfoRow>
            <InfoRow label="Notice period">
              {emp.noticePeriodDays != null ? `${emp.noticePeriodDays} days` : <span className="text-gray-400">—</span>}
            </InfoRow>
          </div>
        </dl>
      </Card>
    );
  }

  return (
    <Card title="Edit employment" className="border-ooosh-200"
      action={<button onClick={() => setEditing(false)} className={btnQuiet}>Cancel</button>}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Likes to be known as</span>
          <input value={preferredName} onChange={e => setPreferredName(e.target.value)}
            placeholder={row.name.split(' ')[0]}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
          <span className="block text-xs text-gray-500 mt-1">
            Used wherever their name appears. Blank uses their first name.
          </span>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Pronouns</span>
          <input value={pronouns} onChange={e => setPronouns(e.target.value)}
            placeholder="e.g. he/him"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Start date</span>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <Field label="Job title" value={jobTitle} onChange={setJobTitle} white />
        <Field label="Department" value={department} onChange={setDepartment} white />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Bank holidays</span>
          <select value={bankHolidays} onChange={e => setBankHolidays(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            <option value="">Company default — {BH_LABEL[COMPANY_BANK_HOLIDAY_DEFAULT]}</option>
            <option value="use_allowance">{BH_LABEL.use_allowance}</option>
            <option value="granted">{BH_LABEL.granted}</option>
          </select>
          <span className="block text-xs text-gray-500 mt-1">
            Leave on the default unless their contract differs.
          </span>
        </label>
        <div className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Holiday allowance</span>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <input type="number" min={0} max={365} step={0.5}
                value={entitlementDays}
                disabled={!workingDaysPerWeek}
                onChange={e => {
                  const v = e.target.value;
                  setEntitlementDays(v);
                  // Days are per-person: 5.6 weeks is 28 days on a five-day week
                  // and 22.4 on a four-day one. Convert against THIS person's
                  // week, and store weeks — see the note below.
                  setEntitlement(v === '' || !workingDaysPerWeek
                    ? '' : String(Math.round((Number(v) / workingDaysPerWeek) * 1000) / 1000));
                }}
                placeholder={workingDaysPerWeek ? fmtDays(5.6 * workingDaysPerWeek) : '—'}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100" />
              <span className="block text-[11px] text-gray-500 mt-0.5">days</span>
            </div>
            <span className="text-gray-400 pb-4">=</span>
            <div className="flex-1">
              <input type="number" min={0} max={52} step={0.1}
                value={entitlement}
                onChange={e => {
                  const v = e.target.value;
                  setEntitlement(v);
                  setEntitlementDays(v === '' || !workingDaysPerWeek
                    ? '' : fmtDays(Number(v) * workingDaysPerWeek));
                }}
                placeholder="5.6 (statutory)"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
              <span className="block text-[11px] text-gray-500 mt-0.5">weeks</span>
            </div>
          </div>
          {/* Stored in WEEKS, deliberately: if they later change to a different
              number of days a week, 5.6 weeks stays right while a fixed day
              count would quietly become wrong. */}
          <span className="block text-xs text-gray-500 mt-1">
            {workingDaysPerWeek ? (
              <>
                Type either — they convert on their {fmtDays(workingDaysPerWeek)}-day week.
                Blank = statutory ({fmtDays(5.6 * workingDaysPerWeek)} days).
              </>
            ) : (
              <>Set their working hours first.</>
            )}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Probation ends (optional)</span>
          <input type="date" value={probationEnd} onChange={e => setProbationEnd(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Notice period (days)</span>
          <input type="number" min={0} max={365} value={noticeDays}
            onChange={e => setNoticeDays(e.target.value)} placeholder="e.g. 28"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Status</span>
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            <option value="employed">Employed</option>
            <option value="left">Left</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Leaving date (if applicable)</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
      </div>
      <button onClick={() => void save()} disabled={saving} className={btnPrimary}>
        {saving ? 'Saving…' : 'Save employment details'}
      </button>
    </Card>
  );
}

function PatternHistory({ patterns }: { patterns: Pattern[] }) {
  if (patterns.length === 0) {
    return (
      <div className="text-sm text-gray-500 p-3 rounded-lg border border-dashed border-gray-300">
        No working hours set — they show as “not scheduled” every day on the calendar until there are.
      </div>
    );
  }
  const current = patterns.find(p => p.effective_to === null);
  const earlier = patterns.filter(p => p !== current);
  return (
    <div className="space-y-3">
      {current
        ? <WeekStrip pattern={current} />
        : <p className="text-sm text-amber-700">No hours in force today — the latest ended {fmtDate(patterns[0].effective_to!)}.</p>}
      {current?.notes && <p className="text-xs text-gray-500 italic">{current.notes}</p>}
      {earlier.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-ooosh-700 hover:underline select-none">
            Earlier working hours ({earlier.length})
          </summary>
          <div className="mt-3 space-y-3">
            {earlier.map(p => (
              <div key={p.id} className="p-3 rounded-lg border border-gray-200 bg-gray-50/60">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <span className="text-sm font-medium text-gray-900">
                    {fmtDate(p.effective_from)} → {p.effective_to ? fmtDate(p.effective_to) : 'ongoing'}
                  </span>
                  <span className="text-xs text-gray-600">{fmt(p.weeklyMinutes)} / week</span>
                </div>
                <WeekStrip pattern={p} compact />
                {p.notes && <div className="mt-1.5 text-xs text-gray-500 italic">{p.notes}</div>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * A pattern as seven day tiles, Monday first — a week reads at a glance where
 * the old one-line list of "Mon 09:00–17:00 (−60m) = 7h" did not. A two-week
 * cycle gets one row per week.
 */
function WeekStrip({ pattern, compact = false }: { pattern: Pattern; compact?: boolean }) {
  const weeks = pattern.cycle_weeks === 2 ? [1, 2] : [1];
  return (
    <div className="space-y-2">
      {weeks.map(w => (
        <div key={w}>
          {weeks.length > 1 && <div className="text-xs text-gray-500 mb-1">Week {w}</div>}
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((name, wd) => {
              const d = pattern.days.find(x => x.weekday === wd && (weeks.length === 1 || x.cycle_week === w));
              const on = !!d?.is_working;
              return (
                <div key={wd}
                  className={`rounded-lg border text-center ${compact ? 'px-1 py-1.5' : 'px-1 py-2.5'} ${
                    on ? (d!.at_home ? 'border-teal-200 bg-teal-50' : 'border-ooosh-200 bg-ooosh-50/60')
                       : 'border-gray-200 bg-gray-50'}`}>
                  <div className={`text-[11px] font-semibold uppercase tracking-wide ${on ? 'text-gray-700' : 'text-gray-400'}`}>
                    {name.slice(0, 3)}
                  </div>
                  {on ? (
                    <>
                      <div className={`${compact ? 'text-[11px]' : 'text-xs sm:text-[13px]'} text-gray-900 tabular-nums mt-0.5 leading-tight`}>
                        {d!.start_time?.slice(0, 5)}<span className="hidden sm:inline">–</span><br className="sm:hidden" />{d!.end_time?.slice(0, 5)}
                      </div>
                      {!compact && (
                        <div className="text-[11px] text-gray-500 mt-0.5">
                          {fmt(d!.minutes)}{d!.at_home && <span className="text-teal-700"> · ⌂</span>}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-gray-400 mt-0.5">Off</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!compact && pattern.days.some(d => d.is_working && d.break_minutes > 0) && (
        <p className="text-xs text-gray-500">
          Paid hours, after the unpaid break{
            new Set(pattern.days.filter(d => d.is_working).map(d => d.break_minutes)).size === 1
              ? ` (${pattern.days.find(d => d.is_working)!.break_minutes} min a day)` : ''}.
          {pattern.days.some(d => d.at_home) && ' ⌂ = a regular day working from home.'}
        </p>
      )}
    </div>
  );
}

function PatternEditor({ personId, seed, onSaved, onError }: {
  personId: string; seed?: Pattern;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [cycleWeeks, setCycleWeeks] = useState<1 | 2>(1);
  const [days, setDays] = useState<DraftDay[]>(() => blankDays(1));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const prefill = useCallback(() => {
    if (!seed) { setCycleWeeks(1); setDays(blankDays(1)); return; }
    const cw = seed.cycle_weeks === 2 ? 2 : 1;
    setCycleWeeks(cw);
    setDays(blankDays(cw).map(b => {
      const src = seed.days.find(d => d.weekday === b.weekday && d.cycle_week === b.cycleWeek);
      if (!src) return b;
      return {
        ...b, isWorking: src.is_working,
        startTime: src.start_time?.slice(0, 5) || '09:00',
        endTime: src.end_time?.slice(0, 5) || '17:00',
        breakMinutes: src.break_minutes,
        atHome: !!src.at_home,
      };
    }));
  }, [seed]);

  useEffect(() => { if (open) prefill(); }, [open, prefill]);

  function setCycle(n: 1 | 2) {
    setCycleWeeks(n);
    setDays(prev => blankDays(n).map(b => prev.find(p => p.weekday === b.weekday && p.cycleWeek === b.cycleWeek) ?? b));
  }
  function update(idx: number, patch: Partial<DraftDay>) {
    setDays(prev => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  const weeklyMinutes = useMemo(
    () => days.reduce((s, d) => s + Math.max(0, dayMinutes(d)), 0) / cycleWeeks, [days, cycleWeeks]);
  const workingDays = useMemo(
    () => days.filter(d => d.isWorking).length / cycleWeeks, [days, cycleWeeks]);
  const invalid = days.filter(d => d.isWorking && dayMinutes(d) <= 0);
  const entitlementMinutes = Math.round(weeklyMinutes * 5.6);
  const nominalDay = workingDays > 0 ? weeklyMinutes / workingDays : 0;

  async function save() {
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/patterns`, {
        effectiveFrom, cycleWeeks, notes: notes || null,
        days: days.map(d => ({
          weekday: d.weekday, cycleWeek: d.cycleWeek, isWorking: d.isWorking,
          startTime: d.isWorking ? d.startTime : null,
          endTime: d.isWorking ? d.endTime : null,
          breakMinutes: d.isWorking ? d.breakMinutes : 0,
          atHome: d.isWorking && !!d.atHome,
        })),
      });
      setOpen(false); setNotes('');
      await onSaved(`Working hours saved, effective ${fmtDate(effectiveFrom)}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save the working hours');
    } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={btnSecondary}>
        {seed ? 'Change working hours' : 'Set working hours'}
      </button>
    );
  }

  return (
    <div className="p-4 rounded-xl border border-ooosh-200 bg-ooosh-50/40">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold text-gray-900">{seed ? 'New working hours' : 'Working hours'}</h3>
        <button onClick={() => setOpen(false)} className={btnQuiet}>Cancel</button>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Effective from</span>
          <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Pattern repeats</span>
          <select value={cycleWeeks} onChange={e => setCycle(Number(e.target.value) as 1 | 2)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            <option value={1}>Every week</option>
            <option value={2}>Alternating 2 weeks</option>
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[12rem]">
          <span className="block text-xs text-gray-600 mb-1">Note (optional)</span>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. moved to compressed hours"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
        </label>
      </div>

      {seed && (
        <p className="text-xs text-gray-600 mb-3">
          This does not change the existing hours — it closes them the day before{' '}
          {fmtDate(effectiveFrom)} and starts a new period, so past weeks stay as they were.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-600">
              <th className="text-left font-medium py-1 pr-3">Day</th>
              <th className="text-left font-medium py-1 pr-3">Works</th>
              <th className="text-left font-medium py-1 pr-3">Start</th>
              <th className="text-left font-medium py-1 pr-3">End</th>
              <th className="text-left font-medium py-1 pr-3">Unpaid break</th>
              <th className="text-left font-medium py-1 pr-3" title="A regular agreed day working from home — still working, just not in the building">From home</th>
              <th className="text-right font-medium py-1">Paid</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => {
              const mins = dayMinutes(d);
              const bad = d.isWorking && mins <= 0;
              return (
                <tr key={`${d.cycleWeek}-${d.weekday}`} className="border-t border-gray-200">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-900">
                    {cycleWeeks === 2 && <span className="text-gray-400 text-xs">W{d.cycleWeek} </span>}
                    {WEEKDAYS[d.weekday]}
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="checkbox" checked={d.isWorking}
                      onChange={e => update(i, { isWorking: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300" />
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="time" value={d.startTime} disabled={!d.isWorking}
                      onChange={e => update(i, { startTime: e.target.value })}
                      className="px-2 py-1 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100 disabled:text-gray-400" />
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="time" value={d.endTime} disabled={!d.isWorking}
                      onChange={e => update(i, { endTime: e.target.value })}
                      className="px-2 py-1 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100 disabled:text-gray-400" />
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="number" min={0} max={480} step={5} value={d.breakMinutes} disabled={!d.isWorking}
                      onChange={e => update(i, { breakMinutes: Number(e.target.value) })}
                      className="w-20 px-2 py-1 border border-gray-300 rounded text-sm bg-white disabled:bg-gray-100 disabled:text-gray-400" />
                    <span className="text-xs text-gray-500 ml-1">min</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="checkbox" checked={d.isWorking && !!d.atHome} disabled={!d.isWorking}
                      onChange={e => update(i, { atHome: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 disabled:opacity-40" />
                  </td>
                  <td className={`py-1.5 text-right tabular-nums ${bad ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                    {d.isWorking ? (bad ? 'invalid' : fmt(mins)) : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 p-3 rounded bg-white border border-gray-200 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span><span className="text-gray-600">Weekly hours:</span>{' '}
            <span className="font-medium text-gray-900">{fmt(Math.round(weeklyMinutes))}</span></span>
          <span><span className="text-gray-600">Days per week:</span>{' '}
            <span className="font-medium text-gray-900">{workingDays}</span></span>
          <span><span className="text-gray-600">Average day:</span>{' '}
            <span className="font-medium text-gray-900">{fmt(Math.round(nominalDay))}</span></span>
        </div>
        {weeklyMinutes > 0 && (
          <div className="mt-1.5 text-xs text-gray-600">
            Statutory holiday at 5.6 weeks would be{' '}
            <span className="font-medium text-gray-900">{(entitlementMinutes / 60).toFixed(1)} hours</span>
            {nominalDay > 0 && <> — about <span className="font-medium text-gray-900">
              {(entitlementMinutes / nominalDay).toFixed(1)} of their days</span></>}.
          </div>
        )}
      </div>

      {invalid.length > 0 && (
        <div className="mt-3 p-2.5 rounded bg-red-50 border border-red-200 text-sm text-red-700">
          {invalid.length} day{invalid.length === 1 ? ' has' : 's have'} an end time at or before the start
          (or a break longer than the shift). Fix before saving.
        </div>
      )}

      <button onClick={() => void save()} disabled={saving || invalid.length > 0 || weeklyMinutes <= 0}
        className={`mt-3 ${btnPrimary}`}>
        {saving ? 'Saving…' : 'Save working hours'}
      </button>
    </div>
  );
}

// ── Adding people ───────────────────────────────────────────────────────────

function Field({ label, value, onChange, type = 'text', white = false }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; white?: boolean;
}) {
  return (
    <label className="text-sm">
      <span className="block text-xs text-gray-600 mb-1">{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 border border-gray-300 rounded text-sm ${white ? 'bg-white' : ''}`} />
    </label>
  );
}

/** Turn an existing person into an employee (they may or may not have a login). */
function AddEmployee({ existing, onAdded, onError }: {
  existing: string[]; onAdded: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PersonSearchRow[]>([]);
  const [picked, setPicked] = useState<PersonSearchRow | null>(null);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PersonSearchRow[] }>(
          `/people?search=${encodeURIComponent(search.trim())}&limit=10`);
        if (!cancelled) setResults(res.data.filter(p => !existing.includes(p.id)));
      } catch { /* best-effort */ }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, existing]);

  async function save() {
    if (!picked) return;
    setSaving(true);
    try {
      await api.put(`/staff-calendar/employees/${picked.id}`, {
        startDate, jobTitle: jobTitle || null, department: department || null,
      });
      const name = `${picked.first_name} ${picked.last_name}`;
      setPicked(null); setSearch(''); setJobTitle(''); setDepartment(''); setOpen(false);
      await onAdded(`${name} added as an employee. Set their working hours next.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add the employee');
    } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">
        + Add employee
      </button>
    );
  }

  return (
    <div className="w-full p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-gray-900">Add an employee</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
      {picked ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-gray-900">{picked.first_name} {picked.last_name}</span>
            <button onClick={() => setPicked(null)} className="text-xs text-ooosh-600 hover:underline">change</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Start date</span>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </label>
            <Field label="Job title" value={jobTitle} onChange={setJobTitle} />
            <Field label="Department" value={department} onChange={setDepartment} />
          </div>
          <button onClick={() => void save()} disabled={saving}
            className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Adding…' : 'Add employee'}
          </button>
        </div>
      ) : (
        <div>
          <input value={search} onChange={e => setSearch(e.target.value)} autoFocus
            placeholder="Search people by name…"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm" />
          {results.length > 0 && (
            <ul className="mt-2 border border-gray-200 rounded divide-y divide-gray-100 max-h-56 overflow-y-auto">
              {results.map(p => (
                <li key={p.id}>
                  <button onClick={() => setPicked(p)} className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50">
                    <span className="text-gray-900">{p.first_name} {p.last_name}</span>
                    {p.email && <span className="text-gray-500 ml-2 text-xs">{p.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {search.trim().length >= 2 && results.length === 0 && (
            <p className="mt-2 text-xs text-gray-500">
              No matches (existing employees are hidden). People are added in the address book first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Create a login. Same call the old Settings form made. */
function AddUser({ onAdded, onError }: {
  onAdded: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('staff');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (password.length < 8) { onError('Password must be at least 8 characters.'); return; }
    setSaving(true);
    try {
      await api.post('/auth/register', {
        first_name: first.trim(), last_name: last.trim(),
        email: email.trim().toLowerCase(), password, role,
      });
      const name = `${first} ${last}`;
      setFirst(''); setLast(''); setEmail(''); setPassword(''); setRole('staff'); setOpen(false);
      await onAdded(`${name} added as ${ROLE_LABELS[role] || role}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create the login');
    } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-3 py-2 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50">
        + Add login
      </button>
    );
  }

  return (
    <div className="w-full p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-medium text-gray-900">Add a login</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Creates an OP account. It does not make someone an employee — use “Add employee”
        for working hours and holiday.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Field label="First name" value={first} onChange={setFirst} />
        <Field label="Last name" value={last} onChange={setLast} />
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password (min 8 characters)" value={password} onChange={setPassword} type="password" />
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Role</span>
          <select value={role} onChange={e => setRole(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
            {/* 'freelancer' stays in ROLE_LABELS to label the old seed row, but it is no
                longer a login the backend will create — freelancers use the portal. */}
            {Object.entries(ROLE_LABELS).filter(([v]) => v !== 'freelancer').map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <button onClick={() => void save()} disabled={saving || !first || !last || !email || !password}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Creating…' : 'Create login'}
      </button>
    </div>
  );
}


/**
 * An employee with no login — and the fix for it.
 *
 * This is worth surfacing loudly because it breaks My Time completely and
 * silently: hours, holiday and overtime all hang off the staff record, so if
 * someone's login points at a DIFFERENT `people` row (easily done by picking
 * the wrong duplicate when adding them), their balances read zero and every
 * request is refused with no explanation.
 *
 * Linking moves `users.person_id`, which is the one column that decides whose
 * staff record a login sees. The reverse — moving employment, patterns and
 * ledger onto the login's person — is impossible: the ledger is append-only
 * and refuses UPDATE by design.
 */
function NoLogin({ row, isAdmin, onSaved, onError }: {
  row: RosterRow; isAdmin: boolean;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [candidates, setCandidates] = useState<
    { user_id: string; email: string; role: string; name: string }[]>([]);
  const [chosen, setChosen] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!linking || candidates.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: typeof candidates }>('/staff-calendar/unlinked-logins');
        if (!cancelled) setCandidates(res.data);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Failed to load logins');
      }
    })();
    return () => { cancelled = true; };
  }, [linking, candidates.length, onError]);

  async function link() {
    if (!chosen) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${row.personId}/link-login`, { userId: chosen });
      setLinking(false);
      await onSaved(`Login linked to ${row.name}. Their My Time page will work now.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to link the login');
    } finally { setSaving(false); }
  }

  return (
    <div className="p-3 rounded border border-amber-200 bg-amber-50">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-sm text-amber-900">
          <strong className="block">No login linked to this staff record.</strong>
          They show on the calendar and in reports, but cannot see their own balances
          or book anything — My Time will read zero for them.
        </div>
        {isAdmin && !linking && (
          <button onClick={() => setLinking(true)}
            className="text-xs text-ooosh-700 underline shrink-0">Link a login</button>
        )}
      </div>

      {linking && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Login to point at this record</span>
            <select value={chosen} onChange={e => setChosen(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white min-w-[16rem]">
              <option value="">Choose a login…</option>
              {candidates.map(c => (
                <option key={c.user_id} value={c.user_id}>{c.name} — {c.email}</option>
              ))}
            </select>
          </label>
          <button onClick={() => void link()} disabled={saving || !chosen}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Linking…' : 'Link'}
          </button>
          <button onClick={() => setLinking(false)}
            className="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {candidates.length === 0 && (
            <span className="text-xs text-gray-500 pb-2">
              No unlinked logins — every active login already has a staff record.
            </span>
          )}
          <p className="w-full text-xs text-gray-600 mt-1">
            Only shows logins that have no staff record of their own. The person record that
            login used to point at stays in the address book with its history.
          </p>
        </div>
      )}
    </div>
  );
}
