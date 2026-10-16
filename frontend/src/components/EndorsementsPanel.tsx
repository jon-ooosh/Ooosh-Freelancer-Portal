import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import SearchPicker, { type PickerOption } from './SearchPicker';
import DatePicker from './DatePicker';
import { ukToday } from '../lib/ukDate';

/**
 * Artist endorsements — list + add/edit. Used on Operations › Backline –
 * Endorsements (everything, with filters) and on a person's / band's Details
 * tab (just theirs). Backend: routes/endorsements.ts → services/endorsements.ts.
 *
 * A reference, not a calculator (jon, Oct 2026): the deal is free text; "last
 * checked" is the date a rep / A&R last confirmed it; over 12 months is flagged.
 * An endorsement follows the ARTIST — it sits on a band only when the artist
 * isn't in OP, and "Edit" can move it to the person later.
 */
export interface Endorsement {
  id: string;
  brand_id: string;
  brand_name: string;
  brand_standard_deal: string | null;
  person_id: string | null;
  person_name: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  who: string | null;
  deal: string | null;
  confirmed_with: string | null;
  last_checked_on: string | null;
  last_checked_by_name: string | null;
  check_state: 'unconfirmed' | 'current' | 'stale';
  notes: string | null;
  status: 'active' | 'ended';
  ended_reason: string | null;
  via?: string;
}

export interface EndorsementBrand { id: string; name: string; standard_deal: string | null; is_active: boolean }

export function formatCheckedDate(d: string | null): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The last-checked pill — grey never confirmed, red over 12 months, green otherwise. */
export function CheckPill({ e }: { e: Pick<Endorsement, 'check_state' | 'last_checked_on' | 'last_checked_by_name'> }) {
  if (e.check_state === 'unconfirmed') {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600" title="No rep / A&R confirmation recorded yet">Not confirmed yet</span>;
  }
  const title = `Last confirmed ${formatCheckedDate(e.last_checked_on)}${e.last_checked_by_name ? ` by ${e.last_checked_by_name}` : ''}`;
  return e.check_state === 'stale'
    ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700" title={title}>Checked {formatCheckedDate(e.last_checked_on)} — over 12 months</span>
    : <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700" title={title}>Checked {formatCheckedDate(e.last_checked_on)}</span>;
}

async function searchPeople(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; first_name: string; last_name: string; current_organisations?: Array<{ organisation_name: string }> | null }> }>(
    `/people?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map((p) => ({
    value: p.id,
    label: `${p.first_name} ${p.last_name}`,
    hint: (p.current_organisations || []).map((o) => o.organisation_name).join(', ') || undefined,
  }));
}

async function searchOrgs(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
    `/organisations?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map((o) => ({ value: o.id, label: o.name, hint: o.type }));
}

const inputCls = 'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500';
const labelCls = 'block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1';

function EndorsementForm({ initial, fixedOwner, brands, onBrandAdded, onSaved, onCancel }: {
  initial: Endorsement | null;
  /** Set when the panel is scoped to one person / band — the owner isn't picked */
  fixedOwner: { kind: 'person' | 'organisation'; id: string } | null;
  brands: EndorsementBrand[];
  onBrandAdded: (b: EndorsementBrand) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const startKind: 'person' | 'organisation' = initial
    ? (initial.person_id ? 'person' : 'organisation')
    : (fixedOwner?.kind ?? 'person');
  const [ownerKind, setOwnerKind] = useState<'person' | 'organisation'>(startKind);
  const [owner, setOwner] = useState<PickerOption | null>(
    initial
      ? (initial.person_id
        ? { value: initial.person_id, label: initial.person_name || 'Person' }
        : { value: initial.organisation_id!, label: initial.organisation_name || 'Band' })
      : null
  );
  const [brandId, setBrandId] = useState(initial?.brand_id ?? '');
  const [who, setWho] = useState(initial?.who ?? '');
  const [deal, setDeal] = useState(initial?.deal ?? '');
  const [confirmedWith, setConfirmedWith] = useState(initial?.confirmed_with ?? '');
  // When the rep / A&R confirmed it — any past date (backfilling), or Today
  const [checkedOn, setCheckedOn] = useState(initial?.last_checked_on ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Editing a record that started on a band lets you move it to a person (and back)
  const canPickOwner = !fixedOwner || !!initial;
  const brand = brands.find((b) => b.id === brandId);

  async function addBrand() {
    const name = window.prompt('New brand name (e.g. Zildjian)');
    if (!name || !name.trim()) return;
    const standard = window.prompt(`Standard deal for ${name.trim()} (free text)`, `70% off ${name.trim()} kit (subject to minimum hire charge)`);
    try {
      const r = await api.post<{ data: EndorsementBrand }>('/endorsements/brands', { name: name.trim(), standard_deal: standard ?? null });
      onBrandAdded(r.data);
      setBrandId(r.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add brand');
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ownerId = canPickOwner ? owner?.value : fixedOwner?.id;
    if (!brandId) { setError('Pick a brand'); return; }
    if (!ownerId) { setError(ownerKind === 'person' ? 'Pick the artist' : 'Pick the band'); return; }
    setSaving(true);
    setError('');
    const body = {
      brand_id: brandId,
      person_id: ownerKind === 'person' ? ownerId : null,
      organisation_id: ownerKind === 'organisation' ? ownerId : null,
      who: who || null,
      deal: deal || null,
      confirmed_with: confirmedWith || null,
      notes: notes || null,
      checked_on: checkedOn || null,
    };
    try {
      if (initial) await api.put(`/endorsements/${initial.id}`, body);
      else await api.post('/endorsements', body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
      {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          {/* Same height as the artist label row (which carries the person / band switch) */}
          <div className="flex items-center h-6 mb-1"><label className={`${labelCls} mb-0`}>Brand *</label></div>
          <div className="flex gap-2">
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={inputCls}>
              <option value="">Pick a brand…</option>
              {/* A brand since switched off keeps its own option, so editing never blanks it */}
              {initial && !brands.some((b) => b.id === initial.brand_id) && (
                <option value={initial.brand_id}>{initial.brand_name}</option>
              )}
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button type="button" onClick={addBrand} className="px-3 py-1.5 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50 whitespace-nowrap">+ Brand</button>
          </div>
        </div>
        {canPickOwner && (
          <div>
            {/* Person / band switch sits in the label row so the picker lines up with Brand */}
            <div className="flex items-center justify-between gap-2 h-6 mb-1">
              <span className={`${labelCls} mb-0`}>Endorsed artist *</span>
              <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs" role="group" aria-label="Endorsement is on">
                {([['person', 'A person'], ['organisation', 'The band (artist not in OP)']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => { if (ownerKind !== k) { setOwnerKind(k); setOwner(null); } }}
                    aria-pressed={ownerKind === k}
                    className={`px-2 py-0.5 ${ownerKind === k ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <SearchPicker
              key={ownerKind}
              value={owner}
              onChange={setOwner}
              loadOptions={ownerKind === 'person' ? searchPeople : searchOrgs}
              minChars={2}
              placeholder={ownerKind === 'person' ? 'Type the artist’s name…' : 'Type the band’s name…'}
            />
          </div>
        )}
      </div>
      {ownerKind === 'organisation' && (
        <div>
          <label className={labelCls}>Who in the band</label>
          <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Drummer — Sam" className={inputCls} />
          <p className="mt-1 text-xs text-gray-500">An endorsement follows the artist. Once they’re in OP, Edit → “A person” moves it to them.</p>
        </div>
      )}
      <div>
        <label className={labelCls}>Deal</label>
        <textarea value={deal} onChange={(e) => setDeal(e.target.value)} rows={2}
          placeholder={brand?.standard_deal ? `Leave blank for the standard deal: ${brand.standard_deal}` : 'e.g. 70% off the brand’s kit (subject to minimum hire charge)'}
          className={`${inputCls} resize-none`} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Confirmed with (rep / A&R)</label>
          <input value={confirmedWith}
            onChange={(e) => { setConfirmedWith(e.target.value); if (!checkedOn && e.target.value.trim()) setCheckedOn(ukToday()); }}
            placeholder="e.g. Jo Smith, DW artist relations" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Confirmed on</label>
          <div className="flex items-center gap-2">
            <DatePicker value={checkedOn} onChange={setCheckedOn} max={ukToday()} className="flex-1" placeholder="Not confirmed yet" />
            <button type="button" onClick={() => setCheckedOn(ukToday())} className="px-3 py-2 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50">Today</button>
            {checkedOn && (
              <button type="button" onClick={() => setCheckedOn('')} className="text-xs text-gray-500 hover:underline" title="Not confirmed yet">Clear date</button>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">Backfilling? Pick the date they actually confirmed it — over 12 months ago shows red.</p>
        </div>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50">
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add endorsement'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50">Cancel</button>
      </div>
    </form>
  );
}

export default function EndorsementsPanel({ personId, organisationId, showFilters = false }: {
  personId?: string;
  organisationId?: string;
  /** The Operations page: brand / state filters and an owner column */
  showFilters?: boolean;
}) {
  const scoped = personId || organisationId;
  const fixedOwner = personId ? { kind: 'person' as const, id: personId }
    : organisationId ? { kind: 'organisation' as const, id: organisationId } : null;

  const [rows, setRows] = useState<Endorsement[]>([]);
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState<EndorsementBrand[]>([]);
  const [brandFilter, setBrandFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [showEnded, setShowEnded] = useState(false);
  const [editing, setEditing] = useState<Endorsement | 'new' | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (personId) qs.set('person_id', personId);
    if (organisationId) { qs.set('organisation_id', organisationId); qs.set('include_members', 'true'); }
    if (brandFilter) qs.set('brand_id', brandFilter);
    if (stateFilter) qs.set('state', stateFilter);
    if (showEnded) qs.set('include_ended', 'true');
    try {
      const r = await api.get<{ data: Endorsement[] }>(`/endorsements?${qs}`);
      setRows(r.data || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [personId, organisationId, brandFilter, stateFilter, showEnded]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ data: EndorsementBrand[] }>('/endorsements/brands').then((r) => setBrands(r.data || [])).catch(() => setBrands([]));
  }, []);

  async function markChecked(e: Endorsement) {
    const who = window.prompt(`Who confirmed ${e.brand_name} this time? (rep / A&R — leave as is if the same)`, e.confirmed_with || '');
    if (who === null) return;
    try {
      await api.post(`/endorsements/${e.id}/checked`, { confirmed_with: who || null });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function end(e: Endorsement) {
    const reason = window.prompt(`End this ${e.brand_name} endorsement? Reason (optional):`, '');
    if (reason === null) return;
    try {
      await api.post(`/endorsements/${e.id}/end`, { reason: reason || null });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {showFilters && (
          <>
            <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} className="rounded border border-gray-300 px-3 py-2 text-sm">
              <option value="">All brands</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="rounded border border-gray-300 px-3 py-2 text-sm">
              <option value="">Any check date</option>
              <option value="stale">Checked over 12 months ago</option>
              <option value="unconfirmed">Not confirmed yet</option>
              <option value="current">Checked in the last 12 months</option>
            </select>
          </>
        )}
        <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} className="rounded border-gray-300" />
          Show ended
        </label>
        {editing === null && (
          <button onClick={() => setEditing('new')} className="ml-auto bg-ooosh-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700">
            + Add endorsement
          </button>
        )}
      </div>

      {editing !== null && (
        <EndorsementForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          fixedOwner={fixedOwner}
          brands={brands}
          onBrandAdded={(b) => setBrands((cur) => [...cur.filter((x) => x.id !== b.id), b].sort((a, z) => a.name.localeCompare(z.name)))}
          onSaved={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          {scoped ? 'No endorsements recorded.' : 'No endorsements match.'}
        </p>
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Brand</th>
                {!scoped && <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Artist</th>}
                {organisationId && <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Who</th>}
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Deal</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Confirmed with</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Last checked</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((e) => (
                <tr key={e.id} className={e.status === 'ended' ? 'opacity-50' : ''}>
                  <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap">{e.brand_name}</td>
                  {!scoped && (
                    <td className="px-4 py-2">
                      {e.person_id
                        ? <Link to={`/people/${e.person_id}?tab=details`} className="text-ooosh-600 hover:underline">{e.person_name}</Link>
                        : <><Link to={`/organisations/${e.organisation_id}?tab=details`} className="text-ooosh-600 hover:underline">{e.organisation_name}</Link>
                            <span className="text-gray-500">{e.who ? ` — ${e.who}` : ' (band)'}</span></>}
                    </td>
                  )}
                  {organisationId && (
                    <td className="px-4 py-2 text-gray-700">
                      {/* A current member's own endorsement shows here too; it lives on them */}
                      {e.person_id
                        ? <Link to={`/people/${e.person_id}?tab=details`} className="text-ooosh-600 hover:underline">{e.person_name}</Link>
                        : (e.who || 'The band')}
                    </td>
                  )}
                  <td className="px-4 py-2 text-gray-700 max-w-xs">
                    {e.deal || <span className="text-gray-400" title="The brand's standard deal">{e.brand_standard_deal || '—'}</span>}
                    {e.notes && <p className="text-xs text-gray-500 mt-0.5">{e.notes}</p>}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{e.confirmed_with || '—'}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {e.status === 'ended'
                      ? <span className="text-xs text-gray-500">Ended{e.ended_reason ? ` — ${e.ended_reason}` : ''}</span>
                      : <CheckPill e={e} />}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-right">
                    {e.status === 'active' && (
                      <div className="flex justify-end gap-3 text-xs">
                        <button onClick={() => markChecked(e)} className="text-ooosh-600 hover:underline" title="The rep / A&R confirmed it again today">Confirmed today</button>
                        <button onClick={() => setEditing(e)} className="text-gray-600 hover:underline">Edit</button>
                        <button onClick={() => end(e)} className="text-red-600 hover:underline">End</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * The compact block for New Enquiry / Job view's Client History panel —
 * renders nothing when there are none (jon: "only if there is one").
 */
export function EndorsementsNote({ endorsements }: { endorsements: Endorsement[] | undefined | null }) {
  if (!endorsements || endorsements.length === 0) return null;
  return (
    <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
      <div className="text-xs font-semibold text-amber-800 uppercase mb-1">Endorsed artists</div>
      <ul className="space-y-1.5">
        {endorsements.map((e) => (
          <li key={e.id} className="text-xs text-gray-700">
            <span className="font-semibold text-gray-900">{e.brand_name}</span>
            {' — '}
            {e.person_id
              ? <Link to={`/people/${e.person_id}?tab=details`} className="text-ooosh-600 hover:underline">{e.person_name}</Link>
              : <span>{e.who || 'the band'}</span>}
            {e.via && e.person_id && <span className="text-gray-500"> ({e.via.charAt(0).toLowerCase() + e.via.slice(1)})</span>}
            <div className="text-gray-600">{e.deal || e.brand_standard_deal}</div>
            <div className="mt-0.5"><CheckPill e={e} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}
