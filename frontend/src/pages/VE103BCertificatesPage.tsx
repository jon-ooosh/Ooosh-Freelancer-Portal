/**
 * VE103BCertificatesPage — Certificate browser at /vehicles/ve103b
 *
 * Lists all VE103B certificates with filtering, voiding, PDF download,
 * BVRLA report download, and standalone generation.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

/** Close modal on Escape key */
function useEscapeKey(onEscape: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onEscape, active]);
}

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
  generated_via: string | null;
  created_at: string;
}

/** Human label for how a certificate was generated. */
function methodLabel(via: string | null): string {
  switch (via) {
    case 'book_out': return 'Book-out';
    case 've103b_board': return 'VE103B board';
    case 've103b_board_manual': return 'VE103B board (manual entry)';
    default: return 'Method not recorded';
  }
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
  const [genSuccess, setGenSuccess] = useState('');
  const [assignments, setAssignments] = useState<Array<{
    id: string; vehicle_reg: string; driver_name: string | null;
    hire_start: string | null; hire_end: string | null;
    hirehop_job_id: number | null; status: string; ve103b_ref: string | null;
  }>>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  // Manual / test generation state
  const [genMode, setGenMode] = useState<'assignment' | 'manual'>('assignment');
  const [vehicles, setVehicles] = useState<Array<{ id: string; reg: string; make: string | null; model: string | null }>>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [genVehicleId, setGenVehicleId] = useState('');
  const [genDriverName, setGenDriverName] = useState('');
  const [genDriverAddress, setGenDriverAddress] = useState('');
  const [genHireStart, setGenHireStart] = useState('');
  const [genHireEnd, setGenHireEnd] = useState('');

  // Escape key to close modals
  const closeVoid = useCallback(() => { setVoidTarget(null); setVoidReason(''); }, []);
  const closeGenerate = useCallback(() => { setShowGenerate(false); setGenError(''); setGenSuccess(''); }, []);
  useEscapeKey(closeVoid, !!voidTarget);
  useEscapeKey(closeGenerate, showGenerate);

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
      const result = await api.blob(`/ve103b/${cert.id}/download`);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cert.pdf_filename || `VE103B-${cert.certificate_number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download PDF:', err);
    }
  }

  async function handleDownloadBVRLA() {
    try {
      const result = await api.blob(`/ve103b/bvrla-report?month=${reportMonth}`);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `BVRLA-VE103B-${reportMonth}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download BVRLA report:', err);
    }
  }

  async function loadAssignments() {
    setAssignmentsLoading(true);
    setVehiclesLoading(true);
    try {
      // Fetch recent assignments that have both a vehicle and driver
      const data = await api.get<{ data: Array<{
        id: string; vehicle_reg: string; driver_name: string | null;
        hire_start: string | null; hire_end: string | null;
        hirehop_job_id: number | null; status: string; ve103b_ref: string | null;
      }> }>('/assignments?limit=100');
      const withDrivers = data.data.filter(a => a.driver_name);
      setAssignments(withDrivers);
      // Auto-switch to manual mode if no assignments with drivers
      if (withDrivers.length === 0) setGenMode('manual');
    } catch (err) {
      console.error('Failed to load assignments:', err);
      setGenMode('manual');
    } finally {
      setAssignmentsLoading(false);
    }
    // Also load vehicles for manual mode
    try {
      const vData = await api.get<{ data: Array<{ id: string; reg: string; make: string | null; model: string | null }> }>('/vehicles/fleet?limit=200&is_active=true');
      setVehicles(vData.data);
    } catch (err) {
      console.error('Failed to load vehicles:', err);
    } finally {
      setVehiclesLoading(false);
    }
  }

  async function handleGenerate() {
    if (!genCertNumber.trim()) return;
    setGenerating(true);
    setGenError('');
    setGenSuccess('');
    try {
      let result: { pdf_filename: string; emailed: boolean; vehicle_reg: string };

      if (genMode === 'assignment') {
        if (!genAssignmentId.trim()) return;
        result = await api.post<typeof result>('/ve103b/generate', {
          assignment_id: genAssignmentId.trim(),
          certificate_number: genCertNumber.trim(),
          source: 've103b_board',
        });
      } else {
        if (!genVehicleId || !genDriverName.trim()) return;
        result = await api.post<typeof result>('/ve103b/test-generate', {
          vehicle_id: genVehicleId,
          driver_name: genDriverName.trim(),
          driver_address: genDriverAddress.trim(),
          certificate_number: genCertNumber.trim(),
          hire_start: genHireStart || undefined,
          hire_end: genHireEnd || undefined,
        });
      }

      setGenSuccess(
        `Generated ${result.pdf_filename}${result.emailed ? ' — emailed to info@oooshtours.co.uk' : ' — email failed, check logs'}`
      );
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

  function formatDateTime(d: string | null) {
    if (!d) return 'unknown time';
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
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
          onClick={() => { setShowGenerate(true); setGenSuccess(''); setGenError(''); loadAssignments(); }}
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
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Generated By</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-500">
                  <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
                  Loading...
                </td>
              </tr>
            ) : certs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-500">
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
                <td className="px-4 py-3 text-sm text-gray-700">
                  {cert.generated_by_email ? (
                    <span
                      className="cursor-help border-b border-dotted border-gray-400"
                      title={`Generated ${formatDateTime(cert.created_at)}\nMethod: ${methodLabel(cert.generated_via)}`}
                    >
                      {cert.generated_by_email.split('@')[0]}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
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
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Generate VE103B Certificate</h3>
            <p className="mt-2 text-sm text-gray-600">
              The PDF will be generated and emailed to the office for printing.
            </p>

            {/* Mode toggle */}
            <div className="mt-4 flex rounded-lg border border-gray-200 overflow-hidden">
              <button
                onClick={() => setGenMode('assignment')}
                className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${
                  genMode === 'assignment' ? 'bg-ooosh-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                From Assignment
              </button>
              <button
                onClick={() => setGenMode('manual')}
                className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${
                  genMode === 'manual' ? 'bg-ooosh-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Manual Entry
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {genMode === 'assignment' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hire Assignment</label>
                  {assignmentsLoading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
                      Loading assignments...
                    </div>
                  ) : assignments.length === 0 ? (
                    <p className="text-sm text-gray-500 py-2">No assignments with drivers found — use Manual Entry mode</p>
                  ) : (
                    <select
                      value={genAssignmentId}
                      onChange={e => setGenAssignmentId(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                    >
                      <option value="">Select an assignment...</option>
                      {assignments.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.vehicle_reg} — {a.driver_name}
                          {a.hirehop_job_id ? ` (Job ${a.hirehop_job_id})` : ''}
                          {a.hire_start ? ` — ${new Date(a.hire_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                          {a.ve103b_ref ? ` [VE103B: ${a.ve103b_ref}]` : ''}
                          {' '}[{a.status}]
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
                    {vehiclesLoading ? (
                      <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
                        Loading vehicles...
                      </div>
                    ) : (
                      <select
                        value={genVehicleId}
                        onChange={e => setGenVehicleId(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                      >
                        <option value="">Select a vehicle...</option>
                        {vehicles.map(v => (
                          <option key={v.id} value={v.id}>
                            {v.reg}{v.make ? ` — ${v.make}` : ''}{v.model ? ` ${v.model}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Driver Name</label>
                    <input
                      type="text"
                      value={genDriverName}
                      onChange={e => setGenDriverName(e.target.value)}
                      placeholder="e.g. John Smith"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Driver Address (one line per row)</label>
                    <textarea
                      value={genDriverAddress}
                      onChange={e => setGenDriverAddress(e.target.value)}
                      placeholder={"123 Example Street\nFlat 2\nLondon\nSW1A 1AA"}
                      rows={3}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                      <input
                        type="date"
                        value={genHireStart}
                        onChange={e => setGenHireStart(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
                      <input
                        type="date"
                        value={genHireEnd}
                        onChange={e => setGenHireEnd(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Certificate Number</label>
                <input
                  type="text"
                  value={genCertNumber}
                  onChange={e => setGenCertNumber(e.target.value)}
                  placeholder="Number from the physical VE103B form, e.g. 1455063"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                />
              </div>

              {genError && (
                <p className="text-sm text-red-600">{genError}</p>
              )}
              {genSuccess && (
                <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{genSuccess}</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => { setShowGenerate(false); setGenError(''); setGenSuccess(''); }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {genSuccess ? 'Close' : 'Cancel'}
              </button>
              <button
                onClick={handleGenerate}
                disabled={
                  !genCertNumber.trim() || generating ||
                  (genMode === 'assignment' && !genAssignmentId.trim()) ||
                  (genMode === 'manual' && (!genVehicleId || !genDriverName.trim()))
                }
                className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-800 disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate & Email'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
