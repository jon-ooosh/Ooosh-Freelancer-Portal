/**
 * A social post, new or existing (docs/BUSINESS-FIGURES-SPEC.md §8e) — every staff login.
 * OP plans it; the post itself is scheduled in Meta Business Suite ("Copy for Meta" puts
 * the caption and hashtags on the clipboard). Backend: routes/marketing-content.ts.
 *
 * Merges the server's reply into the parent through onSaved, and stays open after a save,
 * so a person can keep working on it (frontend.md "Modals").
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import ModalShell from '../ModalShell';
import SearchPicker, { type PickerOption } from '../SearchPicker';
import { ukToday } from '../../lib/ukDate';
import {
  type Asset, type Channel, type Post, CHANNELS, FORMATS, STATUSES, IG_CAPTION_MAX, IG_HASHTAG_MAX, countHashtags,
  assetKindOf, ASSET_KINDS,
} from './contentCopy';

interface StaffOption { id: string; person_id: string | null; first_name: string; last_name: string; preferred_name?: string | null }
interface LinkChoice { id: string; code: string; label: string | null; short_url: string }
interface HashtagSet { id: string; name: string; tags: string }

const box = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm';
const label = 'block text-xs font-semibold text-gray-700 mb-1';
const errMsg = (e: unknown, fallback: string) => (e as { body?: { error?: string } })?.body?.error || fallback;

export async function searchJobs(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null }> }>(
    `/hirehop/jobs?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map((j) => ({ value: j.id, label: j.hh_job_number ? `#${j.hh_job_number}` : (j.job_name || j.client_name || 'Job'), hint: j.job_name || j.client_name || undefined }));
}
export async function searchOrgs(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; name: string }> }>(`/organisations?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map((o) => ({ value: o.id, label: o.name }));
}
export async function searchPeople(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; first_name: string; last_name: string }> }>(`/people?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}`.trim() }));
}

export default function PostEditor({ postId, startDate, onClose, onSaved }: {
  postId: string | null;
  /** A new post from a calendar day. */
  startDate?: string | null;
  onClose: () => void;
  onSaved: (p: Post) => void;
}) {
  const [loading, setLoading] = useState(!!postId);
  const [id, setId] = useState<string | null>(postId);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(startDate || '');
  const [time, setTime] = useState('18:00');
  const [channels, setChannels] = useState<Channel[]>(['instagram', 'facebook']);
  const [format, setFormat] = useState('');
  const [status, setStatus] = useState<string>(startDate ? 'in_progress' : 'idea');
  const [owner, setOwner] = useState('');
  const [theme, setTheme] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [job, setJob] = useState<PickerOption | null>(null);
  const [org, setOrg] = useState<PickerOption | null>(null);
  const [credit, setCredit] = useState<PickerOption | null>(null);
  const [linkId, setLinkId] = useState('');
  const [liveUrl, setLiveUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [links, setLinks] = useState<LinkChoice[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [sets, setSets] = useState<HashtagSet[]>([]);
  const [library, setLibrary] = useState<Asset[]>([]);
  const [newAsset, setNewAsset] = useState<{ title: string; url: string; kind: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    api.get<{ data: StaffOption[] }>('/users?assignable=true').then((r) => setStaff(r.data)).catch(() => {});
    api.get<{ data: LinkChoice[] }>('/marketing-content/links').then((r) => setLinks(r.data)).catch(() => {});
    api.get<{ data: string[] }>('/marketing-content/themes').then((r) => setThemes(r.data)).catch(() => {});
    api.get<{ data: HashtagSet[] }>('/marketing-content/hashtag-sets').then((r) => setSets(r.data)).catch(() => {});
    api.get<{ data: Asset[] }>('/marketing-content/assets').then((r) => setLibrary(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!postId) return;
    api.get<{ data: Post }>(`/marketing-content/posts/${postId}`)
      .then((r) => {
        const p = r.data;
        setTitle(p.title); setDate(p.publish_date || ''); setTime(p.publish_time || '18:00');
        setChannels(p.channels || []); setFormat(p.format || ''); setStatus(p.status);
        setOwner(p.owner_person_id || ''); setTheme(p.theme || ''); setCaption(p.caption || ''); setHashtags(p.hashtags || '');
        setJob(p.job_id ? { value: p.job_id, label: p.job_number ? `#${p.job_number}` : (p.job_name || 'Job'), hint: p.job_name || undefined } : null);
        setOrg(p.organisation_id ? { value: p.organisation_id, label: p.organisation_name || 'Band' } : null);
        setCredit(p.credit_person_id ? { value: p.credit_person_id, label: p.credit_name || 'Person' } : null);
        setLinkId(p.tracked_link_id || ''); setLiveUrl(p.live_url || ''); setNotes(p.notes || ''); setAssets(p.assets || []);
      })
      .catch((e) => setError(errMsg(e, 'Could not load the post')))
      .finally(() => setLoading(false));
  }, [postId]);

  const formats = useMemo(() => FORMATS.filter((f) => channels.length === 0 || f.for.some((c) => channels.includes(c))), [channels]);
  const tagCount = countHashtags(hashtags);
  const igTicked = channels.includes('instagram');

  function toggleChannel(c: Channel) {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function save(overrides: Partial<{ status: string }> = {}) {
    if (!title.trim()) { setError('Give the post a name'); return; }
    setSaving(true);
    setError('');
    setNote('');
    const body = {
      title: title.trim(), publish_date: date || null, publish_time: date ? (time || '18:00') : null, channels,
      format: format || null, status: overrides.status ?? status, owner_person_id: owner || null, theme: theme.trim() || null,
      caption: caption || null, hashtags: hashtags || null, job_id: job?.value || null, organisation_id: org?.value || null,
      credit_person_id: credit?.value || null, tracked_link_id: linkId || null, live_url: liveUrl.trim() || null,
      notes: notes || null, asset_ids: assets.map((a) => a.id),
    };
    try {
      const r = id
        ? await api.patch<{ data: Post }>(`/marketing-content/posts/${id}`, body)
        : await api.post<{ data: Post }>('/marketing-content/posts', body);
      setId(r.data.id);
      setStatus(r.data.status);
      onSaved(r.data);
      setNote('Saved.');
    } catch (e) {
      setError(errMsg(e, 'Could not save'));
    } finally {
      setSaving(false);
    }
  }

  async function addNewAsset() {
    if (!newAsset) return;
    try {
      const r = await api.post<{ data: Asset }>('/marketing-content/assets', {
        title: newAsset.title.trim(), url: newAsset.url.trim(), kind: newAsset.kind,
        job_id: job?.value || null, organisation_id: org?.value || null, credit_person_id: credit?.value || null,
      });
      setAssets((prev) => [...prev, r.data]);
      setLibrary((prev) => [r.data, ...prev]);
      setNewAsset(null);
    } catch (e) {
      setError(errMsg(e, 'Could not add that'));
    }
  }

  async function saveSet() {
    const name = window.prompt('Name this hashtag set (e.g. "Rehearsal rooms")');
    if (!name?.trim()) return;
    try { setSets((await api.post<{ data: HashtagSet[] }>('/marketing-content/hashtag-sets', { name: name.trim(), tags: hashtags })).data); }
    catch (e) { setError(errMsg(e, 'Could not save the set')); }
  }

  async function copyForMeta() {
    const text = [caption.trim(), hashtags.trim()].filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(text); setNote('Caption and hashtags copied — paste them into Meta Business Suite.'); }
    catch { setNote('Your browser blocked copying — select the caption and copy it by hand.'); }
  }

  const libraryOptions: PickerOption[] = library
    .filter((a) => !assets.some((x) => x.id === a.id))
    .map((a) => ({ value: a.id, label: `${assetKindOf(a.kind).icon} ${a.title}`, hint: [a.organisation_name, a.job_number ? `#${a.job_number}` : null].filter(Boolean).join(' · ') || undefined }));

  return (
    <ModalShell title={id ? 'Social post' : 'New social post'} subtitle="Planned here; scheduled and posted in Meta Business Suite." onClose={() => { if (!saving) onClose(); }} width="max-w-3xl">
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : (
        <div className="space-y-4 text-sm">
          <div>
            <label className={label} htmlFor="mp-title">Name (for us)</label>
            <input id="mp-title" className={box} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ruby Road on tour - van shot" autoFocus />
          </div>

          <div className="flex flex-wrap gap-4">
            <div>
              <span className={label}>Channels</span>
              <div className="flex flex-wrap gap-1.5">
                {CHANNELS.map((c) => (
                  <button key={c.key} type="button" onClick={() => toggleChannel(c.key)}
                    className={`px-2.5 py-1 rounded-full border text-xs font-medium ${channels.includes(c.key) ? c.cls : 'bg-white text-gray-500 border-gray-300'}`}>
                    {channels.includes(c.key) ? '✓ ' : ''}{c.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={label} htmlFor="mp-format">Format</label>
              <select id="mp-format" className={box} value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">—</option>
                {formats.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                {format && !formats.some((f) => f.key === format) && <option value={format}>{FORMATS.find((f) => f.key === format)?.label || format}</option>}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className={label} htmlFor="mp-date">Goes out on</label>
              <input id="mp-date" type="date" className={box} value={date} min={date && date < ukToday() ? undefined : ukToday()} onChange={(e) => setDate(e.target.value)} />
              {!date && <p className="text-[11px] text-gray-500 mt-0.5">No date = an idea</p>}
            </div>
            <div>
              <label className={label} htmlFor="mp-time">At</label>
              <input id="mp-time" type="time" className={box} value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="mp-status">Status</label>
              <select id="mp-status" className={box} value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="mp-owner">Owner</label>
              <select id="mp-owner" className={box} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Nobody yet</option>
                {staff.filter((u) => u.person_id).map((u) => (
                  <option key={u.person_id!} value={u.person_id!}>{`${u.preferred_name || u.first_name} ${u.last_name}`.trim()}</option>
                ))}
                {owner && !staff.some((u) => u.person_id === owner) && <option value={owner}>Someone else</option>}
              </select>
              <p className="text-[11px] text-gray-500 mt-0.5">Gets a To Do two days before, if it isn't approved.</p>
            </div>
          </div>

          <div>
            <label className={label} htmlFor="mp-theme">Theme</label>
            <input id="mp-theme" className={box} list="mp-themes" value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="Bands on the road / Kit spotlight / Behind the scenes / Tips / Offers" />
            <datalist id="mp-themes">{themes.map((t) => <option key={t} value={t} />)}</datalist>
          </div>

          <div>
            <div className="flex items-end justify-between">
              <label className={label} htmlFor="mp-caption">Caption, with the call to action</label>
              <span className={`text-[11px] mb-1 ${igTicked && caption.length > IG_CAPTION_MAX ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                {caption.length}{igTicked ? ` / ${IG_CAPTION_MAX}` : ''}
              </span>
            </div>
            <textarea id="mp-caption" rows={5} className={box} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>

          <div>
            <div className="flex items-end justify-between">
              <label className={label} htmlFor="mp-tags">Hashtags and mentions</label>
              <span className={`text-[11px] mb-1 ${igTicked && tagCount > IG_HASHTAG_MAX ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                {tagCount} hashtag{tagCount === 1 ? '' : 's'}{igTicked ? ` (Instagram allows ${IG_HASHTAG_MAX})` : ''}
              </span>
            </div>
            <textarea id="mp-tags" rows={2} className={box} value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#oooshtours #tourlife @theband" />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {sets.length > 0 && (
                <select className="border border-gray-300 rounded px-2 py-1" value="" onChange={(e) => {
                  const s = sets.find((x) => x.id === e.target.value);
                  if (s) setHashtags((h) => [h.trim(), s.tags].filter(Boolean).join(' '));
                }}>
                  <option value="">+ Add a saved set…</option>
                  {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {hashtags.trim() && <button type="button" onClick={saveSet} className="text-ooosh-700 hover:underline">Save these as a set</button>}
            </div>
          </div>

          <div>
            <span className={label}>Content (photos, videos, graphics)</span>
            {assets.length > 0 && (
              <ul className="mb-2 divide-y rounded-lg border border-gray-200">
                {assets.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-ooosh-700 hover:underline">{assetKindOf(a.kind).icon} {a.title}</a>
                    <button type="button" onClick={() => setAssets((prev) => prev.filter((x) => x.id !== a.id))} className="text-xs text-gray-400 hover:text-red-600">Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <SearchPicker value={null} options={libraryOptions} placeholder="Add from the library…"
                onChange={(o) => { const a = library.find((x) => x.id === o?.value); if (a) setAssets((prev) => [...prev, a]); }} />
              {!newAsset ? (
                <button type="button" onClick={() => setNewAsset({ title: '', url: '', kind: 'photo' })}
                  className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-left text-xs text-gray-600 hover:bg-gray-50">+ A new Drive link</button>
              ) : null}
            </div>
            {newAsset && (
              <div className="mt-2 grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 sm:grid-cols-[1fr_1.4fr_auto_auto]">
                <input className={box} placeholder="What it is" value={newAsset.title} onChange={(e) => setNewAsset({ ...newAsset, title: e.target.value })} />
                <input className={box} placeholder="https://drive.google.com/…" value={newAsset.url} onChange={(e) => setNewAsset({ ...newAsset, url: e.target.value })} />
                <select className={box} value={newAsset.kind} onChange={(e) => setNewAsset({ ...newAsset, kind: e.target.value })}>
                  {ASSET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
                <span className="flex gap-1">
                  <button type="button" onClick={addNewAsset} className="rounded-lg bg-ooosh-600 px-3 py-2 text-xs text-white hover:bg-ooosh-700">Add</button>
                  <button type="button" onClick={() => setNewAsset(null)} className="px-2 text-xs text-gray-500">✕</button>
                </span>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div><span className={label}>The band</span><SearchPicker value={org} onChange={setOrg} loadOptions={searchOrgs} minChars={2} placeholder="Search bands…" /></div>
            <div><span className={label}>Their job</span><SearchPicker value={job} onChange={setJob} loadOptions={searchJobs} minChars={2} placeholder="Job number or name…" /></div>
            <div><span className={label}>Credit (photographer)</span><SearchPicker value={credit} onChange={setCredit} loadOptions={searchPeople} minChars={2} placeholder="Search people…" /></div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="mp-link">Tracked link for the call to action</label>
              <select id="mp-link" className={box} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                <option value="">None</option>
                {links.map((l) => <option key={l.id} value={l.id}>{l.short_url.replace(/^https?:\/\//, '')}{l.label ? ` — ${l.label}` : ''}</option>)}
                {linkId && !links.some((l) => l.id === linkId) && <option value={linkId}>(a paused link)</option>}
              </select>
              <p className="text-[11px] text-gray-500 mt-0.5">So we can see which posts bring enquiries.</p>
            </div>
            <div>
              <label className={label} htmlFor="mp-live">The post, once it's up</label>
              <input id="mp-live" className={box} value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} placeholder="https://www.instagram.com/p/…" />
            </div>
          </div>

          <div>
            <label className={label} htmlFor="mp-notes">Notes</label>
            <textarea id="mp-notes" rows={2} className={box} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <div className="text-red-600">{error}</div>}
          {note && <div className="text-green-700">{note}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <div className="flex gap-2">
              <button type="button" onClick={copyForMeta} disabled={!caption.trim() && !hashtags.trim()}
                className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50">Copy for Meta</button>
              {id && status !== 'dropped' && (
                <button type="button" disabled={saving} onClick={() => { if (window.confirm('Drop this post? It stays on record, off the calendar.')) void save({ status: 'dropped' }); }}
                  className="px-3 py-2 rounded-lg text-gray-500 hover:text-red-600">Drop it</button>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50">Close</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
