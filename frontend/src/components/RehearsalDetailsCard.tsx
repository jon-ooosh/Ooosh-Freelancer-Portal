/**
 * RehearsalDetailsCard — the "everything about this studio job" card on the Job
 * Detail Overview (Rehearsals module). Lightweight per-job intake + the band's
 * known preferences (surfaced read-only from the profile) + the client info pack.
 *
 * Self-hides on non-rehearsal jobs (gated on `hasRehearsal`).
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

const PROFILE_LABELS: [keyof Profile, string][] = [
  ['room_setup', 'Room setup'],
  ['mic_list', 'Mics'],
  ['power_notes', 'Power'],
  ['pa_monitoring', 'PA & monitoring'],
  ['usual_backline', 'Usual backline'],
  ['desk', 'Desk'],
  ['load_in_access', 'Load-in / access'],
  ['regular_contact', 'Regular contact'],
];

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
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const load = () => {
    api.get<{ data: Resp }>(`/rehearsals/job/${jobId}`)
      .then((r) => {
        setData(r.data);
        const d = r.data.details;
        setForm({
          pa_setup: d?.pa_setup ?? '',
          backline_notes: d?.backline_notes ?? '',
          cars_count: d?.cars_count ?? null,
          dropoff_pickup: d?.dropoff_pickup ?? '',
          notes: d?.notes ?? '',
          info_pack_sent_at: d?.info_pack_sent_at ?? null,
        });
        setDirty(false);
      })
      .catch(() => { /* leave empty */ })
      .finally(() => setLoaded(true));
  };

  useEffect(() => { if (hasRehearsal) load(); /* eslint-disable-next-line */ }, [jobId, hasRehearsal]);

  if (!hasRehearsal || !loaded) return null;

  const set = (k: keyof JobDetails, v: string | number | null) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/rehearsals/job/${jobId}`, {
        pa_setup: form.pa_setup || null,
        backline_notes: form.backline_notes || null,
        cars_count: form.cars_count,
        dropoff_pickup: form.dropoff_pickup || null,
        notes: form.notes || null,
      });
      setDirty(false);
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
  const hasProfile = knownPrefs.length > 0 || (profile?.preferences?.length ?? 0) > 0;

  const field = (label: string, k: keyof JobDetails, placeholder = '') => (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <textarea
        value={(form[k] as string) ?? ''}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
      />
    </div>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <span>🎸</span> Rehearsal details
          {data?.anchorOrg?.name && (
            <Link to={`/organisations/${data.anchorOrg.id}?tab=rehearsal`} className="text-sm font-normal text-ooosh-600 hover:underline">
              {data.anchorOrg.name}
            </Link>
          )}
        </h3>
      </div>

      {/* Known preferences from the band profile (read-only) */}
      {hasProfile && data?.anchorOrg && (
        <div className="rounded-md bg-ooosh-50 border border-ooosh-100 p-3">
          <div className="text-xs font-semibold text-ooosh-800 mb-1.5">
            Known preferences · <Link to={`/organisations/${data.anchorOrg.id}?tab=rehearsal`} className="underline">manage →</Link>
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

      {/* Per-job intake */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field('PA setup', 'pa_setup', 'What PA does the band want?')}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Backline from us</label>
          <textarea
            value={form.backline_notes ?? ''}
            onChange={(e) => set('backline_notes', e.target.value)}
            placeholder="What do they want from us?"
            rows={2}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
          />
          {typeof backlinePrepMins === 'number' && backlinePrepMins > 0 && (
            <p className="mt-1 text-xs text-gray-400">HireHop shows backline on this job — tracked on the Backline card.</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Cars the band is bringing</label>
          <input
            type="number" min={0}
            value={form.cars_count ?? ''}
            onChange={(e) => set('cars_count', e.target.value === '' ? null : Number(e.target.value))}
            className="w-28 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
          />
        </div>
        {field('Drop-off / pickup (lorry, van, etc.)', 'dropoff_pickup', 'Who, what, when?')}
      </div>
      {field('Notes', 'notes')}

      <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-gray-100">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-ooosh-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-ooosh-700 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save details'}
        </button>

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
  );
}
