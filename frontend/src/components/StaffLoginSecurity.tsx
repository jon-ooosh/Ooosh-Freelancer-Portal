/**
 * Staff page › Access › Login security (docs/STAFF-LOGIN-SECURITY-SPEC.md §3.7).
 * Manager-tier; an admin's own row is only touched by an admin (the backend refuses).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { Card, btnSecondary } from './StaffCard';

interface Device { id: string; label: string; created_at: string; last_used_at: string }
interface State { mfa_enrolled: boolean; mfa_enrolled_at: string | null; mfa_enforced_from: string | null; devices: Device[] }

export default function StaffLoginSecurity({ userId, name, onSaved, onError }: {
  userId: string; name: string;
  onSaved: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const load = useCallback(async () => {
    try { setState(await api.get<State>(`/users/${userId}/security`)); } catch { setState(null); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  async function reset() {
    if (!confirm(`Reset ${name}'s login security? Every remembered device is forgotten and they are signed out everywhere; their next login asks for an email code again.`)) return;
    try { await api.post(`/users/${userId}/security/reset`, {}); await load(); await onSaved(`${name}'s login security reset.`); }
    catch (err) { onError(err instanceof Error ? err.message : 'Reset failed'); }
  }
  async function signOut() {
    if (!confirm(`Sign ${name} out of OP on every device?`)) return;
    try { await api.post(`/users/${userId}/security/sign-out-everywhere`, {}); await load(); await onSaved(`${name} signed out everywhere.`); }
    catch (err) { onError(err instanceof Error ? err.message : 'Sign-out failed'); }
  }

  if (!state) return null;
  return (
    <Card title="Login security" subtitle="Second factor and remembered devices">
      <p className="text-sm text-gray-700">
        {state.mfa_enrolled
          ? `Second factor set up${state.mfa_enrolled_at ? ` on ${new Date(state.mfa_enrolled_at).toLocaleDateString('en-GB')}` : ''}.`
          : `No second factor yet${state.mfa_enforced_from ? ` — required from ${new Date(state.mfa_enforced_from).toLocaleDateString('en-GB')}` : ''}.`}
      </p>
      {state.devices.length > 0 ? (
        <ul className="mt-2 text-sm text-gray-700 list-disc pl-5">
          {state.devices.map((d) => (
            <li key={d.id}>{d.label} <span className="text-xs text-gray-500">— last used {new Date(d.last_used_at).toLocaleDateString('en-GB')}</span></li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-gray-500">No remembered devices.</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" className={btnSecondary} onClick={signOut}>Sign out everywhere</button>
        <button type="button" className={btnSecondary} onClick={reset}>Reset second factor</button>
      </div>
    </Card>
  );
}
