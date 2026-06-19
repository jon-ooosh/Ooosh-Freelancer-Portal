import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import { Pcn, PCN_STATUS_LABEL, PcnStatusPill, FINE_TYPE_LABEL } from './PcnsPage';
import {
  PcnDocument,
  PcnDocKind,
  PCN_DOC_KINDS,
  PCN_DOC_KIND_LABEL,
  mergePcnDocuments,
} from '../components/pcn/format';
import PcnActionChooser from '../components/PcnActionChooser';
import { compressImage } from '../components/holding/compress';

interface PcnEvent {
  id: string;
  event_type: string;
  body: string | null;
  created_by_name: string | null;
  created_at: string;
}
interface PcnDetail extends Pcn { events: PcnEvent[] }

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const fmtDateTime = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-GB') : '—');
const money = (n: number | null | undefined) => (n == null ? '—' : `£${Number(n).toFixed(2)}`);

const ACTION_LABEL: Record<string, string> = {
  pay_direct: 'Driver to pay direct',
  transfer_liability: 'Transfer liability',
  pay_recharge: 'Pay & recharge',
  internal_ooosh: 'Internal (Ooosh)',
  internal_freelancer: 'Internal (Freelancer)',
  query: 'Query / dispute',
};

export default function PcnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [pcn, setPcn] = useState<PcnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await api.get<{ data: PcnDetail }>(`/pcns/${id}`);
      setPcn(r.data);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    if (!id) return;
    setSaving(true);
    try {
      await api.patch(`/pcns/${id}`, body);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-6 text-slate-400">Loading…</div>;
  if (!pcn) return <div className="p-6 text-slate-400">PCN not found.</div>;

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <Link to="/vehicles/pcns" className="text-sm text-[#7B5EA7] hover:underline">← Back to PCNs</Link>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-2 mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800">{pcn.reference || '(no ref)'}</h1>
          <PcnStatusPill status={pcn.status} />
        </div>
        <span className="text-sm text-slate-500">{FINE_TYPE_LABEL[pcn.fine_type] || pcn.fine_type}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Details */}
        <div className="lg:col-span-2 bg-white rounded-lg border p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Details</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {field('Vehicle', pcn.vehicle_id
              ? <Link className="text-[#7B5EA7] hover:underline" to={`/vehicles/fleet/${pcn.vehicle_id}`}>{pcn.fleet_reg || pcn.vehicle_reg}</Link>
              : (pcn.fleet_reg || pcn.vehicle_reg || '—'))}
            {field('Driver', (
              <span className="inline-flex items-center gap-2 flex-wrap">
                {pcn.driver_id
                  ? <Link className="text-[#7B5EA7] hover:underline" to={`/drivers/${pcn.driver_id}`}>{pcn.driver_name}</Link>
                  : <span className="text-slate-400">{pcn.driver_name || 'Unassigned'}</span>}
                <button
                  type="button"
                  onClick={() => setAssignOpen(true)}
                  className="text-xs text-[#7B5EA7] hover:underline"
                >
                  {pcn.driver_id ? 'Change' : 'Assign'}
                </button>
              </span>
            ))}
            {field('Client', pcn.client_organisation_id
              ? <Link className="text-[#7B5EA7] hover:underline" to={`/organisations/${pcn.client_organisation_id}`}>{pcn.client_organisation_name}</Link>
              : (pcn.client_organisation_name || '—'))}
            {field('Job', pcn.hh_job_number
              ? (pcn.job_id
                  ? <Link className="text-[#7B5EA7] hover:underline" to={`/jobs/${pcn.job_id}`}>#{pcn.hh_job_number}</Link>
                  : `#${pcn.hh_job_number}`)
              : '—')}
            {field('Offence', `${fmtDate(pcn.offence_at)}${pcn.offence_time_text ? ' ' + pcn.offence_time_text : ''}`)}
            {field('Location', pcn.location || '—')}
            {field('Authority', pcn.issuing_authority || '—')}
            {field('Fine', money(pcn.fine_amount))}
            {field('Reduced', pcn.reduced_amount ? `${money(pcn.reduced_amount)} by ${fmtDate(pcn.reduced_deadline)}` : '—')}
            {field('Final deadline', fmtDate(pcn.final_deadline))}
          </dl>
          {pcn.notes && (
            <div className="mt-3 pt-3 border-t">
              <dt className="text-xs text-slate-500">Notes</dt>
              <dd className="text-sm text-slate-800 whitespace-pre-wrap">{pcn.notes}</dd>
            </div>
          )}
          <div className="mt-3 pt-3 border-t">
            <PcnDocuments pcn={pcn} reload={load} />
          </div>

          {/* Pay-direct tracking — deadline + chase ladder progress */}
          {pcn.status === 'driver_notified_pay' && (
            <div className="mt-3 pt-3 border-t">
              <dt className="text-xs text-slate-500 mb-1">Driver to pay direct</dt>
              <dd className="text-sm text-slate-800">
                {pcn.pay_direct_deadline && <>Deadline {fmtDate(pcn.pay_direct_deadline)}. </>}
                {pcn.receipt_chase_level
                  ? <span className="text-amber-700">Chased {pcn.receipt_chase_level}×, awaiting proof.</span>
                  : <span className="text-slate-500">Awaiting proof of payment.</span>}
              </dd>
              <p className="text-xs text-slate-400 mt-1">Chases auto-send on the 3/5/7-day ladder; info@ is copied each time.</p>
            </div>
          )}
        </div>

        {/* Action panel — the "what next?" chooser */}
        <div className="bg-white rounded-lg border p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">What next?</h2>
          <PcnActionChooser pcnId={pcn.id} driverEmail={pcn.driver_email} onActioned={() => load()} />

          {/* Manual override — set status / action path directly without firing email or charge */}
          <details className="mt-4 border-t pt-3">
            <summary className="text-xs text-slate-500 cursor-pointer">Manual override (no email / no charge)</summary>
            <label className="text-sm block mt-2 mb-3">Status
              <select
                className="border rounded-lg px-3 py-2 text-sm w-full mt-1"
                value={pcn.status}
                disabled={saving}
                onChange={(e) => patch({ status: e.target.value })}
              >
                {Object.entries(PCN_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="text-sm block">Action path
              <select
                className="border rounded-lg px-3 py-2 text-sm w-full mt-1"
                value={pcn.action_path || ''}
                disabled={saving}
                onChange={(e) => patch({ action_path: e.target.value || null })}
              >
                <option value="">— not set —</option>
                {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </details>
        </div>
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-lg border p-4 mt-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Activity</h2>
        {pcn.events.length === 0 ? (
          <p className="text-sm text-slate-400">No events yet.</p>
        ) : (
          <ul className="space-y-2">
            {pcn.events.map((e) => (
              <li key={e.id} className="text-sm flex gap-3">
                <span className="text-slate-400 whitespace-nowrap">{fmtDateTime(e.created_at)}</span>
                <span className="text-slate-700">
                  {e.body || e.event_type}
                  {e.created_by_name ? <span className="text-slate-400"> — {e.created_by_name}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {assignOpen && (
        <AssignDriverModal
          pcn={pcn}
          onClose={() => setAssignOpen(false)}
          onAssign={async (driverId) => { await patch({ driver_id: driverId }); setAssignOpen(false); }}
        />
      )}
    </div>
  );
}

// Assign / change / unassign the driver after the fact. Sources candidates two
// ways: drivers who were on this vehicle around the offence date (the
// multi-driver "who was actually in the van" case, via /pcns/match), plus a
// free search over all drivers. Unassign clears it back to no driver.
function AssignDriverModal({ pcn, onClose, onAssign }: {
  pcn: PcnDetail;
  onClose: () => void;
  onAssign: (driverId: string | null) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<{ driver_id: string; driver_name: string; reg?: string; hh_job_number?: number | null }[]>([]);
  const [loadingCand, setLoadingCand] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; full_name: string; email: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  const reg = pcn.fleet_reg || pcn.vehicle_reg;

  // Who was on this vehicle around the offence date.
  useEffect(() => {
    if (!reg || !pcn.offence_at) return;
    setLoadingCand(true);
    api.get<{ data: { drivers: Array<{ driver_id: string | null; driver_name: string | null; reg?: string; hh_job_number?: number | null }> } }>(
      `/pcns/match?reg=${encodeURIComponent(reg)}&offence_at=${encodeURIComponent(pcn.offence_at)}`
    )
      .then((r) => {
        const seen = new Set<string>();
        setCandidates(
          (r.data.drivers || [])
            .filter((d): d is typeof d & { driver_id: string } => !!d.driver_id && !seen.has(d.driver_id) && !!seen.add(d.driver_id))
            .map((d) => ({ driver_id: d.driver_id, driver_name: d.driver_name || '(unnamed)', reg: d.reg, hh_job_number: d.hh_job_number }))
        );
      })
      .catch(() => { /* non-fatal — search still works */ })
      .finally(() => setLoadingCand(false));
  }, [reg, pcn.offence_at]);

  // Free driver search (debounced).
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ data: Array<{ id: string; full_name: string; email: string | null }> }>(
        `/drivers?search=${encodeURIComponent(q.trim())}&limit=10`
      )
        .then((r) => setResults(r.data))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const choose = async (driverId: string | null) => {
    setBusy(true);
    try { await onAssign(driverId); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-800">Assign driver</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        {(loadingCand || candidates.length > 0) && (
          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-1">On this vehicle around the offence date</p>
            {loadingCand ? (
              <p className="text-xs text-slate-400">Checking…</p>
            ) : (
              <div className="space-y-1">
                {candidates.map((c) => (
                  <button key={c.driver_id} disabled={busy} onClick={() => choose(c.driver_id)}
                    className="w-full text-left px-3 py-2 rounded-lg border hover:bg-slate-50 text-sm disabled:opacity-50">
                    <span className="font-medium text-slate-800">{c.driver_name}</span>
                    <span className="text-slate-400"> · {c.reg}{c.hh_job_number ? ` · #${c.hh_job_number}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <p className="text-xs text-slate-500 mb-1">Or search all drivers</p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, email, licence…"
            className="border rounded-lg px-3 py-2 text-sm w-full"
          />
          {results.length > 0 && (
            <div className="mt-1 space-y-1 max-h-52 overflow-y-auto">
              {results.map((d) => (
                <button key={d.id} disabled={busy} onClick={() => choose(d.id)}
                  className="w-full text-left px-3 py-2 rounded-lg border hover:bg-slate-50 text-sm disabled:opacity-50">
                  <span className="font-medium text-slate-800">{d.full_name}</span>
                  {d.email && <span className="text-slate-400"> · {d.email}</span>}
                </button>
              ))}
            </div>
          )}
          {q.trim().length >= 2 && results.length === 0 && (
            <p className="text-xs text-slate-400 mt-1">No drivers found.</p>
          )}
        </div>

        {pcn.driver_id && (
          <button disabled={busy} onClick={() => choose(null)}
            className="mt-4 text-xs text-red-600 hover:underline disabled:opacity-50">
            Unassign current driver ({pcn.driver_name})
          </button>
        )}
      </div>
    </div>
  );
}

// Documents — the multi-doc audit list (notice front/back, correspondence,
// council/company responses) + an "Add document" control. After an add it
// surfaces the next-steps chooser so staff can progress the PCN off the back
// of, e.g., an issuer's response landing.
function PcnDocuments({ pcn, reload }: { pcn: PcnDetail; reload: () => Promise<void> | void }) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<PcnDocKind>('response');
  const [comment, setComment] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const [view, setView] = useState<PcnDocument | null>(null);
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [showNext, setShowNext] = useState(false);

  const docs = mergePcnDocuments(pcn);
  const terminal = ['paid_by_driver', 'paid_recharged', 'internal_ooosh', 'internal_freelancer', 'closed'].includes(pcn.status);
  // r2_keys stored in the documents array can be removed; the legacy pointers can't.
  const removableKeys = new Set((pcn.documents || []).map((d) => d.r2_key));

  const add = async () => {
    if (!file) return;
    setUploading(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('attachment_only', 'true');
      fd.append('file', await compressImage(file));
      const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
      await api.post(`/pcns/${pcn.id}/documents`, { r2_key: up.r2_key, name: file.name, kind, comment: comment.trim() || null });
      setFile(null); setComment(''); setAdding(false);
      setJustAdded(true);
      await reload();
    } catch {
      setErr('Upload failed — please try again.');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (d: PcnDocument) => {
    if (!confirm('Remove this document from the PCN? (The file itself is retained.)')) return;
    try {
      await api.delete(`/pcns/${pcn.id}/documents?r2_key=${encodeURIComponent(d.r2_key)}`);
      await reload();
    } catch { /* surfaced on next load */ }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <dt className="text-xs text-slate-500">Documents {docs.length > 0 && <span className="text-slate-400">({docs.length})</span>}</dt>
        {!adding && <button onClick={() => { setAdding(true); setJustAdded(false); }} className="text-xs text-[#7B5EA7] hover:underline">+ Add document</button>}
      </div>

      {docs.length === 0 && !adding && <p className="text-sm text-slate-400">No documents yet.</p>}

      <ul className="space-y-1">
        {docs.map((d, i) => (
          <li key={d.r2_key + i} className="flex items-center gap-2 text-sm bg-slate-50 rounded px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-slate-400 w-24 shrink-0">{PCN_DOC_KIND_LABEL[(d.kind as PcnDocKind) || 'other']}</span>
            <button onClick={() => setView(d)} className="text-[#7B5EA7] hover:underline truncate flex-1 text-left">
              📄 {d.name || 'Document'}
            </button>
            {d.comment && <span className="text-xs text-slate-400 truncate hidden sm:block">{d.comment}</span>}
            {removableKeys.has(d.r2_key) && (
              <button onClick={() => remove(d)} className="text-xs text-slate-400 hover:text-red-600 shrink-0">remove</button>
            )}
          </li>
        ))}
      </ul>

      {adding && (
        <div className="mt-2 border rounded-lg p-3 bg-slate-50/60 space-y-2">
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="text-sm w-full"
          />
          <div className="flex gap-2 flex-wrap">
            <select value={kind} onChange={(e) => setKind(e.target.value as PcnDocKind)} className="border rounded px-2 py-1.5 text-sm">
              {PCN_DOC_KINDS.map((k) => <option key={k} value={k}>{PCN_DOC_KIND_LABEL[k]}</option>)}
            </select>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)"
              className="border rounded px-2 py-1.5 text-sm flex-1 min-w-[140px]" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setAdding(false); setFile(null); setErr(''); }} className="text-sm px-3 py-1.5 border rounded-lg hover:bg-white">Cancel</button>
            <button onClick={add} disabled={uploading || !file}
              className="text-sm px-3 py-1.5 rounded-lg bg-[#7B5EA7] text-white hover:bg-[#6a5092] disabled:opacity-50">
              {uploading ? 'Uploading…' : 'Add document'}
            </button>
          </div>
        </div>
      )}

      {/* Next steps off the back of an added document (e.g. issuer responded) */}
      {justAdded && !terminal && (
        <div className="mt-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2">
          <p className="text-sm text-green-800">✓ Document added. Does this move the PCN on?</p>
          {!showNext ? (
            <button onClick={() => setShowNext(true)} className="text-sm text-[#7B5EA7] hover:underline mt-1">Choose next step →</button>
          ) : (
            <div className="mt-2">
              <PcnActionChooser pcnId={pcn.id} driverEmail={pcn.driver_email}
                onActioned={() => { setShowNext(false); setJustAdded(false); reload(); }} />
            </div>
          )}
        </div>
      )}

      {view && <DocLightbox r2Key={view.r2_key} onClose={() => setView(null)} />}
    </div>
  );
}

// Scanned-PCN lightbox — fetches the R2 blob authenticated (JWT isn't sent on a
// plain <img src> to /files/download) and shows it large (image inline, PDF in
// an iframe). Backdrop / ✕ to close.
function DocLightbox({ r2Key, onClose }: { r2Key: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let objUrl = ''; let cancelled = false;
    api.blob(`/files/download?key=${encodeURIComponent(r2Key)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        setType(contentType);
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      })
      .catch(() => { if (!cancelled) setErr('Failed to load scan'); });
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [r2Key]);
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-auto p-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-slate-700">Scanned PCN</span>
          <div className="flex items-center gap-3">
            {url && <a href={url} download className="text-sm text-[#7B5EA7] hover:underline">Download</a>}
            <button onClick={onClose} className="text-slate-500 hover:text-slate-800">✕</button>
          </div>
        </div>
        {err && <p className="text-sm text-red-600 p-4">{err}</p>}
        {!url && !err && <p className="text-sm text-slate-400 p-4">Loading…</p>}
        {url && (type.includes('pdf')
          ? <iframe src={url} title="Scanned PCN" className="w-full h-[80vh]" />
          : <img src={url} alt="Scanned PCN" className="max-w-full mx-auto" />)}
      </div>
    </div>
  );
}
