import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import StaffBalancePanel from '../components/StaffBalancePanel';

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
  email: string | null;
  avatarUrl: string | null;
  account: { role: string; isActive: boolean; hhUserId: number | null } | null;
  employment: {
    status: string; startDate: string; endDate: string | null;
    jobTitle: string | null; department: string | null;
    bankHolidayPolicy: 'use_allowance' | 'granted' | null;
    entitlementWeeks: string | null;
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
}
interface Pattern {
  id: string; effective_from: string; effective_to: string | null;
  cycle_weeks: number; notes: string | null; days: PatternDay[]; weeklyMinutes: number;
}
interface PersonSearchRow { id: string; first_name: string; last_name: string; email: string | null }
interface DraftDay {
  weekday: number; cycleWeek: number; isWorking: boolean;
  startTime: string; endTime: string; breakMinutes: number;
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
  const [openId, setOpenId] = useState<string | null>(null);
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

  const announce = useCallback(async (msg: string) => {
    setNotice(msg);
    setError(null);
    await load();
  }, [load]);

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

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-semibold text-gray-900">Staff</h1>
        <Link to="/staff/calendar" className="text-sm text-ooosh-600 hover:underline">View calendar →</Link>
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

      {loading ? (
        <div className="text-sm text-gray-500 py-6">Loading…</div>
      ) : (
        <>
          <Group title="Employees" count={employees.length}
            empty={isAdmin ? 'Nobody set up as an employee yet.' : undefined}>
            {employees.map(r => (
              <PersonCard key={r.personId} row={r} isAdmin={isAdmin}
                open={openId === r.personId}
                onToggle={() => setOpenId(openId === r.personId ? null : r.personId)}
                onSaved={announce} onError={setError} />
            ))}
          </Group>

          {others.length > 0 && (
            <Group
              title="Other accounts"
              count={others.length}
              hint="Logins that aren't employees — service accounts, test logins, freelancer access."
            >
              {others.map(r => (
                <PersonCard key={r.personId} row={r} isAdmin={isAdmin}
                  open={openId === r.personId}
                  onToggle={() => setOpenId(openId === r.personId ? null : r.personId)}
                  onSaved={announce} onError={setError} />
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({ title, count, hint, empty, children }: {
  title: string; count: number; hint?: string; empty?: string; children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-gray-500">{count}</span>
      </div>
      {hint && <p className="text-xs text-gray-500 mb-2">{hint}</p>}
      {count === 0 && empty ? (
        <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">{empty}</div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

// ── One person ──────────────────────────────────────────────────────────────

function PersonCard({ row, isAdmin, open, onToggle, onSaved, onError }: {
  row: RosterRow; isAdmin: boolean; open: boolean; onToggle: () => void;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const left = row.employment?.status === 'left';
  return (
    <div className={`rounded-lg border bg-white ${left ? 'border-gray-200 opacity-70' : 'border-gray-200'}`}>
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900">{row.preferredName || row.name}</span>
            {row.account ? (
              <span className={`text-[11px] px-1.5 py-0.5 rounded ${ROLE_COLOURS[row.account.role] || 'bg-gray-100 text-gray-700'}`}>
                {ROLE_LABELS[row.account.role] || row.account.role}
              </span>
            ) : (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">No login</span>
            )}
            {row.account && !row.account.isActive && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">Inactive</span>
            )}
            {left && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">Left</span>}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {row.email || 'no email'}
            {isAdmin && row.employment && (
              <>
                {' · '}
                {row.hasPattern
                  ? `${fmt(row.weeklyMinutes ?? 0)}/week`
                  : <span className="text-amber-700">no working hours set</span>}
              </>
            )}
            {isAdmin && row.cotCard?.last4 && ` · card ${row.cotCard.last4}`}
          </div>
        </div>
        <span className="text-gray-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4 space-y-5">
          <AccountSection row={row} isAdmin={isAdmin} onSaved={onSaved} onError={onError} />
          {isAdmin && <CotCardSection row={row} onSaved={onSaved} onError={onError} />}
          {isAdmin && (
            row.employment
              ? <EmploymentSection row={row} onSaved={onSaved} onError={onError} />
              : <NotAnEmployee />
          )}
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
    return (
      <div className="p-3 rounded border border-dashed border-gray-300 text-sm text-gray-500">
        No login. They appear on the calendar and in reports, but cannot sign in to OP.
      </div>
    );
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
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-900">Login &amp; role</h3>
          <div className="flex items-center gap-3 text-xs">
            <button onClick={() => setEditing(true)} className="text-ooosh-600 hover:underline">Edit</button>
            {isAdmin && <button onClick={() => void resetPassword()} className="text-ooosh-600 hover:underline">Reset password</button>}
            {row.account.isActive
              ? <button onClick={() => void deactivate()} className="text-red-600 hover:underline">Deactivate</button>
              : <button onClick={() => void reactivate()} className="text-emerald-700 hover:underline">Reactivate</button>}
          </div>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          <div><dt className="text-xs text-gray-500">Email</dt><dd className="text-gray-900 truncate">{row.email || '—'}</dd></div>
          <div><dt className="text-xs text-gray-500">Role</dt><dd className="text-gray-900">{ROLE_LABELS[row.account.role] || row.account.role}</dd></div>
          <div><dt className="text-xs text-gray-500">HireHop user ID</dt><dd className="text-gray-900">{row.account.hhUserId ?? '—'}</dd></div>
          <div><dt className="text-xs text-gray-500">Status</dt><dd className="text-gray-900">{row.account.isActive ? 'Active' : 'Inactive'}</dd></div>
        </dl>
      </div>
    );
  }

  return (
    <div className="p-3 rounded border border-ooosh-200 bg-ooosh-50/40">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900">Login &amp; role</h3>
        <button onClick={() => setEditing(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
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
      <button onClick={() => void save()} disabled={saving}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save account'}
      </button>
    </div>
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
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">Company card</h3>
      <p className="text-xs text-gray-500 mb-2">
        The cost-capture form stamps the holder and last 4 from here — staff never type card details.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Card agreement</span>
          <span className={`inline-block px-2 py-1 rounded text-xs ${
            row.cotCard?.agreementCompletedAt ? 'bg-emerald-100 text-emerald-800'
              : row.cotCard?.agreementStatus ? 'bg-amber-100 text-amber-800'
              : 'bg-gray-100 text-gray-500'}`}>
            {row.cotCard?.agreementCompletedAt
              ? `Signed ${new Date(row.cotCard.agreementCompletedAt).toLocaleDateString('en-GB')}`
              : row.cotCard?.agreementStatus ? 'Outstanding' : 'Not assigned'}
          </span>
        </div>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Last 4</span>
          <input value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="1234" inputMode="numeric"
            className="w-24 px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Label</span>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. COT"
            className="w-40 px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
        <button onClick={() => void save()} disabled={saving || !dirty}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save card'}
        </button>
      </div>
    </div>
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

  return (
    <div className="space-y-4">
      <EmploymentDetails row={row} onSaved={onSaved} onError={onError} />
      <StaffBalancePanel personId={row.personId} canManage year={new Date().getFullYear()} />
      {!loaded ? (
        <div className="text-sm text-gray-500">Loading hours…</div>
      ) : (
        <>
          <PatternHistory patterns={patterns} />
          <PatternEditor personId={row.personId} seed={current}
            onSaved={async (msg) => { await load(); await onSaved(msg); }} onError={onError} />
        </>
      )}
    </div>
  );
}

function EmploymentDetails({ row, onSaved, onError }: {
  row: RosterRow; onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const emp = row.employment!;
  const [editing, setEditing] = useState(false);
  const [startDate, setStartDate] = useState(emp.startDate);
  const [endDate, setEndDate] = useState(emp.endDate ?? '');
  const [status, setStatus] = useState(emp.status);
  const [jobTitle, setJobTitle] = useState(emp.jobTitle ?? '');
  const [department, setDepartment] = useState(emp.department ?? '');
  const [bankHolidays, setBankHolidays] = useState<string>(emp.bankHolidayPolicy ?? '');
  const [entitlement, setEntitlement] = useState(emp.entitlementWeeks ?? '');
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
      });
      setEditing(false);
      await onSaved('Employment details saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save employment details');
    } finally { setSaving(false); }
  }

  const effectiveBh = emp.bankHolidayPolicy ?? COMPANY_BANK_HOLIDAY_DEFAULT;

  if (!editing) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-900">Employment</h3>
          <button onClick={() => setEditing(true)} className="text-xs text-ooosh-600 hover:underline">Edit</button>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          <div><dt className="text-xs text-gray-500">Started</dt><dd className="text-gray-900">{fmtDate(emp.startDate)}</dd></div>
          <div><dt className="text-xs text-gray-500">Job title</dt><dd className="text-gray-900">{emp.jobTitle || '—'}</dd></div>
          <div><dt className="text-xs text-gray-500">Department</dt><dd className="text-gray-900">{emp.department || '—'}</dd></div>
          <div>
            <dt className="text-xs text-gray-500">Holiday allowance</dt>
            <dd className="text-gray-900">{emp.entitlementWeeks != null ? `${emp.entitlementWeeks} weeks` : '5.6 weeks (statutory)'}</dd>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-xs text-gray-500">Bank holidays</dt>
            <dd className="text-gray-900">
              {BH_LABEL[effectiveBh]}
              {emp.bankHolidayPolicy === null && <span className="text-xs text-gray-500"> (company default)</span>}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="p-3 rounded border border-ooosh-200 bg-ooosh-50/40">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900">Employment</h3>
        <button onClick={() => setEditing(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
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
            Leave on the default unless this person&apos;s contract differs — then a future
            policy change follows them automatically.
          </span>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Holiday allowance (weeks)</span>
          <input type="number" min={0} max={52} step={0.1} value={entitlement}
            onChange={e => setEntitlement(e.target.value)} placeholder="5.6 (statutory)"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
          <span className="block text-xs text-gray-500 mt-1">
            Blank uses the statutory 5.6 weeks, applied to their own contracted hours — so
            part-timers pro-rata without anyone calculating anything.
          </span>
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
      <button onClick={() => void save()} disabled={saving}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save employment details'}
      </button>
    </div>
  );
}

function PatternHistory({ patterns }: { patterns: Pattern[] }) {
  if (patterns.length === 0) {
    return (
      <div className="text-sm text-gray-500 p-3 rounded border border-dashed border-gray-300">
        No working hours set — they show as “not scheduled” every day on the calendar until there are.
      </div>
    );
  }
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-2">Working hours history</h3>
      <div className="space-y-2">
        {patterns.map(p => {
          const working = p.days.filter(d => d.is_working);
          return (
            <div key={p.id} className="p-3 rounded border border-gray-200 bg-gray-50/60">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1.5">
                <span className="text-sm font-medium text-gray-900">
                  {fmtDate(p.effective_from)} → {p.effective_to ? fmtDate(p.effective_to) : 'ongoing'}
                  {p.effective_to === null && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Current</span>
                  )}
                </span>
                <span className="text-xs text-gray-600">
                  {fmt(p.weeklyMinutes)} / week · {working.length} day{working.length === 1 ? '' : 's'}
                  {p.cycle_weeks === 2 && ' · 2-week cycle'}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                {working.map((d, i) => (
                  <span key={i}>
                    {p.cycle_weeks === 2 && <span className="text-gray-400">W{d.cycle_week} </span>}
                    <span className="text-gray-900">{WEEKDAYS[d.weekday].slice(0, 3)}</span>{' '}
                    {d.start_time?.slice(0, 5)}–{d.end_time?.slice(0, 5)}
                    {d.break_minutes > 0 && <span className="text-gray-400"> (−{d.break_minutes}m)</span>}
                    {' = '}{fmt(d.minutes)}
                  </span>
                ))}
              </div>
              {p.notes && <div className="mt-1.5 text-xs text-gray-500 italic">{p.notes}</div>}
            </div>
          );
        })}
      </div>
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
      <button onClick={() => setOpen(true)}
        className="px-3 py-2 text-sm rounded border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50">
        {seed ? 'Change working hours' : 'Set working hours'}
      </button>
    );
  }

  return (
    <div className="p-4 rounded border border-ooosh-200 bg-ooosh-50/40">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900">{seed ? 'New working hours' : 'Working hours'}</h3>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
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
            {' '}Entitlement is granted in Phase B; this is a preview.
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
        className="mt-3 px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
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
            {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
