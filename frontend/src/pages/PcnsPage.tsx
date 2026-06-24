import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import PcnActionChooser from '../components/PcnActionChooser';
import { compressImage } from '../components/holding/compress';
import {
  Pcn,
  PCN_STATUS_LABEL,
  PCN_STATUS_COLOUR,
  FINE_TYPE_LABEL,
  PcnStatusPill,
  PcnNextActionCell,
  pcnTrafficLight,
  PcnLight,
  PCN_DOC_KINDS,
  PCN_DOC_KIND_LABEL,
} from '../components/pcn/format';

// Re-export the shared display surface so existing importers (PcnDetailPage)
// keep working off this module.
export { PCN_STATUS_LABEL, PCN_STATUS_COLOUR, FINE_TYPE_LABEL, PcnStatusPill };
export type { Pcn };

// ── Types ───────────────────────────────────────────────────────────────
interface MatchedDriver {
  assignment_id: string;
  vehicle_id: string;
  reg: string;
  driver_id: string | null;
  driver_name: string | null;
  driver_email: string | null;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
  client_organisation_id: string | null;
  client_organisation_name: string | null;
}

interface CrewCandidate {
  person_id: string;
  person_name: string | null;
  person_email: string | null;
  is_freelancer: boolean;
  role: string;
  job_type: string;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
}

interface ExtractedPcn {
  reference: string | null;
  vehicle_reg: string | null;
  offence_date: string | null;
  offence_time: string | null;
  issued_date: string | null;
  location: string | null;
  issuing_authority: string | null;
  offence_description: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  fine_type: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const money = (n: number | null | undefined) => (n == null ? '—' : `£${Number(n).toFixed(2)}`);

// ── Page ────────────────────────────────────────────────────────────────
export default function PcnsPage() {
  const [pcns, setPcns] = useState<Pcn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Seed status/type from the URL so dashboard deep-links (e.g. the PCN
  // NeedsAttention buckets → ?status= / ?fine_type=) land pre-filtered.
  // Otherwise fall back to the last-used view persisted in localStorage.
  const initialParams = new URLSearchParams(window.location.search);
  const prefs: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem('ooosh_pcns_prefs') || '{}'); } catch { return {}; }
  })();
  const [statusFilter, setStatusFilter] = useState(initialParams.get('status') || prefs.statusFilter || '');
  const [typeFilter, setTypeFilter] = useState(initialParams.get('fine_type') || prefs.typeFilter || '');
  const [offenceFrom, setOffenceFrom] = useState(prefs.offenceFrom || '');
  const [offenceTo, setOffenceTo] = useState(prefs.offenceTo || '');
  const [sort, setSort] = useState(prefs.sort || 'created_desc');
  // Traffic-light filter is derived (partly from deadlines) so it's applied
  // client-side over the already-fetched rows.
  const [lightFilter, setLightFilter] = useState<'' | PcnLight>((prefs.lightFilter as PcnLight) || '');
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);

  // Deep-link: /vehicles/pcns?new=1 (from the Quick tab) opens the modal.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowCreate(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter) params.set('fine_type', typeFilter);
      if (offenceFrom) params.set('offence_from', offenceFrom);
      if (offenceTo) params.set('offence_to', offenceTo);
      if (sort) params.set('sort', sort);
      const r = await api.get<{ data: Pcn[] }>(`/pcns?${params.toString()}`);
      setPcns(r.data);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, typeFilter, offenceFrom, offenceTo, sort]);

  useEffect(() => { load(); }, [load]);

  // Persist the last-used sort + filters so the view is restored on return.
  useEffect(() => {
    localStorage.setItem('ooosh_pcns_prefs', JSON.stringify({
      sort, statusFilter, typeFilter, offenceFrom, offenceTo, lightFilter,
    }));
  }, [sort, statusFilter, typeFilter, offenceFrom, offenceTo, lightFilter]);

  const visible = lightFilter ? pcns.filter((p) => pcnTrafficLight(p) === lightFilter) : pcns;
  const hasFilters = !!(search || statusFilter || typeFilter || offenceFrom || offenceTo || lightFilter || sort !== 'created_desc');
  const clearFilters = () => {
    setSearch(''); setStatusFilter(''); setTypeFilter('');
    setOffenceFrom(''); setOffenceTo(''); setLightFilter(''); setSort('created_desc');
  };

  // Column-header sorting. Clicking a column sorts by it; clicking the active
  // column flips direction. Date/number columns lead with desc (newest/highest
  // first); text columns with asc (A→Z).
  const DESC_FIRST = new Set(['offence', 'fine', 'job']);
  const sortField = sort.replace(/_(asc|desc)$/, '');
  const sortDir: 'asc' | 'desc' = sort.endsWith('_asc') ? 'asc' : 'desc';
  const toggleSort = (field: string) =>
    setSort(
      sortField === field
        ? `${field}_${sortDir === 'asc' ? 'desc' : 'asc'}`
        : `${field}_${DESC_FIRST.has(field) ? 'desc' : 'asc'}`
    );
  const th = (field: string, label: string) => (
    <th className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className="inline-flex items-center gap-1 hover:text-slate-700"
        title={`Sort by ${label}`}
      >
        {label}
        <span className="text-[10px] text-slate-400">
          {sortField === field ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-800">PCNs</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#6a5092]"
        >
          + Log PCN
        </button>
      </div>

      <div className="bg-white rounded-lg border p-3 mb-4 space-y-2">
        {/* Row 1 — search + the server-side dropdowns */}
        <div className="flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ref, reg, authority, job #…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[220px]"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {Object.entries(PCN_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All types</option>
            {Object.entries(FINE_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            value={['created_desc', 'deadline_asc'].includes(sort) ? sort : 'column'}
            onChange={(e) => setSort(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            title="Sort (or click a column heading)"
          >
            <option value="created_desc">Newest logged</option>
            <option value="deadline_asc">Deadline soonest</option>
            <option value="column" disabled hidden>Sorted by column ↕</option>
          </select>
        </div>

        {/* Row 2 — offence date range, traffic-light, clear */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-500">Offence</label>
          <input
            type="date"
            value={offenceFrom}
            onChange={(e) => setOffenceFrom(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-sm"
            title="Offence date from"
          />
          <span className="text-slate-400 text-sm">→</span>
          <input
            type="date"
            value={offenceTo}
            onChange={(e) => setOffenceTo(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-sm"
            title="Offence date to"
          />

          <div className="flex rounded-lg border overflow-hidden ml-1">
            {([
              ['', 'All'],
              ['red', '🔴 Outstanding'],
              ['amber', '🟡 In flight'],
              ['green', '🟢 Sorted'],
            ] as const).map(([val, label]) => (
              <button
                key={val || 'all'}
                onClick={() => setLightFilter(val)}
                className={`px-2.5 py-1.5 text-xs font-medium border-l first:border-l-0 ${
                  lightFilter === val ? 'bg-[#7B5EA7] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-slate-500 hover:text-slate-700 underline ml-1">
              Clear
            </button>
          )}
          <span className="text-xs text-slate-400 ml-auto">{visible.length} PCN{visible.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="bg-white rounded-lg border overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No PCNs found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                {th('reference', 'Reference')}
                {th('reg', 'Vehicle')}
                {th('driver', 'Driver')}
                {th('job', 'Job')}
                {th('offence', 'Offence')}
                {th('issued', 'PCN date')}
                <th className="px-3 py-2 font-medium">Next action</th>
                {th('fine', 'Fine')}
                {th('status', 'Status')}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link to={`/vehicles/pcns/${p.id}`} className="text-[#7B5EA7] font-medium hover:underline">
                      {p.reference || '(no ref)'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{p.fleet_reg || p.vehicle_reg || '—'}</td>
                  <td className="px-3 py-2">
                    {p.driver_name
                      || (p.driver_person_name
                        ? <>{p.driver_person_name} <span className="text-xs text-slate-400">(crew)</span></>
                        : '—')}
                  </td>
                  <td className="px-3 py-2">{p.hh_job_number ? `#${p.hh_job_number}` : '—'}</td>
                  <td className="px-3 py-2">{fmtDate(p.offence_at)}{p.offence_time_text ? ` ${p.offence_time_text}` : ''}</td>
                  <td className="px-3 py-2">{fmtDate(p.issued_date)}</td>
                  <td className="px-3 py-2"><PcnNextActionCell pcn={p} /></td>
                  <td className="px-3 py-2">{money(p.fine_amount)}</td>
                  <td className="px-3 py-2"><PcnStatusPill status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreatePcnModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Create modal: extraction-first, manual fallback ───────────────────────
const EMPTY_FORM = {
  reference: '', fine_type: 'private_pcn', vehicle_reg: '',
  offence_date: '', offence_time: '', issued_date: '', location: '', issuing_authority: '',
  fine_amount: '', reduced_amount: '', reduced_deadline: '', final_deadline: '',
  notes: '',
};

function CreatePcnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  // After save, the modal switches to the "what next?" action step.
  const [created, setCreated] = useState<{ id: string; driver_email: string | null } | null>(null);
  const [actionTaken, setActionTaken] = useState(false);
  // Multiple pages: front + back of a paper notice, or extra pages. Each carries
  // a `kind` so it's filed correctly. Index 0 defaults to the notice front.
  const [pages, setPages] = useState<{ file: File; kind: string }[]>([]);
  const [dupes, setDupes] = useState<Pcn[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false); // revealed after extract OR manual choice
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [matches, setMatches] = useState<MatchedDriver[] | null>(null);
  const [crewCandidates, setCrewCandidates] = useState<CrewCandidate[]>([]);
  const [picked, setPicked] = useState<MatchedDriver | null>(null);
  const [matching, setMatching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const addFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setExtractError(null);
    setPages((prev) => {
      const next = [...prev];
      Array.from(fileList).forEach((f) => {
        const kind = next.length === 0 ? 'notice_front' : next.length === 1 ? 'notice_back' : 'other';
        next.push({ file: f, kind });
      });
      return next;
    });
  };
  const setPageKind = (i: number, kind: string) => setPages((p) => p.map((pg, idx) => (idx === i ? { ...pg, kind } : pg)));
  const removePage = (i: number) => setPages((p) => p.filter((_, idx) => idx !== i));

  // Non-blocking duplicate flag — surface any existing PCN sharing this ref.
  useEffect(() => {
    const ref = form.reference.trim();
    if (!ref) { setDupes([]); return; }
    const t = setTimeout(() => {
      api.get<{ data: Pcn[] }>(`/pcns/check-duplicate?reference=${encodeURIComponent(ref)}`)
        .then((r) => setDupes(r.data))
        .catch(() => setDupes([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.reference]);

  const extract = async () => {
    if (pages.length === 0) return;
    setExtracting(true); setExtractError(null);
    try {
      const fd = new FormData();
      // Compress photos (~1600px) before sending — keeps the upload small while
      // staying legible for extraction. PDFs + non-images pass through untouched.
      // All pages go in one call so front + back are read together.
      for (const pg of pages) fd.append('files', await compressImage(pg.file));
      const r = await api.upload<{ data: ExtractedPcn }>('/pcns/extract', fd);
      const d = r.data;
      setForm({
        reference: d.reference || '',
        fine_type: d.fine_type || 'private_pcn',
        vehicle_reg: d.vehicle_reg || '',
        offence_date: d.offence_date || '',
        offence_time: d.offence_time || '',
        issued_date: d.issued_date || '',
        location: d.location || '',
        issuing_authority: d.issuing_authority || '',
        fine_amount: d.fine_amount != null ? String(d.fine_amount) : '',
        reduced_amount: d.reduced_amount != null ? String(d.reduced_amount) : '',
        reduced_deadline: d.reduced_deadline || '',
        final_deadline: d.final_deadline || '',
        notes: [d.offence_description, d.notes].filter(Boolean).join(' — '),
      });
      setConfidence(d.confidence);
      setShowForm(true);
    } catch (e) {
      const msg = (e as { message?: string })?.message || '';
      setExtractError(
        msg.includes('503') || msg.toLowerCase().includes('not configured')
          ? 'AI extraction isn’t configured on the server yet — enter the details manually below.'
          : 'Extraction failed — enter the details manually below.'
      );
      setShowForm(true);
    } finally {
      setExtracting(false);
    }
  };

  const findDriver = async () => {
    if (!form.vehicle_reg.trim() || !form.offence_date) {
      setError('Enter vehicle reg and offence date first.');
      return;
    }
    setMatching(true); setError(null); setPicked(null);
    try {
      const offenceAt = `${form.offence_date}T${form.offence_time || '12:00'}:00`;
      const r = await api.get<{ data: { drivers: MatchedDriver[]; crew_candidates?: CrewCandidate[] } }>(
        `/pcns/match?reg=${encodeURIComponent(form.vehicle_reg)}&offence_at=${encodeURIComponent(offenceAt)}`
      );
      setMatches(r.data.drivers);
      setCrewCandidates(r.data.crew_candidates || []);
      if (r.data.drivers.length === 1) setPicked(r.data.drivers[0]);
    } catch {
      setError('Driver match failed.');
    } finally {
      setMatching(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      // Stash each page in R2 first (best-effort — don't block the save).
      const documents: { r2_key: string; name: string; kind: string }[] = [];
      for (const pg of pages) {
        try {
          const fd = new FormData();
          fd.append('attachment_only', 'true');
          fd.append('file', await compressImage(pg.file));
          const up = await api.upload<{ r2_key: string }>('/files/upload', fd);
          documents.push({ r2_key: up.r2_key, name: pg.file.name, kind: pg.kind });
        } catch { /* keep going — the PCN record matters more than a scan */ }
      }
      // Legacy primary pointer = the notice front (or first uploaded), so the
      // email-attach + existing readers keep working.
      const documentUrl = documents.find((d) => d.kind === 'notice_front')?.r2_key ?? documents[0]?.r2_key ?? null;
      const offenceAt = form.offence_date
        ? `${form.offence_date}T${form.offence_time || '12:00'}:00`
        : null;
      const body: Record<string, unknown> = {
        reference: form.reference || null,
        fine_type: form.fine_type,
        vehicle_reg: form.vehicle_reg.toUpperCase().replace(/\s/g, '') || null,
        offence_at: offenceAt,
        offence_time_text: form.offence_time || null,
        issued_date: form.issued_date || null,
        location: form.location || null,
        issuing_authority: form.issuing_authority || null,
        fine_amount: form.fine_amount ? Number(form.fine_amount) : null,
        reduced_amount: form.reduced_amount ? Number(form.reduced_amount) : null,
        reduced_deadline: form.reduced_deadline || null,
        final_deadline: form.final_deadline || null,
        notes: form.notes || null,
        pcn_document_url: documentUrl,
        documents,
      };
      if (picked) {
        body.vehicle_id = picked.vehicle_id;
        body.driver_id = picked.driver_id;
        body.assignment_id = picked.assignment_id;
        body.job_id = picked.job_id;
        body.hh_job_number = picked.hh_job_number;
        body.client_organisation_id = picked.client_organisation_id;
      }
      const r = await api.post<{ data: { id: string } }>('/pcns', body);
      // Keep the modal open and move to the action step rather than closing.
      setCreated({ id: r.data.id, driver_email: picked?.driver_email ?? null });
      setSaving(false);
    } catch {
      setError('Failed to save PCN.');
      setSaving(false);
    }
  };

  const input = 'border rounded-lg px-3 py-2 text-sm w-full';

  // ── Post-save: "what next?" action step ─────────────────────────────────
  if (created) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto" onClick={onCreated}>
        <div className="bg-white rounded-xl max-w-2xl w-full my-8 p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-bold text-slate-800">PCN logged ✓</h2>
          <p className="text-sm text-slate-500 mb-4">
            {actionTaken ? 'Action taken. Anything else, or close.' : 'What do you want to do with it?'}
          </p>
          <PcnActionChooser pcnId={created.id} driverEmail={created.driver_email} onActioned={() => setActionTaken(true)} />
          <div className="flex justify-between items-center gap-2 mt-5">
            <button
              onClick={() => { onCreated(); navigate(`/vehicles/pcns/${created.id}`); }}
              className="text-sm text-[#7B5EA7] hover:underline"
            >
              Open PCN →
            </button>
            <button onClick={onCreated}
              className={`px-4 py-2 text-sm rounded-lg ${actionTaken ? 'bg-[#7B5EA7] text-white hover:bg-[#6a5092]' : 'border hover:bg-slate-50'}`}>
              {actionTaken ? 'Close' : 'Done / decide later'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-2xl w-full my-8 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Log PCN</h2>

        {/* Step 1 — Upload & extract (primary path). Multiple pages supported
            — front + back of a paper notice are read together by extraction. */}
        <div className="border-2 border-dashed rounded-xl p-5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }}
          />
          {pages.length === 0 ? (
            <div className="text-center">
              <p className="text-4xl mb-2">📄</p>
              <button onClick={() => fileRef.current?.click()}
                className="text-[#7B5EA7] font-medium hover:underline">
                Take a photo or choose a file
              </button>
              <p className="text-xs text-slate-400 mt-1">Snap the notice (front &amp; back), or upload JPEG / PNG / PDF — add as many pages as you need</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pages.map((pg, i) => (
                <div key={i} className="flex items-center gap-2 flex-wrap bg-slate-50 rounded-lg px-3 py-2">
                  <span className="text-sm text-slate-700 flex-1 min-w-0 truncate">📎 {pg.file.name}</span>
                  <select value={pg.kind} onChange={(e) => setPageKind(i, e.target.value)}
                    className="border rounded px-2 py-1 text-xs">
                    {PCN_DOC_KINDS.map((k) => <option key={k} value={k}>{PCN_DOC_KIND_LABEL[k]}</option>)}
                  </select>
                  <button onClick={() => removePage(i)} className="text-xs text-slate-400 hover:text-red-600">remove</button>
                </div>
              ))}
              <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                <button onClick={() => fileRef.current?.click()} className="text-xs text-[#7B5EA7] hover:underline">+ Add another page</button>
                <button onClick={extract} disabled={extracting}
                  className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#6a5092] disabled:opacity-50">
                  {extracting ? 'Extracting…' : '✨ Extract Data'}
                </button>
              </div>
            </div>
          )}
        </div>

        {extractError && <p className="text-sm text-amber-700 mt-2">{extractError}</p>}

        {!showForm && (
          <p className="text-center text-sm text-slate-400 mt-3">
            or <button onClick={() => setShowForm(true)} className="text-[#7B5EA7] hover:underline">enter details manually</button>
          </p>
        )}

        {/* Step 2 — Review / correct / fill */}
        {showForm && (
          <>
            {confidence && (
              <div className={`mt-3 text-sm rounded-lg px-3 py-2 ${
                confidence === 'high' ? 'bg-green-50 text-green-800'
                : confidence === 'medium' ? 'bg-amber-50 text-amber-800'
                : 'bg-red-50 text-red-800'}`}>
                Extracted with <strong>{confidence}</strong> confidence — please check the fields below before saving.
              </div>
            )}

            {dupes.length > 0 && (
              <div className="mt-3 text-sm rounded-lg px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200">
                ⚠ A PCN with this reference is already logged
                {dupes.slice(0, 3).map((d) => (
                  <span key={d.id}>
                    {' '}— <Link to={`/vehicles/pcns/${d.id}`} target="_blank" className="underline font-medium">
                      {PCN_STATUS_LABEL[d.status] || d.status}, {fmtDate(d.created_at)}
                    </Link>
                  </span>
                ))}
                . You can still log it (non-blocking).
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <label className="text-sm">Reference
                <input className={input} value={form.reference} onChange={(e) => set('reference', e.target.value)} />
              </label>
              <label className="text-sm">Type
                <select className={input} value={form.fine_type} onChange={(e) => set('fine_type', e.target.value)}>
                  {Object.entries(FINE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="text-sm">Vehicle reg
                <input className={input} value={form.vehicle_reg} onChange={(e) => set('vehicle_reg', e.target.value)} />
              </label>
              <label className="text-sm">Issuing authority
                <input className={input} value={form.issuing_authority} onChange={(e) => set('issuing_authority', e.target.value)} />
              </label>
              <label className="text-sm">Offence date
                <input type="date" className={input} value={form.offence_date} onChange={(e) => set('offence_date', e.target.value)} />
              </label>
              <label className="text-sm">Offence time
                <input type="time" className={input} value={form.offence_time} onChange={(e) => set('offence_time', e.target.value)} />
              </label>
              <label className="text-sm">PCN issued date
                <input type="date" className={input} value={form.issued_date} onChange={(e) => set('issued_date', e.target.value)} />
              </label>
              <label className="text-sm">Location
                <input className={input} value={form.location} onChange={(e) => set('location', e.target.value)} />
              </label>
              <label className="text-sm">Fine amount (£)
                <input type="number" className={input} value={form.fine_amount} onChange={(e) => set('fine_amount', e.target.value)} />
              </label>
              <label className="text-sm">Reduced amount (£)
                <input type="number" className={input} value={form.reduced_amount} onChange={(e) => set('reduced_amount', e.target.value)} />
              </label>
              <label className="text-sm">Reduced deadline
                <input type="date" className={input} value={form.reduced_deadline} onChange={(e) => set('reduced_deadline', e.target.value)} />
              </label>
              <label className="text-sm">Final deadline
                <input type="date" className={input} value={form.final_deadline} onChange={(e) => set('final_deadline', e.target.value)} />
              </label>
            </div>

            <label className="text-sm block mt-3">Notes
              <textarea className={`${input} resize-y min-h-[60px]`} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>

            {/* Driver matching */}
            <div className="mt-4 border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Driver match</span>
                <button onClick={findDriver} disabled={matching}
                  className="text-sm border rounded-lg px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50">
                  {matching ? 'Matching…' : '🔍 Find driver from hire data'}
                </button>
              </div>
              {matches !== null && (
                <div className="mt-2 space-y-1">
                  {matches.length === 0 && (
                    <p className="text-sm text-amber-700">No hire matched this reg + time. Save as-is and triage manually.</p>
                  )}
                  {matches.map((m) => (
                    <label key={m.assignment_id}
                      className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 cursor-pointer ${picked?.assignment_id === m.assignment_id ? 'border-[#7B5EA7] bg-purple-50' : ''}`}>
                      <input type="radio" name="driver" checked={picked?.assignment_id === m.assignment_id}
                        onChange={() => setPicked(m)} />
                      <span>
                        <strong>{m.driver_name || '(no driver on row)'}</strong>
                        {m.client_organisation_name ? ` · ${m.client_organisation_name}` : ''}
                        {m.hh_job_number ? ` · job #${m.hh_job_number}` : ''}
                      </span>
                    </label>
                  ))}
                  {matches.length > 0 && (
                    <button onClick={() => setPicked(null)} className="text-xs text-slate-500 hover:underline">
                      Clear selection (log without a driver)
                    </button>
                  )}
                </div>
              )}

              {/* Crew / transport context — V&D + D&C runs rarely record a reg,
                  so this helps decipher who had the van that day. Read-only. */}
              {matches !== null && crewCandidates.length > 0 && (
                <div className="mt-3 bg-slate-50 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-slate-600 mb-1">
                    Crew / transport on this date {matches.length === 0 ? '(no self-drive hire matched — was this a van & driver / D&C run?)' : ''}
                  </p>
                  <ul className="space-y-0.5">
                    {crewCandidates.map((c) => (
                      <li key={c.person_id + (c.hh_job_number || '')} className="text-xs text-slate-600">
                        <strong>{c.person_name || 'Unknown'}</strong>
                        <span className="text-slate-400"> — {c.role} · {c.job_type}</span>
                        {c.hh_job_number ? ` · job #${c.hh_job_number}` : ''}
                        {c.is_freelancer ? <span className="ml-1 text-[10px] uppercase text-amber-600">freelancer</span> : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-slate-400 mt-1">For reference — pick "Internal — Freelancer" on the next step if one of these was driving.</p>
                </div>
              )}
            </div>
          </>
        )}

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving || !showForm}
            className="px-4 py-2 text-sm rounded-lg bg-[#7B5EA7] text-white hover:bg-[#6a5092] disabled:opacity-50">
            {saving ? 'Saving…' : 'Save PCN'}
          </button>
        </div>
      </div>
    </div>
  );
}
