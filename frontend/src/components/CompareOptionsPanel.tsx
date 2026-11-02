import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { OPTION_COPY } from '../lib/optionCopy';
import { isOptionDead, optionDateSpan, optionStatusStyle } from '../lib/quoteOptions';
import type { JobGroupRead, JobGroupMember } from '../../../shared/types';

/**
 * Compare options — the slide-over (spec §6.2): one row per option of the
 * enquiry with the things they differ on side by side: config (from the
 * HireHop-derived flags), dates and day count, physical item count, client £,
 * status. Row actions: open, pin as lead, edit the label. Marking an option
 * lost lives on its own Job Detail page (the Lost modal) until PR 3's
 * confirm panel.
 */
interface Props {
  group: JobGroupRead;
  currentJobId: string;
  onClose: () => void;
  onAdd: () => void;
  /** The panel changed the group (pin, label) — parent re-reads. */
  onChanged: (next: JobGroupRead) => void;
}

const money = (n: number | null) =>
  n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** Charge days the way the Job Detail header counts them: ceil(hours / 24). */
function dayCount(m: JobGroupMember): number | null {
  if (!m.job_date || !m.job_end) return null;
  const t = (s: string | null, fallback: string) => (s || fallback).slice(0, 5);
  const start = Date.parse(`${m.job_date.slice(0, 10)}T${t(m.start_time, '09:00')}:00Z`);
  const end = Date.parse(`${m.job_end.slice(0, 10)}T${t(m.end_time, '09:00')}:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

export default function CompareOptionsPanel({ group: initial, currentJobId, onClose, onAdd, onChanged }: Props) {
  const [data, setData] = useState<JobGroupRead>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setData(initial); }, [initial]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { group, members } = data;
  const live = members.filter((m) => !isOptionDead(m.pipeline_status));
  const chasing = live.filter((m) => m.is_chasing).length;
  const paused = live.filter((m) => m.pipeline_status === 'paused').length;
  const lead = members.find((m) => m.is_lead) ?? null;

  async function reload() {
    const res = await api.get<{ data: JobGroupRead }>(`/pipeline/groups/${group.id}`);
    setData(res.data);
    onChanged(res.data);
  }

  async function togglePin(memberId: string) {
    setError('');
    try {
      const pinned = group.lead_job_id === memberId;
      const res = await api.patch<{ data: JobGroupRead }>(`/pipeline/groups/${group.id}`, { lead_job_id: pinned ? null : memberId });
      setData(res.data);
      onChanged(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the lead option');
    }
  }

  async function saveLabel(m: JobGroupMember) {
    setEditingId(null);
    const next = labelDraft.trim();
    if (next === (m.option_label || '')) return;
    setError('');
    try {
      await api.patch(`/pipeline/${m.id}/edit`, { option_label: next || null });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the label');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-4xl bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-6 pt-5 pb-4 border-b border-gray-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wide text-gray-400 uppercase">{OPTION_COPY.compareTitle}</p>
            <h2 className="text-xl font-bold text-gray-900 truncate">{group.label || OPTION_COPY.barLabelPlaceholder}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {OPTION_COPY.barCaption(members.length)}
              {' · '}
              {live.length === members.length ? OPTION_COPY.barNoneChosen : `${members.length - live.length} closed`}
              {chasing > 0 && ` · ${chasing} being chased`}
              {paused > 0 && ` · ${paused} paused`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 w-8 h-8 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500" aria-label="Close">×</button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="text-left py-2 pr-3 font-semibold">Option</th>
                <th className="text-left py-2 pr-3 font-semibold">Config</th>
                <th className="text-left py-2 pr-3 font-semibold">Dates</th>
                <th className="text-left py-2 pr-3 font-semibold">Items</th>
                <th className="text-right py-2 pr-3 font-semibold">Client £</th>
                <th className="text-left py-2 pr-3 font-semibold">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((m) => {
                const dead = isOptionDead(m.pipeline_status);
                const here = m.id === currentJobId;
                const style = optionStatusStyle(m);
                const days = dayCount(m);
                const pinned = group.lead_job_id === m.id;
                return (
                  <tr key={m.id} className={`${here ? 'bg-ooosh-50/50' : ''} ${dead ? 'text-gray-400' : 'text-gray-800'}`}>
                    <td className="py-3 pr-3 align-top">
                      <div className={`font-semibold ${dead ? 'line-through' : 'text-gray-900'}`}>
                        Option {m.option_no}
                        {here && <span className="ml-1.5 text-[10px] font-medium text-ooosh-600 no-underline">you are here</span>}
                      </div>
                      {editingId === m.id ? (
                        <input
                          autoFocus
                          value={labelDraft}
                          maxLength={120}
                          placeholder={OPTION_COPY.labelPlaceholder}
                          onChange={(e) => setLabelDraft(e.target.value)}
                          onBlur={() => saveLabel(m)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(m); if (e.key === 'Escape') setEditingId(null); }}
                          className="mt-0.5 w-full text-xs border-b border-ooosh-400 outline-none bg-transparent"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setLabelDraft(m.option_label || ''); setEditingId(m.id); }}
                          className={`mt-0.5 block text-left text-xs hover:text-ooosh-700 ${m.option_label ? 'text-gray-600' : 'text-gray-400 italic'}`}
                          title={OPTION_COPY.compareEditLabel}
                        >
                          {m.option_label || OPTION_COPY.compareNoLabel}
                        </button>
                      )}
                      {m.hh_job_number && <div className="text-[11px] text-gray-400 mt-0.5">#{m.hh_job_number}</div>}
                    </td>
                    <td className="py-3 pr-3 align-top text-xs">{m.config || <span className="text-gray-300">—</span>}</td>
                    <td className="py-3 pr-3 align-top text-xs whitespace-nowrap">
                      {optionDateSpan(m) || '—'}
                      {days != null && days > 0 && <div className="text-gray-400">{days} day{days === 1 ? '' : 's'}</div>}
                    </td>
                    <td className="py-3 pr-3 align-top text-xs">
                      <span title={m.item_names.length ? m.item_names.join('\n') : undefined} className={m.item_names.length ? 'cursor-help border-b border-dotted border-gray-300' : ''}>
                        {m.items_count} item{m.items_count === 1 ? '' : 's'}
                      </span>
                    </td>
                    <td className="py-3 pr-3 align-top text-right font-medium whitespace-nowrap">{money(m.job_value)}</td>
                    <td className="py-3 pr-3 align-top">
                      <span
                        className="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap"
                        style={{ backgroundColor: `${style.colour}1A`, color: style.colour }}
                      >
                        {dead && m.lost_reason?.startsWith('Confirmed Alternative Quote') ? 'Lost · alt. quote' : style.label}
                      </span>
                      {m.is_chasing && m.next_chase_date && (
                        <div className="text-[11px] text-gray-400 mt-0.5">chase due</div>
                      )}
                    </td>
                    <td className="py-3 align-top text-right whitespace-nowrap text-xs">
                      {!dead && (
                        <button
                          type="button"
                          onClick={() => togglePin(m.id)}
                          className={`mr-3 text-base leading-none ${m.is_lead ? 'text-amber-500' : 'text-gray-200 hover:text-amber-400'}`}
                          title={pinned ? OPTION_COPY.barUnpin : m.is_lead ? OPTION_COPY.barAutoLead : OPTION_COPY.barPin}
                        >
                          {m.is_lead ? '★' : '☆'}
                        </button>
                      )}
                      {here ? (
                        <span className="text-gray-300">Open</span>
                      ) : (
                        <Link to={`/jobs/${m.id}`} className="text-ooosh-600 hover:text-ooosh-800 font-medium" onClick={onClose}>Open</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-gray-400">{OPTION_COPY.compareItemsNote}</p>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>
            {OPTION_COPY.compareLeadLine}{' '}
            <span className="font-semibold text-gray-700">
              {group.lead_job_id ? OPTION_COPY.compareLeadPinned : OPTION_COPY.compareLeadAuto}
              {lead ? ` (Option ${lead.option_no})` : ''}
            </span>
          </span>
          {live.length === members.length && (
            <button
              type="button"
              onClick={() => { onClose(); onAdd(); }}
              className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ooosh-600 text-white font-medium hover:bg-ooosh-700"
            >
              {OPTION_COPY.addLink}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
