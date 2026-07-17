/**
 * Rehearsals hub (Operations → Rehearsals). Houses the studio-sitter roster
 * (re-homed from the old /operations/studio-sitters page) plus the client
 * info-pack boilerplate settings. See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
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
      await api.put('/system-settings', { settings: values });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-gray-600">
        This is the client-facing content of the pre-hire info pack email. Each field appears as its own
        section — write it as you'd like it to read. Leave a field blank to omit that section.
      </p>
      {rows.map((s) => (
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
