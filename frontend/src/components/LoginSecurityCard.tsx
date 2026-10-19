/**
 * My profile › Login security (docs/STAFF-LOGIN-SECURITY-SPEC.md §2, §3).
 *
 * Shows whether this person has a second factor and lets them set one up
 * (LoginSecuritySetup — the same flow the banner's modal uses), lists their
 * passkeys and remembered devices, hands an admin new recovery codes, and offers
 * "Sign out everywhere".
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import LoginSecuritySetup, { guessDeviceLabel, addPasskeyLabel } from './LoginSecuritySetup';
import { passkeysSupported, registerPasskey, wasCancelled } from '../lib/passkeys';

interface Device { id: string; label: string; created_at: string; last_used_at: string; current: boolean }
interface Passkey { id: string; label: string; backed_up: boolean; created_at: string; last_used_at: string | null }
interface SecurityState {
  mfa_enrolled: boolean; mfa_enforced_from: string | null; passkey_required: boolean;
  devices: Device[]; passkeys: Passkey[]; recovery_codes_left: number | null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LoginSecurityCard() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const logout = useAuthStore((s) => s.logout);
  const [state, setState] = useState<SecurityState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try { setState(await api.get<SecurityState>('/auth/security')); } catch { /* card stays quiet */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function addPasskey() {
    setBusy(true); setMsg(null);
    try {
      const r = await registerPasskey(guessDeviceLabel());
      updateUser({ mfa_enrolled: true, passkeys: (user?.passkeys ?? 0) + 1, passkey_required: false });
      if (r.recoveryCodes?.length) setNewCodes(r.recoveryCodes);
      setMsg({ type: 'ok', text: 'Passkey added.' });
      await load();
    } catch (err) {
      if (!wasCancelled(err)) setMsg({ type: 'error', text: err instanceof Error ? err.message : 'The passkey could not be added' });
    } finally { setBusy(false); }
  }

  async function removePasskey(p: Passkey) {
    const last = (state?.passkeys.length ?? 0) <= 1;
    const warn = last && user?.role === 'admin'
      ? ' It is your only one — you will be asked to add another straight away.'
      : last ? ' It is your only one; you will be back to email codes.' : '';
    if (!confirm(`Remove the passkey "${p.label}"?${warn}`)) return;
    try {
      await api.delete(`/auth/security/passkeys/${p.id}`);
      const n = Math.max(0, (state?.passkeys.length ?? 1) - 1);
      updateUser({ passkeys: n, passkey_required: user?.role === 'admin' && n === 0 });
      await load();
    } catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not remove the passkey' }); }
  }

  async function newRecoveryCodes() {
    if (!confirm('Make a new set of ten recovery codes? The old ones stop working.')) return;
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/security/recovery-codes', {});
      setNewCodes(r.recoveryCodes);
      await load();
    } catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not make new codes' }); }
  }

  async function forget(d: Device) {
    if (!confirm(`Forget ${d.label}? It will ask for a second step at its next login.`)) return;
    try { await api.delete(`/auth/security/devices/${d.id}`); await load(); }
    catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not remove the device' }); }
  }

  async function signOutEverywhere() {
    if (!confirm('Sign out of OP on every device, including this one? Each will ask you to log in again.')) return;
    try { await api.post('/auth/security/sign-out-everywhere', {}); logout(); window.location.href = '/login'; }
    catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not sign out everywhere' }); }
  }

  const enforced = state?.mfa_enforced_from
    ? new Date(state.mfa_enforced_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null;
  const isAdmin = user?.role === 'admin';

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 sm:px-6 py-5 flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-gray-900">Login security</h2>
        <p className="mt-0.5 text-[13px] text-gray-500">
          A passkey (Face ID, Touch ID, Windows Hello) or a 6-digit email code, asked for once per device. A device you say yes to is remembered for 90 days.
        </p>
      </div>

      {state && (!state.mfa_enrolled || state.passkey_required) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900 mb-2">
            {state.passkey_required ? 'Admin logins need a passkey.' : `Not set up yet${enforced ? ` — needed from ${enforced}` : ''}.`}
          </p>
          <LoginSecuritySetup compact onDone={() => { setMsg({ type: 'ok', text: 'Done.' }); void load(); }} />
        </div>
      )}

      {state?.mfa_enrolled && !state.passkey_required && (
        <p className="text-sm text-emerald-700">
          Set up.{state.passkeys.length ? ' Your passkey signs you in' : ' Codes go to your email'} on any device that is not remembered.
        </p>
      )}

      {newCodes && (
        <div className="rounded-lg border border-ooosh-200 bg-ooosh-50 px-4 py-3">
          <p className="text-sm font-medium text-gray-900">Your recovery codes — shown only now</p>
          <p className="text-[13px] text-gray-600">Each gets you in once if your passkey is not to hand. Print them or keep them somewhere safe.</p>
          <pre className="mt-2 rounded bg-white border border-gray-200 px-3 py-2 text-sm font-mono leading-7 columns-2">{newCodes.join('\n')}</pre>
          <button type="button" className="mt-2 text-sm text-ooosh-700 hover:underline" onClick={() => setNewCodes(null)}>I've saved these</button>
        </div>
      )}

      {state && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-gray-800">Passkeys</h3>
            {passkeysSupported() && state.mfa_enrolled && (
              <button type="button" onClick={addPasskey} disabled={busy} className="text-xs text-ooosh-700 hover:underline disabled:opacity-50">
                {busy ? 'Waiting for your device…' : addPasskeyLabel()}
              </button>
            )}
          </div>
          {state.passkeys.length === 0 ? (
            <p className="text-xs text-gray-500">None yet. Apple and Google sync a passkey across your own devices, so one usually covers your phone and laptop.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {state.passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>
                    {p.label}{p.backed_up && <span className="ml-2 text-xs text-gray-400">synced</span>}
                    <span className="block text-xs text-gray-500">
                      added {fmtDate(p.created_at)}{p.last_used_at ? ` · last used ${fmtDate(p.last_used_at)}` : ' · not used yet'}
                    </span>
                  </span>
                  <button type="button" onClick={() => removePasskey(p)} className="text-xs text-gray-500 hover:text-red-700">Remove</button>
                </li>
              ))}
            </ul>
          )}
          {isAdmin && state.passkeys.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              Recovery codes: {state.recovery_codes_left ?? 0} left.{' '}
              <button type="button" onClick={newRecoveryCodes} className="text-ooosh-700 hover:underline">New set</button>
            </p>
          )}
        </div>
      )}

      {state && state.devices.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-800 mb-1">Remembered devices</h3>
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
            {state.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  {d.label}{d.current && <span className="ml-2 text-xs text-ooosh-700">this device</span>}
                  <span className="block text-xs text-gray-500">added {fmtDate(d.created_at)} · last used {fmtDate(d.last_used_at)}</span>
                </span>
                <button type="button" onClick={() => forget(d)} className="text-xs text-gray-500 hover:text-red-700">Forget</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-4">
        <button type="button" onClick={signOutEverywhere} className="text-sm text-gray-500 hover:text-red-700">Sign out everywhere</button>
        {msg && <span className={`text-[13px] ${msg.type === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
