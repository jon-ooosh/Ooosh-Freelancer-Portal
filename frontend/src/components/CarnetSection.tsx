/**
 * CarnetSection — staff cockpit for a job's ATA Carnet.
 *
 * Self-fetches /api/carnets/by-job/:jobId and renders nothing when the job has
 * no carnet (mirrors StagingOverviewCard). Surfaces on the Job Detail Overview
 * tab below the prep checklist. Drives the we_supply lifecycle (status, custody,
 * GMRs, documents) and the client_arranges minimal flow.
 *
 * NOTE (Jun 2026): this rich cockpit is currently NOT mounted anywhere — it was
 * briefly on the Job Detail Overview but pulled (too heavy for job view, and it
 * duplicated the requirement-card tracker). It's retained as the basis for the
 * Operations > Carnets tab (slice 5), where the full management lives. Job View
 * keeps only the thin `carnet` requirement card (tracker bar). When mounting in
 * Operations, adapt it to take a carnet id / list context rather than jobId.
 *
 * Slice 3 (staff management). The public client request form + signed
 * Letter of Authorisation PDF (which populates the client-data fields and seeds
 * GMRs) land in a later slice.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

interface Gmr {
  id: string;
  crossing_date: string | null;
  crossing_location: string | null;
  direction: 'into_eu' | 'out_of_eu' | null;
  status: 'needed' | 'made' | 'sent';
  gmr_reference: string | null;
  qr_image_url: string | null;
  sent_to_client_at: string | null;
  notes: string | null;
}

interface CarnetFile {
  url: string;
  name: string;
  label?: string | null;
  comment?: string | null;
  uploaded_at?: string;
}

interface Carnet {
  id: string;
  job_id: string;
  mode: 'we_supply' | 'client_arranges';
  status: string;
  format: 'paper' | 'digital';
  custody_location: 'ooosh' | 'client' | 'issuer' | null;
  carnet_length_months: number | null;
  carnet_start_date: string | null;
  carnet_expiry_date: string | null;
  liability_until: string | null;
  eu_countries: string[];
  non_eu_countries: string[];
  lead_name: string | null;
  lead_email: string | null;
  lead_role: string | null;
  additional_names: { first?: string; last?: string }[];
  application_ref: string | null;
  form_submitted_at: string | null;
  signed_authority_url: string | null;
  chase_date: string | null;
  spreadsheet_requested_at: string | null;
  spreadsheet_sent_at: string | null;
  notes: string | null;
  gmrs: Gmr[];
}

const WE_SUPPLY_STEPS: { key: string; label: string }[] = [
  { key: 'detected', label: 'Detected' },
  { key: 'form_sent', label: 'Form sent' },
  { key: 'info_received', label: 'Info received' },
  { key: 'applied', label: 'Applied' },
  { key: 'received', label: 'Received' },
  { key: 'with_client', label: 'With client' },
  { key: 'returned', label: 'Returned' },
  { key: 'discharged', label: 'Discharged' },
  { key: 'closed', label: 'Closed' },
];
const CLIENT_STEPS: { key: string; label: string }[] = [
  { key: 'requested', label: 'Requested' },
  { key: 'spreadsheet_sent', label: 'Spreadsheet sent' },
  { key: 'done', label: 'Done' },
];

function fmtDate(d: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB');
}

// Authenticated R2 image (QR codes / scans).
function R2Image({ k, className }: { k: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    api.blob(`/files/download?key=${encodeURIComponent(k)}`)
      .then(({ blob }) => { if (alive) { url = URL.createObjectURL(blob); setSrc(url); } })
      .catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [k]);
  if (!src) return <div className={`bg-gray-100 animate-pulse ${className || ''}`} />;
  return <img src={src} alt="QR" className={className} />;
}

export default function CarnetSection({ jobId }: { jobId: string }) {
  const [carnet, setCarnet] = useState<Carnet | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Carnet | null }>(`/carnets/by-job/${jobId}`);
      setCarnet(res.data);
    } catch {
      setCarnet(null);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    if (!carnet) return;
    setBusy(true); setErr(null);
    try {
      await api.patch(`/carnets/${carnet.id}`, body);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }, [carnet, load]);

  if (loading || !carnet) return null;

  const steps = carnet.mode === 'we_supply' ? WE_SUPPLY_STEPS : CLIENT_STEPS;
  const currentIdx = steps.findIndex((s) => s.key === carnet.status);
  const isCancelled = carnet.status === 'cancelled';

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h3 className="text-lg font-semibold text-gray-900">📄 ATA Carnet</h3>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${carnet.mode === 'we_supply' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}`}>
          {carnet.mode === 'we_supply' ? 'We supply' : 'Client arranges'}
        </span>
        {isCancelled
          ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Cancelled</span>
          : <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 capitalize">{carnet.status.replace(/_/g, ' ')}</span>}
        {carnet.mode === 'we_supply' && (
          <select
            value={carnet.format}
            disabled={busy || isCancelled}
            onChange={(e) => patch({ format: e.target.value })}
            className="ml-auto text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="paper">Paper</option>
            <option value="digital">Digital</option>
          </select>
        )}
      </div>

      {err && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}

      {!isCancelled && (
        <>
          {/* Lifecycle stepper */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {steps.map((s, i) => {
              const done = i < currentIdx;
              const active = i === currentIdx;
              return (
                <button
                  key={s.key}
                  disabled={busy}
                  onClick={() => patch({ status: s.key })}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                    active ? 'bg-purple-600 text-white'
                      : done ? 'bg-purple-100 text-purple-700'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                  title="Set status (no hard gates — click any step)"
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Custody (we_supply only) */}
          {carnet.mode === 'we_supply' && (
            <div className="flex items-center gap-2 mb-4 text-sm">
              <span className="text-gray-500">Custody:</span>
              {(['ooosh', 'client', 'issuer'] as const).map((c) => (
                <button
                  key={c}
                  disabled={busy}
                  onClick={() => patch({ custody_location: c })}
                  className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${
                    carnet.custody_location === c ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {c === 'ooosh' ? 'We have it' : c === 'client' ? 'With client' : 'Issuer'}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Detail / edit */}
      {carnet.mode === 'we_supply' && (
        <DetailBlock carnet={carnet} editing={editing} setEditing={setEditing} onSave={patch} busy={busy} />
      )}
      {carnet.mode === 'client_arranges' && (
        <ClientArrangesBlock carnet={carnet} onSave={patch} busy={busy} />
      )}

      {/* GMRs (we_supply) */}
      {carnet.mode === 'we_supply' && (
        <GmrManager carnet={carnet} reload={load} />
      )}

      {/* Documents */}
      <DocsManager carnet={carnet} reload={load} />

      {/* Footer actions */}
      {!isCancelled && (
        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center gap-3">
          {carnet.signed_authority_url && (
            <DownloadLink k={carnet.signed_authority_url} label="Signed authority (PDF)" />
          )}
          <button
            onClick={async () => {
              if (!window.confirm('Cancel this carnet? It stays on record for audit but drops out of active tracking.')) return;
              setBusy(true);
              try { await api.post(`/carnets/${carnet.id}/cancel`, {}); await load(); }
              finally { setBusy(false); }
            }}
            className="ml-auto text-xs text-red-600 hover:text-red-800"
          >
            Cancel carnet
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detail / edit block (we_supply) ──
function DetailBlock({ carnet, editing, setEditing, onSave, busy }: {
  carnet: Carnet; editing: boolean; setEditing: (v: boolean) => void;
  onSave: (b: Record<string, unknown>) => Promise<void>; busy: boolean;
}) {
  const [form, setForm] = useState({
    lead_name: carnet.lead_name || '', lead_email: carnet.lead_email || '', lead_role: carnet.lead_role || '',
    carnet_length_months: carnet.carnet_length_months || '', carnet_start_date: carnet.carnet_start_date?.slice(0, 10) || '',
    application_ref: carnet.application_ref || '', notes: carnet.notes || '',
  });
  useEffect(() => {
    setForm({
      lead_name: carnet.lead_name || '', lead_email: carnet.lead_email || '', lead_role: carnet.lead_role || '',
      carnet_length_months: carnet.carnet_length_months || '', carnet_start_date: carnet.carnet_start_date?.slice(0, 10) || '',
      application_ref: carnet.application_ref || '', notes: carnet.notes || '',
    });
  }, [carnet]);

  if (!editing) {
    return (
      <div className="bg-gray-50 rounded p-3 mb-4 text-sm">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-gray-700">
            {carnet.form_submitted_at ? 'Client submission' : 'Carnet details'}
          </span>
          <button onClick={() => setEditing(true)} className="text-xs text-purple-600 hover:text-purple-800">Edit</button>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-600">
          <div><dt className="inline text-gray-400">Lead:</dt> {carnet.lead_name || '—'}{carnet.lead_role ? ` (${carnet.lead_role})` : ''}</div>
          <div><dt className="inline text-gray-400">Email:</dt> {carnet.lead_email || '—'}</div>
          <div><dt className="inline text-gray-400">Length:</dt> {carnet.carnet_length_months ? `${carnet.carnet_length_months} mo` : '—'}</div>
          <div><dt className="inline text-gray-400">Start:</dt> {fmtDate(carnet.carnet_start_date)}</div>
          <div><dt className="inline text-gray-400">Expiry:</dt> {fmtDate(carnet.carnet_expiry_date)}</div>
          <div><dt className="inline text-gray-400">Liability until:</dt> {fmtDate(carnet.liability_until)}</div>
          <div className="col-span-2"><dt className="inline text-gray-400">Application ref:</dt> {carnet.application_ref || '—'}</div>
          {carnet.eu_countries.length > 0 && <div className="col-span-2"><dt className="inline text-gray-400">EU:</dt> {carnet.eu_countries.join(', ')}</div>}
          {carnet.non_eu_countries.length > 0 && <div className="col-span-2"><dt className="inline text-gray-400">Non-EU:</dt> {carnet.non_eu_countries.join(', ')}</div>}
          {carnet.additional_names.length > 0 && <div className="col-span-2"><dt className="inline text-gray-400">Additional names:</dt> {carnet.additional_names.map((n) => `${n.first || ''} ${n.last || ''}`.trim()).filter(Boolean).join(', ')}</div>}
          {carnet.notes && <div className="col-span-2"><dt className="inline text-gray-400">Notes:</dt> {carnet.notes}</div>}
        </dl>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 rounded p-3 mb-4 text-sm space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input className="border rounded px-2 py-1" placeholder="Lead name" value={form.lead_name} onChange={(e) => setForm({ ...form, lead_name: e.target.value })} />
        <input className="border rounded px-2 py-1" placeholder="Lead email" value={form.lead_email} onChange={(e) => setForm({ ...form, lead_email: e.target.value })} />
        <input className="border rounded px-2 py-1" placeholder="Lead role" value={form.lead_role} onChange={(e) => setForm({ ...form, lead_role: e.target.value })} />
        <select className="border rounded px-2 py-1" value={form.carnet_length_months} onChange={(e) => setForm({ ...form, carnet_length_months: e.target.value })}>
          <option value="">Length…</option>
          <option value="2">2 months</option>
          <option value="6">6 months</option>
          <option value="12">12 months</option>
        </select>
        <input type="date" className="border rounded px-2 py-1" value={form.carnet_start_date} onChange={(e) => setForm({ ...form, carnet_start_date: e.target.value })} />
        <input className="border rounded px-2 py-1" placeholder="Application ref" value={form.application_ref} onChange={(e) => setForm({ ...form, application_ref: e.target.value })} />
      </div>
      <textarea className="border rounded px-2 py-1 w-full" rows={2} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            await onSave({
              lead_name: form.lead_name, lead_email: form.lead_email, lead_role: form.lead_role,
              carnet_length_months: form.carnet_length_months ? Number(form.carnet_length_months) : null,
              carnet_start_date: form.carnet_start_date || null,
              application_ref: form.application_ref, notes: form.notes,
            });
            setEditing(false);
          }}
          className="px-3 py-1 bg-purple-600 text-white rounded text-xs disabled:opacity-50"
        >Save</button>
        <button onClick={() => setEditing(false)} className="px-3 py-1 bg-gray-200 rounded text-xs">Cancel</button>
      </div>
    </div>
  );
}

// ── client_arranges minimal block ──
function ClientArrangesBlock({ carnet, onSave, busy }: {
  carnet: Carnet; onSave: (b: Record<string, unknown>) => Promise<void>; busy: boolean;
}) {
  return (
    <div className="bg-gray-50 rounded p-3 mb-4 text-sm space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {CLIENT_STEPS.map((s) => (
          <button key={s.key} disabled={busy} onClick={() => onSave({ status: s.key })}
            className={`px-2.5 py-1 rounded text-xs font-medium ${carnet.status === s.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500">Chase date:</span>
        <input type="date" disabled={busy} value={carnet.chase_date?.slice(0, 10) || ''}
          onChange={(e) => onSave({ chase_date: e.target.value || null })}
          className="border rounded px-2 py-1" />
      </div>
      <textarea className="border rounded px-2 py-1 w-full" rows={2} placeholder="Notes" defaultValue={carnet.notes || ''}
        onBlur={(e) => { if (e.target.value !== (carnet.notes || '')) onSave({ notes: e.target.value }); }} />
    </div>
  );
}

// ── GMR manager ──
function GmrManager({ carnet, reload }: { carnet: Carnet; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const sent = carnet.gmrs.filter((g) => g.status === 'sent').length;

  const updateGmr = async (gmrId: string, body: Record<string, unknown>) => {
    setBusy(true);
    try { await api.patch(`/carnets/${carnet.id}/gmrs/${gmrId}`, body); await reload(); }
    finally { setBusy(false); }
  };
  const uploadQr = async (gmrId: string, file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
      await api.patch(`/carnets/${carnet.id}/gmrs/${gmrId}`, { qr_image_url: up.r2_key });
      await reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">
          GMRs {carnet.gmrs.length > 0 && <span className="text-gray-400 font-normal">· {carnet.gmrs.length} total, {sent} sent</span>}
        </span>
        <button onClick={() => setAdding((v) => !v)} className="text-xs text-purple-600 hover:text-purple-800">+ Add GMR</button>
      </div>

      {adding && (
        <GmrAddForm
          busy={busy}
          onAdd={async (body) => { setBusy(true); try { await api.post(`/carnets/${carnet.id}/gmrs`, body); await reload(); setAdding(false); } finally { setBusy(false); } }}
        />
      )}

      {carnet.gmrs.length === 0 && !adding && <p className="text-xs text-gray-400">No GMRs yet. Add one per EU border crossing.</p>}

      <div className="space-y-2">
        {carnet.gmrs.map((g) => (
          <div key={g.id} className="border border-gray-200 rounded p-2 text-sm flex flex-wrap items-center gap-2">
            <span className="text-gray-600">{g.crossing_location || 'Crossing'}{g.crossing_date ? ` · ${fmtDate(g.crossing_date)}` : ''}</span>
            {g.direction && <span className="text-xs text-gray-400">{g.direction === 'into_eu' ? '→ EU' : '← EU'}</span>}
            <input
              className="border rounded px-2 py-0.5 text-xs w-36" placeholder="GMR number"
              defaultValue={g.gmr_reference || ''}
              onBlur={(e) => { if (e.target.value !== (g.gmr_reference || '')) updateGmr(g.id, { gmr_reference: e.target.value }); }}
            />
            <select value={g.status} disabled={busy} onChange={(e) => updateGmr(g.id, { status: e.target.value })}
              className="border rounded px-1.5 py-0.5 text-xs">
              <option value="needed">Needed</option>
              <option value="made">Made</option>
              <option value="sent">Sent</option>
            </select>
            {g.qr_image_url
              ? <R2Image k={g.qr_image_url} className="w-8 h-8 object-contain border rounded" />
              : <label className="text-xs text-purple-600 hover:text-purple-800 cursor-pointer">
                  Upload QR
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadQr(g.id, f); }} />
                </label>}
            {g.status !== 'sent' && <button onClick={() => updateGmr(g.id, { status: 'sent' })} disabled={busy} className="text-xs text-green-600 hover:text-green-800">Mark sent</button>}
            <button
              onClick={async () => { if (window.confirm('Delete this GMR?')) { setBusy(true); try { await api.delete(`/carnets/${carnet.id}/gmrs/${g.id}`); await reload(); } finally { setBusy(false); } } }}
              className="ml-auto text-xs text-red-500 hover:text-red-700">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function GmrAddForm({ onAdd, busy }: { onAdd: (b: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const [f, setF] = useState({ crossing_location: '', crossing_date: '', direction: '' });
  return (
    <div className="bg-gray-50 rounded p-2 mb-2 flex flex-wrap items-center gap-2">
      <input className="border rounded px-2 py-1 text-xs" placeholder="Crossing (e.g. Dover)" value={f.crossing_location} onChange={(e) => setF({ ...f, crossing_location: e.target.value })} />
      <input type="date" className="border rounded px-2 py-1 text-xs" value={f.crossing_date} onChange={(e) => setF({ ...f, crossing_date: e.target.value })} />
      <select className="border rounded px-2 py-1 text-xs" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
        <option value="">Direction…</option>
        <option value="into_eu">Into EU</option>
        <option value="out_of_eu">Out of EU</option>
      </select>
      <button disabled={busy} onClick={() => onAdd({ crossing_location: f.crossing_location || null, crossing_date: f.crossing_date || null, direction: f.direction || null })}
        className="px-3 py-1 bg-purple-600 text-white rounded text-xs disabled:opacity-50">Add</button>
    </div>
  );
}

// ── Documents ──
function DocsManager({ carnet, reload }: { carnet: Carnet; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const files: CarnetFile[] = []; // populated from carnet via cast below
  const carnetFiles = (carnet as unknown as { files?: CarnetFile[] }).files || files;

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
      await api.post(`/carnets/${carnet.id}/files`, { r2_key: up.r2_key, name: file.name });
      await reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">Documents</span>
        <label className="text-xs text-purple-600 hover:text-purple-800 cursor-pointer">
          + Upload
          <input type="file" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        </label>
      </div>
      {carnetFiles.length === 0
        ? <p className="text-xs text-gray-400">Scanned carnet pages, customs stamps, etc.</p>
        : <ul className="space-y-1">
            {carnetFiles.map((file, idx) => (
              <li key={idx} className="flex items-center gap-2 text-sm">
                <DownloadLink k={file.url} label={file.name} />
                <button
                  onClick={async () => { if (window.confirm('Remove this document?')) { setBusy(true); try { await api.delete(`/carnets/${carnet.id}/files/${idx}`); await reload(); } finally { setBusy(false); } } }}
                  className="ml-auto text-xs text-red-500 hover:text-red-700">✕</button>
              </li>
            ))}
          </ul>}
    </div>
  );
}

// Authenticated download/open of an R2 object.
function DownloadLink({ k, label }: { k: string; label: string }) {
  const open = async () => {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(k)}`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { /* ignore */ }
  };
  return <button onClick={open} className="text-purple-600 hover:text-purple-800 hover:underline text-left">{label}</button>;
}
