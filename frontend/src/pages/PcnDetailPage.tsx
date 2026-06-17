import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import { Pcn, PCN_STATUS_LABEL, PcnStatusPill, FINE_TYPE_LABEL } from './PcnsPage';

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
            {field('Vehicle', pcn.fleet_reg || pcn.vehicle_reg || '—')}
            {field('Driver', pcn.driver_id
              ? <Link className="text-[#7B5EA7] hover:underline" to={`/drivers/${pcn.driver_id}`}>{pcn.driver_name}</Link>
              : (pcn.driver_name || '—'))}
            {field('Client', pcn.client_organisation_name || '—')}
            {field('Job', pcn.hh_job_number
              ? <a className="text-[#7B5EA7] hover:underline" href={pcn.job_id ? `/jobs/${pcn.job_id}` : '#'}>#{pcn.hh_job_number}</a>
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
        </div>

        {/* Action panel */}
        <div className="bg-white rounded-lg border p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Action</h2>
          <label className="text-sm block mb-3">Status
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
          <p className="text-xs text-slate-400 mt-3">
            Email + HireHop charge + pay-direct receipt flow land in a later PR.
          </p>
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
    </div>
  );
}
