/**
 * Rehearsals hub (Operations → Rehearsals). Houses the studio-sitter roster
 * (re-homed from the old /operations/studio-sitters page) plus the client
 * info-pack boilerplate settings. See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { compressImage } from '../components/holding/compress';
import StudioSittersPage from './StudioSittersPage';

type Tab = 'sitters' | 'infopack';

interface SettingRow {
  key: string;
  value: string | null;
  label: string;
  category: string;
  value_type: string;
  sort_order: number;
}

interface InfoPackImage { key: string; filename: string; caption: string; url?: string }

// Keys managed by dedicated controls below (not rendered as plain text fields).
const SPECIAL_KEYS = ['rehearsal_info_pack_images', 'rehearsal_info_pack_auto_enabled', 'rehearsal_info_pack_auto_days'];

// Photos that render inline in the client info pack (parking, loading door, site map…).
function InfoPackPhotos() {
  const [images, setImages] = useState<InfoPackImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ data: InfoPackImage[] }>('/rehearsals/info-pack-images')
      .then((r) => setImages(r.data ?? []))
      .catch(() => { /* leave empty */ })
      .finally(() => setLoading(false));
  }, []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!picked) return;
    setUploading(true);
    try {
      const file = await compressImage(picked);
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
      const r = await api.post<{ data: InfoPackImage[] }>('/rehearsals/info-pack-images', {
        r2_key: up.r2_key, filename: up.filename,
      });
      setImages(r.data ?? []);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const saveCaption = async (key: string, caption: string) => {
    try {
      const r = await api.patch<{ data: InfoPackImage[] }>(
        `/rehearsals/info-pack-images/${encodeURIComponent(key)}`, { caption }
      );
      setImages(r.data ?? []);
    } catch { /* keep local */ }
  };
  const remove = async (key: string) => {
    if (!window.confirm('Remove this photo?')) return;
    try {
      const r = await api.delete<{ data: InfoPackImage[] }>(`/rehearsals/info-pack-images/${encodeURIComponent(key)}`);
      setImages(r.data ?? []);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">Photos</label>
        {images.length < 6 && (
          <button onClick={() => fileInput.current?.click()} disabled={uploading} className="text-sm text-ooosh-600 hover:underline disabled:opacity-50">
            {uploading ? 'Uploading…' : '+ Add photo'}
          </button>
        )}
        <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onFile} />
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Rendered inline in the client email (parking, loading door, a site map…). Up to 6. Downscaled on upload.
      </p>
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : images.length === 0 ? (
        <p className="text-sm text-gray-400">No photos yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {images.map((im) => (
            <div key={im.key} className="border border-gray-200 rounded p-2 space-y-1.5">
              {im.url && <img src={im.url} alt={im.caption || im.filename} className="w-full h-28 object-cover rounded bg-gray-50" />}
              <input
                defaultValue={im.caption}
                onBlur={(e) => { if (e.target.value !== im.caption) saveCaption(im.key, e.target.value); }}
                placeholder="Caption (optional)"
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-ooosh-500 focus:ring-ooosh-500"
              />
              <button onClick={() => remove(im.key)} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InfoPackSettings() {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<{ data: SettingRow[] }>('/system-settings?category=rehearsals')
      .then((r) => {
        const list = r.data ?? [];
        setRows(list);
        setValues(Object.fromEntries(list.map((s) => [s.key, s.value ?? ''])));
      })
      .catch(() => { /* leave empty */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // Photos are managed via dedicated endpoints — never PUT the (possibly
      // stale) images JSON here or it would clobber an uploaded photo.
      const toSave = { ...values };
      delete toSave['rehearsal_info_pack_images'];
      await api.put('/system-settings', { settings: toSave });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  const boilerplate = rows.filter((s) => !SPECIAL_KEYS.includes(s.key));
  const autoEnabled = (values['rehearsal_info_pack_auto_enabled'] ?? 'false') === 'true';

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-gray-600">
        This is the client-facing content of the pre-hire info pack email. Each field appears as its own
        section — write it as you'd like it to read. Leave a field blank to omit that section.
      </p>
      {boilerplate.map((s) => (
        <div key={s.key}>
          <label className="block text-sm font-medium text-gray-700 mb-1">{s.label}</label>
          <textarea
            value={values[s.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:ring-ooosh-500"
          />
        </div>
      ))}

      <InfoPackPhotos />

      {/* Auto-send (persisted with the Save button below). */}
      <div className="rounded-md border border-gray-200 p-3 space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={autoEnabled}
            onChange={(e) => setValues((v) => ({ ...v, rehearsal_info_pack_auto_enabled: e.target.checked ? 'true' : 'false' }))}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Auto-send the info pack before each rehearsal
        </label>
        <div className="flex items-center gap-2 text-sm text-gray-600 pl-6">
          <span>Send</span>
          <input
            type="number" min={1} max={60}
            value={values['rehearsal_info_pack_auto_days'] ?? '7'}
            onChange={(e) => setValues((v) => ({ ...v, rehearsal_info_pack_auto_days: e.target.value }))}
            disabled={!autoEnabled}
            className="w-16 rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:ring-ooosh-500 disabled:opacity-50"
          />
          <span>days before the first session (only confirmed rehearsals; once per job).</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-ooosh-600 px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-green-600">Saved ✓</span>}
      </div>
    </div>
  );
}

export default function RehearsalsPage() {
  const [params, setParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(user?.role);
  const initial = params.get('tab') === 'infopack' && isManager ? 'infopack' : 'sitters';
  const [tab, setTab] = useState<Tab>(initial);

  const select = (t: Tab) => {
    setTab(t);
    const next = new URLSearchParams(params);
    if (t === 'sitters') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-6 px-1">
          <button
            onClick={() => select('sitters')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'sitters' ? 'border-ooosh-600 text-ooosh-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Studio Sitters
          </button>
          {isManager && (
            <button
              onClick={() => select('infopack')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'infopack' ? 'border-ooosh-600 text-ooosh-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Info Pack settings
            </button>
          )}
        </nav>
      </div>

      {tab === 'sitters' && <StudioSittersPage />}
      {tab === 'infopack' && isManager && <InfoPackSettings />}
    </div>
  );
}
