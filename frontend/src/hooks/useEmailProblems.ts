import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Which of these email addresses are currently NOT receiving our email —
 * bounced, blocked by Resend (its suppression list) or reported us as spam.
 * Fed by Resend's webhook (backend services/email-delivery.ts); a flag clears
 * itself when a later email to the address is delivered, or by "Mark as fixed".
 *
 * One request for all the addresses on a page. A failed check shows no flags
 * (it is a warning layered on top of the address, never a gate).
 */
export interface EmailProblem {
  email: string;
  problem: 'bounced' | 'suppressed' | 'complained';
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  failed_count: number;
}

const norm = (e: string) => {
  const s = e.trim();
  const angled = s.match(/<([^>]+)>/);
  return (angled ? angled[1] : s).trim().toLowerCase();
};

export function useEmailProblems(emails: Array<string | null | undefined>) {
  const key = [...new Set(emails.filter((e): e is string => !!e && e.includes('@')).map(norm))].sort().join(',');
  const [problems, setProblems] = useState<Record<string, EmailProblem>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!key) { setProblems({}); return; }
    let live = true;
    api.get<{ data: EmailProblem[] }>(`/email/problems?emails=${encodeURIComponent(key)}`)
      .then((r) => {
        if (live) setProblems(Object.fromEntries((r.data || []).map((p) => [p.email, p])));
      })
      .catch((err) => console.warn('[useEmailProblems] check failed:', err));
    return () => { live = false; };
  }, [key, reload]);

  const problemFor = useCallback(
    (email: string | null | undefined): EmailProblem | null => (email ? problems[norm(email)] || null : null),
    [problems],
  );

  const markFixed = useCallback(async (email: string) => {
    await api.post('/email/problems/resolve', { email });
    setReload((n) => n + 1);
  }, []);

  return { problemFor, markFixed };
}
