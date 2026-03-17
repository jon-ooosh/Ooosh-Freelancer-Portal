import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface TeamUser {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
  first_name: string | null;
  last_name: string | null;
  last_login: string | null;
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

export default function TeamPage() {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'manager';

  // New user form
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('staff');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const data = await api.get<{ data: TeamUser[] }>('/users?include_inactive=true');
      setUsers(data.data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
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

  async function toggleActive(user: TeamUser) {
    if (user.id === currentUser?.id) return;
    const action = user.is_active ? 'lock' : 'unlock';
    if (!confirm(`Are you sure you want to ${action} ${user.first_name || user.email}'s account?`)) return;
    try {
      await api.put(`/users/${user.id}`, { is_active: !user.is_active });
      setSuccess(`${user.first_name || user.email}'s account has been ${action}ed.`);
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} account`);
    }
  }

  async function saveRole(userId: string) {
    try {
      await api.put(`/users/${userId}`, { role: editRole });
      setEditingId(null);
      setSuccess('Role updated.');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  const activeUsers = users.filter((u) => u.is_active);
  const inactiveUsers = users.filter((u) => !u.is_active);
  const displayUsers = showInactive ? users : activeUsers;

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team</h1>
          <p className="text-sm text-gray-500 mt-1">
            {activeUsers.length} active user{activeUsers.length !== 1 ? 's' : ''}
            {inactiveUsers.length > 0 && (
              <span className="text-gray-400"> &middot; {inactiveUsers.length} locked</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {inactiveUsers.length > 0 && (
            <button
              onClick={() => setShowInactive(!showInactive)}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              {showInactive ? 'Hide locked' : 'Show locked'}
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => { setShowForm(!showForm); setError(''); setSuccess(''); }}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              {showForm ? 'Cancel' : 'Add User'}
            </button>
          )}
        </div>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {success}
        </div>
      )}

      {error && !showForm && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {/* Add user form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Add New User</h2>

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
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
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
                disabled={submitting}
                className="bg-ooosh-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
              >
                {submitting ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users list */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              {isAdmin && (
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {displayUsers.map((u) => (
              <tr key={u.id} className={`hover:bg-gray-50 ${!u.is_active ? 'opacity-50' : ''}`}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                      u.is_active ? 'bg-ooosh-100 text-ooosh-700' : 'bg-gray-200 text-gray-500'
                    }`}>
                      {(u.first_name || u.email)[0].toUpperCase()}
                    </div>
                    <span className="text-sm font-medium text-gray-900">
                      {u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.email}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{u.email}</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {editingId === u.id ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-ooosh-500 focus:outline-none"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                      <button onClick={() => saveRole(u.id)} className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium">Save</button>
                      <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    </div>
                  ) : (
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${roleBadgeColors[u.role] || 'bg-gray-100 text-gray-700'} ${isAdmin && u.id !== currentUser?.id ? 'cursor-pointer hover:ring-2 hover:ring-ooosh-200' : ''}`}
                      onClick={() => {
                        if (isAdmin && u.id !== currentUser?.id) {
                          setEditingId(u.id);
                          setEditRole(u.role);
                        }
                      }}
                      title={isAdmin && u.id !== currentUser?.id ? 'Click to change role' : undefined}
                    >
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {u.is_active ? (
                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Active</span>
                  ) : (
                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Locked</span>
                  )}
                </td>
                {isAdmin && (
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    {u.id !== currentUser?.id && (
                      <button
                        onClick={() => toggleActive(u)}
                        className={`text-xs font-medium ${
                          u.is_active
                            ? 'text-red-600 hover:text-red-700'
                            : 'text-green-600 hover:text-green-700'
                        }`}
                      >
                        {u.is_active ? 'Lock Account' : 'Unlock'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {displayUsers.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-6 py-8 text-center text-sm text-gray-400">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
