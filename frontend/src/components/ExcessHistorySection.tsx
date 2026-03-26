/**
 * ExcessHistorySection — Reusable component for showing excess history
 * on PersonDetailPage and OrganisationDetailPage.
 *
 * Shows a summary + list of excess records, with action buttons.
 */
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import ExcessPaymentModal, { statusLabel, statusColor } from './ExcessPaymentModal';
import type { JobExcess, ExcessPersonSummary } from '../../../shared/types';

interface ExcessHistorySectionProps {
  entityType: 'person' | 'organisation';
  entityId: string;
}

export default function ExcessHistorySection({ entityType, entityId }: ExcessHistorySectionProps) {
  const [summary, setSummary] = useState<ExcessPersonSummary | null>(null);
  const [history, setHistory] = useState<JobExcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionExcess, setActionExcess] = useState<JobExcess | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const endpoint = entityType === 'person'
        ? `/excess/by-person/${entityId}`
        : `/excess/by-org/${entityId}`;
      const data = await api.get<{ summary: ExcessPersonSummary; history: JobExcess[] }>(endpoint);
      setSummary(data.summary);
      setHistory(data.history);
    } catch (err) {
      console.error(`Failed to load ${entityType} excess history:`, err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [entityId, entityType]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-gray-500">Loading excess history...</div>;
  }

  if (!summary || summary.total_hires === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        No insurance excess records found for this {entityType}.
      </div>
    );
  }

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-500">Total Hires</p>
          <p className="text-lg font-bold text-gray-900">{summary.total_hires}</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
          <p className="text-xs text-green-700">Total Collected</p>
          <p className="text-lg font-bold text-green-800">£{summary.total_taken.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-500">Claimed / Reimbursed</p>
          <p className="text-lg font-bold text-gray-900">
            £{summary.total_claimed.toFixed(2)} / £{summary.total_reimbursed.toFixed(2)}
          </p>
        </div>
        <div className={`rounded-lg border p-3 ${summary.balance_held > 0 ? 'border-green-200 bg-green-50' : 'border-gray-200'}`}>
          <p className="text-xs text-gray-500">Balance Held</p>
          <p className={`text-lg font-bold ${summary.balance_held > 0 ? 'text-green-800' : 'text-gray-900'}`}>
            £{summary.balance_held.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Balance on account banner */}
      {summary.balance_held > 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <p className="text-sm text-green-800">
            <span className="font-semibold">£{summary.balance_held.toFixed(2)}</span> currently held on account.
            {summary.pending_count > 0 && (
              <span className="ml-1 text-amber-700 font-medium">
                {summary.pending_count} excess{summary.pending_count > 1 ? 'es' : ''} still pending.
              </span>
            )}
          </p>
        </div>
      )}

      {/* History table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Vehicle</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Dates</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {history.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <p className="text-sm text-gray-900">{record.hirehop_job_name || record.job_name || '—'}</p>
                  {record.hirehop_job_id && <p className="text-xs text-gray-500">HH #{record.hirehop_job_id}</p>}
                </td>
                <td className="px-4 py-2.5 text-sm text-gray-600">{record.vehicle_reg || '—'}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">
                  {record.hire_start
                    ? new Date(record.hire_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-sm">
                  <span className="font-medium text-gray-900">
                    £{Number(record.excess_amount_taken || 0).toFixed(2)}
                  </span>
                  {record.excess_amount_required && (
                    <span className="text-gray-500"> / £{Number(record.excess_amount_required).toFixed(2)}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(record.excess_status)}`}>
                    {statusLabel(record.excess_status)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => setActionExcess(record)}
                    className="text-xs text-ooosh-600 hover:text-ooosh-800 font-medium"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Action modal */}
      {actionExcess && (
        <ExcessPaymentModal
          excess={actionExcess}
          onClose={() => setActionExcess(null)}
          onUpdated={loadData}
        />
      )}
    </div>
  );
}
