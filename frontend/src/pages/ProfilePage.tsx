import { useState, useRef } from 'react';
import { useAuthStore } from '../hooks/useAuthStore';
import { displayFullName, displayInitials } from '../lib/displayName';
import { api } from '../services/api';

// Client-side only — a nudge, not a rule. The server's only rule is 8+ chars.
// +1 each for 8+ characters, 12+ characters, mixed case, a digit, a symbol;
// capped at 4 so the five bars read Very weak … Strong.
function passwordScore(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score, 4);
}

function PasswordStrength({ password }: { password: string }) {
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];
  const idx = passwordScore(password);

  if (!password) return null;

  return (
    <div className="mt-0.5 flex flex-col gap-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded-full ${i <= idx ? colors[idx] : 'bg-gray-200'}`} />
        ))}
      </div>
      <p className={`text-xs ${idx >= 3 ? 'text-emerald-700' : idx >= 2 ? 'text-yellow-700' : 'text-red-600'}`}>
        {labels[idx]}
      </p>
    </div>
  );
}

// Shared field styling. 16px text on a phone so iOS doesn't zoom in.
const LABEL = 'flex flex-col gap-1.5 text-[13px] text-gray-600';
const INPUT = 'w-full px-3 py-2.5 rounded-lg border border-gray-300 text-base sm:text-[15px] text-gray-900 focus:outline-none focus:border-ooosh-500 focus:ring-1 focus:ring-ooosh-500';
const READONLY = 'px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-base sm:text-[15px] text-gray-500 break-all';
const BTN_PRIMARY = 'inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-[18px] py-2.5 rounded-lg bg-ooosh-600 text-white text-sm font-semibold hover:bg-ooosh-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors';

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  // Profile fields
  const [firstName, setFirstName] = useState(user?.first_name || '');
  const [lastName, setLastName] = useState(user?.last_name || '');
  const [preferredName, setPreferredName] = useState(user?.preferred_name || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Avatar
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = displayInitials(user);

  // Save is only offered once something differs from what's stored.
  const profileDirty = firstName !== (user?.first_name || '')
    || lastName !== (user?.last_name || '')
    || preferredName.trim() !== (user?.preferred_name || '').trim();
  const passwordMismatch = !!confirmPassword && confirmPassword !== newPassword;
  const passwordReady = !!currentPassword && newPassword.length >= 8 && newPassword === confirmPassword;
  // The card reads what's typed, so a new preferred name shows before saving.
  const liveName = displayFullName({ ...user, first_name: firstName, last_name: lastName, preferred_name: preferredName });

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault();
    setProfileSaving(true);
    setProfileMsg(null);

    try {
      // preferred_name always goes, including as '' — that is how the field
      // says "clear it and go back to my first name".
      const payload: Record<string, unknown> = {
        first_name: firstName,
        last_name: lastName,
        preferred_name: preferredName.trim(),
      };
      const result = await api.put<{ first_name: string; last_name: string; preferred_name: string | null }>('/auth/profile', payload);
      updateUser({
        first_name: result.first_name,
        last_name: result.last_name,
        preferred_name: result.preferred_name ?? null,
      });
      setProfileMsg({ type: 'success', text: 'Saved.' });
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
      setPasswordMsg({ type: 'success', text: 'Password changed.' });
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

  const roleLabel = ROLE_LABELS[user?.role || ''] || user?.role || '';
  const preferredTrim = preferredName.trim();

  return (
    <div className="flex flex-col gap-4">
      {/* Force password change banner */}
      {user?.force_password_change && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
          <svg className="w-5 h-5 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <p className="text-sm font-medium text-amber-800">
            An admin has asked you to change your password — do it below before carrying on.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {/* Avatar section — the identity card */}
        <div className="flex-[1_1_280px] min-w-0 bg-white border border-gray-200 rounded-xl px-6 py-7 flex flex-col items-center text-center gap-3.5">
          {user?.avatar_url ? (
            // Public endpoint (no JWT needed), so a plain <img> is right here.
            <img
              src={`/api/auth/avatar/${user.avatar_url.split('/').pop()}`}
              alt="Profile"
              className="w-28 h-28 rounded-full object-cover ring-4 ring-ooosh-50"
            />
          ) : (
            <div className="w-28 h-28 rounded-full bg-ooosh-600 flex items-center justify-center text-4xl font-semibold text-white ring-4 ring-ooosh-50">
              {initials}
            </div>
          )}
          <div className="min-w-0 max-w-full">
            <div className="text-xl font-semibold text-gray-900 break-words">{liveName}</div>
            <div className="mt-[3px] text-sm text-gray-500 break-all">{user?.email}</div>
          </div>
          {roleLabel && (
            <span className="px-2.5 py-[3px] rounded-full bg-ooosh-100 text-ooosh-700 text-xs font-semibold">{roleLabel}</span>
          )}
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              className="inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-ooosh-600 text-white text-sm font-semibold hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
            >
              {avatarUploading ? 'Uploading…' : user?.avatar_url ? 'Change photo' : 'Upload a photo'}
            </button>
            {user?.avatar_url && (
              <button
                onClick={handleAvatarRemove}
                disabled={avatarUploading}
                className="inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-red-200 bg-white text-red-600 text-sm hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400">JPG, PNG, GIF or WebP, up to 5MB. It shows next to your name across the app.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={handleAvatarUpload}
            className="hidden"
          />
          {avatarMsg && (
            <p className={`text-xs ${avatarMsg.type === 'success' ? 'text-emerald-700' : 'text-red-600'}`}>
              {avatarMsg.text}
            </p>
          )}
        </div>

        <div className="flex-[2_1_520px] min-w-0 flex flex-col gap-4">
          {/* Profile details */}
          <form onSubmit={handleProfileSave} className="bg-white border border-gray-200 rounded-xl px-5 sm:px-6 py-5 flex flex-col gap-4">
            <h2 className="text-[17px] font-semibold text-gray-900">Your details</h2>
            <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
              <label className={LABEL}>
                First name
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => { setFirstName(e.target.value); setProfileMsg(null); }}
                  className={INPUT}
                  required
                />
              </label>
              <label className={LABEL}>
                Last name
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => { setLastName(e.target.value); setProfileMsg(null); }}
                  className={INPUT}
                  required
                />
              </label>
              <label className={`${LABEL} col-span-full`}>
                What should we call you?
                <input
                  type="text"
                  maxLength={60}
                  value={preferredName}
                  onChange={(e) => { setPreferredName(e.target.value); setProfileMsg(null); }}
                  className={INPUT}
                  placeholder={firstName || user?.first_name || 'your first name'}
                />
                <span className="text-xs text-gray-400">
                  {preferredTrim
                    ? `The app will call you ${preferredTrim}.`
                    : `Leave it empty to go by ${firstName || user?.first_name || 'your first name'}.`}
                </span>
              </label>
              <div className={LABEL}>
                Email
                <div className={READONLY}>{user?.email || ''}</div>
                <span className="text-xs text-gray-400">Ask an admin to change this.</span>
              </div>
              <div className={LABEL}>
                Role
                <div className={READONLY}>{roleLabel}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={profileSaving || !profileDirty} className={BTN_PRIMARY}>
                {profileSaving ? 'Saving…' : 'Save changes'}
              </button>
              {profileMsg ? (
                <span className={`text-[13px] ${profileMsg.type === 'success' ? 'text-emerald-700' : 'text-red-600'}`}>
                  {profileMsg.text}
                </span>
              ) : profileDirty ? (
                <span className="text-[13px] text-amber-800">You have unsaved changes.</span>
              ) : null}
            </div>
          </form>

          {/* Password change */}
          <form onSubmit={handlePasswordChange} className="bg-white border border-gray-200 rounded-xl px-5 sm:px-6 py-5 flex flex-col gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-gray-900">Password</h2>
              <p className="mt-0.5 text-[13px] text-gray-500">At least 8 characters. Longer is better than clever.</p>
            </div>
            <div className="grid gap-4 items-start grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
              <label className={`${LABEL} col-span-full sm:max-w-[calc(50%-8px)] sm:min-w-[220px]`}>
                Current password
                <input
                  type={showPasswords ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={INPUT}
                  required
                />
              </label>
              <label className={LABEL}>
                New password
                <input
                  type={showPasswords ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={INPUT}
                  required
                  minLength={8}
                />
                <PasswordStrength password={newPassword} />
              </label>
              <label className={LABEL}>
                Type it again
                <input
                  type={showPasswords ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`${INPUT} ${passwordMismatch ? '!border-red-300 focus:!border-red-500 focus:!ring-red-500' : ''}`}
                  required
                  minLength={8}
                />
                {passwordMismatch && <span className="text-xs text-red-600">Doesn’t match yet</span>}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" disabled={passwordSaving || !passwordReady} className={BTN_PRIMARY}>
                {passwordSaving ? 'Changing…' : 'Change password'}
              </button>
              <label className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 text-[13px] text-gray-600 cursor-pointer">
                <input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} className="w-4 h-4 accent-ooosh-600" />
                Show passwords
              </label>
              {passwordMsg && (
                <span className={`text-[13px] ${passwordMsg.type === 'success' ? 'text-emerald-700' : 'text-red-600'}`}>
                  {passwordMsg.text}
                </span>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
