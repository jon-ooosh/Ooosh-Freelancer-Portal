/**
 * VE103BCertificatesPage — Certificate browser at /vehicles/ve103b
 *
 * Lists all VE103B certificates with filtering, voiding, PDF download,
 * BVRLA report download, and standalone generation.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

interface VE103BCert {
  id: string;
  certificate_number: string;
  vehicle_reg: string;
  driver_name: string;
  driver_address: string | null;
  hire_start: string | null;
  hire_end: string | null;
  hirehop_job_number: number | null;
  status: 'issued' | 'void';
  void_reason: string | null;
  voided_at: string | null;
  voided_by_email: string | null;
  pdf_filename: string | null;
  date_certificate_supplied: string;
  generated_by_email: string | null;
  created_at: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type StatusFilter = 'all' | 'issued' | 'void';

export default function VE103BCertificatesPage() {
  const [certs, setCerts] = useState<VE103BCert[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');

  // Void modal
  const [voidTarget, setVoidTarget] = useState<VE103BCert | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // BVRLA report
  const [reportMonth, setReportMonth] = useState(() => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  });

  // Generate modal
  const [showGenerate, setShowGenerate] = useState(false);
  const [genAssignmentId, setGenAssignmentId] = useState('');
  const [genCertNumber, setGenCertNumber] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadCerts = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const qp = new URLSearchParams({ page: String(page), limit: '50' });
      if (statusFilter !== 'all') qp.set('status', statusFilter);
      if (searchDebounced) qp.set('search', searchDebounced);
      const data = await api.get<{ data: VE103BCert[]; pagination: Pagination }>(`/ve103b?${qp}`);
      setCerts(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load VE103B certificates:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchDebounced]);

  useEffect(() => { loadCerts(1); }, [loadCerts]);

  async function handleVoid() {
    if (!voidTarget || !voidReason.trim()) return;
    setVoiding(true);
    try {
      await api.post(`/ve103b/${voidTarget.id}/void`, { reason: voidReason.trim() });
      setVoidTarget(null);
      setVoidReason('');
      loadCerts(pagination.page);
    } catch (err) {
      console.error('Failed to void certificate:', err);
    } finally {
      setVoiding(false);
    }
  }

  async function handleDownloadPdf(cert: VE103BCert) {
    try {
      const blob = await api.blob(`/ve103b/${cert.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cert.pdf_filename || `VE103B-${cert.certificate_number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download PDF:', err);
    }
  }

  function handleDownloadBVRLA() {
    // Direct download via window — the API sets Content-Disposition
    const token = localStorage.getItem('accessToken') || '';
    window.open(`/api/ve103b/bvrla-report?month=${reportMonth}&token=${token}`, '_blank');
  }

  async function handleGenerate() {
    if (!genAssignmentId.trim() || !genCertNumber.trim()) return;
    setGenerating(true);
    setGenError('');
    try {
      await api.post('/ve103b/generate', {
        assignment_id: genAssignmentId.trim(),
        certificate_number: genCertNumber.trim(),
      });
      setShowGenerate(false);
      setGenAssignmentId('');
      setGenCertNumber('');
      loadCerts(1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      setGenError(message);
    } finally {
      setGenerating(false);
    }
  }

  function formatDate(d: string | null) {
    if (!d) return '—';
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">VE103B Certificates</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track VE103B certificates issued for vehicles going abroad
          </p>
        </div>
        <button
          onClick={() => setShowGenerate(true)}
          className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-800 transition-colors"
        >
          Generate VE103B
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status pills */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['all', 'issued', 'void'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                statusFilter === s
                  ? 'bg-ooosh-navy text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search cert number, reg, or driver..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy w-72"
        />

        {/* Spacer */}
        <div className="flex-1" />

        {/* BVRLA report download */}
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={reportMonth}
            onChange={e => setReportMonth(e.target.value)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-ooosh-navy focus:outline-none"
          />
          <button
            onClick={handleDownloadBVRLA}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            BVRLA Report
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Cert #</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Vehicle</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Driver</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Job</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Hire Dates</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Issued</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-500">
                  <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
                  Loading...
                </td>
              </tr>
            ) : certs.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-500">
                  No certificates found
                </td>
              </tr>
            ) : certs.map(cert => (
              <tr key={cert.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-mono font-medium text-gray-900">
                  {cert.certificate_number}
                </td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  {cert.vehicle_reg}
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">
                  {cert.driver_name}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {cert.hirehop_job_number ? `#${cert.hirehop_job_number}` : '—'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {formatDate(cert.hire_start)} — {formatDate(cert.hire_end)}
                </td>
                <td className="px-4 py-3">
                  {cert.status === 'issued' ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                      Issued
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800" title={cert.void_reason || ''}>
                      Void
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {formatDate(cert.date_certificate_supplied)}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {cert.pdf_filename && (
                      <button
                        onClick={() => handleDownloadPdf(cert)}
                        className="rounded px-2 py-1 text-xs font-medium text-ooosh-navy hover:bg-ooosh-50 transition-colors"
                        title="Download PDF"
                      >
                        PDF
                      </button>
                    )}
                    {cert.status === 'issued' && (
                      <button
                        onClick={() => setVoidTarget(cert)}
                        className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Void
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {pagination.total} certificate{pagination.total !== 1 ? 's' : ''} total
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => loadCerts(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-3 py-1.5 text-sm text-gray-600">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              onClick={() => loadCerts(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Void modal */}
      {voidTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Void Certificate</h3>
            <p className="mt-2 text-sm text-gray-600">
              Voiding certificate <strong>{voidTarget.certificate_number}</strong> for{' '}
              <strong>{voidTarget.vehicle_reg}</strong>. This cannot be undone.
              The certificate will still appear in the BVRLA monthly report as VOID.
            </p>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700">Reason</label>
              <input
                type="text"
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                placeholder="e.g. Misprint, ink smeared"
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                autoFocus
              />
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => { setVoidTarget(null); setVoidReason(''); }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleVoid}
                disabled={!voidReason.trim() || voiding}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {voiding ? 'Voiding...' : 'Void Certificate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generate modal */}
      {showGenerate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Generate VE103B Certificate</h3>
            <p className="mt-2 text-sm text-gray-600">
              Generate a VE103B for an existing hire assignment. The PDF will be emailed to the office for printing.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">Assignment ID</label>
                <input
                  type="text"
                  value={genAssignmentId}
                  onChange={e => setGenAssignmentId(e.target.value)}
                  placeholder="UUID of the hire assignment"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Certificate Number</label>
                <input
                  type="text"
                  value={genCertNumber}
                  onChange={e => setGenCertNumber(e.target.value)}
                  placeholder="e.g. 1455063"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                  autoFocus
                />
              </div>
              {genError && (
                <p className="text-sm text-red-600">{genError}</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => { setShowGenerate(false); setGenError(''); }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={!genAssignmentId.trim() || !genCertNumber.trim() || generating}
                className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-800 disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
