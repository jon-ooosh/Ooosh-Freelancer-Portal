import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import ActivityTimeline from '../components/ActivityTimeline';

const STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
  10: 'Not Interested', 11: 'Completed',
};

const STATUS_COLOURS: Record<number, string> = {
  0: 'bg-blue-100 text-blue-700',
  1: 'bg-amber-100 text-amber-700',
  2: 'bg-green-100 text-green-700',
  3: 'bg-purple-100 text-purple-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-indigo-100 text-indigo-700',
  6: 'bg-yellow-100 text-yellow-800',
  7: 'bg-teal-100 text-teal-700',
  8: 'bg-red-100 text-red-700',
  9: 'bg-gray-100 text-gray-500',
  10: 'bg-gray-100 text-gray-500',
  11: 'bg-emerald-100 text-emerald-700',
};

interface JobDetail {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  job_type: string | null;
  status: number;
  status_name: string | null;
  colour: string | null;
  client_id: string | null;
  client_name: string | null;
  company_name: string | null;
  client_ref: string | null;
  venue_id: string | null;
  venue_name: string | null;
  address: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  created_date: string | null;
  duration_days: number | null;
  duration_hrs: number | null;
  manager1_name: string | null;
  manager1_person_id: string | null;
  manager2_name: string | null;
  manager2_person_id: string | null;
  hh_project_id: number | null;
  project_name: string | null;
  details: string | null;
  custom_index: string | null;
  depot_name: string | null;
  is_internal: boolean;
  notes: string | null;
  tags: string[];
  created_at: string;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  created_by_email: string | null;
  mentioned_user_ids: string[];
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = (location.state as { from?: string })?.from || '/jobs';
  const backLabel = backTo === '/pipeline' ? 'Back to Pipeline' : 'Back to Jobs';

  const [job, setJob] = useState<JobDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline' | 'details'>('overview');

  useEffect(() => {
    if (id) {
      loadJob();
      loadInteractions();
    }
  }, [id]);

  async function loadJob() {
    try {
      const data = await api.get<JobDetail>(`/hirehop/jobs/${id}`);
      setJob(data);
    } catch {
      navigate(backTo);
    } finally {
      setLoading(false);
    }
  }

  async function loadInteractions() {
    try {
      const data = await api.get<{ data: Interaction[] }>(`/interactions?job_id=${id}`);
      setInteractions(data.data);
    } catch (err) {
      console.error('Failed to load interactions:', err);
    }
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function formatDateTime(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (!job) {
    return <div className="text-center py-12 text-gray-500">Job not found.</div>;
  }

  const statusLabel = STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`;
  const statusColour = STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600';

  return (
    <div>
      {/* Back link */}
      <Link to={backTo} className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block">
        &larr; {backLabel}
      </Link>

      {/* Header Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-mono text-gray-400">#{job.hh_job_number}</span>
              <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${statusColour}`}>
                {statusLabel}
              </span>
              {job.is_internal && (
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-200 text-gray-600">Internal</span>
              )}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mt-2">
              {job.job_name || 'Untitled Job'}
            </h1>
            <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-600">
              {(job.client_name || job.company_name) && (
                <span>
                  {job.client_id ? (
                    <Link to={`/organisations/${job.client_id}`} className="text-ooosh-600 hover:text-ooosh-700">
                      {job.client_name || job.company_name}
                    </Link>
                  ) : (
                    job.client_name || job.company_name
                  )}
                </span>
              )}
              {job.venue_name && (
                <span>
                  {job.venue_id ? (
                    <Link to={`/venues/${job.venue_id}`} className="text-ooosh-600 hover:text-ooosh-700">
                      {job.venue_name}
                    </Link>
                  ) : (
                    job.venue_name
                  )}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tags */}
        {job.tags && job.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {job.tags.map((tag) => (
              <span key={tag} className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['overview', 'timeline', 'details'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'overview' ? 'Overview' : tab === 'timeline' ? 'Activity Timeline' : 'Full Details'}
            </button>
          ))}
        </nav>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Dates Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Dates</h3>
            <div className="space-y-3">
              <DateRow label="Out Date" value={formatDate(job.out_date)} />
              <DateRow label="Job Start" value={formatDate(job.job_date)} />
              <DateRow label="Job End" value={formatDate(job.job_end)} />
              <DateRow label="Return Date" value={formatDate(job.return_date)} />
              {(job.duration_days || job.duration_hrs) && (
                <div className="pt-2 border-t">
                  <span className="text-xs text-gray-500">Duration: </span>
                  <span className="text-sm text-gray-900">
                    {job.duration_days ? `${job.duration_days} day${job.duration_days !== 1 ? 's' : ''}` : ''}
                    {job.duration_days && job.duration_hrs ? ', ' : ''}
                    {job.duration_hrs ? `${job.duration_hrs} hr${job.duration_hrs !== 1 ? 's' : ''}` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* People Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">People</h3>
            <div className="space-y-3">
              <div>
                <span className="text-xs text-gray-500 block">Client</span>
                {job.client_id ? (
                  <Link to={`/organisations/${job.client_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700 font-medium">
                    {job.client_name || job.company_name || '—'}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-900">{job.client_name || job.company_name || '—'}</span>
                )}
                {job.client_ref && (
                  <span className="text-xs text-gray-400 ml-2">Ref: {job.client_ref}</span>
                )}
              </div>
              <div>
                <span className="text-xs text-gray-500 block">Manager 1</span>
                {job.manager1_person_id ? (
                  <Link to={`/people/${job.manager1_person_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700 font-medium">
                    {job.manager1_name || '—'}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-900">{job.manager1_name || '—'}</span>
                )}
              </div>
              <div>
                <span className="text-xs text-gray-500 block">Manager 2</span>
                {job.manager2_person_id ? (
                  <Link to={`/people/${job.manager2_person_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700 font-medium">
                    {job.manager2_name || '—'}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-900">{job.manager2_name || '—'}</span>
                )}
              </div>
            </div>
          </div>

          {/* Venue Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Venue</h3>
            <div className="space-y-2">
              <div>
                <span className="text-xs text-gray-500 block">Name</span>
                {job.venue_id ? (
                  <Link to={`/venues/${job.venue_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700 font-medium">
                    {job.venue_name || '—'}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-900">{job.venue_name || '—'}</span>
                )}
              </div>
              {job.address && (
                <div>
                  <span className="text-xs text-gray-500 block">Address</span>
                  <span className="text-sm text-gray-900">{job.address}</span>
                </div>
              )}
            </div>
          </div>

          {/* Project Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Project & Meta</h3>
            <div className="space-y-2">
              {job.project_name && (
                <div>
                  <span className="text-xs text-gray-500 block">Project</span>
                  <span className="text-sm text-gray-900">{job.project_name}</span>
                </div>
              )}
              {job.job_type && (
                <div>
                  <span className="text-xs text-gray-500 block">Type</span>
                  <span className="text-sm text-gray-900">{job.job_type}</span>
                </div>
              )}
              {job.depot_name && (
                <div>
                  <span className="text-xs text-gray-500 block">Depot</span>
                  <span className="text-sm text-gray-900">{job.depot_name}</span>
                </div>
              )}
              {job.custom_index && (
                <div>
                  <span className="text-xs text-gray-500 block">Custom Index</span>
                  <span className="text-sm text-gray-900">{job.custom_index}</span>
                </div>
              )}
              <div>
                <span className="text-xs text-gray-500 block">Created</span>
                <span className="text-sm text-gray-900">{formatDateTime(job.created_date)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {(job.notes || job.details) && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 md:col-span-2">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Notes</h3>
              {job.details && (
                <p className="text-sm text-gray-600 whitespace-pre-wrap mb-3">{job.details}</p>
              )}
              {job.notes && (
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{job.notes}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timeline Tab */}
      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="job_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={loadInteractions}
        />
      )}

      {/* Full Details Tab */}
      {activeTab === 'details' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailField label="HireHop Job #" value={String(job.hh_job_number)} />
            <DetailField label="Job Name" value={job.job_name} />
            <DetailField label="Job Type" value={job.job_type} />
            <DetailField label="Status" value={statusLabel} />
            <DetailField label="Client" value={job.client_name || job.company_name} />
            <DetailField label="Client Ref" value={job.client_ref} />
            <DetailField label="Venue" value={job.venue_name} />
            <DetailField label="Address" value={job.address} />
            <DetailField label="Out Date" value={formatDate(job.out_date)} />
            <DetailField label="Job Start" value={formatDate(job.job_date)} />
            <DetailField label="Job End" value={formatDate(job.job_end)} />
            <DetailField label="Return Date" value={formatDate(job.return_date)} />
            <DetailField label="Duration" value={
              job.duration_days || job.duration_hrs
                ? `${job.duration_days || 0} days, ${job.duration_hrs || 0} hrs`
                : null
            } />
            <DetailField label="Manager 1" value={job.manager1_name} />
            <DetailField label="Manager 2" value={job.manager2_name} />
            <DetailField label="Project" value={job.project_name} />
            <DetailField label="Depot" value={job.depot_name} />
            <DetailField label="Custom Index" value={job.custom_index} />
            <DetailField label="Internal" value={job.is_internal ? 'Yes' : 'No'} />
            <DetailField label="Created in HireHop" value={formatDateTime(job.created_date)} />
            <DetailField label="Synced" value={formatDateTime(job.created_at)} />
          </div>
          {job.details && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Details</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{job.details}</p>
            </div>
          )}
          {job.notes && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{job.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-sm text-gray-900">{value}</span>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value || '—'}</dd>
    </div>
  );
}
