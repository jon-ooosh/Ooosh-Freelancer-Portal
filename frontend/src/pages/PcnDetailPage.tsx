import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import { Pcn, PCN_STATUS_LABEL, PcnStatusPill, FINE_TYPE_LABEL } from './PcnsPage';
import PcnActionChooser from '../components/PcnActionChooser';

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
  const [viewDoc, setViewDoc] = useState(false);

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
            {field('Driver', pcn.driver_id
              ? <Link className="text-[#7B5EA7] hover:underline" to={`/drivers/${pcn.driver_id}`}>{pcn.driver_name}</Link>
              : (pcn.driver_name || '—'))}
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
          {pcn.pcn_document_url && (
            <div className="mt-3 pt-3 border-t">
              <dt className="text-xs text-slate-500 mb-1">Scanned notice</dt>
              <button onClick={() => setViewDoc(true)} className="text-sm text-[#7B5EA7] hover:underline">📄 View scanned PCN</button>
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

      {viewDoc && pcn.pcn_document_url && (
        <DocLightbox r2Key={pcn.pcn_document_url} onClose={() => setViewDoc(false)} />
      )}
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
