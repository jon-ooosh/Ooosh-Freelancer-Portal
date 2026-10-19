/**
 * Setting up login security — the one flow, used by the banner's modal and by
 * My profile › Login security (docs/STAFF-LOGIN-SECURITY-SPEC.md §2, §3.4).
 *
 * Passkey first (Face ID / Touch ID / Windows Hello — nothing to phish), the
 * email code as the fallback. An admin is offered the passkey only (§1.2); their
 * first passkey also mints their recovery codes, shown once here.
 */
import { useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { passkeysSupported, registerPasskey, wasCancelled } from '../lib/passkeys';

/** "iPhone", "Mac", "Windows PC"… — the default label for a new passkey. */
export function guessDeviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

/** "Add a passkey on this iPhone" / "Add a passkey on this device". */
export function addPasskeyLabel(): string {
  const d = guessDeviceLabel();
  return d === 'This device' ? 'Add a passkey on this device' : `Add a passkey on this ${d}`;
}

interface Props {
  /** Called once the person has a second factor (and has seen any recovery codes). */
  onDone: () => void;
  /** Pass this where the card already explains itself. */
  compact?: boolean;
}

export default function LoginSecuritySetup({ onDone, compact }: Props) {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [step, setStep] = useState<'choose' | 'code' | 'recovery'>('choose');
  const [hint, setHint] = useState('');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const isAdmin = user?.role === 'admin';
  const canPasskey = passkeysSupported();
  // An admin logs in with a passkey — the email code alone is not offered (§1.2).
  const offerEmail = !isAdmin || !canPasskey;

  async function addPasskey() {
    setBusy(true); setError('');
    try {
      const r = await registerPasskey(guessDeviceLabel());
      // The mandate (passkey_required) is lifted only once any recovery codes have
      // been seen — lifting it first would close the forced modal under them.
      updateUser({ mfa_enrolled: true, passkeys: (user?.passkeys ?? 0) + 1 });
      if (r.recoveryCodes && r.recoveryCodes.length) { setRecoveryCodes(r.recoveryCodes); setStep('recovery'); }
      else finish();
    } catch (err) {
      if (!wasCancelled(err)) setError(err instanceof Error ? err.message : 'The passkey could not be added');
    } finally { setBusy(false); }
  }

  function finish() {
    updateUser({ passkey_required: false });
    onDone();
  }

  async function sendCode() {
    setBusy(true); setError('');
    try {
      const r = await api.post<{ emailHint: string }>('/auth/security/send-code', {});
      setHint(r.emailHint); setStep('code'); setCode('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send a code'); }
    finally { setBusy(false); }
  }

  async function enrol() {
    setBusy(true); setError('');
    try {
      await api.post('/auth/security/enrol', { code: code.trim(), trustDevice: trust });
      updateUser({ mfa_enrolled: true });
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : 'That code was not accepted'); }
    finally { setBusy(false); }
  }

  async function copyCodes() {
    try { await navigator.clipboard.writeText(recoveryCodes.join('\n')); setCopied(true); } catch { /* nothing to do */ }
  }

  const primary = 'px-4 py-2 rounded bg-ooosh-600 text-white text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50';
  const secondary = 'px-4 py-2 rounded border border-gray-300 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50';

  if (step === 'recovery') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-800">
          <span className="font-medium">Your recovery codes.</span> Each one gets you in once if your passkey is not to hand.
          They are shown only now — print them or put them somewhere safe.
        </p>
        <pre className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm font-mono leading-7 columns-2">{recoveryCodes.join('\n')}</pre>
        <div className="flex items-center gap-3">
          <button type="button" className={secondary} onClick={copyCodes}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className={primary} onClick={finish}>I've saved these</button>
        </div>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-800">We've sent a 6-digit code to <span className="font-medium">{hint}</span>. Enter it here:</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <input inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="w-44 rounded border border-gray-300 px-3 py-2 text-center text-xl tracking-[0.3em]" />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          Remember this device for 90 days
        </label>
        <div className="flex items-center gap-3">
          <button type="button" className={primary} onClick={enrol} disabled={busy || code.length !== 6}>Verify</button>
          <button type="button" className="text-sm text-ooosh-700 hover:underline" onClick={sendCode} disabled={busy}>Send again</button>
          <button type="button" className="text-sm text-gray-500 hover:underline" onClick={() => { setStep('choose'); setError(''); }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <p className="text-sm text-gray-700">
          A second step at login, asked for once per device — then this laptop or phone is remembered for 90 days.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {canPasskey && (
        <div className="rounded-lg border border-ooosh-200 bg-ooosh-50 px-4 py-3">
          <p className="text-sm font-medium text-gray-900">Use a passkey{offerEmail ? ' (recommended)' : ''}</p>
          <p className="mt-0.5 text-[13px] text-gray-600">
            Face ID, Touch ID or Windows Hello on this device stands in for your password and the code. Nothing to type, nothing to phish.
            {isAdmin && ' Admin logins need one.'}
          </p>
          <button type="button" className={`${primary} mt-2`} onClick={addPasskey} disabled={busy}>
            {busy ? 'Waiting for your device…' : addPasskeyLabel()}
          </button>
        </div>
      )}
      {offerEmail && (
        <div className={`rounded-lg border border-gray-200 px-4 py-3 ${canPasskey ? '' : 'bg-amber-50 border-amber-200'}`}>
          <p className="text-sm font-medium text-gray-900">{canPasskey ? 'Or an email code' : 'An email code'}</p>
          <p className="mt-0.5 text-[13px] text-gray-600">
            A 6-digit code to your inbox, once per device.{!canPasskey && ' This browser cannot do passkeys.'}
          </p>
          <button type="button" className={`${secondary} mt-2`} onClick={sendCode} disabled={busy}>
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </div>
      )}
    </div>
  );
}
