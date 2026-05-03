/**
 * Warehouse Collections list — kiosk page (no Layout wrapper).
 *
 * Shows jobs ready for in-person customer pickup. Tapping a row goes to
 * the detail/sign-off page.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clearWarehouseToken, getWarehouseToken, warehouseFetch } from '../services/warehouseSession';

interface CollectionJob {
  id: string;
  jobName: string;
  hhRef: string;
  clientName: string;
  hireStartDate: string;
  pipelineStatus: string;
}

export default function WarehouseCollectionsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [jobs, setJobs] = useState<CollectionJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const fetchJobs = useCallback(async () => {
    if (!getWarehouseToken()) {
      navigate('/warehouse', { replace: true });
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const response = await warehouseFetch('/api/warehouse/collections');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to fetch collections');
        return;
      }
      const data = await response.json();
      setJobs(data.jobs || []);
      setLastRefresh(new Date());
    } catch (err) {
      if (err && typeof err === 'object' && 'unauthorized' in err) {
        navigate('/warehouse', { replace: true });
        return;
      }
      console.error('Fetch collections error:', err);
      setError('Failed to load collections. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [navigate]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // ?completed=true after a successful sign-off
  useEffect(() => {
    if (searchParams.get('completed') === 'true') {
      setShowSuccess(true);
      // Clear the param so refresh doesn't re-show the toast
      const next = new URLSearchParams(searchParams);
      next.delete('completed');
      setSearchParams(next, { replace: true });
      const timer = setTimeout(() => setShowSuccess(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [searchParams, setSearchParams]);

  function handleLogout() {
    clearWarehouseToken();
    navigate('/warehouse', { replace: true });
  }

  function formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const jobDate = new Date(dateStr);
      jobDate.setHours(0, 0, 0, 0);
      if (jobDate.getTime() === today.getTime()) return 'Today';
      if (jobDate.getTime() === tomorrow.getTime()) return 'Tomorrow';
      if (jobDate.getTime() === yesterday.getTime()) return 'Yesterday';
      return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch {
      return dateStr;
    }
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/ooosh-logo.svg" alt="Ooosh Tours" className="h-10 w-auto" />
            <div>
              <h1 className="text-lg font-bold text-gray-800">Collections</h1>
              <p className="text-xs text-gray-500">Ready for pickup</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchJobs}
              disabled={isLoading}
              className="p-2 text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh list"
            >
              <svg className={`w-6 h-6 ${isLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
              title="Logout"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {lastRefresh && (
        <div className="max-w-3xl mx-auto px-4 py-2">
          <p className="text-xs text-gray-400 text-center">
            Last updated: {lastRefresh.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} • Tap refresh for latest
          </p>
        </div>
      )}

      {showSuccess && (
        <div className="max-w-3xl mx-auto px-4 mb-2">
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
            <span className="text-2xl">✅</span>
            <div>
              <p className="font-medium text-green-800">Collection completed!</p>
              <p className="text-sm text-green-600">Job marked as on hire and delivery note sent.</p>
            </div>
            <button onClick={() => setShowSuccess(false)} className="ml-auto text-green-600 hover:text-green-800">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 py-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <p className="text-red-700">{error}</p>
            <button onClick={fetchJobs} className="mt-2 text-red-600 underline text-sm">Try again</button>
          </div>
        )}

        {isLoading && jobs.length === 0 && (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
            <p className="mt-4 text-gray-500">Loading collections…</p>
          </div>
        )}

        {!isLoading && jobs.length === 0 && !error && (
          <div className="text-center py-12 bg-white rounded-xl">
            <div className="text-6xl mb-4">📦</div>
            <h2 className="text-xl font-semibold text-gray-700 mb-2">No collections ready</h2>
            <p className="text-gray-500 mb-4">No confirmed jobs with hire dates around today.</p>
            <button onClick={fetchJobs} className="text-purple-600 underline">Refresh list</button>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="space-y-3">
            {jobs.map((job) => (
              <button
                key={job.id}
                onClick={() => navigate(`/warehouse/collections/${job.id}`)}
                className="w-full bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-800 truncate">{job.jobName}</h3>
                    {job.clientName && (
                      <p className="text-gray-600 mt-1">👤 {job.clientName}</p>
                    )}
                    {job.hhRef && (
                      <p className="text-sm text-gray-500 mt-1">HH: {job.hhRef}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                      formatDate(job.hireStartDate) === 'Today'
                        ? 'bg-green-100 text-green-700'
                        : formatDate(job.hireStartDate) === 'Tomorrow'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {formatDate(job.hireStartDate)}
                    </span>
                    <div className="mt-2 text-gray-400">
                      <svg className="w-5 h-5 ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {jobs.length > 0 && (
          <p className="text-center text-gray-400 text-sm mt-6">
            {jobs.length} job{jobs.length !== 1 ? 's' : ''} ready for collection
          </p>
        )}
      </main>
    </div>
  );
}
