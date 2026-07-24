/**
 * RehearsalDetailsCard — the "everything about this studio job" card on the Job
 * Detail Overview (Rehearsals module). Self-hides on non-rehearsal jobs.
 *
 * Unified editing (Option A, Jul 2026): every band-standing SETUP field (PA &
 * monitoring, backline, room setup, mics, power, desk, load-in, contact — see
 * lib/rehearsal-fields) carries a [Band usual | This hire] toggle:
 *   - "Band usual" writes the band profile field (carries forward to every future
 *     booking) and clears any per-hire override.
 *   - "This hire" writes rehearsal_job_details.overrides[key] — a one-off for this
 *     booking, leaving the band's usual untouched.
 * Display precedence: a per-hire override shadows the band's usual. Each field
 * shows as a tidy read row (label + value + which-one tag) that expands to the
 * toggle + textarea when clicked, so the card stays neat until you edit.
 *
 * Genuinely per-hire fields (cars / drop-off / notes) stay on the job. The band's
 * bulky extras (preference rows, files, internal notes) are summarised with a
 * "manage →" link to the org Rehearsals tab (their editors live there).
 *
 * Collapsed by default with an "N things" content count. Same setup-field list is
 * shared with the org tab via lib/rehearsal-fields so the two surfaces can't drift.
 * See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md.
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { REHEARSAL_SETUP_FIELDS, RehearsalSetupKey } from '../lib/rehearsal-fields';

interface JobDetails {
  cars_count: number | null;
  dropoff_pickup: string | null;
  notes: string | null;
  overrides: Record<string, string>;
  info_pack_sent_at: string | null;
}
interface Profile {
  organisation_id: string;
  room_setup: string | null;
  mic_list: string | null;
  power_notes: string | null;
  pa_monitoring: string | null;
  usual_backline: string | null;
  desk: string | null;
  load_in_access: string | null;
  regular_contact: string | null;
  preferences: { label: string; value: string }[];
  internal_notes?: string | null;
  files?: { r2_key: string }[];
}
interface AnchorOrg { id: string; name: string | null }
interface LastSent { sent_at: string; job_id: string; hh_job_number: number | null }
interface InfoPackPreview { subject: string; html: string; recipient: string; isFallback: boolean }
interface Resp {
  details: JobDetails | null;
  anchorOrg: AnchorOrg | null;
  profile: Profile | null;
  lastInfoPackSent: LastSent | null;
}

type SaveTarget = 'this_hire' | 'band_usual';
interface SetupState { value: string; target: SaveTarget }
const COLLAPSE_KEY = 'rehearsal-details-collapsed';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const nonEmpty = (v: unknown) => (typeof v === 'string' ? v.trim().length > 0 : v != null);

export default function RehearsalDetailsCard({
  jobId,
  hasRehearsal,
  backlinePrepMins,
}: {
  jobId: string;
  hasRehearsal: boolean;
  backlinePrepMins?: number;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [perHire, setPerHire] = useState<{ cars_count: number | null; dropoff_pickup: string; notes: string }>({
    cars_count: null, dropoff_pickup: '', notes: '',
  });
  const [setupForm, setSetupForm] = useState<Record<string, SetupState>>({});
  const [initialSetup, setInitialSetup] = useState<Record<string, SetupState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) !== 'false');
  // Info-pack preview modal.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<InfoPackPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!previewOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewOpen]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  };

  const load = () => {
    api.get<{ data: Resp }>(`/rehearsals/job/${jobId}`)
      .then((r) => {
        setData(r.data);
        const d = r.data.details;
        const prof = r.data.profile;
        const canUsual = !!r.data.anchorOrg;
        const overrides = d?.overrides ?? {};
        const setup: Record<string, SetupState> = {};
        for (const f of REHEARSAL_SETUP_FIELDS) {
          const ov = overrides[f.key];
          const usual = (prof?.[f.key] as string | null) ?? '';
          const hasOverride = !!ov && ov.trim().length > 0;
          setup[f.key] = {
            value: hasOverride ? ov : usual,
            // Default to "band usual" (carries forward); "this hire" when an
            // override already exists, or when there's no anchor org to write a
            // profile (else a typed value would be silently dropped).
            target: hasOverride ? 'this_hire' : (canUsual ? 'band_usual' : 'this_hire'),
          };
        }
        setSetupForm(setup);
        setInitialSetup(JSON.parse(JSON.stringify(setup)));
        setPerHire({
          cars_count: d?.cars_count ?? null,
          dropoff_pickup: d?.dropoff_pickup ?? '',
          notes: d?.notes ?? '',
        });
        setExpanded(new Set());
        setDirty(false);
      })
      .catch(() => { /* leave empty */ })
      .finally(() => setLoaded(true));
  };

  useEffect(() => { if (hasRehearsal) load(); /* eslint-disable-next-line */ }, [jobId, hasRehearsal]);

  if (!hasRehearsal || !loaded) return null;

  const anchorOrg = data?.anchorOrg ?? null;
  const profile = data?.profile ?? null;
  const canSaveUsual = !!anchorOrg;

  const setSetupValue = (key: RehearsalSetupKey, value: string) => {
    setSetupForm((s) => ({ ...s, [key]: { ...s[key], value } }));
    setDirty(true);
  };
  const setSetupTarget = (key: RehearsalSetupKey, target: SaveTarget) => {
    if (target === 'band_usual' && !canSaveUsual) return;
    setSetupForm((s) => ({ ...s, [key]: { ...s[key], target } }));
    setDirty(true);
  };
  const setPer = (k: 'cars_count' | 'dropoff_pickup' | 'notes', v: string | number | null) => {
    setPerHire((p) => ({ ...p, [k]: v }));
    setDirty(true);
  };
  const toggleExpand = (key: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // Complete overrides map (replace semantics): a field on "this hire" with a
      // value → override; anything else → omitted (i.e. cleared). Dirty "band
      // usual" fields write the profile so the band's usual carries forward.
      const overrides: Record<string, string> = {};
      const profilePayload: Record<string, unknown> = {};
      for (const f of REHEARSAL_SETUP_FIELDS) {
        const cur = setupForm[f.key];
        if (!cur) continue;
        const init = initialSetup[f.key];
        const fieldDirty = !init || cur.value !== init.value || cur.target !== init.target;
        if (cur.target === 'this_hire') {
          if (cur.value.trim()) overrides[f.key] = cur.value;
        } else if (canSaveUsual && fieldDirty) {
          profilePayload[f.key] = cur.value.trim() ? cur.value : null;
        }
      }

      const jobPayload = {
        cars_count: perHire.cars_count,
        dropoff_pickup: perHire.dropoff_pickup || null,
        notes: perHire.notes || null,
        overrides,
      };
      const calls: Promise<unknown>[] = [api.put(`/rehearsals/job/${jobId}`, jobPayload)];
      if (anchorOrg && Object.keys(profilePayload).length) {
        calls.push(api.put(`/rehearsals/profile/${anchorOrg.id}`, profilePayload));
      }
      await Promise.all(calls);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const r = await api.get<{ data: InfoPackPreview }>(`/rehearsals/job/${jobId}/info-pack-preview`);
      setPreview(r.data);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const sendPack = async () => {
    const recent = data?.lastInfoPackSent
      && (Date.now() - new Date(data.lastInfoPackSent.sent_at).getTime()) < 21 * 864e5;
    if (recent && !window.confirm(
      `The info pack was last sent to this band on ${fmtDate(data!.lastInfoPackSent!.sent_at)}. Send it again?`
    )) return;
    setSending(true);
    setSendResult(null);
    try {
      const r = await api.post<{ data: { recipient: string; isFallback: boolean } }>(
        `/rehearsals/job/${jobId}/send-info-pack`, {}
      );
      setSendResult(r.data.isFallback
        ? `No client email on file — sent to ${r.data.recipient} (info@) to forward.`
        : `Sent to ${r.data.recipient}.`);
      setPreviewOpen(false);
      load();
    } catch (e) {
      setSendResult(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const prefCount = profile?.preferences?.length ?? 0;
  const fileCount = profile?.files?.length ?? 0;
  const hasInternalNotes = !!profile?.internal_notes?.trim();
  const setupFilled = REHEARSAL_SETUP_FIELDS.filter((f) => setupForm[f.key]?.value.trim()).length;
  const perFilled = [perHire.cars_count, perHire.dropoff_pickup, perHire.notes].filter(nonEmpty).length;
  const thingCount = setupFilled + perFilled + prefCount + fileCount;

  const targetToggle = (key: RehearsalSetupKey, target: SaveTarget) => (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-[11px] leading-none">
      {(['band_usual', 'this_hire'] as SaveTarget[]).map((t) => {
        const active = target === t;
        const disabled = t === 'band_usual' && !canSaveUsual;
        return (
          <button
            key={t}
            type="button"
            onClick={() => setSetupTarget(key, t)}
            disabled={disabled}
            title={disabled ? 'No band linked — can only save for this hire' : undefined}
            className={`px-2 py-0.5 font-medium transition-colors ${
              active ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
            } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {t === 'band_usual' ? '⭑ Band usual' : '📌 This hire'}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Collapsible header. The org name is a real Link (sibling of the toggle
          button, not nested — an <a> inside a <button> is invalid + wouldn't
          navigate), so it deep-links to the band's Rehearsals tab. */}
      <div className="w-full flex items-center justify-between gap-2 p-4">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-2 flex-wrap text-left min-w-0"
        >
          <span>🎸</span>
          <span className="font-semibold text-gray-900">Rehearsal details</span>
          <span className="text-xs font-normal text-gray-400">
            {thingCount > 0 ? `${thingCount} thing${thingCount !== 1 ? 's' : ''}` : 'nothing filled in yet'}
          </span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {anchorOrg?.name && (
            <Link
              to={`/organisations/${anchorOrg.id}?tab=rehearsal`}
              className="text-sm text-ooosh-600 hover:underline truncate max-w-[10rem]"
            >
              {anchorOrg.name}
            </Link>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            className={`text-gray-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          >
            ▶
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-4">
          {/* Band setup fields — tidy read rows that expand to the toggle + box. */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Setup <span className="font-normal normal-case text-gray-400">· band usual, or override just this hire</span>
            </div>
            <div className="rounded-md border border-gray-200 divide-y divide-gray-100">
              {REHEARSAL_SETUP_FIELDS.map((f) => {
                const cur = setupForm[f.key] ?? { value: '', target: canSaveUsual ? 'band_usual' : 'this_hire' };
                const isOpen = expanded.has(f.key);
                const filled = cur.value.trim().length > 0;
                return (
                  <div key={f.key} className="px-2.5">
                    <button
                      type="button"
                      onClick={() => toggleExpand(f.key)}
                      className="w-full flex items-center justify-between gap-2 text-left py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-gray-500">
                          {f.label}
                          {filled && (
                            <span className="ml-1.5 font-normal text-gray-400">
                              · {cur.target === 'this_hire' ? 'this hire' : 'band usual'}
                            </span>
                          )}
                        </div>
                        {!isOpen && (
                          <div className={`text-sm truncate ${filled ? 'text-gray-800' : 'text-gray-300'}`}>
                            {filled ? cur.value : '—'}
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-ooosh-600 shrink-0">{isOpen ? 'Done' : 'Edit'}</span>
                    </button>
                    {isOpen && (
                      <div className="pb-2.5 space-y-1.5">
                        {targetToggle(f.key, cur.target)}
                        <textarea
                          value={cur.value}
                          onChange={(e) => setSetupValue(f.key, e.target.value)}
                          placeholder={f.placeholder}
                          rows={2}
                          className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
                        />
                        {f.key === 'usual_backline' && typeof backlinePrepMins === 'number' && backlinePrepMins > 0 && (
                          <p className="text-xs text-gray-400">HireHop shows backline on this job — tracked on the Backline card.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-job specifics (never carry forward) */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">This hire</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Cars the band is bringing</label>
                <input
                  type="number" min={0}
                  value={perHire.cars_count ?? ''}
                  onChange={(e) => setPer('cars_count', e.target.value === '' ? null : Number(e.target.value))}
                  className="w-28 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Drop-off / pickup (lorry, van, etc.)</label>
                <textarea
                  value={perHire.dropoff_pickup}
                  onChange={(e) => setPer('dropoff_pickup', e.target.value)}
                  placeholder="Who, what, when?"
                  rows={2}
                  className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
                />
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes (this hire)</label>
              <textarea
                value={perHire.notes}
                onChange={(e) => setPer('notes', e.target.value)}
                rows={2}
                className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
              />
            </div>
          </div>

          {/* Band-only extras — summarised, edited on the org Rehearsals tab. */}
          {anchorOrg && (prefCount > 0 || fileCount > 0 || hasInternalNotes) && (
            <div className="rounded-md bg-ooosh-50 border border-ooosh-100 p-3 text-sm">
              <div className="text-xs font-semibold text-ooosh-800 mb-1.5">
                {anchorOrg.name || 'Band'}'s extras ·{' '}
                <Link to={`/organisations/${anchorOrg.id}?tab=rehearsal`} className="underline">manage →</Link>
              </div>
              {prefCount > 0 && (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                  {profile!.preferences.map((p, i) => (
                    <div key={i} className="flex gap-1.5">
                      <dt className="text-gray-500 shrink-0">{p.label}:</dt>
                      <dd className="text-gray-800">{p.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {(fileCount > 0 || hasInternalNotes) && (
                <div className="mt-1 flex gap-3 text-xs text-gray-500">
                  {fileCount > 0 && <span>📎 {fileCount} file{fileCount !== 1 ? 's' : ''}</span>}
                  {hasInternalNotes && <span>📝 Internal notes</span>}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-gray-100">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded bg-ooosh-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-ooosh-700 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save details'}
            </button>
            {saved && <span className="text-sm text-green-600">Saved ✓</span>}

            <div className="ml-auto flex items-center gap-2">
              {data?.lastInfoPackSent ? (
                <span className="text-xs text-gray-500">
                  Info pack last sent to this band on {fmtDate(data.lastInfoPackSent.sent_at)}
                  {data.lastInfoPackSent.hh_job_number ? ` (#${data.lastInfoPackSent.hh_job_number})` : ''}
                </span>
              ) : (
                <span className="text-xs text-gray-400">Info pack not sent yet</span>
              )}
              <button
                onClick={openPreview}
                disabled={sending}
                className="rounded border border-ooosh-300 px-3 py-1.5 text-sm font-medium text-ooosh-700 hover:bg-ooosh-50 disabled:opacity-40"
              >
                ✉ Preview & send info pack
              </button>
            </div>
          </div>
          {sendResult && <p className="text-xs text-gray-600">{sendResult}</p>}
        </div>
      )}
    </div>

    {/* Info-pack preview modal — see exactly what will send before sending. */}
    {previewOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={() => setPreviewOpen(false)}
      >
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Info pack preview</h3>
            <button onClick={() => setPreviewOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">✕</button>
          </div>
          <div className="p-4 overflow-y-auto flex-1 space-y-3">
            {previewLoading && <p className="text-sm text-gray-500">Loading preview…</p>}
            {previewError && <p className="text-sm text-red-600">{previewError}</p>}
            {preview && (
              <>
                <div className="text-sm space-y-1">
                  <div>
                    <span className="text-gray-500">To:</span> {preview.recipient}
                    {preview.isFallback && (
                      <span className="ml-2 text-amber-600 text-xs">
                        (no client email on file — would go to info@ to forward)
                      </span>
                    )}
                  </div>
                  <div><span className="text-gray-500">Subject:</span> {preview.subject}</div>
                </div>
                <iframe
                  title="Info pack preview"
                  srcDoc={preview.html}
                  sandbox=""
                  className="w-full h-[52vh] border border-gray-200 rounded bg-white"
                />
              </>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
            <button onClick={() => setPreviewOpen(false)} className="text-sm text-gray-600 hover:underline px-3 py-1.5">Close</button>
            <button
              onClick={sendPack}
              disabled={sending || previewLoading || !preview}
              className="rounded bg-ooosh-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-ooosh-700 disabled:opacity-40"
            >
              {sending ? 'Sending…' : '✉ Send this info pack'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
