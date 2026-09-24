import { useState, useEffect, useCallback } from 'react';
import { hasManagerRole } from '../lib/roles';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { Navigate, Link } from 'react-router-dom';
import XeroBankAccountsSection from '../components/XeroBankAccountsSection';
import { compressImage } from '../modules/vehicles/lib/image-utils';
import { DOC_TYPES as STAFF_DOC_TYPES } from '../components/StaffRecordFiles';

interface TeamUser {
  id: string;
  email: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url?: string | null;
  hh_user_id?: number | null;
}

interface BackupEntry {
  key: string;
  filename: string;
  size: number;
  sizeMB: string;
  created_at: string;
}

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);

  if (!hasManagerRole(user?.role)) {
    return <Navigate to="/" replace />;
  }

  return <SettingsContent />;
}

// Team-member management moved to the Staff page (Sep 2026). What remains here
// is platform configuration only; each section below loads its own data.
function SettingsContent() {
  const currentUser = useAuthStore((s) => s.user);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage user accounts and platform settings</p>
        </div>
      </div>

      {/* Team members, logins and company cards moved to the Staff page (Sep 2026).
          They are facts about a person who works here, not platform configuration
          — see docs/STAFF-CALENDAR-SPEC.md §10. Pointer left so nobody hunts. */}
      <div className="mb-8 p-4 rounded-lg border border-gray-200 bg-white">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Team members</h2>
        <p className="text-sm text-gray-600">
          Logins, roles, company cards and working hours now live on the{' '}
          <Link to="/staff/admin" className="text-ooosh-600 hover:underline font-medium">Staff page</Link>
          {' '}— everyone who works here in one place, alongside the staff calendar.
        </p>
      </div>

      {/* Calculator Settings — admin & manager */}
      <CostingSettingsSection />

      {/* Out-of-Hours return settings — admin & manager */}
      <OohSettingsSection />

      <CarnetSettingsSection />

      {/* Studio-sitter lock-up report template — admin & manager */}
      <StudioSitterSettingsSection />

      {/* Auto-chase draft voice — admin & manager */}
      <ChaseVoiceSettingsSection />

      {/* Auto-chase manager mailboxes — admin only (which inboxes we ingest) */}
      {currentUser?.role === 'admin' && <ManagerMailboxesSection />}

      {/* Xero bank account mapping — admin & manager */}
      <XeroBankAccountsSection />

      {/* Vehicle Issues settings — admin & manager */}
      <VehicleIssueSettingsSection />

      {/* Staff time thresholds & bank holidays — admin & manager */}
      <StaffTimeSettingsSection />

      {/* Links sent to a freelancer the moment they're approved — admin & manager */}
      <FreelancerLinksSection />

      {/* Email Service section — admin only */}
      {currentUser?.role === 'admin' && <EmailSection />}

      {/* HireHop Sync section — admin only */}
      {currentUser?.role === 'admin' && <HireHopSection />}

      {/* Database Backups section — admin only */}
      {currentUser?.role === 'admin' && <BackupsSection />}
    </div>
  );
}

interface SyncResult {
  orgsCreated: number;
  orgsUpdated: number;
  peopleCreated: number;
  peopleUpdated: number;
  rolesCreated: number;
  venuesCreated: number;
  errors: string[];
  total: number;
}

interface SyncPreview {
  totalContacts: number;
  totalCompanies: number;
  alreadyMapped: { people: number; organisations: number };
  newPeople: number;
  newOrganisations: number;
  sample: Array<{ name: string; company: string; email: string }>;
}

function EmailSection() {
  const [status, setStatus] = useState<{ configured: boolean; mode: string; templates: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const data = await api.get<{ configured: boolean; mode: string; templates: string[] }>('/email/status');
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  async function toggleMode() {
    if (!status) return;
    const newMode = status.mode === 'test' ? 'live' : 'test';
    const confirmMsg = newMode === 'live'
      ? 'Switch to LIVE mode? Emails will be sent to real recipients.'
      : 'Switch to TEST mode? All emails will be redirected to the test address.';
    if (!confirm(confirmMsg)) return;

    setToggling(true);
    setError('');
    setMessage('');
    try {
      await api.put('/email/mode', { mode: newMode });
      setStatus({ ...status, mode: newMode });
      setMessage(`Email mode changed to ${newMode.toUpperCase()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change mode');
    } finally {
      setToggling(false);
    }
  }

  async function sendTestEmail() {
    setTesting(true);
    setError('');
    setMessage('');
    try {
      await api.post('/email/test', {});
      setMessage('Test email sent successfully. Check your inbox.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send test email');
    } finally {
      setTesting(false);
    }
  }

  if (loading) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Email Service</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Transactional email via Google Workspace SMTP.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status?.configured && (
            <>
              <button
                onClick={sendTestEmail}
                disabled={testing}
                className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {testing ? 'Sending...' : 'Send Test'}
              </button>
              <button
                onClick={toggleMode}
                disabled={toggling}
                className={`px-4 py-2 text-sm rounded font-medium transition-colors disabled:opacity-50 ${
                  status.mode === 'live'
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-amber-500 text-white hover:bg-amber-600'
                }`}
              >
                {toggling ? 'Switching...' : status.mode === 'live' ? 'LIVE' : 'TEST MODE'}
              </button>
            </>
          )}
        </div>
      </div>

      {message && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {message}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {!status?.configured ? (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-lg text-sm">
          SMTP not configured. Add <code className="bg-amber-100 px-1 rounded">SMTP_USER</code> and <code className="bg-amber-100 px-1 rounded">SMTP_PASS</code> to the server .env file.
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Status</p>
              <p className="text-sm font-medium text-green-600">Connected</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Mode</p>
              <p className={`text-sm font-medium ${status.mode === 'live' ? 'text-green-600' : 'text-amber-600'}`}>
                {status.mode === 'live' ? 'Live — sending to real recipients' : 'Test — all emails redirected'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Templates</p>
              <p className="text-sm font-medium text-gray-900">{status.templates.length} registered</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HireHopSection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    try {
      const data = await api.get<{ configured: boolean }>('/hirehop/status');
      setConfigured(data.configured);
    } catch {
      setConfigured(false);
    }
  }

  async function loadPreview() {
    setPreviewing(true);
    setError('');
    try {
      const data = await api.get<SyncPreview>('/hirehop/preview');
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function runSync() {
    if (!confirm('This will import contacts from HireHop. Existing records will be updated. Continue?')) return;
    setSyncing(true);
    setError('');
    setResult(null);
    try {
      const data = await api.post<SyncResult>('/hirehop/sync', {});
      setResult(data);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">HireHop Integration</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Sync contacts between HireHop and Ooosh.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {configured && !syncing && (
            <button
              onClick={loadPreview}
              disabled={previewing}
              className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {previewing ? 'Loading...' : 'Preview Sync'}
            </button>
          )}
          {configured && preview && (
            <button
              onClick={runSync}
              disabled={syncing}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
        </div>
      </div>

      {configured === false && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-lg text-sm">
          HireHop API token not configured. Add <code className="bg-amber-100 px-1 rounded">HIREHOP_API_TOKEN</code> to the server .env file.
        </div>
      )}

      {configured === true && !preview && !result && !error && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-500">
            Click "Preview Sync" to see what will be imported from HireHop before running the sync.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {preview && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Sync Preview</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-900">{preview.totalContacts}</div>
              <div className="text-xs text-gray-500">HireHop Contacts</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-900">{preview.totalCompanies}</div>
              <div className="text-xs text-gray-500">Companies</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{preview.newPeople}</div>
              <div className="text-xs text-gray-500">New People</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{preview.newOrganisations}</div>
              <div className="text-xs text-gray-500">New Organisations</div>
            </div>
          </div>

          {preview.alreadyMapped.people > 0 && (
            <p className="text-xs text-gray-500 mb-3">
              Already synced: {preview.alreadyMapped.people} people, {preview.alreadyMapped.organisations} organisations (will be updated)
            </p>
          )}

          {preview.sample.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Sample contacts:</p>
              <div className="space-y-1">
                {preview.sample.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs text-gray-600 bg-gray-50 px-3 py-1.5 rounded">
                    <span className="font-medium text-gray-800">{s.name || '(no name)'}</span>
                    <span className="text-gray-400">@</span>
                    <span>{s.company || '(no company)'}</span>
                    {s.email && <span className="text-gray-400 ml-auto">{s.email}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-green-700 mb-3">Sync Complete</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
            <Stat label="People Created" value={result.peopleCreated} color="text-green-600" />
            <Stat label="People Updated" value={result.peopleUpdated} color="text-blue-600" />
            <Stat label="Orgs Created" value={result.orgsCreated} color="text-green-600" />
            <Stat label="Orgs Updated" value={result.orgsUpdated} color="text-blue-600" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Stat label="Roles Linked" value={result.rolesCreated} color="text-purple-600" />
            <Stat label="Venues Created" value={result.venuesCreated} color="text-amber-600" />
            <Stat label="Total Processed" value={result.total} color="text-gray-600" />
          </div>
          {result.errors.length > 0 && (
            <div className="mt-3 bg-red-50 rounded p-3">
              <p className="text-xs font-medium text-red-700 mb-1">{result.errors.length} error(s):</p>
              <div className="text-xs text-red-600 max-h-32 overflow-y-auto space-y-1">
                {result.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

// ── Calculator / Costing Settings ─────────────────────────────────────────

interface SettingRow {
  key: string;
  value: number;
  label: string;
  unit: string;
}

const UNIT_LABELS: Record<string, string> = {
  per_hour: '/hr',
  per_day: '/day',
  per_litre: '/L',
  minutes: 'mins',
  percent: '%',
  currency: '£',
  hours: 'hrs',
  ratio: 'x',
};

const SETTING_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: 'Freelancer Rates',
    keys: ['freelancer_hourly_day', 'freelancer_hourly_night', 'driver_day_rate'],
  },
  {
    title: 'Client Rates',
    keys: ['client_hourly_day', 'client_hourly_night', 'day_rate_client_markup'],
  },
  {
    title: 'Fuel & Transport',
    keys: ['fuel_price_per_litre', 'fuel_efficiency_mpg'],
  },
  {
    title: 'Timing',
    keys: ['handover_time_mins', 'unload_time_mins', 'min_hours_threshold'],
  },
  {
    title: 'Costs & Markup',
    keys: ['admin_cost_per_hour', 'expense_markup_percent', 'expense_variance_threshold', 'min_client_charge_floor'],
  },
];

function CostingSettingsSection() {
  const [settings, setSettings] = useState<Record<string, SettingRow>>({});
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const data = await api.get<{ data: Record<string, { value: number; label: string; unit: string }> }>('/quotes/settings');
      const rows: Record<string, SettingRow> = {};
      const vals: Record<string, string> = {};
      for (const [key, info] of Object.entries(data.data)) {
        rows[key] = { key, value: info.value, label: info.label, unit: info.unit };
        vals[key] = String(info.value);
      }
      setSettings(rows);
      setEditValues(vals);
    } catch (err) {
      console.error('Failed to load costing settings:', err);
      setError('Could not load calculator settings.');
    } finally {
      setLoading(false);
    }
  }

  function handleEdit(key: string, val: string) {
    setEditValues((prev) => ({ ...prev, [key]: val }));
  }

  function hasChanges(): boolean {
    return Object.keys(settings).some(
      (key) => String(settings[key].value) !== editValues[key]
    );
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const changed: Record<string, number> = {};
      for (const [key, row] of Object.entries(settings)) {
        const newVal = parseFloat(editValues[key]);
        if (!isNaN(newVal) && newVal !== row.value) {
          changed[key] = newVal;
        }
      }
      if (Object.keys(changed).length === 0) {
        setEditing(false);
        return;
      }
      await api.put('/quotes/settings', { settings: changed });
      setSuccess('Settings updated.');
      setEditing(false);
      loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    // Reset edit values
    const vals: Record<string, string> = {};
    for (const [key, row] of Object.entries(settings)) {
      vals[key] = String(row.value);
    }
    setEditValues(vals);
    setEditing(false);
    setError('');
  }

  if (loading) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Calculator Settings</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Rates and defaults used by the transport/crew calculator.
          </p>
        </div>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 transition-colors"
          >
            Edit Rates
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges()}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {SETTING_GROUPS.map((group) => (
          <div key={group.title} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">{group.title}</h3>
            <div className="space-y-3">
              {group.keys.map((key) => {
                const row = settings[key];
                if (!row) return null;
                const unitLabel = UNIT_LABELS[row.unit] || row.unit;
                return (
                  <div key={key}>
                    <label className="block text-xs text-gray-500 mb-1">{row.label}</label>
                    <div className="flex items-center gap-2">
                      {row.unit === 'currency' || row.unit === 'per_hour' || row.unit === 'per_day' || row.unit === 'per_litre' ? (
                        <span className="text-sm text-gray-400">£</span>
                      ) : null}
                      {editing ? (
                        <input
                          type="number"
                          value={editValues[key] || ''}
                          onChange={(e) => handleEdit(key, e.target.value)}
                          step="0.01"
                          min="0"
                          className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                        />
                      ) : (
                        <span className="text-sm font-medium text-gray-900">
                          {row.value}
                        </span>
                      )}
                      <span className="text-xs text-gray-400 whitespace-nowrap">{unitLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Out-of-Hours Return Settings ─────────────────────────────────────────

interface SystemSetting {
  key: string;
  value: string | null;
  label: string | null;
  category: string | null;
  value_type: string | null;
  sort_order: number;
}

function CarnetSettingsSection() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sigSrc, setSigSrc] = useState<string | null>(null);

  const TEXT_KEYS = ['carnet_ooosh_signatory_name', 'carnet_ooosh_signatory_role', 'carnet_company_address'];

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=carnets');
      setSettings(res.data);
      const v: Record<string, string> = {};
      for (const s of res.data) v[s.key] = s.value ?? '';
      setVals(v);
      const sigKey = res.data.find(s => s.key === 'carnet_ooosh_signature_url')?.value;
      if (sigKey) {
        try {
          const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(sigKey)}`);
          setSigSrc(URL.createObjectURL(blob));
        } catch { setSigSrc(null); }
      } else setSigSrc(null);
    } catch {
      setError('Could not load carnet settings (has migration 141 run?).');
    } finally { setLoading(false); }
  }

  async function saveText() {
    setSaving(true); setError(''); setSuccess('');
    try {
      const changed: Record<string, string | null> = {};
      for (const k of TEXT_KEYS) {
        const orig = settings.find(s => s.key === k)?.value ?? '';
        if (orig !== (vals[k] ?? '')) changed[k] = vals[k] === '' ? null : vals[k];
      }
      if (Object.keys(changed).length > 0) { await api.put('/system-settings', { settings: changed }); setSuccess('Saved.'); }
      load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  async function uploadSignature(file: File) {
    setUploading(true); setError(''); setSuccess('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
      await api.put('/system-settings', { settings: { carnet_ooosh_signature_url: up.r2_key } });
      setSuccess('Signature uploaded.');
      load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed'); }
    finally { setUploading(false); }
  }

  if (loading) return null;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Carnet — Letter of Authorisation</h2>
      <p className="text-sm text-gray-500 mb-4">The Ooosh signatory + signature stamped onto the carnet Letter of Authorisation.</p>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {success && <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{success}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="text-gray-500 text-xs">Signatory name</span>
          <input className="mt-1 w-full border rounded px-2 py-1" value={vals.carnet_ooosh_signatory_name || ''} onChange={(e) => setVals({ ...vals, carnet_ooosh_signatory_name: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="text-gray-500 text-xs">Signatory role / designation</span>
          <input className="mt-1 w-full border rounded px-2 py-1" value={vals.carnet_ooosh_signatory_role || ''} onChange={(e) => setVals({ ...vals, carnet_ooosh_signatory_role: e.target.value })} />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-gray-500 text-xs">Company address (letter header — comma separated)</span>
          <input className="mt-1 w-full border rounded px-2 py-1" value={vals.carnet_company_address || ''} onChange={(e) => setVals({ ...vals, carnet_company_address: e.target.value })} />
        </label>
      </div>
      <button onClick={saveText} disabled={saving} className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm disabled:opacity-50 mb-5">
        {saving ? 'Saving…' : 'Save details'}
      </button>

      <div className="border-t pt-4">
        <span className="text-gray-500 text-xs">Signature image</span>
        <div className="flex items-center gap-4 mt-2">
          {sigSrc
            ? <img src={sigSrc} alt="Ooosh signature" className="h-16 border rounded bg-white object-contain px-2" />
            : <span className="text-sm text-gray-400">No signature uploaded yet</span>}
          <label className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded text-sm cursor-pointer">
            {uploading ? 'Uploading…' : sigSrc ? 'Replace' : 'Upload signature'}
            <input type="file" accept="image/png,image/jpeg" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSignature(f); }} />
          </label>
        </div>
        <p className="text-xs text-gray-400 mt-2">PNG or JPG. A transparent-background PNG looks best on the letter.</p>
      </div>
    </div>
  );
}

// ── Studio-sitter lock-up report template ────────────────────────────────────

interface LockupRef { text?: string; photos: string[]; }
interface LockupTemplateItem {
  id: string;
  label: string;
  type: 'yesno' | 'text' | 'number';
  section?: string;
  expected?: string;
  end_of_booking_only?: boolean;
  reference?: LockupRef;
  note_prompt?: string;
}
interface LockupTemplateShape {
  version: number;
  intro?: string;
  items: LockupTemplateItem[];
  notes_label?: string;
  lost_property_prompt?: string;
}

function slugId(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return base || `item_${Math.random().toString(36).slice(2, 7)}`;
}

// Reference-photo preview: external URLs render directly, R2 keys via auth blob.
function RefPhotoPreview({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(url.startsWith('files/') ? null : url);
  useEffect(() => {
    let revoke: string | null = null;
    if (url.startsWith('files/')) {
      api.blob(`/files/download?key=${encodeURIComponent(url)}`)
        .then(({ blob }) => { const o = URL.createObjectURL(blob); revoke = o; setSrc(o); })
        .catch(() => setSrc(null));
    }
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [url]);
  if (!src) return <div className="w-full h-16 bg-gray-100 rounded flex items-center justify-center text-[10px] text-gray-400">preview…</div>;
  return <img src={src} alt="reference" className="w-full h-16 object-cover rounded border border-gray-200" />;
}

function StudioSitterSettingsSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tpl, setTpl] = useState<LockupTemplateShape | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=studio_sitter');
      const rawTpl = res.data.find(s => s.key === 'studio_sitter_lockup_template')?.value ?? '';
      let parsed: LockupTemplateShape;
      try {
        const p = JSON.parse(rawTpl);
        parsed = {
          version: Number(p.version) || 1,
          intro: p.intro ?? '',
          items: Array.isArray(p.items) ? p.items : [],
          notes_label: p.notes_label ?? '',
          lost_property_prompt: p.lost_property_prompt ?? '',
        };
      } catch { parsed = { version: 1, intro: '', items: [], notes_label: '', lost_property_prompt: '' }; }
      setTpl(parsed);
    } catch {
      setError('Could not load studio-sitter settings (has migration 168 run?).');
    } finally { setLoading(false); }
  }

  function updateItem(idx: number, patch: Partial<LockupTemplateItem>) {
    setTpl(t => t ? { ...t, items: t.items.map((it, i) => i === idx ? { ...it, ...patch } : it) } : t);
  }
  function moveItem(idx: number, dir: -1 | 1) {
    setTpl(t => {
      if (!t) return t;
      const j = idx + dir;
      if (j < 0 || j >= t.items.length) return t;
      const items = [...t.items];
      [items[idx], items[j]] = [items[j], items[idx]];
      return { ...t, items };
    });
  }
  function addItem() {
    setTpl(t => t ? { ...t, items: [...t.items, { id: slugId('new item'), label: '', type: 'yesno', expected: 'yes', section: t.items[t.items.length - 1]?.section }] } : t);
  }
  function removeItem(idx: number) {
    setTpl(t => t ? { ...t, items: t.items.filter((_, i) => i !== idx) } : t);
  }

  async function uploadItemPhoto(idx: number, file: File) {
    setUploadingIdx(idx); setError('');
    try {
      // Reference photos are only "what it should look like" guides — downscale
      // before upload so they load fast for sitters on 4G (a phone photo is
      // ~3MB; this lands ~150-250KB). Falls back to the original on any decode
      // failure (e.g. a non-image).
      let upload: Blob = file;
      let name = file.name;
      try {
        upload = await compressImage(file, 1400, 0.8);
        name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      } catch { /* keep original */ }
      const fd = new FormData();
      fd.append('file', upload, name);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
      setTpl(t => t ? { ...t, items: t.items.map((it, i) => i === idx
        ? { ...it, reference: { text: it.reference?.text, photos: [...(it.reference?.photos ?? []), up.r2_key] } } : it) } : t);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed'); }
    finally { setUploadingIdx(null); }
  }
  function removeItemPhoto(idx: number, photoIdx: number) {
    setTpl(t => t ? { ...t, items: t.items.map((it, i) => i === idx
      ? { ...it, reference: { text: it.reference?.text, photos: (it.reference?.photos ?? []).filter((_, p) => p !== photoIdx) } } : it) } : t);
  }

  async function save() {
    if (!tpl) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const seen = new Set<string>();
      const items = tpl.items
        .filter(it => it.label.trim() !== '')
        .map(it => {
          let id = it.id?.trim() || slugId(it.label);
          while (seen.has(id)) id = `${id}_${Math.random().toString(36).slice(2, 4)}`;
          seen.add(id);
          const out: LockupTemplateItem = { id, label: it.label.trim(), type: it.type };
          if (it.section?.trim()) out.section = it.section.trim();
          if (it.expected) out.expected = it.expected;
          if (it.end_of_booking_only) out.end_of_booking_only = true;
          if (it.note_prompt?.trim()) out.note_prompt = it.note_prompt.trim();
          const refText = it.reference?.text?.trim();
          const refPhotos = (it.reference?.photos ?? []).filter(Boolean);
          if (refText || refPhotos.length > 0) out.reference = { text: refText || undefined, photos: refPhotos };
          return out;
        });
      const payload: LockupTemplateShape = {
        version: (tpl.version || 1) + 1,
        intro: tpl.intro?.trim() || undefined,
        items,
        notes_label: tpl.notes_label?.trim() || undefined,
        lost_property_prompt: tpl.lost_property_prompt?.trim() || undefined,
      };
      await api.put('/system-settings', { settings: { studio_sitter_lockup_template: JSON.stringify(payload) } });
      setSuccess('Lock-up template saved.');
      load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  if (loading || !tpl) return null;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Studio Sitter — Lock-up report</h2>
      <p className="text-sm text-gray-500 mb-4">
        The end-of-night &ldquo;Finish for the night&rdquo; checklist a sitter fills in. Items with an
        <em> expected</em> answer flag anything off-expected. End-of-booking items are hidden when the
        studio is in use again the next day. A <em>section</em> groups items under a header; a
        <em> reference</em> shows &ldquo;what it should look like&rdquo; photos + text on that item.
      </p>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {success && <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{success}</div>}

      <div className="grid grid-cols-1 gap-3 mb-4">
        <label className="text-sm">
          <span className="text-gray-500 text-xs">Intro line</span>
          <textarea className="mt-1 w-full border rounded px-2 py-1" rows={2} value={tpl.intro || ''} onChange={(e) => setTpl({ ...tpl, intro: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="text-gray-500 text-xs">Notes prompt</span>
          <input className="mt-1 w-full border rounded px-2 py-1" value={tpl.notes_label || ''} onChange={(e) => setTpl({ ...tpl, notes_label: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="text-gray-500 text-xs">Lost-property prompt</span>
          <input className="mt-1 w-full border rounded px-2 py-1" value={tpl.lost_property_prompt || ''} onChange={(e) => setTpl({ ...tpl, lost_property_prompt: e.target.value })} />
        </label>
      </div>

      <div className="border-t pt-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">Checklist items</span>
          <button onClick={addItem} className="text-sm px-2.5 py-1 bg-gray-100 hover:bg-gray-200 rounded">+ Add item</button>
        </div>
        <div className="space-y-2">
          {tpl.items.map((it, idx) => (
            <div key={idx} className="border rounded p-2.5 bg-gray-50">
              <div className="flex gap-2 items-start">
                <input className="flex-1 border rounded px-2 py-1 text-sm" placeholder="Checklist question" value={it.label} onChange={(e) => updateItem(idx, { label: e.target.value })} />
                <div className="flex flex-col gap-1">
                  <button onClick={() => moveItem(idx, -1)} disabled={idx === 0} className="px-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Move up">▲</button>
                  <button onClick={() => moveItem(idx, 1)} disabled={idx === tpl.items.length - 1} className="px-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Move down">▼</button>
                </div>
                <button onClick={() => removeItem(idx)} className="px-1.5 text-red-400 hover:text-red-600" title="Remove">✕</button>
              </div>
              <div className="flex flex-wrap gap-3 mt-2 text-xs items-center">
                <label className="flex items-center gap-1">
                  <span className="text-gray-500">Section</span>
                  <input className="border rounded px-1 py-0.5 w-28" placeholder="e.g. Upstairs" value={it.section ?? ''} onChange={(e) => updateItem(idx, { section: e.target.value })} />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-gray-500">Type</span>
                  <select className="border rounded px-1 py-0.5" value={it.type} onChange={(e) => updateItem(idx, { type: e.target.value as LockupTemplateItem['type'] })}>
                    <option value="yesno">Yes/No</option>
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                  </select>
                </label>
                {it.type === 'yesno' && (
                  <label className="flex items-center gap-1">
                    <span className="text-gray-500">Expected</span>
                    <select className="border rounded px-1 py-0.5" value={it.expected ?? ''} onChange={(e) => updateItem(idx, { expected: e.target.value || undefined })}>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                      <option value="">(no flag)</option>
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={!!it.end_of_booking_only} onChange={(e) => updateItem(idx, { end_of_booking_only: e.target.checked })} />
                  <span className="text-gray-500">End-of-booking only</span>
                </label>
              </div>

              {/* Per-item reference: "what it should look like" */}
              <div className="mt-2 border-t border-gray-200 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-500">Reference</span>
                  <input className="flex-1 border rounded px-1.5 py-0.5 text-xs" placeholder="What it should look like (optional caption)"
                    value={it.reference?.text ?? ''} onChange={(e) => updateItem(idx, { reference: { text: e.target.value, photos: it.reference?.photos ?? [] } })} />
                  <label className="text-xs px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded cursor-pointer">
                    {uploadingIdx === idx ? 'Uploading…' : '+ Photo'}
                    <input type="file" accept="image/png,image/jpeg" className="hidden" disabled={uploadingIdx === idx}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadItemPhoto(idx, f); e.target.value = ''; }} />
                  </label>
                </div>
                {(it.reference?.photos?.length ?? 0) > 0 && (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2">
                    {it.reference!.photos.map((p, pi) => (
                      <div key={pi} className="relative">
                        <RefPhotoPreview url={p} />
                        <button onClick={() => removeItemPhoto(idx, pi)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none" title="Remove">×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Always-on note box: prompt shown on the form regardless of answer
                  (e.g. "how did they pay?"). Empty = no note box for this item. */}
              <div className="mt-2 border-t border-gray-200 pt-2">
                <label className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-500 whitespace-nowrap">Always-ask note</span>
                  <input className="flex-1 border rounded px-1.5 py-0.5 text-xs" placeholder="e.g. How did they pay? (leave blank for none)"
                    value={it.note_prompt ?? ''} onChange={(e) => updateItem(idx, { note_prompt: e.target.value })} />
                </label>
              </div>
            </div>
          ))}
          {tpl.items.length === 0 && <p className="text-sm text-gray-400">No items yet.</p>}
        </div>
      </div>

      <button onClick={save} disabled={saving} className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm disabled:opacity-50">
        {saving ? 'Saving…' : 'Save lock-up template'}
      </button>
    </div>
  );
}

// ── Auto-Chase draft voice ───────────────────────────────────────────────────

interface MailboxStatusRow {
  mailbox: string;
  mode: 'full' | 'matched_only';
  profile?: { emailAddress: string };
  syncState?: { last_synced_at: string | null; last_error: string | null } | null;
  error?: string;
}

// Admin-only: which mailboxes auto-chase ingests. info@ (full) is fixed; manager
// mailboxes (matched-only) are add/remove here — no deploy. Each row is probed
// live, so a delegation gap on a manager mailbox shows as "Not connected".
function ManagerMailboxesSection() {
  const [rows, setRows] = useState<MailboxStatusRow[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newAddr, setNewAddr] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError('');
    try {
      const res = await api.get<{ data: { configured: boolean; mailboxes: MailboxStatusRow[] } }>('/auto-chase/mailboxes');
      setConfigured(res.data.configured);
      setRows(res.data.mailboxes || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load mailbox status');
    } finally { setLoading(false); }
  }

  const managerList = () => rows.filter((r) => r.mode === 'matched_only').map((r) => r.mailbox);

  async function saveList(list: string[]) {
    setSaving(true); setError('');
    try {
      const res = await api.put<{ data: { configured: boolean; mailboxes: MailboxStatusRow[] } }>(
        '/auto-chase/mailboxes', { mailboxes: list },
      );
      setConfigured(res.data.configured);
      setRows(res.data.mailboxes || []);
      setNewAddr('');
    } catch (e) {
      const err = e as { body?: { error?: string }; message?: string };
      setError(err.body?.error || err.message || 'Save failed');
    } finally { setSaving(false); }
  }

  function addMailbox() {
    const addr = newAddr.trim().toLowerCase();
    if (!addr) return;
    saveList([...managerList(), addr]);
  }

  function removeMailbox(mb: string) {
    if (!window.confirm(`Stop ingesting ${mb}? Emails already logged onto jobs stay; no new mail from this mailbox will be read.`)) return;
    saveList(managerList().filter((m) => m !== mb));
  }

  if (loading) return null;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Auto-Chase — manager mailboxes</h2>
      <p className="text-sm text-gray-500 mb-4">
        Mailboxes ingested alongside <strong>info@</strong>. Manager mailboxes run <strong>matched-only</strong> — an
        email is logged only when it confidently matches a job; anything else is dropped (never queued), so
        non-job mail from a personal mailbox never surfaces to staff. info@ stays full (matched + review queue).
      </p>
      {!configured && (
        <div className="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Gmail ingestion isn’t configured on the server yet — mailboxes can’t be read.
        </div>
      )}
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <div className="space-y-2 mb-4">
        {rows.map((r) => (
          <div key={r.mailbox} className="flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 truncate">{r.mailbox}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${r.mode === 'full' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-gray-100 text-gray-600'}`}>
                  {r.mode === 'full' ? 'primary · full' : 'matched-only'}
                </span>
              </div>
              <div className="text-xs mt-0.5">
                {r.error
                  ? <span className="text-red-600">⚠ Not connected — {r.error}</span>
                  : <span className="text-green-700">✓ Connected{r.syncState?.last_synced_at ? ` · last synced ${new Date(r.syncState.last_synced_at).toLocaleString('en-GB')}` : ' · awaiting first sync'}</span>}
                {r.syncState?.last_error && !r.error && <span className="text-amber-600"> · last error: {r.syncState.last_error}</span>}
              </div>
            </div>
            {r.mode === 'matched_only' && (
              <button type="button" onClick={() => removeMailbox(r.mailbox)} disabled={saving}
                className="text-xs text-gray-400 hover:text-red-600 shrink-0">Remove</button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="email" value={newAddr} onChange={(e) => setNewAddr(e.target.value)}
          placeholder="name@oooshtours.co.uk"
          onKeyDown={(e) => { if (e.key === 'Enter') addMailbox(); }}
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <button type="button" onClick={addMailbox} disabled={saving || !newAddr.trim()}
          className="bg-ooosh-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Add mailbox'}
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        A newly added mailbox ingests from now on — it establishes a baseline first, then reads new mail on the
        10-minute cycle. Only @oooshtours.co.uk addresses can be added.
      </p>
    </div>
  );
}

function ChaseVoiceSettingsSection() {
  const [orig, setOrig] = useState('');
  const [val, setVal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Example-driven voice tuning (§9.3): paste real emails → distil into guidance.
  const [showLearn, setShowLearn] = useState(false);
  const [examples, setExamples] = useState('');
  const [learning, setLearning] = useState(false);
  const [proposed, setProposed] = useState('');
  const [learnError, setLearnError] = useState('');
  // Master auto-send switch (§10). Off = jobs set to Auto-send only create drafts.
  const [sendEnabled, setSendEnabled] = useState(false);
  const [sendSaving, setSendSaving] = useState(false);
  // Default sign-off name for AUTOMATED chases (manual drafts use the clicker).
  const [senderName, setSenderName] = useState('');
  const [senderOrig, setSenderOrig] = useState('');
  const [senderSaving, setSenderSaving] = useState(false);

  async function saveSenderName() {
    setSenderSaving(true);
    try {
      await api.put('/system-settings', { settings: { chase_default_sender_name: senderName.trim() === '' ? null : senderName.trim() } });
      setSenderOrig(senderName.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the sender name');
    } finally { setSenderSaving(false); }
  }

  useEffect(() => { load(); }, []);

  async function toggleSend() {
    const next = !sendEnabled;
    setSendSaving(true);
    try {
      await api.put('/system-settings', { settings: { auto_chase_send_enabled: next ? 'true' : 'false' } });
      setSendEnabled(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the auto-send switch');
    } finally { setSendSaving(false); }
  }

  async function learnFromExamples() {
    setLearning(true); setLearnError(''); setProposed('');
    try {
      const res = await api.post<{ data: { proposed: string } }>(
        '/auto-chase/voice/learn',
        { examples, current: val },
      );
      setProposed(res.data.proposed);
    } catch (e) {
      setLearnError(e instanceof Error ? e.message : 'Could not learn from these examples');
    } finally { setLearning(false); }
  }

  async function load() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=chase');
      const v = res.data.find(s => s.key === 'chase_voice_instructions')?.value ?? '';
      setOrig(v);
      setVal(v);
      setSendEnabled(res.data.find(s => s.key === 'auto_chase_send_enabled')?.value === 'true');
      const sn = res.data.find(s => s.key === 'chase_default_sender_name')?.value ?? '';
      setSenderName(sn);
      setSenderOrig(sn);
    } catch {
      setError('Could not load chase settings (has migration 157 run?).');
    } finally { setLoading(false); }
  }

  async function save() {
    setSaving(true); setError(''); setSuccess('');
    try {
      await api.put('/system-settings', { settings: { chase_voice_instructions: val.trim() === '' ? null : val } });
      setOrig(val);
      setSuccess('Saved. New drafts will use this voice.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  if (loading) return null;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Auto-Chase — draft voice</h2>
      <p className="text-sm text-gray-500 mb-4">
        Extra tone guidance appended to the AI chase-draft prompt (the “Draft chase” button on enquiries).
        Your steer on “more of this / less of that” — takes effect on the next draft, no deploy needed.
        The hard rules (checking-in not renegotiating, never fabricate, urgency matched to the hire date) can’t be overridden here.
      </p>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {success && <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{success}</div>}

      {/* Master auto-send switch (§10) — the global backstop on top of per-job
          Auto-send mode. Off = even Auto-send jobs only create drafts. */}
      <div className={`mb-5 rounded-lg border p-3 flex items-start justify-between gap-4 ${sendEnabled ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
        <div>
          <p className="text-sm font-medium text-gray-900">Auto-send chases {sendEnabled ? '· ON' : '· off (drafts only)'}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Master switch. While off, jobs set to “Auto-send” still only create Gmail drafts — so you can watch what would go out.
            Turn on to let those jobs actually send automatically (each still passes the suppression check first).
          </p>
        </div>
        <button
          type="button"
          onClick={toggleSend}
          disabled={sendSaving}
          role="switch"
          aria-checked={sendEnabled}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${sendEnabled ? 'bg-amber-500' : 'bg-gray-300'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${sendEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Default sign-off for AUTOMATED chases (manual "Draft chase" uses the
          clicker's name; the runner uses the job's manager, then this). */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-gray-700 mb-1">Automated chase sign-off</label>
        <p className="text-xs text-gray-500 mb-2">
          Name automated chases sign off with when a job has no assigned manager (blank = “the Ooosh team”).
          Manual drafts always sign off with whoever clicked.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder="e.g. Will"
            className="w-48 border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <button
            onClick={saveSenderName}
            disabled={senderSaving || senderName.trim() === senderOrig.trim()}
            className="px-3 py-1.5 bg-ooosh-600 text-white rounded text-sm disabled:opacity-50"
          >
            {senderSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <textarea
        value={val}
        onChange={(e) => { setVal(e.target.value); setSuccess(''); }}
        rows={6}
        placeholder={'e.g. Keep it really casual and friendly — we\'re a small team, not a corporate. Avoid exclamation marks. Sign off as "Cheers, the Ooosh team". Never mention the exact price.'}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y min-h-[120px]"
      />
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving || val === orig} className="px-3 py-1.5 bg-ooosh-600 text-white rounded text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save voice'}
        </button>
        {val !== orig && <button onClick={() => setVal(orig)} className="text-sm text-gray-500 hover:text-gray-700">Reset</button>}
      </div>

      {/* Example-driven voice tuning (§9.3) — teach the voice by showing real
          emails instead of hand-writing the guidance above. */}
      <div className="mt-5 border-t border-gray-100 pt-4">
        <button
          type="button"
          onClick={() => setShowLearn((v) => !v)}
          className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700"
        >
          {showLearn ? '▾' : '▸'} Teach the voice from real examples
        </button>
        {showLearn && (
          <div className="mt-3">
            <p className="text-xs text-gray-500 mb-2">
              Paste a few real examples — client emails and the actual replies your team sent are ideal.
              We’ll distil the tone/style into a proposed guidance note, which you can review and drop into
              the box above before saving. Style only — client names, prices and job details are never baked in.
            </p>
            <textarea
              value={examples}
              onChange={(e) => setExamples(e.target.value)}
              rows={7}
              placeholder={'Paste example emails here, e.g.\n\nCLIENT: Hi, any update on the quote for the two vans?\nOOOSH: Hey! Yep all good to go whenever you are — just give us a shout and we\'ll get it locked in. Cheers, the Ooosh team'}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y min-h-[120px]"
            />
            {learnError && <div className="mt-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{learnError}</div>}
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={learnFromExamples}
                disabled={learning || examples.trim() === ''}
                className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm disabled:opacity-50"
              >
                {learning ? 'Learning…' : '✨ Suggest guidance from these'}
              </button>
            </div>
            {proposed && (
              <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50/60 p-3">
                <div className="text-xs font-semibold text-purple-700 mb-1">Proposed voice guidance</div>
                <p className="text-sm text-gray-700 whitespace-pre-line">{proposed}</p>
                <div className="flex items-center gap-3 mt-3">
                  <button
                    onClick={() => { setVal(proposed); setSuccess(''); setProposed(''); }}
                    className="px-3 py-1.5 bg-ooosh-600 text-white rounded text-sm"
                  >
                    Use this ↑
                  </button>
                  <button onClick={() => setProposed('')} className="text-sm text-gray-500 hover:text-gray-700">Discard</button>
                </div>
                <p className="mt-2 text-[11px] text-gray-400">“Use this” drops it into the box above — review, tweak, then <strong>Save voice</strong> to apply.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OohSettingsSection() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // TEMPORARY: SMS connectivity test (remove after go-live — see GH reminder issue)
  const [testNumber, setTestNumber] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=ooh_returns');
      setSettings(res.data);
      const vals: Record<string, string> = {};
      for (const s of res.data) vals[s.key] = s.value ?? '';
      setEditValues(vals);
    } catch (err) {
      console.error('Failed to load OOH settings:', err);
      setError('Could not load OOH return settings.');
    } finally {
      setLoading(false);
    }
  }

  function hasChanges(): boolean {
    return settings.some(s => (s.value ?? '') !== (editValues[s.key] ?? ''));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const changed: Record<string, string | null> = {};
      for (const s of settings) {
        const orig = s.value ?? '';
        const next = editValues[s.key] ?? '';
        if (orig !== next) changed[s.key] = next === '' ? null : next;
      }
      if (Object.keys(changed).length === 0) {
        setEditing(false);
        return;
      }
      await api.put('/system-settings', { settings: changed });
      setSuccess('OOH settings updated.');
      setEditing(false);
      loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    const vals: Record<string, string> = {};
    for (const s of settings) vals[s.key] = s.value ?? '';
    setEditValues(vals);
    setEditing(false);
    setError('');
  }

  // TEMPORARY: SMS connectivity test (remove after go-live — see GH reminder issue)
  async function sendTestSms() {
    setTesting(true);
    setTestResult('');
    try {
      const res = await api.post<{ success: boolean; redirectedTo: string | null }>(
        '/system-settings/test-sms',
        { to: testNumber.trim() || undefined },
      );
      setTestResult(
        res.redirectedTo
          ? `Sent (test mode → redirected to ${res.redirectedTo}). Check that phone.`
          : 'Sent. Check the phone.',
      );
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Test SMS failed');
    } finally {
      setTesting(false);
    }
  }

  // TEMPORARY: run the geofence scan now (remove after go-live — see GH reminder issue)
  async function runOohScan() {
    setScanning(true);
    setScanResult('');
    try {
      const res = await api.post<{ checked: number; texted: number; skipped: number }>(
        '/system-settings/run-ooh-scan',
        {},
      );
      setScanResult(`Scan done — checked ${res.checked}, texted ${res.texted}, skipped ${res.skipped}.`);
    } catch (err) {
      setScanResult(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  if (loading) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Out-of-Hours Returns</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Settings used in the OOH info email — gate code, yard address, key-drop photo.
          </p>
        </div>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 transition-colors"
          >
            Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              disabled={saving}
              className="px-4 py-2 text-sm border border-gray-300 rounded font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges()}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}
      {success && <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">{success}</div>}

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        {settings.map(s => {
          const isBool = s.value_type === 'bool';
          const isUrl = s.value_type === 'url';
          return (
            <div key={s.key} className="flex items-center justify-between gap-4 py-1">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-700">{s.label || s.key}</p>
                {!editing && isUrl && (editValues[s.key] || '').length > 0 && (
                  <a
                    href={editValues[s.key]}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline truncate block"
                  >
                    {editValues[s.key]}
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                {editing ? (
                  isBool ? (
                    <select
                      value={editValues[s.key] || 'false'}
                      onChange={e => setEditValues(v => ({ ...v, [s.key]: e.target.value }))}
                      className="border border-gray-300 rounded px-2 py-1 text-sm"
                    >
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <input
                      type={isUrl ? 'url' : 'text'}
                      value={editValues[s.key] ?? ''}
                      onChange={e => setEditValues(v => ({ ...v, [s.key]: e.target.value }))}
                      placeholder={isUrl ? 'https://…' : ''}
                      className="border border-gray-300 rounded px-2 py-1 text-sm w-72 max-w-full"
                    />
                  )
                ) : (
                  <span className="text-sm text-gray-900 font-mono truncate max-w-xs">
                    {isBool
                      ? editValues[s.key] === 'true' ? 'Yes' : 'No'
                      : !isUrl
                      ? editValues[s.key] || <span className="text-gray-400 italic">—</span>
                      : null}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* TEMPORARY: SMS connectivity test — remove after go-live (see GH reminder issue). */}
      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
        <p className="text-sm font-medium text-amber-900">Send test SMS (temporary)</p>
        <p className="text-xs text-amber-700 mt-0.5 mb-2">
          Fires one text via Twilio to confirm the setup. While SMS_MODE=test it redirects to
          SMS_TEST_REDIRECT regardless of the number entered. Remove this once go-live is confirmed.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="tel"
            value={testNumber}
            onChange={e => setTestNumber(e.target.value)}
            placeholder="+447… (blank = test redirect)"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-64 max-w-full"
          />
          <button
            onClick={sendTestSms}
            disabled={testing}
            className="px-4 py-2 text-sm bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send test SMS'}
          </button>
        </div>
        {testResult && <p className="text-xs text-amber-800 mt-2">{testResult}</p>}

        <div className="mt-3 pt-3 border-t border-amber-200">
          <p className="text-sm font-medium text-amber-900">Run geofence scan now (temporary)</p>
          <p className="text-xs text-amber-700 mt-0.5 mb-2">
            The approach scan normally only runs 17:00–08:59. Use this to test in daylight: needs an
            OOH-flagged, booked-out van with a recent Traccar fix within the radius. In test mode any
            text redirects to SMS_TEST_REDIRECT.
          </p>
          <button
            onClick={runOohScan}
            disabled={scanning}
            className="px-4 py-2 text-sm bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {scanning ? 'Scanning…' : 'Run OOH scan now'}
          </button>
          {scanResult && <p className="text-xs text-amber-800 mt-2">{scanResult}</p>}
        </div>
      </div>
    </div>
  );
}

function BackupsSection() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    loadBackups();
  }, []);

  async function loadBackups() {
    try {
      const data = await api.get<{ data: BackupEntry[] }>('/backups');
      setBackups(data.data);
    } catch (err) {
      console.error('Failed to load backups:', err);
      setError('Could not load backups. R2 may not be configured.');
    } finally {
      setLoading(false);
    }
  }

  async function triggerBackup() {
    setRunning(true);
    setError('');
    setSuccessMsg('');
    try {
      await api.post('/backups/trigger', {});
      setSuccessMsg('Backup created successfully');
      loadBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setRunning(false);
    }
  }

  function formatDate(iso: string) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Database Backups</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Automated daily at 02:00. Stored in Cloudflare R2.
          </p>
        </div>
        <button
          onClick={triggerBackup}
          disabled={running}
          className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
        >
          {running ? 'Running...' : 'Backup Now'}
        </button>
      </div>

      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {successMsg}
        </div>
      )}

      {error && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Backup</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">Loading...</td>
              </tr>
            ) : backups.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">No backups yet. Click "Backup Now" to create one.</td>
              </tr>
            ) : (
              backups.map((b) => (
                <tr key={b.key} className="hover:bg-gray-50">
                  <td className="px-6 py-3 text-sm text-gray-900 font-mono text-xs">{b.filename}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{formatDate(b.created_at)}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{b.sizeMB} MB</td>
                  <td className="px-6 py-3 text-right">
                    <a
                      href={`/api/backups/download?key=${encodeURIComponent(b.key)}`}
                      className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Vehicle Issues Settings ──────────────────────────────────────────────
//
// Manages the fleet-wide default watcher list for new vehicle issues
// (migration 082 — vehicle_issue_default_watchers in system_settings).
// Issues auto-created from PrepPage / CheckInPage flags otherwise have
// no watchers + no assignee, so nobody gets pinged on the initial flag.
// Adding staff here means every new vehicle issue lands in their inbox.

function VehicleIssueSettingsSection() {
  const [rawValue, setRawValue] = useState<string>('[]');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<{ data: SystemSetting[] }>('/system-settings?category=vehicle_issues'),
      api.get<{ data: TeamUser[] }>('/users'),
    ]).then(([settingsRes, usersRes]) => {
      setUsers(usersRes.data);
      const setting = settingsRes.data.find(s => s.key === 'vehicle_issue_default_watchers');
      const initial = setting?.value ?? '[]';
      setRawValue(initial);
      try {
        const parsed = JSON.parse(initial);
        if (Array.isArray(parsed)) {
          setSelectedIds(parsed.filter((v): v is string => typeof v === 'string'));
        }
      } catch {
        setSelectedIds([]);
      }
    }).catch(err => {
      console.error('Failed to load vehicle issue settings:', err);
      setError('Could not load settings.');
    }).finally(() => setLoading(false));
  }, []);

  function toggleUser(userId: string) {
    setSelectedIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  }

  function hasChanges(): boolean {
    const currentJson = JSON.stringify(selectedIds);
    let existingJson = '[]';
    try {
      const parsed = JSON.parse(rawValue);
      existingJson = JSON.stringify(Array.isArray(parsed) ? parsed : []);
    } catch { /* ignore */ }
    return currentJson !== existingJson;
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const newValue = JSON.stringify(selectedIds);
      await api.put('/system-settings', {
        settings: { vehicle_issue_default_watchers: newValue },
      });
      setRawValue(newValue);
      setSuccess(`Saved — ${selectedIds.length} default watcher${selectedIds.length === 1 ? '' : 's'} set.`);
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      console.error('Save failed:', err);
      setError('Save failed — try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Vehicle Issues</h2>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Vehicle Issues</h2>
      <p className="text-xs text-gray-500 mb-4">
        Staff selected here are added as watchers on every new vehicle
        issue (auto-flagged from prep / check-in, or manually logged).
        They get a bell + email notification on the initial flag and
        every subsequent re-flag, status change, or assignment.
      </p>

      <div className="mb-3">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Default watchers
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto border border-gray-200 rounded p-2">
          {users.map(u => {
            const checked = selectedIds.includes(u.id);
            return (
              <label
                key={u.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                  checked ? 'bg-ooosh-50' : 'hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleUser(u.id)}
                  className="rounded"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {u.first_name} {u.last_name}
                  </div>
                  <div className="text-[10px] text-gray-500 truncate">{u.email}</div>
                </div>
              </label>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">
          {selectedIds.length === 0
            ? 'No default watchers — new vehicle issues will fire no initial notifications.'
            : `${selectedIds.length} user${selectedIds.length === 1 ? '' : 's'} will be added to every new vehicle issue.`}
        </p>
      </div>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}
      {success && <div className="text-sm text-green-600 mb-2">{success}</div>}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={!hasChanges() || saving}
          onClick={handleSave}
          className="px-4 py-2 bg-ooosh-600 text-white rounded text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Staff Calendar & Time (spec §13) ────────────────────────────────────────

/**
 * The thresholds the staff time module runs on.
 *
 * These exist as settings rather than constants for one reason: spec §17 lists
 * statutory specifics that want a sanity check from the accountants before
 * go-live — the pro-rata rounding rule, whether bank holidays are granted, how
 * banked overtime is handled at year end. A correction should be a settings
 * change, not a deploy, and that only holds if there is somewhere to change it.
 *
 * Everything is stored as text and read through backend
 * services/staff-settings.ts, which falls back to a documented default if a
 * value is empty or malformed — so a typo here degrades rather than breaks.
 */
/**
 * The three links the approval email sends a freelancer on day one.
 *
 * Here rather than in the code because a WhatsApp group invite link is
 * effectively a password — reset the group and every approval email points at a
 * dead invite until someone deploys. Emptying a box removes that block from the
 * email rather than sending a broken link, so clearing the WhatsApp link the
 * moment it leaks is a safe thing to do at 11pm.
 */
function FreelancerLinksSection() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => { void load(); }, []);

  async function load() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=freelancers');
      setSettings(res.data);
      const v: Record<string, string> = {};
      for (const row of res.data) v[row.key] = row.value ?? '';
      setVals(v);
    } catch {
      setError('Could not load freelancer links (has migration 230 run?).');
    } finally { setLoading(false); }
  }

  async function save() {
    setSaving(true); setError(''); setSuccess('');
    try {
      const changed: Record<string, string | null> = {};
      for (const row of settings) {
        const orig = row.value ?? '';
        if (orig !== (vals[row.key] ?? '')) changed[row.key] = vals[row.key];
      }
      if (Object.keys(changed).length === 0) { setSuccess('Nothing changed.'); return; }
      await api.put('/system-settings', { settings: changed });
      setSuccess(`Saved ${Object.keys(changed).length} link${Object.keys(changed).length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally { setSaving(false); }
  }

  if (loading) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Freelancer welcome links</h2>
      <p className="text-sm text-gray-600 mb-4">
        Sent automatically in the approval email. Change one here and the next approval
        uses it — no deploy needed. Leave a box empty to drop that part of the email.
      </p>

      {error && <div className="mb-3 p-2 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {success && <div className="mb-3 p-2 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{success}</div>}

      <div className="space-y-3">
        {settings.map(row => (
          <div key={row.key} className="grid sm:grid-cols-[14rem_minmax(0,1fr)] gap-2 sm:items-center">
            <label htmlFor={row.key} className="text-sm text-gray-700">
              {row.label ?? row.key}
              <span className="block text-xs text-gray-400 font-mono">{row.key}</span>
            </label>
            <input id={row.key} value={vals[row.key] ?? ''} placeholder="https://…"
              onChange={e => setVals(v => ({ ...v, [row.key]: e.target.value }))}
              className="px-2 py-1.5 rounded border border-gray-300 text-sm" />
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs text-gray-400">
        Anyone forwarded the approval email can use the WhatsApp invite link — reset the
        group link and update it here if it ever gets out.
      </p>

      <div className="mt-4">
        <button onClick={() => void save()} disabled={saving}
          className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Editors for the staff settings stored as JSON. Each takes the raw string
 * and hands back a new one, so the section's save path does not change.
 *
 * Both fall back to the raw text box when the stored value doesn't parse:
 * silently replacing somebody's hand-edited setting with an empty editor
 * would lose it on the next save. The backend readers already tolerate junk
 * (getReviewQuestions / getReviewIntervals fall back to built-in defaults).
 */
type JsonEditor = (p: { value: string; onChange: (next: string) => void }) => JSX.Element;

function RawJsonBox({ value, onChange, why }: { value: string; onChange: (v: string) => void; why: string }) {
  return (
    <div>
      <p className="text-xs text-amber-700 mb-1">{why} Showing the raw value — fix it here or clear it to start again.</p>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={4}
        className="w-full px-2 py-1.5 rounded border border-gray-300 text-sm font-mono" />
    </div>
  );
}

/** staff.review_questions — a JSON array of strings, asked of both sides. */
const ReviewQuestionsEditor: JsonEditor = ({ value, onChange }) => {
  let questions: string[] | null = null;
  try {
    const parsed = value.trim() ? JSON.parse(value) : [];
    if (Array.isArray(parsed) && parsed.every(q => typeof q === 'string')) questions = parsed;
  } catch { /* falls through to the raw box */ }
  if (!questions) {
    return <RawJsonBox value={value} onChange={onChange} why="This isn’t a list of questions." />;
  }
  const list = questions;
  const write = (next: string[]) => onChange(JSON.stringify(next));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [q] = next.splice(i, 1);
    next.splice(i + by, 0, q);
    write(next);
  };
  return (
    <div className="space-y-2">
      {list.map((q, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="text-xs text-gray-400 w-5 pt-2 text-right">{i + 1}.</span>
          <textarea value={q} rows={2}
            onChange={e => write(list.map((x, j) => (j === i ? e.target.value : x)))}
            className="flex-1 px-2 py-1.5 rounded border border-gray-300 text-sm" />
          <div className="flex flex-col gap-0.5 text-xs">
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
              className="px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30" aria-label="Move up">▲</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1}
              className="px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30" aria-label="Move down">▼</button>
          </div>
          <button type="button" onClick={() => write(list.filter((_, j) => j !== i))}
            className="text-xs text-red-600 hover:text-red-800 pt-2">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => write([...list, ''])}
        className="text-sm text-ooosh-600 hover:underline">+ Add a question</button>
      <p className="text-xs text-gray-400">
        Both sides answer the same questions before a review. Rewording one only affects future
        reviews — past answers keep the wording they were asked with. Empty questions are ignored.
      </p>
    </div>
  );
};

/** staff.doc_review_intervals — months per staff document type; 0 = never. */
const DocIntervalsEditor: JsonEditor = ({ value, onChange }) => {
  let map: Record<string, number> | null = null;
  try {
    const parsed = value.trim() ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
  } catch { /* falls through to the raw box */ }
  if (!map) {
    return <RawJsonBox value={value} onChange={onChange} why="This isn’t a table of months." />;
  }
  const current = map;
  const known = STAFF_DOC_TYPES.map(t => t.value);
  // Keep anything the setting mentions that the form doesn't know, so a
  // hand-added type isn't dropped on save.
  const rows = [...STAFF_DOC_TYPES, ...Object.keys(current).filter(k => !known.includes(k)).map(k => ({ value: k, label: k }))];
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] sm:grid-cols-[16rem_6rem] gap-x-3 gap-y-1.5 items-center">
        {rows.map(t => (
          <div key={t.value} className="contents">
            <label htmlFor={`interval-${t.value}`} className="text-sm text-gray-700">{t.label}</label>
            <input id={`interval-${t.value}`} type="number" min={0} max={600} inputMode="numeric"
              value={String(current[t.value] ?? 0)}
              onChange={e => {
                const n = Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0)));
                onChange(JSON.stringify({ ...current, [t.value]: n }));
              }}
              className="px-2 py-1 rounded border border-gray-300 text-sm" />
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Months. Used to suggest the “then, on” date when a record is filed — 0 means don’t suggest
        one. It never changes a date already set on a record.
      </p>
    </div>
  );
};

const STRUCTURED_EDITORS: Record<string, JsonEditor> = {
  'staff.review_questions': ReviewQuestionsEditor,
  'staff.doc_review_intervals': DocIntervalsEditor,
};

function StaffTimeSettingsSection() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => { void load(); }, []);

  async function load() {
    try {
      const res = await api.get<{ data: SystemSetting[] }>('/system-settings?category=staff_time');
      setSettings(res.data);
      const v: Record<string, string> = {};
      for (const row of res.data) v[row.key] = row.value ?? '';
      setVals(v);
    } catch {
      setError('Could not load staff time settings (has migration 216 run?).');
    } finally { setLoading(false); }
  }

  async function save() {
    setSaving(true); setError(''); setSuccess('');
    try {
      const changed: Record<string, string | null> = {};
      for (const row of settings) {
        const orig = row.value ?? '';
        if (orig !== (vals[row.key] ?? '')) changed[row.key] = vals[row.key];
      }
      if (Object.keys(changed).length === 0) { setSuccess('Nothing changed.'); return; }
      await api.put('/system-settings', { settings: changed });
      setSuccess(`Saved ${Object.keys(changed).length} setting${Object.keys(changed).length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally { setSaving(false); }
  }

  if (loading) return null;

  // The internal "last reminded" stamp is machinery, not config — shown last
  // and set apart, because clearing it is a deliberate act (it makes the
  // year-end cash-out reminder fire again).
  const INTERNAL = 'staff.overtime_cashout_reminded_year';
  const editable = settings.filter(row => row.key !== INTERNAL);
  // The per-year override rows are handled by BankHolidayOverrides below,
  // which can reach years nobody seeded. They are filtered out here so they do
  // not also appear as raw text boxes.
  const thresholdRows = editable.filter(row => !row.key.startsWith('staff.bank_holidays.'));
  const internal = settings.find(row => row.key === INTERNAL);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Staff time &amp; company calendar</h2>
      <p className="text-sm text-gray-600 mb-4">
        Holiday, overtime and absence thresholds, the bank holiday calendar, and the
        days the company closes. Changing one takes effect within a minute — no deploy
        needed.
      </p>

      {error && <div className="mb-3 p-2 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {success && <div className="mb-3 p-2 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{success}</div>}

      <div className="space-y-3">
        {thresholdRows.map(row => STRUCTURED_EDITORS[row.key] ? (
          // A JSON setting gets a real editor rather than a one-line box.
          // It still reads and writes the same string, so saving is unchanged.
          <div key={row.key} className="pt-2">
            <p className="text-sm text-gray-700">
              {row.label ?? row.key}
              <span className="block text-xs text-gray-400 font-mono">{row.key}</span>
            </p>
            <div className="mt-2">
              {(() => {
                const Editor = STRUCTURED_EDITORS[row.key];
                return <Editor value={vals[row.key] ?? ''}
                  onChange={next => setVals(v => ({ ...v, [row.key]: next }))} />;
              })()}
            </div>
          </div>
        ) : (
          <div key={row.key} className="grid sm:grid-cols-[minmax(0,1fr)_10rem] gap-2 sm:items-center">
            <label htmlFor={row.key} className="text-sm text-gray-700">
              {row.label ?? row.key}
              <span className="block text-xs text-gray-400 font-mono">{row.key}</span>
            </label>
            <input id={row.key} value={vals[row.key] ?? ''}
              onChange={e => setVals(v => ({ ...v, [row.key]: e.target.value }))}
              className="px-2 py-1.5 rounded border border-gray-300 text-sm" />
          </div>
        ))}
      </div>

      <BankHolidayOverrides onError={setError} onSuccess={setSuccess} />

      <CompanyDaysSection onError={setError} onSuccess={setSuccess} />

      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => void save()} disabled={saving}
          className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {internal && (
          <span className="text-xs text-gray-400">
            Year-end cash-out reminder last sent for:{' '}
            <strong>{internal.value || 'never'}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Bank holidays — computed for any year, overridable for the odd one.
 *
 * The dates are worked out from the rules (`services/bank-holidays.ts`) rather
 * than stored, so there is no year to "add" and nothing to keep topped up. This
 * shows what any year resolves to and lets an admin pin a corrected list if the
 * arithmetic is ever wrong — which needs its own endpoint, because the generic
 * settings PUT only updates rows that already exist.
 */
function BankHolidayOverrides({ onError, onSuccess }: {
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [dates, setDates] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: string[] }>(`/staff-calendar/bank-holidays?year=${year}`);
      setDates(res.data);
      setDraft(res.data.join(', '));
    } catch {
      onError('Could not load bank holidays.');
    } finally { setLoading(false); }
  }, [year, onError]);

  useEffect(() => { void load(); setEditing(false); }, [load]);

  async function saveOverride(list: string[]) {
    setSaving(true);
    try {
      await api.put(`/staff-calendar/bank-holidays/${year}`, { dates: list });
      onSuccess(list.length > 0
        ? `${year} pinned to ${list.length} date${list.length === 1 ? '' : 's'}.`
        : `${year} handed back to the automatic dates.`);
      setEditing(false);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to save those dates');
    } finally { setSaving(false); }
  }

  return (
    <div className="mt-5 pt-4 border-t border-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-gray-900">Bank holidays</h3>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          aria-label="Bank holiday year"
          className="px-2 py-1 rounded border border-gray-300 text-sm">
          {Array.from({ length: 8 }, (_, i) => thisYear - 1 + i).map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        England &amp; Wales, <strong>worked out automatically</strong> for any year —
        weekend substitutes included — so there is nothing to keep topped up. Under the{' '}
        <code>use_allowance</code> policy these are marked on the calendar but are
        ordinary working days. A one-off royal bank holiday is not a date change, it is
        the company being shut — that is a company day, not this.
      </p>

      {loading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : editing ? (
        <div className="space-y-2">
          <textarea rows={3} value={draft} onChange={e => setDraft(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 text-sm font-mono"
            placeholder="2029-01-01, 2029-03-30, …" />
          <div className="flex flex-wrap gap-2">
            <button disabled={saving}
              onClick={() => void saveOverride(
                draft.split(',').map(d => d.trim()).filter(Boolean))}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
              Pin these dates
            </button>
            <button disabled={saving} onClick={() => void saveOverride([])}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">
              Use the automatic dates
            </button>
            <button onClick={() => { setEditing(false); setDraft(dates.join(', ')); }}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {dates.map(d => (
              <span key={d} className="text-xs px-2 py-1 rounded bg-violet-50 text-violet-800 font-mono">
                {d}
              </span>
            ))}
          </div>
          <button onClick={() => setEditing(true)}
            className="text-sm text-ooosh-600 hover:underline">
            Correct {year}&apos;s dates
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Company days — the days the company grants to everyone (spec §20).
 *
 * Lives next to bank holidays because they are the same kind of thing from a
 * staff member's point of view: days that are not normal working days. The
 * difference is that bank holidays are computed and are NOT days off under the
 * current policy, whereas these are granted and cost nobody any allowance.
 *
 * The staff calendar links here, because noticing you need one and configuring
 * it are different moments and only the second wants a form.
 */
function CompanyDaysSection({ onError, onSuccess }: {
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  interface CompanyDay {
    id: string; dayDate: string; label: string; recurs: boolean;
    status: 'active' | 'cancelled'; notes: string | null;
  }
  interface Occurrence { date: string; label: string; companyDayId: string }
  interface ReclaimCandidate {
    dayId: string; personId: string; personName: string;
    date: string; minutes: number; leaveType: string;
  }

  const thisYear = new Date().getUTCFullYear();
  const [days, setDays] = useState<CompanyDay[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [year, setYear] = useState(thisYear);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reclaim, setReclaim] = useState<{ dayLabel: string; id: string; candidates: ReclaimCandidate[] } | null>(null);

  const [dayDate, setDayDate] = useState(`${thisYear}-12-25`);
  const [label, setLabel] = useState('');
  const [recurs, setRecurs] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: CompanyDay[]; occurrences: Occurrence[] }>(
        `/staff-calendar/company-days?year=${year}`);
      setDays(res.data);
      setOccurrences(res.occurrences ?? []);
    } catch {
      onError('Could not load company days (has migration 219 run?).');
    } finally { setLoading(false); }
  }, [year, onError]);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!label.trim()) { onError('Give the day a name — it shows on everyone\'s calendar.'); return; }
    setSaving(true);
    try {
      const res = await api.post<{ data: CompanyDay; reclaimCandidates: ReclaimCandidate[] }>(
        '/staff-calendar/company-days', { dayDate, label, recurs });
      onSuccess(`${res.data.label} added.`);
      setAdding(false); setLabel(''); setRecurs(false);
      // Anyone who had already booked it off has paid for a day they are now
      // being given. Surfaced immediately, applied only if asked.
      if (res.reclaimCandidates?.length > 0) {
        setReclaim({ dayLabel: res.data.label, id: res.data.id, candidates: res.reclaimCandidates });
      }
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to add that day');
    } finally { setSaving(false); }
  }

  async function giveBack(ids: string[]) {
    if (!reclaim) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/company-days/${reclaim.id}/reclaim`, { leaveDayIds: ids });
      onSuccess(`${ids.length} booked day${ids.length === 1 ? '' : 's'} given back.`);
      setReclaim(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to give those days back');
    } finally { setSaving(false); }
  }

  async function cancel(d: CompanyDay) {
    const reason = window.prompt(`Why is "${d.label}" being withdrawn? (kept on the record)`);
    if (!reason) return;
    try {
      await api.post(`/staff-calendar/company-days/${d.id}/cancel`, { reason });
      onSuccess(`${d.label} withdrawn.`);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to withdraw that day');
    }
  }

  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(dt.getTime()) ? iso
      : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  return (
    <div className="mt-5 pt-4 border-t border-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-gray-900">Company days</h3>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            aria-label="Company day year"
            className="px-2 py-1 rounded border border-gray-300 text-sm">
            {Array.from({ length: 4 }, (_, i) => thisYear - 1 + i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button onClick={() => setAdding(a => !a)}
            className="px-3 py-1 text-sm rounded border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50">
            {adding ? 'Cancel' : 'Add a day'}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Days the company gives everyone — a Christmas closure, a day around a bank
        holiday. They <strong>cost nobody any allowance</strong>, nobody can book leave
        on them, and they do not count toward cover. Anyone who had already booked one
        off gets it handed back.
      </p>

      {adding && (
        <div className="mb-3 p-3 rounded border border-ooosh-200 bg-ooosh-50/40 space-y-2">
          <div className="grid sm:grid-cols-3 gap-2">
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Date</span>
              <input type="date" value={dayDate} onChange={e => setDayDate(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">What is it</span>
              <input value={label} onChange={e => setLabel(e.target.value)}
                placeholder="Christmas Day · Office closed"
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={recurs} onChange={e => setRecurs(e.target.checked)} />
            Every year on this date
          </label>
          <p className="text-xs text-gray-500">
            Tick it for something fixed like Christmas Day and it looks after itself.
            Leave it for a one-off — you get a reminder each November to set the next
            year&apos;s.
          </p>
          <button disabled={saving} onClick={() => void add()}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            Add it
          </button>
        </div>
      )}

      {reclaim && (
        <div className="mb-3 p-3 rounded border border-sky-200 bg-sky-50">
          <p className="text-sm text-sky-900 mb-2">
            <strong>{reclaim.candidates.length}</strong> booked day
            {reclaim.candidates.length === 1 ? ' has' : 's have'} been overtaken by{' '}
            {reclaim.dayLabel}. Give the allowance back?
          </p>
          <ul className="text-sm text-sky-900 mb-2 space-y-0.5">
            {reclaim.candidates.map(c => (
              <li key={c.dayId}>
                {c.personName} — {fmt(c.date)} ({c.leaveType === 'toil' ? 'TOIL' : 'holiday'})
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button disabled={saving}
              onClick={() => void giveBack(reclaim.candidates.map(c => c.dayId))}
              className="px-3 py-1.5 text-sm rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
              Give all {reclaim.candidates.length} back
            </button>
            <button onClick={() => setReclaim(null)}
              className="px-3 py-1.5 text-sm rounded border border-sky-300 bg-white hover:bg-sky-100">
              Leave them as they are
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          {days.length === 0 ? (
            <div className="text-sm text-gray-400 mb-2">None set up.</div>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded mb-2">
              {days.map(d => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium text-gray-900">{d.label}</span>
                  <span className="text-gray-500">
                    {d.recurs
                      ? `every ${fmt(d.dayDate).replace(/^\w{3} /, '')}`
                      : fmt(d.dayDate) + ' ' + d.dayDate.slice(0, 4)}
                  </span>
                  {d.recurs && (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                      Recurring
                    </span>
                  )}
                  <button onClick={() => void cancel(d)}
                    className="ml-auto text-xs text-red-600 hover:underline">
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="text-xs text-gray-500">
            <span className="font-medium">{year}:</span>{' '}
            {occurrences.length === 0
              ? 'no company days'
              : occurrences.map(o => `${fmt(o.date)} (${o.label})`).join(' · ')}
          </div>
        </>
      )}
    </div>
  );
}
