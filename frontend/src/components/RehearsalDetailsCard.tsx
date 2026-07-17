/**
 * RehearsalDetailsCard — the "everything about this studio job" card on the Job
 * Detail Overview (Rehearsals module). Lightweight per-job intake + the band's
 * standing preferences + the client info pack.
 *
 * Self-hides on non-rehearsal jobs (gated on `hasRehearsal`).
 *
 * Unified editing (round 2, Jul 2026): two fields staff naturally enter at
 * booking time — PA setup and Backline-from-us — can be saved EITHER as a
 * one-off for this hire OR as the band's usual (which carries forward to the
 * next booking). Each carries a [This hire | Band usual] toggle:
 *   - "Band usual" writes the band profile field (pa_monitoring / usual_backline)
 *     and clears any per-job override, so it shows on every future booking.
 *   - "This hire" writes the per-job override, leaving the band's usual untouched.
 * Display precedence: a per-job override shadows the band's usual (shown with a
 * "· this hire" tag); otherwise the band's usual shows (tagged "· band usual").
 * Cars / drop-off / notes stay per-job (they never carry forward). The rest of
 * the band's standing setup lives on the org's Rehearsals tab (linked below).
 *
 * The card is collapsed by default with an "N things" content count so staff
 * can see at a glance whether there's anything worth expanding.
 * See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md.
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface JobDetails {
  pa_setup: string | null;
  backline_notes: string | null;
  cars_count: number | null;
  dropoff_pickup: string | null;
  notes: string | null;
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
}
interface AnchorOrg { id: string; name: string | null }
interface LastSent { sent_at: string; job_id: string; hh_job_number: number | null }
interface Resp {
  details: JobDetails | null;
  anchorOrg: AnchorOrg | null;
  profile: Profile | null;
  lastInfoPackSent: LastSent | null;
}

// Standing preferences shown read-only (managed on the org Rehearsals tab).
// pa_monitoring + usual_backline are excluded — they're editable above as the
// PA setup / Backline fields, so listing them here too would double up.
const PROFILE_LABELS: [keyof Profile, string][] = [
  ['room_setup', 'Room setup'],
  ['mic_list', 'Mics'],
  ['power_notes', 'Power'],
  ['desk', 'Desk'],
  ['load_in_access', 'Load-in / access'],
  ['regular_contact', 'Regular contact'],
];

type SaveTarget = 'this_hire' | 'band_usual';
const COLLAPSE_KEY = 'rehearsal-details-collapsed';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

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
  const [form, setForm] = useState<JobDetails>({
    pa_setup: '', backline_notes: '', cars_count: null, dropoff_pickup: '', notes: '',
    info_pack_sent_at: null,
  });
  // Save target for the two carry-forwardable fields.
  const [paTarget, setPaTarget] = useState<SaveTarget>('band_usual');
  const [backlineTarget, setBacklineTarget] = useState<SaveTarget>('band_usual');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) !== 'false');

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
        // For the two shared fields, show the per-job override if set, else the
        // band's usual. Default the toggle to "this hire" when an override
        // exists, otherwise "band usual" (so fresh entries carry forward).
        const paOverride = d?.pa_setup ?? null;
        const backlineOverride = d?.backline_notes ?? null;
        setForm({
          pa_setup: paOverride ?? prof?.pa_monitoring ?? '',
          backline_notes: backlineOverride ?? prof?.usual_backline ?? '',
          cars_count: d?.cars_count ?? null,
          dropoff_pickup: d?.dropoff_pickup ?? '',
          notes: d?.notes ?? '',
          info_pack_sent_at: d?.info_pack_sent_at ?? null,
        });
        // Default to "band usual" (carries forward) unless there's already a
        // per-job override — but with no anchor org we can't write a profile, so
        // fall back to "this hire" or a typed value would be silently dropped.
        const canUsual = !!r.data.anchorOrg;
        setPaTarget(!canUsual || paOverride?.trim() ? 'this_hire' : 'band_usual');
        setBacklineTarget(!canUsual || backlineOverride?.trim() ? 'this_hire' : 'band_usual');
        setDirty(false);
      })
      .catch(() => { /* leave empty */ })
      .finally(() => setLoaded(true));
  };

  useEffect(() => { if (hasRehearsal) load(); /* eslint-disable-next-line */ }, [jobId, hasRehearsal]);

  if (!hasRehearsal || !loaded) return null;

  const anchorOrg = data?.anchorOrg ?? null;
  const canSaveUsual = !!anchorOrg; // need an anchor org to write the profile

  const set = (k: keyof JobDetails, v: string | number | null) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };
  const setTarget = (which: 'pa' | 'backline', t: SaveTarget) => {
    if (t === 'band_usual' && !canSaveUsual) return;
    if (which === 'pa') setPaTarget(t); else setBacklineTarget(t);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // Per-job intake. A shared field marked "band usual" clears its per-job
      // override (null) so the band's standing value shows through.
      const jobPayload: Record<string, unknown> = {
        cars_count: form.cars_count,
        dropoff_pickup: form.dropoff_pickup || null,
        notes: form.notes || null,
        pa_setup: paTarget === 'this_hire' ? (form.pa_setup || null) : null,
        backline_notes: backlineTarget === 'this_hire' ? (form.backline_notes || null) : null,
      };

      // Fields promoted to the band's usual write the profile (partial upsert,
      // other profile fields untouched).
      const profilePayload: Record<string, unknown> = {};
      if (canSaveUsual && paTarget === 'band_usual') profilePayload.pa_monitoring = form.pa_setup || null;
      if (canSaveUsual && backlineTarget === 'band_usual') profilePayload.usual_backline = form.backline_notes || null;

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
      load();
    } catch (e) {
      setSendResult(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const profile = data?.profile;
  const knownPrefs = profile
    ? PROFILE_LABELS.filter(([k]) => (profile[k] as string | null)?.trim())
    : [];

  // Content count for the collapsed header: effective PA/backline (override or
  // usual), per-job specifics, standing prefs, and preference rows.
  const nonEmpty = (v: unknown) => typeof v === 'string' ? v.trim().length > 0 : v != null;
  const thingCount =
    [form.pa_setup, form.backline_notes, form.cars_count, form.dropoff_pickup, form.notes].filter(nonEmpty).length
    + knownPrefs.length
    + (profile?.preferences?.length ?? 0);

  // A [This hire | Band usual] toggle for a carry-forwardable field.
  const targetToggle = (which: 'pa' | 'backline', target: SaveTarget) => (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-[11px] leading-none">
      {(['band_usual', 'this_hire'] as SaveTarget[]).map((t) => {
        const active = target === t;
        const disabled = t === 'band_usual' && !canSaveUsual;
        return (
          <button
            key={t}
            type="button"
            onClick={() => setTarget(which, t)}
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

  const sharedField = (
    which: 'pa' | 'backline',
    label: string,
    k: 'pa_setup' | 'backline_notes',
    target: SaveTarget,
    placeholder: string,
    extra?: React.ReactNode,
  ) => (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="text-xs font-medium text-gray-500">
          {label}
          <span className="ml-1.5 font-normal text-gray-400">
            · {target === 'this_hire' ? 'this hire' : 'band usual'}
          </span>
        </label>
        {targetToggle(which, target)}
      </div>
      <textarea
        value={(form[k] as string) ?? ''}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
      />
      {extra}
    </div>
  );

  return (
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
          {/* Known standing preferences from the band profile (read-only) */}
          {(knownPrefs.length > 0 || (profile?.preferences?.length ?? 0) > 0) && anchorOrg && (
            <div className="rounded-md bg-ooosh-50 border border-ooosh-100 p-3">
              <div className="text-xs font-semibold text-ooosh-800 mb-1.5">
                {anchorOrg.name || 'Band'}'s usual setup ·{' '}
                <Link to={`/organisations/${anchorOrg.id}?tab=rehearsal`} className="underline">manage →</Link>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {knownPrefs.map(([k, label]) => (
                  <div key={k} className="flex gap-1.5">
                    <dt className="text-gray-500 shrink-0">{label}:</dt>
                    <dd className="text-gray-800">{profile![k] as string}</dd>
                  </div>
                ))}
                {(profile?.preferences ?? []).map((p, i) => (
                  <div key={`pref-${i}`} className="flex gap-1.5">
                    <dt className="text-gray-500 shrink-0">{p.label}:</dt>
                    <dd className="text-gray-800">{p.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Carry-forwardable fields (PA setup, Backline) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sharedField('pa', 'PA setup', 'pa_setup', paTarget, 'What PA does the band want?')}
            {sharedField('backline', 'Backline from us', 'backline_notes', backlineTarget, 'What do they want from us?',
              typeof backlinePrepMins === 'number' && backlinePrepMins > 0
                ? <p className="mt-1 text-xs text-gray-400">HireHop shows backline on this job — tracked on the Backline card.</p>
                : undefined
            )}
          </div>

          {/* Per-job specifics (never carry forward) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Cars the band is bringing</label>
              <input
                type="number" min={0}
                value={form.cars_count ?? ''}
                onChange={(e) => set('cars_count', e.target.value === '' ? null : Number(e.target.value))}
                className="w-28 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Drop-off / pickup (lorry, van, etc.)</label>
              <textarea
                value={form.dropoff_pickup ?? ''}
                onChange={(e) => set('dropoff_pickup', e.target.value)}
                placeholder="Who, what, when?"
                rows={2}
                className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes (this hire)</label>
            <textarea
              value={form.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
              rows={2}
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
            />
          </div>

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
                onClick={sendPack}
                disabled={sending}
                className="rounded border border-ooosh-300 px-3 py-1.5 text-sm font-medium text-ooosh-700 hover:bg-ooosh-50 disabled:opacity-40"
              >
                {sending ? 'Sending…' : '✉ Send info pack'}
              </button>
            </div>
          </div>
          {sendResult && <p className="text-xs text-gray-600">{sendResult}</p>}
        </div>
      )}
    </div>
  );
}
