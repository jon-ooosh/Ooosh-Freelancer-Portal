/**
 * The Overview tab of a staff member's page — a summary, not a form.
 *
 * Most visits to a staff record are to LOOK SOMETHING UP. The old layout made
 * every one of those scroll past five editable panels to reach one fact, so
 * this tab is read-only by design: the facts, what needs attention about this
 * person, and what they owe (or we owe them). Editing lives on the other tabs.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { AttentionItem } from './StaffAttention';

interface EmployeeRecord {
  has_ni_number: boolean;
  rtw_document_type: string | null;
  rtw_expires_on: string | null;
  next_review_scheduled: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  owner_name: string | null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' }) {
  const colour = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`text-sm mt-0.5 ${colour}`}>{value}</dd>
    </div>
  );
}

export default function StaffPersonOverview({
  personId, personName, hours, attention, onOpenTab,
}: {
  personId: string;
  personName: string;
  /** Contracted hours, already formatted by the page. */
  hours: string | null;
  /** This person's slice of the page-level list — no second fetch. */
  attention: AttentionItem[];
  onOpenTab: (tab: string) => void;
}) {
  const [rec, setRec] = useState<EmployeeRecord | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    // Settled, not all: somebody with no employment record 404s on the first
    // call, and Promise.all would throw away their task list with it.
    const [r, t] = await Promise.allSettled([
      api.get<{ data: EmployeeRecord }>(`/staff-calendar/employees/${personId}`),
      api.get<{ data: TaskRow[] }>(`/staff-tasks/person/${personId}`),
    ]);

    if (r.status === 'fulfilled') {
      setRec(r.value.data);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : '';
      // No employment record is a legitimate state, not a failure — the
      // Employment tab explains it. Anything else must not masquerade as one.
      if (!/no employment record/i.test(msg)) setLoadError(msg || 'Could not load this person');
    }
    if (t.status === 'fulfilled') {
      setTasks(t.value.data.filter(x => x.status === 'open'));
    }
    setLoading(false);
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (loadError) {
    return (
      <p className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">
        {loadError}
      </p>
    );
  }

  const emergency = rec && (rec.emergency_contact_name || rec.emergency_contact_phone)
    ? `${rec.emergency_contact_name || '—'}${rec.emergency_contact_relationship ? ` (${rec.emergency_contact_relationship})` : ''}${rec.emergency_contact_phone ? ` · ${rec.emergency_contact_phone}` : ''}`
    : 'Not recorded';

  return (
    <div className="space-y-5">
      {attention.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <h3 className="text-sm font-semibold text-amber-900 mb-2">Needs attention</h3>
          <ul className="space-y-1.5">
            {attention.map(a => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${a.severity === 'urgent' ? 'bg-red-600' : a.severity === 'soon' ? 'bg-amber-500' : 'bg-gray-400'}`} aria-hidden="true" />
                <span className="text-sm text-gray-900">{a.label}</span>
                {a.detail && <span className="text-xs text-gray-600">{a.detail}</span>}
                {a.tab && (
                  <button onClick={() => onOpenTab(a.tab!)}
                    className="ml-auto text-xs font-medium text-ooosh-700 hover:underline">
                    {a.action || 'Open'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rec && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">At a glance</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
            <Fact label="Contracted hours" value={hours || 'Not set'} tone={hours ? undefined : 'warn'} />
            <Fact
              label="Next review"
              value={rec.next_review_scheduled ? fmtDate(rec.next_review_scheduled) : 'None booked'}
              tone={rec.next_review_scheduled ? undefined : 'warn'}
            />
            <Fact
              label="Right to work"
              value={rec.rtw_document_type || 'Not checked'}
              tone={rec.rtw_document_type ? undefined : 'bad'}
            />
            <Fact
              label="Permission expires"
              value={rec.rtw_expires_on ? fmtDate(rec.rtw_expires_on) : 'No limit'}
            />
            <Fact label="NI number" value={rec.has_ni_number ? 'Recorded' : 'Not recorded'} tone={rec.has_ni_number ? undefined : 'warn'} />
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Emergency contact</dt>
              <dd className="text-sm mt-0.5 text-gray-900">{emergency}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Open actions</h3>
        {tasks.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing outstanding.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tasks.map(t => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-sm text-gray-900">{t.title}</span>
                {t.owner_name && <span className="text-xs text-gray-500">{t.owner_name}</span>}
                <span className="ml-auto text-xs text-gray-500">
                  {t.due_date ? `due ${fmtDate(t.due_date)}` : 'no date'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Anything agreed at a review sits on its owner’s own My To Do — including ours.
        </p>
      </div>

      <p className="text-xs text-gray-400">
        Everything here is read-only. {personName.split(' ')[0]}’s details are edited on the other tabs.
      </p>
    </div>
  );
}
