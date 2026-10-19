/**
 * My profile › Login security (docs/STAFF-LOGIN-SECURITY-SPEC.md §2, §3).
 *
 * Shows whether this person has a second factor, lets them set it up before
 * the enforcement date (a code to their own inbox proves it, and this browser
 * becomes a trusted device), lists the devices that will not be asked for a
 * code, and offers "Sign out everywhere".
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface Device { id: string; label: string; created_at: string; last_used_at: string; current: boolean }
interface SecurityState { mfa_enrolled: boolean; mfa_enforced_from: string | null; devices: Device[] }

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LoginSecurityCard() {
  const updateUser = useAuthStore((s) => s.updateUser);
  const logout = useAuthStore((s) => s.logout);
  const [state, setState] = useState<SecurityState | null>(null);
  const [step, setStep] = useState<'idle' | 'sent'>('idle');
  const [hint, setHint] = useState('');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setState(await api.get<SecurityState>('/auth/security')); } catch { /* card stays quiet */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function sendCode() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ emailHint: string }>('/auth/security/send-code', {});
      setHint(r.emailHint); setStep('sent'); setCode('');
    } catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not send a code' }); }
    finally { setBusy(false); }
  }

  async function enrol() {
    setBusy(true); setMsg(null);
    try {
      await api.post('/auth/security/enrol', { code: code.trim(), trustDevice: trust });
      updateUser({ mfa_enrolled: true });
      setStep('idle'); setCode('');
      setMsg({ type: 'ok', text: trust ? 'Done — this device is remembered for 90 days.' : 'Done. This device will ask for a code next time.' });
      await load();
    } catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'That code was not accepted' }); }
    finally { setBusy(false); }
  }

  async function forget(d: Device) {
    if (!confirm(`Forget ${d.label}? It will ask for an email code at its next login.`)) return;
    try { await api.delete(`/auth/security/devices/${d.id}`); await load(); }
    catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not remove the device' }); }
  }

  async function signOutEverywhere() {
    if (!confirm('Sign out of OP on every device, including this one? Each will ask for your password and a code again.')) return;
    try { await api.post('/auth/security/sign-out-everywhere', {}); logout(); window.location.href = '/login'; }
    catch (err) { setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not sign out everywhere' }); }
  }

  const enforced = state?.mfa_enforced_from
    ? new Date(state.mfa_enforced_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 sm:px-6 py-5 flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-gray-900">Login security</h2>
        <p className="mt-0.5 text-[13px] text-gray-500">
          A 6-digit code emailed to you, asked for once per device. A device you say yes to is remembered for 90 days.
        </p>
      </div>

      {state && !state.mfa_enrolled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Not set up yet{enforced ? ` — needed from ${enforced}` : ''}.</p>
          {step === 'idle' ? (
            <button type="button" onClick={sendCode} disabled={busy}
              className="mt-2 px-3 py-1.5 rounded bg-ooosh-600 text-white text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50">
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <p>We've sent a code to {hint}. Enter it here:</p>
              <input inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-40 rounded border border-gray-300 px-3 py-1.5 text-center text-lg tracking-[0.3em]" />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />Remember this device for 90 days</label>
              <div className="flex gap-2">
                <button type="button" onClick={enrol} disabled={busy || code.length !== 6}
                  className="px-3 py-1.5 rounded bg-ooosh-600 text-white text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50">Verify</button>
                <button type="button" onClick={sendCode} disabled={busy} className="text-sm text-ooosh-700 hover:underline">Send again</button>
              </div>
            </div>
          )}
        </div>
      )}

      {state?.mfa_enrolled && (
        <p className="text-sm text-emerald-700">Set up. Codes go to your email on any device that is not remembered.</p>
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
