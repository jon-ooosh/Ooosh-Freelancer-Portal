import { useState, useRef } from 'react';
import { useAuthStore } from '../hooks/useAuthStore';
import { api } from '../services/api';

function PasswordStrength({ password }: { password: string }) {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];
  const idx = Math.min(score, 4);

  if (!password) return null;

  return (
    <div className="mt-1">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded ${i <= idx ? colors[idx] : 'bg-gray-200'}`} />
        ))}
      </div>
      <p className={`text-xs mt-0.5 ${score >= 3 ? 'text-green-600' : score >= 2 ? 'text-yellow-600' : 'text-red-600'}`}>
        {labels[idx]}
      </p>
    </div>
  );
}

function EyeIcon() {
  return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
}
function EyeOffIcon() {
  return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>;
}

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  // Profile fields
  const [firstName, setFirstName] = useState(user?.first_name || '');
  const [lastName, setLastName] = useState(user?.last_name || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Avatar
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase();

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault();
    setProfileSaving(true);
    setProfileMsg(null);

    try {
      const result = await api.put<{ first_name: string; last_name: string }>('/auth/profile', {
        first_name: firstName,
        last_name: lastName,
      });
      updateUser({ first_name: result.first_name, last_name: result.last_name });
      setProfileMsg({ type: 'success', text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update profile' });
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMsg(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'error', text: 'Password must be at least 8 characters.' });
      return;
    }

    setPasswordSaving(true);
    try {
      await api.post('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPasswordMsg({ type: 'success', text: 'Password changed successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      updateUser({ force_password_change: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to change password';
      setPasswordMsg({ type: 'error', text: message });
    } finally {
      setPasswordSaving(false);
    }
  }

  // Compress image client-side before upload (max 256x256, JPEG quality 0.8)
  function compressImage(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 256;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : resolve(file),
          'image/jpeg',
          0.8
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setAvatarUploading(true);
    setAvatarMsg(null);

    try {
      const compressed = await compressImage(file);
      const formData = new FormData();
      formData.append('avatar', compressed, 'avatar.jpg');
      const result = await api.upload<{ avatar_url: string }>('/auth/avatar', formData);
      updateUser({ avatar_url: result.avatar_url });
      setAvatarMsg({ type: 'success', text: 'Photo updated.' });
    } catch (err) {
      setAvatarMsg({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleAvatarRemove() {
    setAvatarUploading(true);
    setAvatarMsg(null);
    try {
      await api.delete('/auth/avatar');
      updateUser({ avatar_url: null });
      setAvatarMsg({ type: 'success', text: 'Photo removed.' });
    } catch (err) {
      setAvatarMsg({ type: 'error', text: err instanceof Error ? err.message : 'Remove failed' });
    } finally {
      setAvatarUploading(false);
    }
  }

  const ROLE_LABELS: Record<string, string> = {
    admin: 'Admin',
    manager: 'Manager',
    staff: 'Staff',
    general_assistant: 'General Assistant',
    weekend_manager: 'Weekend Manager',
    freelancer: 'Freelancer',
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
        <p className="text-sm text-gray-500 mt-1">Manage your account details and password.</p>
      </div>

      {/* Force password change banner */}
      {user?.force_password_change && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <p className="text-sm font-medium text-amber-800">
              An admin has requested you change your password. Please update it below.
            </p>
          </div>
        </div>
      )}

      {/* Avatar section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Profile Photo</h2>
        <div className="flex items-center gap-6">
          {user?.avatar_url ? (
            <img
              src={`/api/auth/avatar/${user.avatar_url.split('/').pop()}`}
              alt="Profile"
              className="w-20 h-20 rounded-full object-cover ring-2 ring-gray-200"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-ooosh-600 flex items-center justify-center text-2xl font-bold text-white ring-2 ring-gray-200">
              {initials}
            </div>
          )}
          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
                className="px-3 py-1.5 text-sm font-medium bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
              >
                {avatarUploading ? 'Uploading...' : 'Upload Photo'}
              </button>
              {user?.avatar_url && (
                <button
                  onClick={handleAvatarRemove}
                  disabled={avatarUploading}
                  className="px-3 py-1.5 text-sm font-medium text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500">JPG, PNG, GIF or WebP. Max 5MB.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleAvatarUpload}
              className="hidden"
            />
            {avatarMsg && (
              <p className={`text-xs ${avatarMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {avatarMsg.text}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Profile details */}
      <form onSubmit={handleProfileSave} className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Account Details</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={user?.email || ''}
              disabled
              className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
            />
            <p className="text-xs text-gray-400 mt-1">Contact an admin to change your email.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <input
              type="text"
              value={ROLE_LABELS[user?.role || ''] || user?.role || ''}
              disabled
              className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={profileSaving}
            className="px-4 py-2 bg-ooosh-600 text-white rounded text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
          >
            {profileSaving ? 'Saving...' : 'Save Changes'}
          </button>
          {profileMsg && (
            <span className={`text-sm ${profileMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
              {profileMsg.text}
            </span>
          )}
        </div>
      </form>

      {/* Password change */}
      <form onSubmit={handlePasswordChange} className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Change Password</h2>
        <div className="space-y-4 max-w-sm">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
            <div className="relative">
              <input
                type={showCurrentPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                required
              />
              <button type="button" onClick={() => setShowCurrentPassword(!showCurrentPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showCurrentPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <div className="relative">
              <input
                type={showNewPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                required
                minLength={8}
              />
              <button type="button" onClick={() => setShowNewPassword(!showNewPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showNewPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            <PasswordStrength password={newPassword} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`w-full rounded border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-1 ${
                  confirmPassword && confirmPassword !== newPassword
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                    : 'border-gray-300 focus:border-ooosh-500 focus:ring-ooosh-500'
                }`}
                required
                minLength={8}
              />
              <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showConfirmPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {confirmPassword && confirmPassword !== newPassword && (
              <p className="text-xs text-red-600 mt-1">Passwords do not match.</p>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={passwordSaving}
            className="px-4 py-2 bg-ooosh-600 text-white rounded text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
          >
            {passwordSaving ? 'Changing...' : 'Change Password'}
          </button>
          {passwordMsg && (
            <span className={`text-sm ${passwordMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
              {passwordMsg.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
