import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

// ---------------------------------------------------------------------------
// Portal sign-in — the freelancer portal's two-step sign-in, from the office's
// side (docs/FREELANCER-PORTAL-SPEC.md §7, Oct 2026). On the Freelancer tab.
//
// - When they last signed in, and how many phones the portal remembers.
// - "Give them a sign-in code": for a freelancer whose code email isn't
//   arriving. Read it out on the phone; they still need their password. Only
//   offered while the code is switched on (Settings › Login security & kiosk).
// - "Sign them out everywhere": forgets every remembered phone and ends every
//   portal session, e.g. a lost phone.
// Anyone on the staff team may use both (jon); both are audit-logged.
// ---------------------------------------------------------------------------

interface PortalSignInStatus {
  lastSignIn: string | null;
  rememberedPhones: number;
  hasPortalPassword: boolean;
  enforcedFrom: string | null;
  enforcedNow: boolean;
}

function fmtDateTime(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "2026-11-01" → "1 Nov 2026", without a timezone shift. */
function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (isNaN(dt.getTime())) return ymd;
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export default function PortalSignInCard({ personId }: { personId: string }) {
  const [status, setStatus] = useState<PortalSignInStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'code' | 'signout' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issued, setIssued] = useState<{ code: string; expiresAt: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: PortalSignInStatus }>(`/people/${personId}/portal-sign-in`);
      setStatus(r.data);
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load portal sign-in');
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  async function giveCode() {
    setBusy('code'); setError(''); setNotice('');
    try {
      const r = await api.post<{ data: { code: string; expiresMinutes: number } }>(`/people/${personId}/portal-sign-in/code`, {});
      setIssued({ code: r.data.code, expiresAt: Date.now() + r.data.expiresMinutes * 60_000 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make a code');
    } finally { setBusy(null); }
  }

  async function signOutEverywhere() {
    const words = status?.enforcedNow
      ? 'Sign them out of the portal on every phone? They will need their password and an emailed code next time.'
      : 'Sign them out of the portal on every phone? They will need their password next time.';
    if (!window.confirm(words)) return;
    setBusy('signout'); setError(''); setNotice(''); setIssued(null);
    try {
      await api.post(`/people/${personId}/portal-sign-in/sign-out`, {});
      setNotice('Signed out everywhere. Every remembered phone is forgotten.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign them out');
    } finally { setBusy(null); }
  }

  const expiresAt = issued ? new Date(issued.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-700">Portal sign-in</h3>

      {loadError && <p className="mt-2 text-sm text-red-600">{loadError}</p>}

      {status && (
        <>
          <dl className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Last signed in</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {status.hasPortalPassword ? (fmtDateTime(status.lastSignIn) || '—') : 'No portal login yet'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Remembered phones</dt>
              <dd className="mt-1 text-sm text-gray-900">{status.rememberedPhones}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Emailed code</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {status.enforcedNow
                  ? `On since ${fmtDay(status.enforcedFrom!)}`
                  : status.enforcedFrom ? `Starts ${fmtDay(status.enforcedFrom)}` : 'Off'}
              </dd>
            </div>
          </dl>

          {!status.hasPortalPassword && (
            <p className="mt-3 text-sm text-gray-500">
              They haven&apos;t set a portal password yet, so there&apos;s nothing to help with here. They sign up at the portal with this email.
            </p>
          )}

          {issued && (
            <div className="mt-4 rounded-lg border border-purple-200 bg-purple-50 p-4">
              <p className="text-sm text-purple-900">Read this out to them. It works until {expiresAt}, once, and they still need their password.</p>
              <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.25em] text-purple-900">{issued.code}</p>
              <p className="mt-2 text-xs text-purple-800">It replaces any code we emailed them. Only give it to the freelancer themselves.</p>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}

          {status.hasPortalPassword && (
            <div className="mt-4 flex flex-wrap gap-2">
              {status.enforcedNow && (
                <button
                  type="button"
                  onClick={() => void giveCode()}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-sm border border-purple-300 text-purple-700 rounded hover:bg-purple-50 transition-colors disabled:opacity-50"
                >
                  {busy === 'code' ? 'Making a code…' : issued ? 'Give them a new code' : 'Give them a sign-in code'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void signOutEverywhere()}
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {busy === 'signout' ? 'Signing out…' : 'Sign them out everywhere'}
              </button>
            </div>
          )}

          {status.hasPortalPassword && !status.enforcedNow && (
            <p className="mt-3 text-xs text-gray-500">
              The emailed code is {status.enforcedFrom ? 'not on yet' : 'switched off'} (an admin sets it in Settings › Login security &amp; kiosk), so they only need their password.
            </p>
          )}
        </>
      )}
    </div>
  );
}
