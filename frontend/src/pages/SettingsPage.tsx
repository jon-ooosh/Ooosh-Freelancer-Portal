import { useState, useEffect } from 'react';
import { hasManagerRole } from '../lib/roles';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { Navigate } from 'react-router-dom';
import XeroBankAccountsSection from '../components/XeroBankAccountsSection';

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

  if (!hasManagerRole(user?.role)) {
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
  const [editHhUserId, setEditHhUserId] = useState('');
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
    setEditHhUserId(u.hh_user_id ? String(u.hh_user_id) : '');
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
        hh_user_id: editHhUserId ? parseInt(editHhUserId, 10) : null,
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

  async function handleForcePassword(userId: string, userName: string) {
    const newPw = prompt(`Set a new temporary password for ${userName}.\nThey will be prompted to change it on next login.\n\nNew password (min 8 characters):`);
    if (!newPw) return;
    if (newPw.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }
    try {
      await api.post(`/users/${userId}/force-password`, { new_password: newPw });
      setSuccess(`Password reset for ${userName}. They will be prompted to change it on next login.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reset password');
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
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full rounded border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    )}
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
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">HireHop User ID</label>
                      <input
                        type="number"
                        value={editHhUserId}
                        onChange={(e) => setEditHhUserId(e.target.value)}
                        placeholder="e.g. 42"
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                      <p className="text-xs text-gray-400 mt-0.5">Sets manager on HH jobs created by this user</p>
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
                    {u.avatar_url ? (
                      <img
                        src={`/api/auth/avatar/${u.avatar_url.split('/').pop()}`}
                        alt=""
                        className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {(u.first_name || u.email)[0].toUpperCase()}
                      </div>
                    )}
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
                      <>
                        <button
                          onClick={() => handleForcePassword(u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email)}
                          className="text-xs text-gray-400 hover:text-amber-600 transition-colors px-2 py-1"
                        >
                          Reset Password
                        </button>
                        <button
                          onClick={() => handleDeactivate(u.id)}
                          className="text-xs text-gray-400 hover:text-red-600 transition-colors px-2 py-1"
                        >
                          Deactivate
                        </button>
                      </>
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

      {/* Out-of-Hours return settings — admin & manager */}
      <OohSettingsSection />

      <CarnetSettingsSection />

      {/* Auto-chase draft voice — admin & manager */}
      <ChaseVoiceSettingsSection />

      {/* Xero bank account mapping — admin & manager */}
      <XeroBankAccountsSection />

      {/* Vehicle Issues settings — admin & manager */}
      <VehicleIssueSettingsSection />

      {/* COT card register — admin only */}
      {currentUser?.role === 'admin' && <CotCardRegisterSection />}

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

// ── Auto-Chase draft voice ───────────────────────────────────────────────────

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

// ── COT card register (admin only) ──────────────────────────────────────────
// Admin sets each staff member's company card (last 4 + a friendly label). The
// cost-capture flow stamps the card holder + last 4 from here server-side, so
// staff never type card details when logging a company-card purchase.

interface CotCardRow {
  id: string;
  email: string;
  is_active: boolean;
  first_name: string | null;
  last_name: string | null;
  cot_card_last4: string | null;
  cot_card_label: string | null;
}

function CotCardRegisterSection() {
  const [rows, setRows] = useState<CotCardRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { last4: string; label: string }>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ data: CotCardRow[] }>('/users/cot-cards')
      .then((res) => {
        setRows(res.data);
        const d: Record<string, { last4: string; label: string }> = {};
        res.data.forEach((r) => { d[r.id] = { last4: r.cot_card_last4 || '', label: r.cot_card_label || '' }; });
        setDrafts(d);
      })
      .catch((err) => { console.error('Failed to load COT cards:', err); setError('Could not load staff.'); })
      .finally(() => setLoading(false));
  }, []);

  async function save(id: string) {
    const draft = drafts[id];
    if (draft.last4 && !/^\d{4}$/.test(draft.last4)) { setError('Last 4 must be exactly 4 digits.'); return; }
    setError('');
    setSavingId(id);
    try {
      await api.patch(`/users/${id}/cot-card`, {
        cot_card_last4: draft.last4 || null,
        cot_card_label: draft.label.trim() || null,
      });
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, cot_card_last4: draft.last4 || null, cot_card_label: draft.label.trim() || null } : r));
      setSavedId(id);
      setTimeout(() => setSavedId((s) => s === id ? null : s), 2500);
    } catch (err) {
      console.error('Save COT card failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingId(null);
    }
  }

  const name = (r: CotCardRow) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email;
  const dirty = (r: CotCardRow) => (drafts[r.id]?.last4 || '') !== (r.cot_card_last4 || '') || (drafts[r.id]?.label.trim() || '') !== (r.cot_card_label || '');

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">COT Card Register</h2>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">COT Card Register</h2>
      <p className="text-xs text-gray-500 mb-4">
        Set each staff member's company card. The cost-capture form stamps the card holder + last 4 from here automatically — staff never type card details.
      </p>
      {error && <div className="mb-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-2 pr-3 font-medium">Staff</th>
              <th className="py-2 px-3 font-medium">Card last 4</th>
              <th className="py-2 px-3 font-medium">Card label</th>
              <th className="py-2 pl-3 font-medium text-right">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b border-gray-100 ${r.is_active ? '' : 'opacity-50'}`}>
                <td className="py-2 pr-3 text-gray-800">{name(r)}{!r.is_active && <span className="text-xs text-gray-400"> (inactive)</span>}</td>
                <td className="py-2 px-3">
                  <input value={drafts[r.id]?.last4 ?? ''} inputMode="numeric" maxLength={4}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...d[r.id], last4: e.target.value.replace(/\D/g, '').slice(0, 4) } }))}
                    placeholder="1234" className="w-20 border border-gray-300 rounded-md px-2 py-1 text-sm" />
                </td>
                <td className="py-2 px-3">
                  <input value={drafts[r.id]?.label ?? ''} maxLength={60}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...d[r.id], label: e.target.value } }))}
                    placeholder="e.g. Amex ·1234" className="w-40 border border-gray-300 rounded-md px-2 py-1 text-sm" />
                </td>
                <td className="py-2 pl-3 text-right">
                  {savedId === r.id ? <span className="text-xs text-green-600">Saved ✓</span> : (
                    <button onClick={() => save(r.id)} disabled={savingId === r.id || !dirty(r)}
                      className="px-3 py-1 text-xs text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-40">
                      {savingId === r.id ? '…' : 'Save'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
