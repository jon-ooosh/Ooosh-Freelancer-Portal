/**
 * Job projects on Job Detail (docs/JOB-PROJECTS-SPEC.md) — "these jobs all
 * belong to the same festival".
 *
 *   ProjectPanel       the collapsible panel in the right-hand column: name,
 *                      client, lead, the dates new jobs start with, roll-ups
 *                      and every job in the project.
 *   AddToProjectModal  "+ Add to a project" in the header: pick a project or
 *                      start a new one from this job.
 *
 * A project has no page of its own — any of its jobs shows the panel. Its
 * dates are defaults for NEW jobs only; nothing here changes an existing job's
 * dates (Start/End are what HireHop charges for). Copy: lib/projectCopy.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import DatePicker from './DatePicker';
import { PROJECT_COPY as C } from '../lib/projectCopy';
import { jobStatusDisplay } from '../lib/pipelineStatus';
import { stripOptionSuffix } from '../lib/quoteOptions';
import { useAuthStore } from '../hooks/useAuthStore';

interface ProjectMember {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: string | null;
  status: number | null;
  job_date: string | null;
  job_end: string | null;
  job_value: string | null;
  client_name: string | null;
  dismissed_at: string | null;
  option_no: number | null;
  counted: boolean;
}

export interface JobProject {
  id: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  lead_user_id: string | null;
  lead_name: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  members: ProjectMember[];
  rollup: {
    job_count: number;
    confirmed_count: number;
    confirmed_value: number;
    quoted_count: number;
    quoted_value: number;
  };
}

interface StaffOption { id: string; first_name: string; last_name: string; preferred_name?: string | null }

const COLLAPSE_KEY = 'op.jobProjectPanel.collapsed';

function gbp(n: number): string {
  return `£${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

/** "12 Aug" from a YYYY-MM-DD, built from its parts (no UTC shift). */
function shortDay(ymd: string | null): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "12 Aug" from a stored timestamp. */
function shortStamp(iso: string | null): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

function staffName(u: StaffOption): string {
  return `${u.preferred_name || u.first_name || ''} ${u.last_name || ''}`.trim();
}

function errorText(e: unknown, fallback: string): string {
  const body = (e as { body?: { error?: string } })?.body;
  return body?.error || (e instanceof Error && e.message) || fallback;
}

// ── The panel ────────────────────────────────────────────────────────────────

export function ProjectPanel({ projectId, jobId, onChanged }: {
  projectId: string;
  jobId: string;
  /** The job's own project membership changed (removed) — reload the job. */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [project, setProject] = useState<JobProject | null>(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [editing, setEditing] = useState(false);
  const [addingExisting, setAddingExisting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: JobProject }>(`/job-projects/${projectId}`);
      setProject(res.data);
      setError('');
    } catch {
      setError(C.loadFailed);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* per-viewer nicety only */ }
  }

  async function removeThis() {
    if (!project || !window.confirm(C.removeConfirm(project.name))) return;
    setBusy(true);
    try {
      await api.delete(`/job-projects/jobs/${jobId}`);
      onChanged();
    } catch (e) {
      window.alert(errorText(e, 'Could not remove the job.'));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 text-xs text-red-600">{error}</div>;
  }
  if (!project) {
    return <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 text-xs text-gray-400">Loading project...</div>;
  }

  const r = project.rollup;
  const newJobUrl = `/pipeline?newEnquiry=1&project=${project.id}${project.client_id ? `&client=${project.client_id}` : ''}`;
  const hasDates = project.out_date || project.job_date || project.job_end || project.return_date;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-ooosh-200 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ooosh-600">{C.panelHeading}</div>
          <h3 className="text-sm font-semibold text-gray-900 break-words">{project.name}</h3>
          <div className="text-[11px] text-gray-500">{C.jobCount(r.job_count)}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!collapsed && (
            <button type="button" onClick={() => setEditing(true)} className="text-xs text-ooosh-600 hover:text-ooosh-800">
              {C.edit}
            </button>
          )}
          <button type="button" onClick={toggle} className="text-xs text-gray-400 hover:text-gray-600" title={collapsed ? C.panelExpand : C.panelCollapse}>
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex gap-2"><dt className="text-gray-400 w-12 shrink-0">{C.client}</dt>
              <dd className="text-gray-700 min-w-0 truncate">
                {project.client_id
                  ? <Link to={`/organisations/${project.client_id}`} className="hover:underline">{project.client_name}</Link>
                  : '-'}
              </dd>
            </div>
            <div className="flex gap-2"><dt className="text-gray-400 w-12 shrink-0">{C.lead}</dt>
              <dd className="text-gray-700">{project.lead_name || C.noLead}</dd>
            </div>
            <div className="flex gap-2"><dt className="text-gray-400 w-12 shrink-0">Dates</dt>
              <dd className="text-gray-700" title={C.dates}>
                {hasDates
                  ? <>out {shortDay(project.out_date) || '-'} · {shortDay(project.job_date) || '-'}-{shortDay(project.job_end) || '-'} · back {shortDay(project.return_date) || '-'}</>
                  : C.noDates}
              </dd>
            </div>
          </dl>

          <div className="grid grid-cols-2 gap-2 mt-3" title={C.valueNote}>
            <div className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-base font-bold text-green-700">{gbp(r.confirmed_value)}</div>
              <div className="text-[10px] text-gray-500">{C.confirmed} ({r.confirmed_count})</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-base font-bold text-gray-800">{gbp(r.quoted_value)}</div>
              <div className="text-[10px] text-gray-500">{C.quoted} ({r.quoted_count})</div>
            </div>
          </div>

          <ul className="mt-3 divide-y divide-gray-100">
            {project.members.map((m) => {
              const st = jobStatusDisplay(m);
              const here = m.id === jobId;
              return (
                <li key={m.id} className={`py-1.5 ${m.counted ? '' : 'opacity-60'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-ooosh-600">
                      {here
                        ? <span className="text-gray-500">{m.hh_job_number ? `J-${m.hh_job_number}` : 'NEW'} · {C.thisJob}</span>
                        : <Link to={`/jobs/${m.id}`} className="hover:underline">{m.hh_job_number ? `J-${m.hh_job_number}` : 'NEW'}</Link>}
                    </span>
                    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium ${st.colour}`}>{st.label}</span>
                  </div>
                  <div className={`text-xs truncate ${here ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
                    {(m.option_no ? stripOptionSuffix(m.job_name) : m.job_name) || 'Untitled'}
                    {m.option_no ? <span className="text-ooosh-700"> · Option {m.option_no}</span> : null}
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-400">
                    <span className="truncate">{shortStamp(m.job_date)}{m.client_name && m.client_name !== project.client_name ? ` · ${m.client_name}` : ''}</span>
                    {Number(m.job_value) > 0 && <span>{gbp(Number(m.job_value))}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex flex-col gap-1.5">
            <button type="button" onClick={() => navigate(newJobUrl)} title={C.newJobTitle}
              className="w-full px-2.5 py-1.5 text-xs border border-ooosh-300 text-ooosh-700 rounded-lg hover:bg-ooosh-50">
              {C.newJob}
            </button>
            <button type="button" onClick={() => setAddingExisting(true)}
              className="w-full px-2.5 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50">
              {C.addExisting}
            </button>
            <button type="button" onClick={removeThis} disabled={busy}
              className="text-[11px] text-gray-400 hover:text-red-600 mt-1 disabled:opacity-50">
              {C.removeThis}
            </button>
          </div>
        </>
      )}

      {editing && (
        <ProjectFormModal
          title={C.editTitle}
          submitLabel={C.save}
          initial={project}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            await api.patch(`/job-projects/${project.id}`, values);
            setEditing(false);
            await load();
          }}
        />
      )}
      {addingExisting && (
        <AddExistingJobModal
          projectId={project.id}
          onClose={() => setAddingExisting(false)}
          onAdded={async () => { setAddingExisting(false); await load(); }}
        />
      )}
    </div>
  );
}

// ── Project form (edit, or new from a job) ───────────────────────────────────

interface ProjectFormValues {
  name: string;
  client_id: string | null;
  lead_user_id: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
}

function ProjectFormModal({ title, intro, submitLabel, initial, onClose, onSubmit, onBack }: {
  title: string;
  intro?: string;
  submitLabel: string;
  initial: Partial<ProjectFormValues> & { client_name?: string | null; lead_name?: string | null };
  onClose: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onBack?: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [clientId, setClientId] = useState<string | null>(initial.client_id ?? null);
  const [clientName, setClientName] = useState<string>(initial.client_name ?? '');
  const [clientSearch, setClientSearch] = useState('');
  const [clientResults, setClientResults] = useState<Array<{ id: string; name: string }>>([]);
  const [leadUserId, setLeadUserId] = useState<string>(initial.lead_user_id ?? '');
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [outDate, setOutDate] = useState(initial.out_date ?? '');
  const [jobDate, setJobDate] = useState(initial.job_date ?? '');
  const [jobEnd, setJobEnd] = useState(initial.job_end ?? '');
  const [returnDate, setReturnDate] = useState(initial.return_date ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ data: StaffOption[] }>('/users?assignable=true').then((r) => setStaff(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const q = clientSearch.trim();
    if (q.length < 2) { setClientResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ results: Array<{ id: string; name: string; type: string }> }>(`/search?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => setClientResults(r.results.filter((x) => x.type === 'organisation')))
        .catch(() => setClientResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [clientSearch]);

  async function submit() {
    if (!name.trim()) { setError('A project needs a name'); return; }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        name: name.trim(),
        client_id: clientId,
        lead_user_id: leadUserId || null,
        out_date: outDate || null,
        job_date: jobDate || null,
        job_end: jobEnd || null,
        return_date: returnDate || null,
      });
    } catch (e) {
      setError(errorText(e, 'Could not save the project.'));
      setSaving(false);
    }
  }

  // A lead who is no longer in the assignable list still shows (frontend.md:
  // a select whose value matches no option renders blank and saves it).
  const leadMissing = leadUserId && !staff.some((u) => u.id === leadUserId);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900 mb-1">{title}</h2>
        {intro ? <p className="text-xs text-gray-500 mb-3">{intro}</p> : <div className="mb-2" />}

        <label className="block text-xs font-medium text-gray-600 mb-1">{C.nameField}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.namePlaceholder}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3" maxLength={200} autoFocus />

        <label className="block text-xs font-medium text-gray-600 mb-1">{C.clientField}</label>
        {clientId ? (
          <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3">
            <span className="truncate">{clientName || 'Selected'}</span>
            <button type="button" onClick={() => { setClientId(null); setClientName(''); }} className="text-xs text-gray-400 hover:text-gray-600">{C.clientClear}</button>
          </div>
        ) : (
          <div className="mb-3">
            <input value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} placeholder={C.clientSearch}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            {clientResults.length > 0 && (
              <ul className="border border-gray-200 rounded-lg mt-1 max-h-40 overflow-y-auto">
                {clientResults.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => { setClientId(o.id); setClientName(o.name); setClientSearch(''); setClientResults([]); }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50">{o.name}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <label className="block text-xs font-medium text-gray-600 mb-1">{C.leadField}</label>
        <select value={leadUserId} onChange={(e) => setLeadUserId(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3">
          <option value="">-</option>
          {leadMissing && <option value={leadUserId}>{initial.lead_name || 'Current lead'}</option>}
          {staff.map((u) => <option key={u.id} value={u.id}>{staffName(u)}</option>)}
        </select>

        <label className="block text-xs font-medium text-gray-600 mb-1">{C.datesField}</label>
        <p className="text-[11px] text-gray-400 mb-2">{C.datesNote}</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div><span className="text-[11px] text-gray-500">{C.outField}</span><DatePicker value={outDate} onChange={setOutDate} /></div>
          <div><span className="text-[11px] text-gray-500">{C.startField}</span><DatePicker value={jobDate} onChange={setJobDate} /></div>
          <div><span className="text-[11px] text-gray-500">{C.endField}</span><DatePicker value={jobEnd} onChange={setJobEnd} /></div>
          <div><span className="text-[11px] text-gray-500">{C.returnField}</span><DatePicker value={returnDate} onChange={setReturnDate} /></div>
        </div>

        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
        <div className="flex justify-between gap-2">
          <div>{onBack && <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700">{C.addBack}</button>}</div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">{C.cancel}</button>
            <button type="button" onClick={submit} disabled={saving}
              className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50">
              {saving ? C.saving : submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add an existing job to a project ─────────────────────────────────────────

function AddExistingJobModal({ projectId, onClose, onAdded }: {
  projectId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Array<{
    id: string; hh_job_number: number | null; job_name: string | null; pipeline_status: string | null;
    job_date: string | null; client_name: string | null; job_project_name: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      api.get<{ data: typeof rows }>(`/job-projects/${projectId}/job-candidates?search=${encodeURIComponent(search.trim())}`)
        .then((r) => setRows(r.data))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [projectId, search]);

  async function add(jobId: string) {
    setAdding(jobId);
    setError('');
    try {
      await api.post(`/job-projects/${projectId}/jobs`, { job_id: jobId });
      onAdded();
    } catch (e) {
      setError(errorText(e, 'Could not add the job.'));
      setAdding(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900 mb-3">{C.existingTitle}</h2>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={C.existingSearch} autoFocus
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />
        {!search.trim() && <p className="text-[11px] text-gray-400 mb-2">{C.existingSuggested}</p>}
        {loading ? (
          <p className="text-xs text-gray-400 py-3">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-gray-400 py-3">{C.existingNone}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((j) => {
              const st = jobStatusDisplay(j);
              return (
                <li key={j.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-900 truncate">
                      <span className="font-mono text-xs text-ooosh-600 mr-1">{j.hh_job_number ? `J-${j.hh_job_number}` : 'NEW'}</span>
                      {j.job_name || 'Untitled'}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {[j.client_name, shortStamp(j.job_date)].filter(Boolean).join(' · ')}
                      {j.job_project_name && <span className="text-amber-700"> · {C.existingInOther(j.job_project_name)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium ${st.colour}`}>{st.label}</span>
                    <button type="button" onClick={() => add(j.id)} disabled={adding !== null}
                      className="px-2.5 py-1 text-xs bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50">
                      {adding === j.id ? C.saving : C.existingAdd}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        <div className="flex justify-end mt-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">{C.cancel}</button>
        </div>
      </div>
    </div>
  );
}

// ── "+ Add to a project" from a job ──────────────────────────────────────────

export function AddToProjectModal({ job, onClose, onDone }: {
  job: {
    id: string;
    client_id: string | null;
    client_name?: string | null;
    client_org_name?: string | null;
    out_date: string | null;
    job_date: string | null;
    job_end: string | null;
    return_date: string | null;
  };
  onClose: () => void;
  onDone: () => void;
}) {
  const me = useAuthStore((st) => st.user);
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; client_name: string | null; job_date: string | null; job_end: string | null; job_count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode !== 'pick') return;
    setLoading(true);
    const t = setTimeout(() => {
      api.get<{ data: typeof projects }>(`/job-projects?search=${encodeURIComponent(search.trim())}`)
        .then((r) => setProjects(r.data))
        .catch(() => setProjects([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [mode, search]);

  async function pick(projectId: string) {
    setAdding(projectId);
    setError('');
    try {
      await api.post(`/job-projects/${projectId}/jobs`, { job_id: job.id });
      onDone();
    } catch (e) {
      setError(errorText(e, 'Could not add the job.'));
      setAdding(null);
    }
  }

  // The new project's dates start as this job's, as UK calendar days.
  const ukDay = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  };

  if (mode === 'new') {
    return (
      <ProjectFormModal
        title={C.newTitle}
        intro={C.addNewIntro}
        submitLabel={C.create}
        initial={{
          name: '',
          // Whoever starts the project leads it until somebody changes it.
          lead_user_id: me?.id ?? null,
          lead_name: me ? 'You' : null,
          client_id: job.client_id,
          client_name: job.client_org_name || job.client_name || null,
          out_date: ukDay(job.out_date),
          job_date: ukDay(job.job_date),
          job_end: ukDay(job.job_end),
          return_date: ukDay(job.return_date),
        }}
        onClose={onClose}
        onBack={() => setMode('pick')}
        onSubmit={async (values) => {
          await api.post('/job-projects', { ...values, from_job_id: job.id });
          onDone();
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900 mb-1">{C.addTitle}</h2>
        <p className="text-xs text-gray-500 mb-3">{C.addIntro}</p>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={C.addSearch} autoFocus
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />
        {loading ? (
          <p className="text-xs text-gray-400 py-3">Loading...</p>
        ) : projects.length === 0 ? (
          <p className="text-xs text-gray-400 py-3">{C.addNone}</p>
        ) : (
          <ul className="divide-y divide-gray-100 mb-2">
            {projects.map((p) => (
              <li key={p.id} className="py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-gray-900 truncate">{p.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {[p.client_name, p.job_date ? `${shortDay(p.job_date)}${p.job_end && p.job_end !== p.job_date ? `-${shortDay(p.job_end)}` : ''}` : null, C.jobCount(p.job_count)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <button type="button" onClick={() => pick(p.id)} disabled={adding !== null}
                  className="px-2.5 py-1 text-xs bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50 shrink-0">
                  {adding === p.id ? C.saving : C.addPick}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
        <div className="flex justify-between items-center mt-2">
          <button type="button" onClick={() => setMode('new')} className="text-sm font-medium text-ooosh-600 hover:text-ooosh-800">
            {C.addNew}
          </button>
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">{C.cancel}</button>
        </div>
      </div>
    </div>
  );
}
