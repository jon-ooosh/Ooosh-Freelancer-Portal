/**
 * Single shared "log a held item" form, used by BOTH the desktop CreateModal
 * (HoldingPage) and the mobile QuickLogSheet (/quick). Previously these were two
 * drifting copies — notify-at-create existed only on mobile. Unifying them here
 * keeps the two surfaces in lockstep by construction.
 *
 * Notify-at-create: after a successful save (unless the owner is unknown or the
 * item was handed straight to the client), if "Notify client now" is ticked we
 * hand straight into the NotifyClientModal so staff email the client mid-flow
 * rather than re-opening the item afterwards. Untick to just log it.
 *
 * `variant` only switches styling (big-touch mobile sheet vs compact desktop
 * modal) and trims a couple of secondary incoming fields on mobile to keep the
 * quick-capture lean. Field set + save payload + notify logic are identical.
 */
import { useState } from 'react';
import { api } from '../../services/api';
import { EntitySearch } from './EntitySearch';
import { JobNumberField } from './JobNumberField';
import { OrgJobSuggestions } from './OrgJobSuggestions';
import { DuplicateNudge } from './DuplicateNudge';
import { NotifyClientModal } from './NotifyClientModal';
import { uploadHeldItemPhotos } from './photo-upload';
import type { HeldItem, HeldItemKind, HeldItemLocation } from '../../../../shared/types';

const PURPLE = '#7B5EA7';
const GIVEN = '__given__';
const KIND_LABEL: Record<HeldItemKind, string> = {
  incoming: 'Delivery', temp_storage: 'Temp storage', lost_property: 'Lost property',
};

async function uploadPhotos(
  files: FileList | null,
  onDone: (atts: { name: string; url: string; type: string }[]) => void,
  onErr: (m: string) => void, setBusy: (b: boolean) => void,
) {
  if (!files || files.length === 0) return;
  setBusy(true); onErr('');
  try { onDone(await uploadHeldItemPhotos(files)); }
  catch { onErr('Photo upload failed'); }
  finally { setBusy(false); }
}

export function HeldItemForm({ variant, kinds, locations, initial, onDone, onCancel }: {
  variant: 'desktop' | 'mobile';
  kinds: HeldItemKind[];          // selectable kinds (1 = fixed, >1 = toggle buttons)
  locations: HeldItemLocation[];
  initial?: {                     // optional prefill (e.g. logging from a job's Overview)
    hh_job_number?: string;
    owner_organisation_id?: string | null;
    org_name?: string;
  };
  onDone: () => void;             // saved (and notify, if any, finished)
  onCancel: () => void;
}) {
  const mobile = variant === 'mobile';
  const inputCls = mobile
    ? 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base'
    : 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';
  const labelCls = mobile ? 'block text-sm text-slate-500 mb-1' : 'block text-xs text-slate-500 mb-1';

  const [f, setF] = useState({
    kind: kinds[0],
    description: '', box_count: '',
    owner_unknown: false,
    owner_organisation_id: (initial?.owner_organisation_id ?? null) as string | null, org_name: initial?.org_name || '',
    owner_person_id: null as string | null, person_name: '',
    client_name_text: '', hh_job_number: initial?.hh_job_number || '',
    found_in: 'van', found_location_text: '',
    storage_location_id: '', storage_location_text: '',
    expected_date: '', import_charge_flag: '', hold_until: '', notes: '',
  });
  const [notifyClient, setNotifyClient] = useState(true);
  const [photos, setPhotos] = useState<{ name: string; url: string; type: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedItem, setSavedItem] = useState<HeldItem | null>(null);

  const isLost = f.kind === 'lost_property';
  const givenStraight = f.storage_location_id === GIVEN;
  const somewhereElse = locations.find((l) => l.id === f.storage_location_id)?.name === 'Somewhere else';
  // Can't notify with nobody to email, and no point if it's been handed over.
  const canNotify = !f.owner_unknown && !givenStraight;

  async function save() {
    setSaving(true); setErr('');
    try {
      const r = await api.post<{ data: HeldItem }>('/holding', {
        kind: f.kind,
        owner_unknown: f.owner_unknown,
        description: f.description || null,
        box_count: !isLost && f.box_count ? Number(f.box_count) : null,
        owner_organisation_id: f.owner_unknown ? null : f.owner_organisation_id,
        owner_person_id: f.owner_unknown ? null : f.owner_person_id,
        client_name_text: f.owner_unknown ? null : (f.client_name_text || null),
        hh_job_number: f.hh_job_number ? Number(f.hh_job_number) : null,
        found_in: isLost ? f.found_in : null,
        found_location_text: isLost ? (f.found_location_text || null) : null,
        storage_location_id: givenStraight ? null : (f.storage_location_id || null),
        storage_location_text: somewhereElse ? (f.storage_location_text || null) : null,
        status: givenStraight ? 'given_to_client' : undefined,
        expected_date: f.kind === 'incoming' && f.expected_date ? f.expected_date : null,
        import_charge_flag: f.kind === 'incoming' && f.import_charge_flag ? f.import_charge_flag : null,
        hold_until: f.kind === 'temp_storage' && f.hold_until ? f.hold_until : null,
        notes: f.notes || null,
        photos,
      });
      // Notify mid-flow: hand straight into the picker (photos already attached).
      if (notifyClient && canNotify && r.data) { setSavedItem(r.data); setSaving(false); return; }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); setSaving(false); }
  }

  if (savedItem) {
    return <NotifyClientModal item={savedItem} onClose={onDone} onSent={onDone} />;
  }

  const submitLabel = saving ? 'Saving…' : (notifyClient && canNotify ? 'Log & notify →' : 'Log it');

  return (
    <div className={mobile ? 'space-y-4 max-w-md mx-auto' : 'space-y-3'}>
      {kinds.length > 1 && (
        <div className="flex gap-2">
          {kinds.map((k) => (
            <button key={k} type="button" onClick={() => setF({ ...f, kind: k })}
              className={`px-3 py-1.5 rounded-lg text-sm border ${f.kind === k ? 'bg-[#7B5EA7] text-white border-[#7B5EA7]' : 'bg-white text-slate-600 border-slate-300'}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      <div><label className={labelCls}>{isLost ? 'What is it?' : 'Description'}</label>
        <input className={inputCls} autoFocus value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
          placeholder={isLost ? 'e.g. Black rucksack, 2 cables' : 'e.g. 3 merch boxes'} /></div>

      {!isLost && (
        <div className={mobile ? '' : 'grid grid-cols-2 gap-3'}>
          <div><label className={labelCls}>Number of boxes/items</label>
            <input className={inputCls} type="number" inputMode="numeric" value={f.box_count} onChange={(e) => setF({ ...f, box_count: e.target.value })} /></div>
          {!mobile && f.kind === 'incoming' && <div><label className={labelCls}>Expected date</label>
            <input className={inputCls} type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></div>}
        </div>
      )}

      {isLost && (
        <div className="grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Found in</label>
            <select className={inputCls} value={f.found_in} onChange={(e) => setF({ ...f, found_in: e.target.value })}>
              <option value="van">Van</option><option value="rehearsal">Rehearsal room</option><option value="backline">Backline</option><option value="elsewhere">Somewhere else</option>
            </select></div>
          {f.found_in === 'van' && <div><label className={labelCls}>Van reg</label>
            <input className={inputCls} value={f.found_location_text} onChange={(e) => setF({ ...f, found_location_text: e.target.value.toUpperCase() })} placeholder="e.g. RX22SXL" /></div>}
        </div>
      )}

      {/* Owner — HireHop job # first; we derive the client from it */}
      <div className="border border-slate-200 rounded-lg p-3 space-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={f.owner_unknown} onChange={(e) => setF({ ...f, owner_unknown: e.target.checked })} />
          Owner unknown (log now, link later)
        </label>
        {!f.owner_unknown && (
          <>
            <JobNumberField value={f.hh_job_number} onChange={(v) => setF({ ...f, hh_job_number: v })} compact={mobile} />
            {!mobile && <DuplicateNudge hhJobNumber={f.hh_job_number} />}
            <EntitySearch kind="organisations" label="Client / band (organisation)" value={f.org_name} compact={mobile} onPick={(id, name) => setF({ ...f, owner_organisation_id: id, org_name: name })} />
            <OrgJobSuggestions orgId={f.owner_organisation_id} hasNumber={!!f.hh_job_number} compact={mobile} onPick={(n) => setF({ ...f, hh_job_number: n })} />
            <EntitySearch kind="people" label="Or a person" value={f.person_name} compact={mobile} onPick={(id, name) => setF({ ...f, owner_person_id: id, person_name: name })} />
            <div><label className={labelCls}>Or just a name (free text)</label>
              <input className={inputCls} value={f.client_name_text} onChange={(e) => setF({ ...f, client_name_text: e.target.value })} /></div>
          </>
        )}
      </div>

      {/* Where stored */}
      <div className={mobile ? '' : 'grid grid-cols-2 gap-3'}>
        <div><label className={labelCls}>Where stored</label>
          <select className={inputCls} value={f.storage_location_id} onChange={(e) => setF({ ...f, storage_location_id: e.target.value })}>
            <option value="">—</option>
            <option value={GIVEN}>✋ Given straight to client</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        {somewhereElse && <div><label className={labelCls}>Where exactly?</label>
          <input className={inputCls} value={f.storage_location_text} onChange={(e) => setF({ ...f, storage_location_text: e.target.value })} /></div>}
      </div>

      {!mobile && f.kind === 'incoming' && (
        <div><label className={labelCls}>Customs / import charge?</label>
          <select className={inputCls} value={f.import_charge_flag} onChange={(e) => setF({ ...f, import_charge_flag: e.target.value })}>
            <option value="">—</option><option value="no">No</option><option value="yes">Yes</option><option value="unknown">Don't know</option>
          </select></div>
      )}

      {f.kind === 'temp_storage' && (
        <div><label className={labelCls}>Hold until (optional)</label>
          <input className={inputCls} type="date" value={f.hold_until} onChange={(e) => setF({ ...f, hold_until: e.target.value })} />
          <p className="text-[11px] text-slate-400 mt-1">We'll remind the team 3 days before this date.</p></div>
      )}

      {/* Photos */}
      <div>
        <label className={labelCls}>Photo{mobile ? '' : 's'}</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {photos.map((p, idx) => (
            <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 rounded px-2 py-1">📷 {p.name}
              <button type="button" onClick={() => setPhotos((cur) => cur.filter((_, j) => j !== idx))} className="text-red-500">×</button></span>
          ))}
        </div>
        {mobile ? (
          <label className="block w-full border-2 border-dashed border-slate-300 rounded-xl py-4 text-center text-slate-500 text-sm">
            📸 Take a photo
            <input type="file" accept="image/*" capture="environment" multiple className="hidden"
              onChange={(e) => uploadPhotos(e.target.files, (a) => setPhotos((p) => [...p, ...a]), setErr, setUploading)} />
          </label>
        ) : (
          <input type="file" accept="image/*" multiple capture="environment" className="text-xs"
            onChange={(e) => uploadPhotos(e.target.files, (a) => setPhotos((p) => [...p, ...a]), setErr, setUploading)} />
        )}
        {uploading && <span className="text-xs text-slate-400 ml-2">Uploading…</span>}
      </div>

      <div><label className={labelCls}>Notes</label>
        <textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>

      {/* Notify-at-create toggle — default on; untick to just log it. */}
      {canNotify && (
        <label className="flex items-start gap-2 text-sm text-slate-700 bg-[#7B5EA7]/5 border border-[#7B5EA7]/20 rounded-lg p-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4" checked={notifyClient} onChange={(e) => setNotifyClient(e.target.checked)} />
          <span>
            <span className="font-medium">✉ Notify client now</span>
            <span className="block text-xs text-slate-500">After logging you'll pick who to email (the photos are attached). Untick to just log it.</span>
          </span>
        </label>
      )}

      {err && <p className="text-red-600 text-sm">{err}</p>}

      {mobile ? (
        <button onClick={save} disabled={saving || uploading} style={{ backgroundColor: PURPLE }}
          className="w-full text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50">{submitLabel}</button>
      ) : (
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button onClick={save} disabled={saving || uploading} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{submitLabel}</button>
        </div>
      )}
    </div>
  );
}
