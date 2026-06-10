/**
 * HireHop job-number input with live client lookup. The HH number is the
 * primary way to identify a held item — type it and we confirm which client /
 * job it links to (or warn if the number isn't a synced OP job). The backend
 * still derives the link on save; this is the visible feedback that it worked.
 *
 * Shared by the desktop CreateModal + the mobile QuickLogSheet.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';

interface JobMatch {
  job_id: string;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
}

export function JobNumberField({ value, onChange, onResolved, compact }: {
  value: string;
  onChange: (v: string) => void;
  /** Fired with the matched job (or null) so the parent can prefill/store if it wants. */
  onResolved?: (job: JobMatch | null) => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'found' | 'none'>('idle');
  const [match, setMatch] = useState<JobMatch | null>(null);
  const inputCls = compact
    ? 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base'
    : 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

  useEffect(() => {
    const n = value.trim();
    if (!n || !/^\d+$/.test(n)) { setState('idle'); setMatch(null); onResolved?.(null); return; }
    let cancelled = false;
    setState('loading');
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: JobMatch }>(`/holding/job-lookup/${n}`);
        if (cancelled) return;
        setMatch(r.data); setState('found'); onResolved?.(r.data);
      } catch {
        if (cancelled) return;
        setMatch(null); setState('none'); onResolved?.(null);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <label className={`block ${compact ? 'text-sm text-slate-500' : 'text-xs text-slate-500'} mb-1`}>HireHop job #</label>
      <input className={inputCls} type="number" inputMode="numeric" value={value}
        onChange={(e) => onChange(e.target.value)} placeholder="e.g. 15816" />
      {state === 'loading' && <p className="text-[11px] text-slate-400 mt-1">Looking up job…</p>}
      {state === 'found' && match && (
        <p className="text-[11px] text-green-700 mt-1">
          ✓ {match.client_name ? <span className="font-medium">{match.client_name}</span> : 'Linked'}
          {match.job_name ? ` · ${match.job_name}` : ''} — we'll link the job &amp; client for you.
        </p>
      )}
      {state === 'none' && (
        <p className="text-[11px] text-amber-600 mt-1">No synced job found for #{value.trim()} — it'll still be saved with this number, link the client manually below.</p>
      )}
      {state === 'idle' && (
        <p className="text-[11px] text-slate-400 mt-1">Enter the job # and we link the job &amp; client for you. Only fill the boxes below if there's no job.</p>
      )}
    </div>
  );
}
