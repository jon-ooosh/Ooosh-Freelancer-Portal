import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { Navigate } from 'react-router-dom';

interface TeamUser {
  id: string;
  email: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
}

interface BackupEntry {
  key: string;
  filename: string;
  size: number;
  sizeMB: string;
  created_at: string;
}

const ROLES = ['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager', 'freelancer'] as const;

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
  general_assistant: 'General Assistant',
  weekend_manager: 'Weekend Manager',
  freelancer: 'Freelancer',
};

const roleBadgeColors: Record<string, string> = {
  admin: 'bg-red-100 text-red-700',
  manager: 'bg-blue-100 text-blue-700',
  staff: 'bg-green-100 text-green-700',
  general_assistant: 'bg-amber-100 text-amber-700',
  weekend_manager: 'bg-purple-100 text-purple-700',
  freelancer: 'bg-teal-100 text-teal-700',
};

function getPasswordStrength(pw: string): { score: number; label: string; color: string; checks: string[] } {
  const checks: string[] = [];
  let score = 0;

  if (pw.length >= 8) score++;
  else checks.push('At least 8 characters');

  if (pw.length >= 12) score++;

  if (/[A-Z]/.test(pw)) score++;
  else checks.push('An uppercase letter');

  if (/[a-z]/.test(pw)) score++;
  else checks.push('A lowercase letter');

  if (/\d/.test(pw)) score++;
  else checks.push('A number');

  if (/[^A-Za-z0-9]/.test(pw)) score++;
  else checks.push('A special character');

  if (score <= 2) return { score, label: 'Weak', color: 'bg-red-500', checks };
  if (score <= 3) return { score, label: 'Fair', color: 'bg-amber-500', checks };
  if (score <= 4) return { score, label: 'Good', color: 'bg-blue-500', checks };
  return { score, label: 'Strong', color: 'bg-green-500', checks };
}

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);

  if (user?.role !== 'admin' && user?.role !== 'manager') {
    return <Navigate to="/" replace />;
  }

  return <SettingsContent />;
}

function SettingsContent() {
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // New user form
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<string>('staff');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Edit user
  const [editingUser, setEditingUser] = useState<TeamUser | null>(null);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const data = await api.get<{ data: TeamUser[] }>('/users');
      setUsers(data.data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }

  const strength = getPasswordStrength(password);
  const isPasswordStrong = password.length >= 8 && strength.score >= 3;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!isPasswordStrong) {
      setError('Password is too weak. Please add: ' + strength.checks.join(', '));
      return;
    }

    setSubmitting(true);

    try {
      await api.post('/auth/register', {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
      });

      setSuccess(`${firstName} ${lastName} has been added as ${ROLE_LABELS[role] || role}.`);
      setFirstName('');
      setLastName('');
      setEmail('');
      setPassword('');
      setRole('staff');
      setShowForm(false);
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(u: TeamUser) {
    setEditingUser(u);
    setEditFirstName(u.first_name || '');
    setEditLastName(u.last_name || '');
    setEditEmail(u.email);
    setEditRole(u.role);
    setEditError('');
  }

  function cancelEdit() {
    setEditingUser(null);
    setEditError('');
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setEditError('');
    setEditSubmitting(true);

    try {
      await api.put(`/users/${editingUser.id}`, {
        first_name: editFirstName.trim(),
        last_name: editLastName.trim(),
        email: editEmail.trim().toLowerCase(),
        role: editRole,
      });

      setEditingUser(null);
      loadUsers();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDeactivate(userId: string) {
    if (!confirm('Deactivate this user? They will no longer be able to log in.')) return;
    try {
      await api.put(`/users/${userId}`, { is_active: false });
      loadUsers();
    } catch (err) {
      console.error('Failed to deactivate user:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage user accounts and platform settings</p>
        </div>
      </div>

      {/* Team Members section */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Team Members</h2>
          <button
            onClick={() => { setShowForm(!showForm); setError(''); setSuccess(''); }}
            className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
          >
            {showForm ? 'Cancel' : 'Add User'}
          </button>
        </div>

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
            {success}
          </div>
        )}

        {/* Add user form */}
        {showForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Add New User</h3>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm mb-4">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                  <input
                    type="text"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input
                    type="text"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@oooshtours.co.uk"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full rounded border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs font-medium px-1"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>

                {password.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${strength.color}`}
                          style={{ width: `${Math.min((strength.score / 6) * 100, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-medium ${
                        strength.label === 'Weak' ? 'text-red-600' :
                        strength.label === 'Fair' ? 'text-amber-600' :
                        strength.label === 'Good' ? 'text-blue-600' : 'text-green-600'
                      }`}>
                        {strength.label}
                      </span>
                    </div>
                    {strength.checks.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        Needs: {strength.checks.join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting || !isPasswordStrong}
                  className="bg-ooosh-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Users list */}
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              {editingUser?.id === u.id ? (
                /* Edit mode */
                <form onSubmit={handleEditSubmit}>
                  {editError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">
                      {editError}
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">First Name</label>
                      <input
                        type="text"
                        required
                        value={editFirstName}
                        onChange={(e) => setEditFirstName(e.target.value)}
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Last Name</label>
                      <input
                        type="text"
                        required
                        value={editLastName}
                        onChange={(e) => setEditLastName(e.target.value)}
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
                      <input
                        type="email"
                        required
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="submit"
                      disabled={editSubmitting}
                      className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                    >
                      {editSubmitting ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="px-4 py-1.5 rounded text-sm font-medium border border-gray-300 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                /* View mode */
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {(u.first_name || u.email)[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.email}
                      </div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${roleBadgeColors[u.role] || 'bg-gray-100 text-gray-700'}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                    <button
                      onClick={() => startEdit(u)}
                      className="text-xs text-gray-400 hover:text-ooosh-600 transition-colors px-2 py-1"
                    >
                      Edit
                    </button>
                    {u.id !== currentUser?.id && (
                      <button
                        onClick={() => handleDeactivate(u.id)}
                        className="text-xs text-gray-400 hover:text-red-600 transition-colors px-2 py-1"
                      >
                        Deactivate
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          {users.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-8">No users found.</p>
          )}
        </div>
      </div>

      {/* Calculator Settings — admin & manager */}
      <CostingSettingsSection />

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
