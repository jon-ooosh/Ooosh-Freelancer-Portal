/**
 * Staff acknowledge-receipt page — the target of the QR code on a merch label.
 * Behind staff login (a UPS driver scanning the label just hits the login wall).
 * Staff confirm how many boxes arrived, snap a photo, pick where they're storing
 * it (or "given straight to client"), then get walked straight to notifying the
 * client as the obvious next step.
 */
import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { uploadHeldItemPhotos } from '../components/holding/photo-upload';
import { locationLabel } from '../components/holding/format';
import type { HeldItem, HeldItemLocation } from '../../../shared/types';

const inputCls = 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base';
const PURPLE = '#7B5EA7';
const GIVEN = '__given__';

export default function HoldingReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [h, setH] = useState<HeldItem | null>(null);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);
  const [received, setReceived] = useState('');
  const [locationId, setLocationId] = useState('');
  const [locationText, setLocationText] = useState('');
  const [photos, setPhotos] = useState<{ name: string; url: string; type: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [err, setErr] = useState('');
  const [phase, setPhase] = useState<'form' | 'received' | 'given'>('form');
  const [notifyMsg, setNotifyMsg] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<{ data: HeldItem }>(`/holding/${id}`);
      setH(r.data);
      setReceived(String(r.data.received_count ?? r.data.box_count ?? ''));
      setLocationId(r.data.storage_location_id || '');
    } catch { setErr('Could not load this consignment.'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  const givenStraight = locationId === GIVEN;
  const somewhereElse = locations.find((l) => l.id === locationId)?.name === 'Somewhere else';

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true); setErr('');
    try {
      const uploaded = await uploadHeldItemPhotos(files);
      setPhotos((p) => [...p, ...uploaded]);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setUploading(false); }
  }

  async function markReceived() {
    if (!h) return;
    setSaving(true); setErr('');
    try {
      // Save any photos + received count first
      await api.put(`/holding/${h.id}`, {
        received_count: received ? Number(received) : null,
        photos: [...(h.photos || []), ...photos],
        ...(givenStraight ? {} : { storage_location_id: locationId || null, storage_location_text: somewhereElse ? (locationText || null) : null, status: 'stored' }),
      });
      if (givenStraight) {
        await api.post(`/holding/${h.id}/collected`, {});
        setPhase('given');
      } else {
        setPhase('received');
      }
      await load();
      setPhotos([]);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }

  async function notify() {
    if (!h) return;
    setNotifying(true); setNotifyMsg('');
    try {
      const r = await api.post<{ emailed: boolean; notified_to: string | null }>(`/holding/${h.id}/notify`, {});
      setNotifyMsg(r.emailed ? `✓ Emailed ${r.notified_to}` : '✓ Marked notified (no client email on file — let the office know)');
      await load();
    } catch (e) { setNotifyMsg(e instanceof Error ? e.message : 'Failed'); } finally { setNotifying(false); }
  }

  if (!h) return <div className="p-8 text-center text-slate-400">{err || 'Loading…'}</div>;

  const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;

  // ── Done states ──
  if (phase === 'given') {
    return (
      <div className="max-w-md mx-auto p-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <div className="text-5xl mb-3">✋</div>
          <h1 className="text-xl font-bold text-slate-800 mb-1">Handed to client</h1>
          <p className="text-slate-500 text-sm mb-5">{h.description} given straight to {client || 'the client'}.</p>
          <button onClick={() => navigate('/holding')} className="w-full text-white rounded-xl py-3 font-semibold" style={{ backgroundColor: PURPLE }}>Done</button>
        </div>
      </div>
    );
  }

  if (phase === 'received') {
    const alreadyNotified = h.status === 'client_notified';
    return (
      <div className="max-w-md mx-auto p-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
          <div className="text-5xl mb-3">📦</div>
          <h1 className="text-xl font-bold text-slate-800 mb-1">Received & stored</h1>
          <p className="text-slate-500 text-sm mb-6">{h.received_count ?? '?'} item(s){locationLabel(h) ? ` · ${locationLabel(h)}` : ''}.</p>

          <p className="text-sm font-medium text-slate-700 mb-2">Next: let the client know it's arrived</p>
          <button onClick={notify} disabled={notifying || alreadyNotified}
            className="w-full bg-green-600 text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50 mb-2">
            {alreadyNotified ? 'Client already notified' : notifying ? 'Notifying…' : '✉ Notify client'}
          </button>
          {notifyMsg && <p className={`text-sm mb-2 ${notifyMsg.startsWith('✓') ? 'text-green-600' : 'text-red-600'}`}>{notifyMsg}</p>}
          <button onClick={() => navigate('/holding')} className="w-full text-slate-500 text-sm py-2">Skip — go to Held for Clients</button>
        </div>
      </div>
    );
  }

  // ── Receive form ──
  return (
    <div className="max-w-md mx-auto p-4 space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h1 className="text-xl font-bold text-slate-800 mb-1">📦 Receive consignment</h1>
        <p className="text-sm text-slate-500">{client || 'Unknown client'}{h.hh_job_number ? ` · Job #${h.hh_job_number}` : ''}</p>
        <p className="text-sm text-slate-600 mt-2">{h.description || 'Items'}{h.box_count ? ` · ${h.box_count} expected` : ''}</p>
        <p className="text-xs mt-1"><span className="px-2 py-0.5 rounded bg-slate-100 capitalize">{h.status.replace(/_/g, ' ')}</span></p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div><label className="block text-sm text-slate-500 mb-1">How many boxes arrived?</label>
          <input className={inputCls} type="number" inputMode="numeric" value={received} onChange={(e) => setReceived(e.target.value)} /></div>

        <div><label className="block text-sm text-slate-500 mb-1">Where are you storing it?</label>
          <select className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">—</option>
            <option value={GIVEN}>✋ Given straight to client</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {somewhereElse && <input className={`${inputCls} mt-2`} value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="Where exactly?" />}
        </div>

        <div>
          <label className="block text-sm text-slate-500 mb-1">Photo</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {photos.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 rounded px-2 py-1">📷 {p.name}
                <button type="button" onClick={() => setPhotos((c) => c.filter((_, j) => j !== idx))} className="text-red-500">×</button></span>
            ))}
          </div>
          <label className="block w-full border-2 border-dashed border-slate-300 rounded-xl py-4 text-center text-slate-500 text-sm">
            📸 Take a photo
            <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => handleUpload(e.target.files)} />
          </label>
          {uploading && <p className="text-xs text-slate-400 mt-1">Uploading…</p>}
        </div>

        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button onClick={markReceived} disabled={saving || uploading} style={{ backgroundColor: PURPLE }}
          className="w-full text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50">
          {saving ? 'Saving…' : givenStraight ? 'Confirm handed to client' : 'Mark received & stored'}</button>
      </div>
    </div>
  );
}
