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
import { Card, StatCard, InfoRow, Pill } from './StaffCard';

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

/** The two balances, from the same /me/balances My Time reads (admins may pass personId). */
interface Balances {
  holiday: { availableMinutes: number; nominalDayMinutes: number | null };
  overtime: { availableMinutes: number };
}

function fmtH(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  const h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
  const [balances, setBalances] = useState<Balances | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    // Settled, not all: somebody with no employment record 404s on the first
    // call, and Promise.all would throw away their task list with it.
    const [r, t, b] = await Promise.allSettled([
      api.get<{ data: EmployeeRecord }>(`/staff-calendar/employees/${personId}`),
      api.get<{ data: TaskRow[] }>(`/staff-tasks/person/${personId}`),
      api.get<{ data: Balances | null }>(
        `/staff-calendar/me/balances?year=${new Date().getFullYear()}&personId=${encodeURIComponent(personId)}`),
    ]);
    // Balances are a headline, not the page: without them the cards say so.
    if (b.status === 'fulfilled') setBalances(b.value.data);

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

  const hol = balances?.holiday;
  const holDays = hol && hol.nominalDayMinutes ? (hol.availableMinutes / hol.nominalDayMinutes).toFixed(1) : null;

  return (
    <div className="space-y-4">
      {/* The three things looked up most, each a way into the tab that holds it.
          Employees only — somebody with no staff record has none of the three. */}
      {rec && <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Holiday left"
          value={hol ? (holDays ?? fmtH(hol.availableMinutes)) : '—'}
          unit={hol && holDays ? 'days' : undefined}
          tone={hol && hol.availableMinutes < 0 ? 'bad' : undefined}
          caption={hol ? (holDays ? `${fmtH(hol.availableMinutes)} this year` : 'this year') : 'No allowance set'}
          onClick={() => onOpenTab('time')} />
        <StatCard label="Overtime in the bank"
          value={balances ? fmtH(balances.overtime.availableMinutes) : '—'}
          caption="Earned, not yet taken or paid"
          onClick={() => onOpenTab('time')} />
        <StatCard label="Next review"
          value={rec?.next_review_scheduled ? fmtDate(rec.next_review_scheduled) : 'None'}
          tone={rec && !rec.next_review_scheduled ? 'warn' : undefined}
          caption={rec?.next_review_scheduled ? 'Booked' : 'Nothing booked yet'}
          onClick={() => onOpenTab('reviews')} />
      </div>}

      {attention.length > 0 && (
        <Card title="Needs attention" subtitle="Things about this person that want doing">
          <ul className="-mx-5 -mb-5">
            {attention.map(a => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3 border-t border-gray-100">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${a.severity === 'urgent' ? 'bg-red-600' : a.severity === 'soon' ? 'bg-amber-500' : 'bg-gray-400'}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-gray-900">{a.label}</div>
                  {a.detail && <div className="text-[13px] text-gray-500">{a.detail}</div>}
                </div>
                {a.tab && (
                  <button onClick={() => onOpenTab(a.tab!)}
                    className="text-sm font-medium text-ooosh-700 hover:underline">
                    {a.action || 'Open'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {rec && (
          <Card title="At a glance">
            <dl>
              <InfoRow label="Contracted hours">
                {hours || <Pill tone="warn">Not set</Pill>}
              </InfoRow>
              <InfoRow label="Right to work">
                {rec.rtw_document_type
                  ? <>{rec.rtw_document_type}{rec.rtw_expires_on && <span className="text-gray-500"> · until {fmtDate(rec.rtw_expires_on)}</span>}</>
                  : <Pill tone="bad">Not checked</Pill>}
              </InfoRow>
              <InfoRow label="NI number">
                {rec.has_ni_number ? <Pill tone="ok">Recorded</Pill> : <Pill tone="warn">Not recorded</Pill>}
              </InfoRow>
              <InfoRow label="Emergency contact">
                {emergency === 'Not recorded' ? <Pill tone="warn">Not recorded</Pill> : emergency}
              </InfoRow>
            </dl>
          </Card>
        )}

        <Card title="Open actions" subtitle="Agreed at a review — each sits on its owner’s own To Do">
          {tasks.length === 0 ? (
            <p className="text-sm text-gray-400">Nothing outstanding.</p>
          ) : (
            <ul className="-mx-5 -mb-5">
              {tasks.map(t => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-gray-100">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] text-gray-900">{t.title}</div>
                    {t.owner_name && <div className="text-[13px] text-gray-500">{t.owner_name}</div>}
                  </div>
                  <Pill tone={t.due_date ? 'info' : 'muted'}>{t.due_date ? `due ${fmtDate(t.due_date)}` : 'no date'}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="text-xs text-gray-400">
        Everything here is read-only. {personName.split(' ')[0]}’s details are edited on the other tabs.
      </p>
    </div>
  );
}
