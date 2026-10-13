import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import CompareOptionsPanel from './CompareOptionsPanel';
import { api } from '../services/api';
import { OPTION_COPY } from '../lib/optionCopy';
import { ALTERNATIVE_QUOTE_LOST_REASON, isOptionDead, isOptionOpen, optionDateSpan, optionStatusStyle } from '../lib/quoteOptions';
import type { JobGroupMember } from '../../../shared/types';
import type { JobGroupRead } from '../../../shared/types';

/**
 * The option bar on Job Detail (spec §6.1) — one pill per option of the
 * enquiry, in option_no order, directly under the header and above the tabs.
 * Renders nothing until the job's group has two members, so a lone job looks
 * exactly as it does today.
 *
 * Compare, pin-as-lead and the Kanban collapse are PR 2; this bar is the
 * navigation plus the group's name and the add / remove actions.
 */
interface Props {
  jobId: string;
  groupId: string;
  /** Bumped by the parent after it changes the group (add, link, remove). */
  refreshSignal?: number;
  onAdd: () => void;
  /** Called after this job leaves its group (the parent reloads the job). */
  onRemoved: () => void;
}

export default function QuoteOptionsBar({ jobId, groupId, refreshSignal, onAdd, onRemoved }: Props) {
  const [data, setData] = useState<JobGroupRead | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [comparing, setComparing] = useState(false);
  // Confirm panel (spec §7): shown on a confirmed option while siblings are
  // still open. "Keep them open" hides it for this exact set of siblings;
  // ?group_prompt=1 (the bell's deep link) overrides that.
  const [searchParams] = useSearchParams();
  const promptForced = searchParams.get('group_prompt') === '1';
  const [keptOpen, setKeptOpen] = useState<string | null>(() => {
    try { return localStorage.getItem(`ooosh_option_prompt_keep:${groupId}`); } catch { return null; }
  });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: JobGroupRead }>(`/pipeline/groups/${groupId}`);
      setData(res.data);
    } catch {
      setData(null);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  // Pre-tick every live sibling whenever the set changes (spec: pre-ticked, staff untick).
  const liveIds = data ? data.members
    .filter((m) => isOptionOpen(m.pipeline_status) && !m.dismissed_at)
    .map((m) => m.id).sort().join(',') : '';
  useEffect(() => { setTicked(new Set(liveIds ? liveIds.split(',') : [])); }, [liveIds]);

  if (!data || data.members.length < 2) return null;
  const { group, members } = data;
  // Past pre-confirmation and not dead = the client chose this one.
  const confirmed = members.find((m) => !isOptionDead(m.pipeline_status) && !isOptionOpen(m.pipeline_status));
  const liveOthers = members.filter((m) => m.id !== confirmed?.id && isOptionOpen(m.pipeline_status) && !m.dismissed_at);
  const liveKey = liveOthers.map((m) => m.id).sort().join(',');
  const showConfirmPanel = !!confirmed && confirmed.id === jobId && liveOthers.length > 0
    && (promptForced || keptOpen !== liveKey);
  const tickedLive = liveOthers.filter((m) => ticked.has(m.id));

  function keepOpen() {
    try { localStorage.setItem(`ooosh_option_prompt_keep:${groupId}`, liveKey); } catch { /* fine */ }
    setKeptOpen(liveKey);
  }

  async function markTickedLost() {
    if (!confirmed || tickedLive.length === 0) return;
    setMarking(true);
    setError('');
    const ref = confirmed.hh_job_number ? `#${confirmed.hh_job_number}` : 'this job';
    const failures: string[] = [];
    const done: JobGroupMember[] = [];
    for (const m of tickedLive) {
      try {
        // The existing lost transition — so the Lost/Cancelled cleanup pattern
        // (requirements, transport, chase date, HireHop status 10) runs as for
        // any lost job.
        await api.patch(`/pipeline/${m.id}/status`, {
          pipeline_status: 'lost',
          lost_reason: ALTERNATIVE_QUOTE_LOST_REASON,
          lost_detail: OPTION_COPY.confirmLostDetail(confirmed.option_no ?? 0, confirmed.option_label, ref),
          transition_note: OPTION_COPY.confirmTransitionNote(confirmed.option_no ?? 0, ref),
          keep_requirement_ids: [],
        });
        done.push(m);
      } catch (e) {
        failures.push(`Option ${m.option_no}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    if (done.length) {
      const losers = done.map((m) => `Option ${m.option_no}`).join(', ');
      await api.post('/interactions', {
        type: 'note',
        content: OPTION_COPY.confirmNoteOnWinner(losers, confirmed.option_no ?? 0),
        job_id: confirmed.id,
      }).catch(() => { /* the lost transitions are the record; the note is a courtesy */ });
    }
    await api.post(`/pipeline/groups/${groupId}/prompt-handled`, {}).catch(() => { /* bells retire on the next visit */ });
    if (failures.length) setError(failures.join(' · '));
    setMarking(false);
    setTicked(new Set());
    await load();
  }

  async function saveLabel() {
    setEditingLabel(false);
    const next = labelDraft.trim();
    if (next === (group.label || '')) return;
    try {
      const res = await api.patch<{ data: JobGroupRead }>(`/pipeline/groups/${group.id}`, { label: next || null });
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename the group');
    }
  }

  // The ★: click to pin this option as the lead (what the pipeline board will
  // show); click a pinned star to unpin and let OP pick the most progressed again.
  async function togglePin(memberId: string) {
    setError('');
    const pinned = group.lead_job_id === memberId;
    try {
      const res = await api.patch<{ data: JobGroupRead }>(`/pipeline/groups/${group.id}`, { lead_job_id: pinned ? null : memberId });
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the lead option');
    }
  }

  async function removeFromGroup() {
    if (!window.confirm(OPTION_COPY.barRemoveConfirm)) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.delete<{ data: { warnings: string[] } }>(`/pipeline/${jobId}/group`);
      if (res.data.warnings?.length) window.alert(`${OPTION_COPY.warningsHeading}\n\n• ${res.data.warnings.join('\n• ')}`);
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this job from the group');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 mb-4">
      {showConfirmPanel && confirmed && (
        <div className="mb-3 rounded-lg border border-green-300 bg-green-50 p-3">
          <p className="text-sm font-bold text-green-800">✓ {OPTION_COPY.confirmTitle(confirmed.option_no ?? 0, confirmed.option_label)}</p>
          <p className="text-sm text-green-800 mt-0.5">{OPTION_COPY.confirmIntro(liveOthers.length)}</p>
          <ul className="mt-2 space-y-1">
            {liveOthers.map((m) => {
              const style = optionStatusStyle(m);
              return (
                <li key={m.id}>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-800">
                    <input
                      type="checkbox"
                      checked={ticked.has(m.id)}
                      onChange={(e) => setTicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(m.id); else next.delete(m.id);
                        return next;
                      })}
                      className="h-4 w-4 rounded border-gray-300 text-green-700"
                    />
                    <span className="font-semibold">Option {m.option_no}</span>
                    {m.option_label && <span>· {m.option_label}</span>}
                    {m.hh_job_number && <span className="text-gray-400">· #{m.hh_job_number}</span>}
                    <span className="text-xs" style={{ color: style.colour }}>· {style.label.toLowerCase()}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-green-900/80">{OPTION_COPY.confirmExplain}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={markTickedLost}
              disabled={marking || tickedLive.length === 0}
              className="px-3 py-1.5 rounded-lg bg-green-700 text-white text-sm font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {marking ? OPTION_COPY.confirmMarking : OPTION_COPY.confirmMark(tickedLive.length)}
            </button>
            <button
              type="button"
              onClick={keepOpen}
              disabled={marking}
              className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {OPTION_COPY.confirmKeep}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 mb-2">
        {editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            placeholder={OPTION_COPY.barLabelPlaceholder}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(); if (e.key === 'Escape') setEditingLabel(false); }}
            className="text-sm font-semibold text-gray-900 border-b border-ooosh-400 outline-none bg-transparent px-0 py-0 min-w-[12rem]"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setLabelDraft(group.label || ''); setEditingLabel(true); }}
            className="text-sm font-semibold text-gray-900 hover:text-ooosh-700"
            title="Click to rename"
          >
            {group.label || OPTION_COPY.barLabelPlaceholder}
          </button>
        )}
        <span>·</span>
        <span>{OPTION_COPY.barCaption(members.length)}</span>
        <span>·</span>
        <span className={confirmed ? 'text-green-700 font-medium' : 'text-amber-700'}>
          {confirmed ? OPTION_COPY.barChosen(confirmed.option_no ?? 0) : OPTION_COPY.barNoneChosen}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setComparing(true)}
            className="inline-flex items-center px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
          >
            {OPTION_COPY.barCompare}
          </button>
          <button
            type="button"
            onClick={removeFromGroup}
            disabled={busy}
            className="text-gray-400 hover:text-red-600 disabled:opacity-50"
          >
            {OPTION_COPY.barRemove}
          </button>
          {!confirmed && (
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center px-2.5 py-1 rounded-lg bg-ooosh-600 text-white font-medium hover:bg-ooosh-700"
              title={OPTION_COPY.barAddMoreTitle}
            >
              {OPTION_COPY.barAddMore}
            </button>
          )}
        </span>
      </div>

      <div className="flex gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1">
        {members.map((m) => {
          const isHere = m.id === jobId;
          const dead = isOptionDead(m.pipeline_status);
          const style = optionStatusStyle(m);
          const inner = (
            <>
              <div className={`text-sm font-semibold truncate ${dead ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                Option {m.option_no}
                {m.option_label ? <span className={`font-normal ${dead ? '' : 'text-gray-600'}`}> · {m.option_label}</span> : null}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                <span
                  className="inline-flex px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: `${style.colour}1A`, color: style.colour }}
                >
                  {dead && m.lost_reason?.startsWith('Confirmed Alternative Quote') ? 'Lost · alt. quote' : style.label}
                </span>
                {optionDateSpan(m) && <span>{optionDateSpan(m)}</span>}
                {m.hh_job_number && <span className="text-gray-400">#{m.hh_job_number}</span>}
              </div>
            </>
          );
          const cls = `block min-w-[11rem] max-w-[16rem] flex-1 text-left rounded-lg border px-3 py-2 pr-7 transition-colors ${
            isHere
              ? 'border-ooosh-500 bg-ooosh-50/60 border-b-2'
              : 'border-gray-200 hover:bg-gray-50'
          }`;
          const pinned = group.lead_job_id === m.id;
          const star = !dead && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(m.id); }}
              className={`absolute top-1.5 right-1.5 text-base leading-none ${
                m.is_lead ? 'text-amber-500' : 'text-gray-200 hover:text-amber-400'
              }`}
              title={pinned ? OPTION_COPY.barUnpin : m.is_lead ? OPTION_COPY.barAutoLead : OPTION_COPY.barPin}
              aria-label={pinned ? OPTION_COPY.barUnpin : OPTION_COPY.barPin}
            >
              {m.is_lead ? '★' : '☆'}
            </button>
          );
          return (
            <div key={m.id} className="relative flex-shrink-0">
              {isHere ? (
                <div className={cls} aria-current="page">{inner}</div>
              ) : (
                <Link to={`/jobs/${m.id}`} className={cls}>{inner}</Link>
              )}
              {star}
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {comparing && (
        <CompareOptionsPanel
          group={data}
          currentJobId={jobId}
          onClose={() => setComparing(false)}
          onAdd={onAdd}
          onChanged={(next) => setData(next)}
        />
      )}
    </div>
  );
}
