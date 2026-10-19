import { useState, FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuthStore';
import { api } from '../services/api';
import { loginWithPasskey, passkeysSupported, wasCancelled } from '../lib/passkeys';

interface LoginResponse {
  user: {
    id: string;
    email: string;
    role: string;
    first_name: string;
    last_name: string;
  };
  accessToken: string;
  refreshToken: string;
}

/** The password was right but a second factor is owed (STAFF-LOGIN-SECURITY-SPEC §3.1). */
interface PendingResponse {
  pending: string;
  methods: string[];
  emailHint: string;
  codeSent: boolean;
  codeError: string | null;
  /** An admin with recovery codes to fall back on. */
  recovery?: boolean;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Second step: the pending token from /auth/login, the code typed, and
  // whether this browser should be remembered (the default — it is what keeps
  // 2FA bearable: one code per device per 90 days, not one per login).
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [notice, setNotice] = useState('');
  // Recovery code entry (admins, §3.5) and whether this browser can do passkeys at all.
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const canPasskey = passkeysSupported();
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();

  // Figure out where to send the user after login. Two sources:
  //  - React Router redirect: state.from.pathname (when ProtectedRoute bounced us here)
  //  - Hard navigation: ?redirect=... (when refresh failed and api.ts did window.location.href)
  function getRedirectTarget(): string {
    const stateFrom = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
    if (stateFrom?.pathname && stateFrom.pathname !== '/login') {
      return `${stateFrom.pathname}${stateFrom.search || ''}`;
    }
    const params = new URLSearchParams(location.search);
    const redirect = params.get('redirect');
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('/login')) {
      return redirect;
    }
    return '/';
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api.post<LoginResponse | PendingResponse>('/auth/login', { email, password });
      if ('pending' in data) {
        setPending(data);
        setCode('');
        setUseRecovery(false);
        setNotice(data.codeSent
          ? `We've emailed a 6-digit code to ${data.emailHint}.`
          : data.methods.includes('email')
            ? (data.codeError || 'The code could not be sent — try "Send again".')
            : 'Finish with your passkey.');
        return;
      }
      login(data.user, data.accessToken, data.refreshToken);
      navigate(getRedirectTarget(), { replace: true });
    } catch (err) {
      const e = err as Error & { body?: { retryAfter?: number } };
      const wait = e.body?.retryAfter;
      setError(wait
        ? `Too many wrong passwords — try again in ${Math.max(1, Math.ceil(wait / 60))} minute${wait > 90 ? 's' : ''}.`
        : (err instanceof Error ? err.message : 'Login failed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError('');
    setLoading(true);
    try {
      const data = await api.post<LoginResponse>('/auth/login/code', { pending: pending.pending, code: code.trim(), trustDevice });
      login(data.user, data.accessToken, data.refreshToken);
      navigate(getRedirectTarget(), { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'That code was not accepted';
      setError(msg);
      // A dead pending token means the five minutes are up: back to the password.
      if (/expired — start again/i.test(msg)) { setPending(null); setCode(''); }
    } finally {
      setLoading(false);
    }
  }

  /** The passkey: the whole login from the first screen, or the second step after a password. */
  async function handlePasskey() {
    setError('');
    setLoading(true);
    try {
      const data = await loginWithPasskey<LoginResponse['user']>(pending?.pending ?? null, trustDevice);
      login(data.user, data.accessToken, data.refreshToken);
      navigate(getRedirectTarget(), { replace: true });
    } catch (err) {
      if (!wasCancelled(err)) {
        const msg = err instanceof Error ? err.message : 'The passkey was not accepted';
        setError(msg);
        if (/expired — start again/i.test(msg)) { setPending(null); setCode(''); }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRecovery(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError('');
    setLoading(true);
    try {
      const data = await api.post<LoginResponse>('/auth/login/recovery', { pending: pending.pending, recoveryCode: recoveryCode.trim(), trustDevice });
      login(data.user, data.accessToken, data.refreshToken);
      navigate(getRedirectTarget(), { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'That code was not accepted';
      setError(msg);
      if (/expired — start again/i.test(msg)) { setPending(null); setRecoveryCode(''); }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    if (!pending) return;
    setError('');
    try {
      await api.post('/auth/login/send-code', { pending: pending.pending });
      setNotice(`A new code is on its way to ${pending.emailHint}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new code');
    }
  }

  if (pending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <img src="/ooosh-logo-full.jpg" alt="Ooosh! Tours" className="h-40 mx-auto mb-4" />
            <p className="mt-2 text-sm text-gray-600">Operations Platform</p>
          </div>
          <form onSubmit={useRecovery ? handleRecovery : handleCode} className="mt-8 space-y-5 bg-white p-8 rounded-xl shadow-sm">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {useRecovery ? 'Recovery code' : pending.methods.includes('email') ? 'Check your email' : 'One more step'}
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                {useRecovery ? 'One of the ten codes you were given. Each works once.' : notice}
              </p>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>
            )}
            {/* A passkey holder: the passkey is the second step (both factors at once, §3.4). */}
            {pending.methods.includes('passkey') && !useRecovery && (
              <button
                type="button"
                onClick={handlePasskey}
                disabled={loading || !canPasskey}
                className="w-full flex justify-center py-2.5 px-4 rounded shadow-sm text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 disabled:opacity-50"
              >
                {loading ? 'Waiting for your device…' : 'Use your passkey'}
              </button>
            )}
            {pending.methods.includes('passkey') && !canPasskey && !useRecovery && (
              <p className="text-xs text-gray-500">This browser cannot use passkeys.{pending.methods.includes('email') ? ' Use the email code below.' : pending.recovery ? ' Use a recovery code.' : ' Try your usual browser.'}</p>
            )}
            {useRecovery && (
              <div>
                <label htmlFor="recovery" className="block text-sm font-medium text-gray-700">Recovery code</label>
                <input
                  id="recovery"
                  autoComplete="off"
                  autoCapitalize="characters"
                  required
                  autoFocus
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX"
                  className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 shadow-sm text-center text-xl font-mono tracking-widest focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            )}
            {pending.methods.includes('email') && !useRecovery && (
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-gray-700">6-digit code</label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 shadow-sm text-center text-2xl tracking-[0.4em] focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            )}
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-0.5" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
              <span>Remember this device for 90 days<span className="block text-xs text-gray-500">Untick on a shared or borrowed computer.</span></span>
            </label>
            {(pending.methods.includes('email') || useRecovery) && (
              <button
                type="submit"
                disabled={loading || (useRecovery ? recoveryCode.replace(/[^A-Z0-9]/g, '').length !== 8 : code.length !== 6)}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded shadow-sm text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ooosh-500 disabled:opacity-50"
              >
                {loading ? 'Checking…' : 'Continue'}
              </button>
            )}
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              {pending.methods.includes('email') && !useRecovery
                ? <button type="button" onClick={resendCode} className="text-ooosh-700 hover:underline">Send again</button>
                : <span />}
              <span className="flex gap-3">
                {pending.recovery && (
                  <button type="button" onClick={() => { setUseRecovery((v) => !v); setError(''); }} className="text-gray-500 hover:underline">
                    {useRecovery ? 'Back' : 'Use a recovery code'}
                  </button>
                )}
                <button type="button" onClick={() => { setPending(null); setCode(''); setError(''); setUseRecovery(false); }} className="text-gray-500 hover:underline">Start over</button>
              </span>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <img src="/ooosh-logo-full.jpg" alt="Ooosh! Tours" className="h-40 mx-auto mb-4" />
          <p className="mt-2 text-sm text-gray-600">Operations Platform</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6 bg-white p-8 rounded-xl shadow-sm">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="relative mt-1">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full rounded border border-gray-300 px-3 py-2 pr-10 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
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
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded shadow-sm text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ooosh-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          {/* The passkey IS the login — no password (STAFF-LOGIN-SECURITY-SPEC §3.1). */}
          {canPasskey && (
            <button
              type="button"
              onClick={handlePasskey}
              disabled={loading}
              className="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" /></svg>
              Sign in with a passkey
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
