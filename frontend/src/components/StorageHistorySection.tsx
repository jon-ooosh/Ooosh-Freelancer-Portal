/**
 * StorageHistorySection — reusable "Storage" tab for OrganisationDetailPage
 * and PersonDetailPage. Shows current + past storage tenancies (and any
 * waiting-list entries) for the entity. Mirrors HireHistory / ExcessHistory /
 * HeldItems section pattern.
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface TenancyRow {
  id: string; status: string; move_in_date: string | null; move_out_date: string | null;
  weekly_rate: number; billing_mode: string; billing_cadence: string; next_bill_date: string | null;
  next_rate_review_date: string | null; access_type: string | null; tcs_accepted_at: string | null;
  room_name: string; size_category: string; location_type: string | null;
  organisation_name: string | null; lead_contact_name: string | null;
}
interface WaitingRow {
  id: string; preferred_size: string | null; date_requested: string; date_last_offered: string | null; status: string; notes: string | null;
}

const money = (n: number | null | undefined) => `£${Number(n || 0).toFixed(2)}`;
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const STATUS_COLOUR: Record<string, string> = {
  active: 'bg-green-100 text-green-800', notice: 'bg-amber-100 text-amber-800',
  reserved: 'bg-blue-100 text-blue-800', ended: 'bg-slate-200 text-slate-600',
};

export default function StorageHistorySection({ entityType, entityId }: { entityType: 'person' | 'organisation'; entityId: string }) {
  const [tenancies, setTenancies] = useState<TenancyRow[]>([]);
  const [waiting, setWaiting] = useState<WaitingRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = entityType === 'person' ? `/storage/by-person/${entityId}` : `/storage/by-organisation/${entityId}`;
      const r = await api.get<{ data: { tenancies: TenancyRow[]; waiting: WaitingRow[] } }>(endpoint);
      setTenancies(r.data.tenancies);
      setWaiting(r.data.waiting);
    } catch (err) {
      console.error('Failed to load storage history:', err);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-slate-400 text-sm">Loading…</p>;

  const live = tenancies.filter((t) => t.status !== 'ended');
  const ended = tenancies.filter((t) => t.status === 'ended');

  if (tenancies.length === 0 && waiting.length === 0) {
    return <p className="text-slate-500 text-sm">No storage history. <Link to="/storage" className="text-ooosh-600">Open Storage →</Link></p>;
  }

  return (
    <div className="space-y-6">
      {live.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Current</h3>
          <div className="space-y-2">{live.map((t) => <TenancyCard key={t.id} t={t} />)}</div>
        </div>
      )}

      {waiting.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Waiting list</h3>
          {waiting.map((w) => (
            <div key={w.id} className="border border-slate-200 rounded-lg p-3 bg-white text-sm flex items-center justify-between">
              <span>Wants {w.preferred_size || 'any'} · asked {fmtDate(w.date_requested)}{w.date_last_offered ? ` · last offered ${fmtDate(w.date_last_offered)}` : ''}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 capitalize">{w.status}</span>
            </div>
          ))}
        </div>
      )}

      {ended.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Past</h3>
          <div className="space-y-2">{ended.map((t) => <TenancyCard key={t.id} t={t} />)}</div>
        </div>
      )}

      <Link to="/storage?tab=tenancies" className="inline-block text-sm text-ooosh-600">Manage in Storage →</Link>
    </div>
  );
}

function TenancyCard({ t }: { t: TenancyRow }) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-white">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-slate-800">{t.room_name} <span className="text-xs text-slate-400 capitalize">({t.size_category}{t.location_type ? `, ${t.location_type}` : ''})</span></span>
        <span className={`text-xs px-2 py-0.5 rounded font-medium capitalize ${STATUS_COLOUR[t.status] || 'bg-slate-100'}`}>{t.status}</span>
      </div>
      <p className="text-sm text-slate-600">{money(t.weekly_rate)}/wk · {t.billing_mode === 'recurring' ? 'Recurring (Xero)' : `We invoice (${t.billing_cadence})`}</p>
      <p className="text-xs text-slate-400">
        In {fmtDate(t.move_in_date)}{t.move_out_date ? ` · Out ${fmtDate(t.move_out_date)}` : ''}
        {t.status !== 'ended' && t.tcs_accepted_at ? ' · T&Cs ✓' : t.status !== 'ended' ? ' · T&Cs —' : ''}
      </p>
    </div>
  );
}
