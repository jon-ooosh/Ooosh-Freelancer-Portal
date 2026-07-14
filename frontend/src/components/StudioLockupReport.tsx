import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Read-only view of a sitter's end-of-night lock-up report (Rehearsals Phase E).
 * Highlights only the exceptions (off-expected answers); the rest is a quiet
 * recap. Shared by the Studio Sitters roster + the Job Detail handover card.
 */

interface LockupItem {
  id: string;
  label: string;
  type: 'yesno' | 'text' | 'number';
  expected?: string;
  end_of_booking_only?: boolean;
}
interface ShiftReport {
  date: string;
  submitted: boolean;
  submitted_at: string | null;
  submitted_by_name: string | null;
  template: { version: number; items: LockupItem[] };
  answers: Record<string, unknown>;
  notes: string;
  continuing_tomorrow: boolean;
  exceptions: { id: string; label: string; answer: string; expected: string }[];
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function answerLabel(raw: unknown): { text: string; tone: 'good' | 'bad' | 'na' | 'plain' } {
  const v = String(raw ?? '').trim();
  const low = v.toLowerCase();
  if (low === 'yes') return { text: 'Yes', tone: 'good' };
  if (low === 'no') return { text: 'No', tone: 'bad' };
  if (low === 'na' || low === 'n/a') return { text: 'N/A', tone: 'na' };
  return { text: v || '—', tone: 'plain' };
}

export default function StudioLockupReport({ date }: { date: string }) {
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await api.get<{ data: ShiftReport }>(`/studio-sitters/report/${date}`);
        if (!cancelled) setReport(res.data);
      } catch {
        if (!cancelled) setError('Could not load the lock-up report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  if (loading) return <div className="text-xs text-gray-400">Loading lock-up report…</div>;
  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (!report || !report.submitted) return <div className="text-xs text-gray-400">No lock-up report submitted for this evening.</div>;

  const exceptionIds = new Set(report.exceptions.map(e => e.id));
  // Items shown: end-of-booking items hidden when continuing tomorrow (they weren't asked).
  const shownItems = report.template.items.filter(it => !(it.end_of_booking_only && report.continuing_tomorrow));

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-xs text-gray-500">
          Submitted {report.submitted_by_name ? `by ${report.submitted_by_name} ` : ''}· {fmtWhen(report.submitted_at)}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${report.exceptions.length > 0 ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'}`}>
          {report.exceptions.length > 0 ? `⚠ ${report.exceptions.length} need${report.exceptions.length === 1 ? 's' : ''} attention` : '✓ All clear'}
        </span>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        {report.continuing_tomorrow ? 'Studio in use again tomorrow.' : 'Last night of the booking (deep-clean applied).'}
      </p>

      <div className="space-y-1">
        {shownItems.map(it => {
          const flagged = exceptionIds.has(it.id);
          const a = answerLabel(report.answers[it.id]);
          const toneClass = flagged
            ? 'text-amber-800'
            : a.tone === 'good' ? 'text-green-700'
            : a.tone === 'bad' ? 'text-red-600'
            : a.tone === 'na' ? 'text-gray-400'
            : 'text-gray-700';
          return (
            <div key={it.id} className={`flex items-start justify-between gap-3 px-2 py-1 rounded ${flagged ? 'bg-amber-50 border border-amber-200' : ''}`}>
              <span className="text-xs text-gray-700">{flagged && '⚠ '}{it.label}</span>
              <span className={`text-xs font-medium shrink-0 ${toneClass}`}>{a.text}</span>
            </div>
          );
        })}
      </div>

      {report.notes && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-0.5">Sitter&apos;s notes</p>
          <p className="text-xs text-gray-700 whitespace-pre-wrap">{report.notes}</p>
        </div>
      )}
    </div>
  );
}
