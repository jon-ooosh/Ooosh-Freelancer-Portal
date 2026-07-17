/**
 * RehearsalProfileSection — the band's persistent "hotel book" on the Org Detail
 * Rehearsals tab. First-class fields + a flexible preferences list + desk files +
 * internal notes. Surfaces read-only on the Job Detail rehearsal card next time
 * the band is in. See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md.
 */
import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';

interface ProfileFile {
  r2_key: string;
  filename: string;
  content_type?: string | null;
  label?: string | null;
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
  internal_notes: string | null;
  files: ProfileFile[];
}

const TEXT_FIELDS: [keyof Profile, string, string][] = [
  ['room_setup', 'Room setup', 'Round a table / forward-facing / their own layout…'],
  ['mic_list', 'Mics they usually ask for', ''],
  ['power_notes', 'Power / distro needs', ''],
  ['pa_monitoring', 'PA & monitoring preferences', 'Wedges / IEMs, monitor mix quirks…'],
  ['usual_backline', 'Usual backline', 'What they hire from us vs bring'],
  ['desk', 'In-house desk they use', ''],
  ['load_in_access', 'Load-in / access quirks', 'Early in, late finish, loading…'],
  ['regular_contact', 'Regular contact', 'TM / engineer + how they like to be reached'],
];

const EMPTY: Profile = {
  organisation_id: '', room_setup: '', mic_list: '', power_notes: '', pa_monitoring: '',
  usual_backline: '', desk: '', load_in_access: '', regular_contact: '',
  preferences: [], internal_notes: '', files: [],
};

export default function RehearsalProfileSection({ entityId }: { entityType?: string; entityId: string }) {
  const [p, setP] = useState<Profile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () => {
    api.get<{ data: Profile | null }>(`/rehearsals/profile/${entityId}`)
      .then((r) => setP({ ...EMPTY, ...(r.data ?? {}), preferences: r.data?.preferences ?? [], files: r.data?.files ?? [] }))
      .catch(() => setP(EMPTY))
      .finally(() => setLoading(false));
  };
  useEffect(load, [entityId]);

  const setField = (k: keyof Profile, v: any) => setP((cur) => ({ ...cur, [k]: v }));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const body: Record<string, unknown> = { preferences: p.preferences.filter((x) => x.label.trim() || x.value.trim()) };
      for (const [k] of TEXT_FIELDS) body[k] = (p[k] as string) || null;
      body.internal_notes = p.internal_notes || null;
      await api.put(`/rehearsals/profile/${entityId}`, body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addPref = () => setP((c) => ({ ...c, preferences: [...c.preferences, { label: '', value: '' }] }));
  const setPref = (i: number, k: 'label' | 'value', v: string) =>
    setP((c) => ({ ...c, preferences: c.preferences.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const rmPref = (i: number) => setP((c) => ({ ...c, preferences: c.preferences.filter((_, j) => j !== i) }));

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string; filename: string; content_type: string; size_bytes: number }>('/files/upload', fd);
      const r = await api.post<{ data: Profile }>(`/rehearsals/profile/${entityId}/files`, {
        r2_key: up.r2_key, filename: up.filename, content_type: up.content_type, size_bytes: up.size_bytes,
      });
      setP((c) => ({ ...c, files: r.data.files ?? [] }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (key: string) => {
    if (!window.confirm('Remove this file?')) return;
    try {
      const r = await api.delete<{ data: Profile }>(`/rehearsals/profile/${entityId}/files/${encodeURIComponent(key)}`);
      setP((c) => ({ ...c, files: r.data.files ?? [] }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  const openFile = async (f: ProfileFile) => {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(f.r2_key)}`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      alert('Failed to open file');
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-gray-600">
        How this band likes their rehearsals set up. Saved here, it surfaces automatically on their next
        booking (Job Detail → Rehearsal details) so we can have things ready for them.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {TEXT_FIELDS.map(([k, label, ph]) => (
          <div key={k}>
            <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
            <textarea
              value={(p[k] as string) ?? ''}
              onChange={(e) => setField(k, e.target.value)}
              placeholder={ph}
              rows={2}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
            />
          </div>
        ))}
      </div>

      {/* Flexible preferences list — the hotel touch */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">Preferences</label>
          <button onClick={addPref} className="text-sm text-ooosh-600 hover:underline">+ Add preference</button>
        </div>
        <p className="text-xs text-gray-500 mb-2">e.g. Milk → Oat ×2, Soya ×1 · Catering → …  · Watch-out → don't move the piano</p>
        <div className="space-y-2">
          {p.preferences.length === 0 && <p className="text-sm text-gray-400">No preferences yet.</p>}
          {p.preferences.map((pref, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={pref.label}
                onChange={(e) => setPref(i, 'label', e.target.value)}
                placeholder="Label (e.g. Milk)"
                className="w-40 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
              />
              <input
                value={pref.value}
                onChange={(e) => setPref(i, 'value', e.target.value)}
                placeholder="Value (e.g. Oat ×2, Soya ×1)"
                className="flex-1 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
              />
              <button onClick={() => rmPref(i)} className="text-gray-400 hover:text-red-500 px-1" title="Remove">✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Desk files / saved mixes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">Desk files & documents</label>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="text-sm text-ooosh-600 hover:underline disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '+ Upload file'}
          </button>
          <input ref={fileInput} type="file" className="hidden" onChange={onFile} />
        </div>
        <div className="space-y-1.5">
          {p.files.length === 0 && <p className="text-sm text-gray-400">No files yet — e.g. a saved desk file for the in-house digital desk.</p>}
          {p.files.map((f) => (
            <div key={f.r2_key} className="flex items-center gap-2 text-sm">
              <button onClick={() => openFile(f)} className="text-ooosh-600 hover:underline truncate">{f.filename}</button>
              <button onClick={() => removeFile(f.r2_key)} className="text-gray-400 hover:text-red-500 text-xs ml-auto" title="Remove">Remove</button>
            </div>
          ))}
        </div>
      </div>

      {/* Internal notes */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Internal notes</label>
        <textarea
          value={p.internal_notes ?? ''}
          onChange={(e) => setField('internal_notes', e.target.value)}
          placeholder="Last time… observations, anything worth remembering."
          rows={3}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-ooosh-600 px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {saved && <span className="text-sm text-green-600">Saved ✓</span>}
      </div>
    </div>
  );
}
