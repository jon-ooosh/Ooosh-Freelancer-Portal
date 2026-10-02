import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

/**
 * Import 2026 history from BrightHR — admin only.
 *
 * Staff went live in October 2026 rather than on 1 January, so the year's
 * holiday, overtime and time off have to be in OP for real (STAFF-CALENDAR-SPEC
 * §18). This page takes the CSV transcribed from BrightHR, PREVIEWS what every
 * row would do without writing anything, and only on Confirm writes it — as
 * ordinary approved records, priced from each person's own pattern, with no
 * emails or bells. The summary puts OP's resulting figures beside what
 * BrightHR says so a difference is seen and decided, never absorbed silently.
 *
 * Re-running is safe: rows already in are skipped, so fix a bad row and go again.
 */

type Kind = 'holiday' | 'toil_taken' | 'unpaid' | 'overtime_earned' | 'toil_paid';
interface Row {
  person: string; kind: Kind; status: 'approved' | 'pending';
  date: string; endDate: string | null; startTime: string | null; endTime: string | null;
  minutes: number | null; note: string | null;
}
interface RowResult {
  index: number; person: string; kind: Kind; date: string;
  outcome: 'ok' | 'skip' | 'error'; message: string;
  holidayMinutes: number; overtimeMinutes: number;
}
interface PersonSummary {
  personId: string; name: string;
  holidayNow: number; overtimeNow: number; holidayAfter: number; overtimeAfter: number;
  nominalDayMinutes: number | null;
}
interface Result { results: RowResult[]; people: PersonSummary[] }

const KINDS: Kind[] = ['holiday', 'toil_taken', 'unpaid', 'overtime_earned', 'toil_paid'];
const KIND_LABEL: Record<Kind, string> = {
  holiday: 'Holiday', toil_taken: 'Overtime taken as time off', unpaid: 'Unpaid',
  overtime_earned: 'Overtime earned', toil_paid: 'Overtime paid out',
};

/** RFC-4180-ish: quoted fields, commas and doubled quotes inside them. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) out.push(row);
  return out;
}

/** CSV → rows the API accepts, or a list of what is wrong with it. */
function toRows(text: string): { rows: Row[]; problems: string[] } {
  const grid = parseCsv(text.trim());
  if (grid.length < 2) return { rows: [], problems: ['Paste the CSV including its header row.'] };
  const head = grid[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const need = ['person', 'kind', 'status', 'date', 'end_date', 'start_time', 'end_time', 'minutes', 'note'];
  const missing = need.filter(n => col(n) < 0);
  if (missing.length) return { rows: [], problems: [`Missing column(s): ${missing.join(', ')}`] };

  const rows: Row[] = [], problems: string[] = [];
  grid.slice(1).forEach((g, i) => {
    const v = (n: string) => (g[col(n)] ?? '').trim();
    const kind = v('kind') as Kind;
    const status = v('status') as Row['status'];
    if (!KINDS.includes(kind)) { problems.push(`Line ${i + 2}: kind "${v('kind')}" is not one of ${KINDS.join(', ')}`); return; }
    if (status !== 'approved' && status !== 'pending') { problems.push(`Line ${i + 2}: status must be approved or pending`); return; }
    // "2 days" in the minutes column is BrightHR's count for time off — OP
    // prices the days itself, so only a plain number is kept.
    const m = v('minutes');
    rows.push({
      person: v('person'), kind, status,
      date: v('date'), endDate: v('end_date') || null,
      startTime: v('start_time') || null, endTime: v('end_time') || null,
      minutes: /^\d+$/.test(m) ? Number(m) : null,
      note: v('note') || null,
    });
  });
  return { rows, problems };
}

function fmtH(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}
const days = (min: number, nominal: number | null) =>
  nominal && nominal > 0 ? ` (${(min / nominal).toFixed(1)} days)` : '';

export default function StaffHistoryImportPage() {
  const role = useAuthStore(s => s.user?.role);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => toRows(text), [text]);

  if (role !== 'admin') {
    return <div className="p-6 text-sm text-gray-600">Admins only.</div>;
  }

  async function run(commit: boolean) {
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: Result }>('/staff-calendar/history-import', { rows: parsed.rows, commit });
      if (commit) { setDone(res.data); setPreview(null); } else { setPreview(res.data); setDone(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally { setBusy(false); }
  }

  const shown = done ?? preview;
  const counts = shown ? {
    ok: shown.results.filter(r => r.outcome === 'ok').length,
    skip: shown.results.filter(r => r.outcome === 'skip').length,
    error: shown.results.filter(r => r.outcome === 'error').length,
  } : null;

  return (
    <div className="max-w-6xl flex flex-col gap-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">Import 2026 history from BrightHR</h1>
          <Link to="/staff/admin" className="text-sm text-ooosh-600 hover:underline">← Staff</Link>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Paste the CSV, check the preview, then confirm. Nothing is written until you do, nobody is
          emailed, and running it again skips what is already in.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-ooosh-600 hover:underline cursor-pointer">
            Choose a CSV file…
            <input type="file" accept=".csv,text/csv" className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void f.text().then(t => { setText(t); setPreview(null); setDone(null); });
              }} />
          </label>
          <span className="text-xs text-gray-400">or paste it below</span>
        </div>
        <textarea value={text} onChange={e => { setText(e.target.value); setPreview(null); setDone(null); }}
          rows={8} spellCheck={false}
          placeholder="person,kind,status,date,end_date,start_time,end_time,minutes,note"
          className="w-full font-mono text-xs px-3 py-2 border border-gray-300 rounded-lg" />
        {parsed.problems.length > 0 && text.trim() && (
          <ul className="text-sm text-red-700 list-disc pl-5">
            {parsed.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy || parsed.rows.length === 0} onClick={() => void run(false)}
            className="px-4 py-2 rounded-lg bg-ooosh-600 hover:bg-ooosh-700 text-white text-sm font-semibold disabled:bg-slate-300">
            {busy && !preview ? 'Checking…' : `Preview ${parsed.rows.length || ''} row${parsed.rows.length === 1 ? '' : 's'}`}
          </button>
          {preview && counts && counts.ok > 0 && (
            <button disabled={busy}
              onClick={() => {
                if (confirm(`Write ${counts.ok} row${counts.ok === 1 ? '' : 's'} into OP? ${counts.error ? `${counts.error} with problems will be left out.` : ''}`)) void run(true);
              }}
              className="px-4 py-2 rounded-lg border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm font-semibold">
              {busy ? 'Importing…' : `Confirm — import ${counts.ok}`}
            </button>
          )}
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      {shown && counts && (
        <>
          <div className={`p-3 rounded-lg border text-sm ${done ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-ooosh-50 border-ooosh-200 text-ooosh-800'}`}>
            {done ? 'Imported.' : 'Preview — nothing written yet.'}{' '}
            {counts.ok} {done ? 'written' : 'ready'} · {counts.skip} already in · {counts.error} with problems
          </div>

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="text-[17px] font-semibold text-gray-900">Per person</h2>
              <p className="text-[13px] text-gray-500">
                Check &ldquo;after&rdquo; against BrightHR&apos;s own figures. A difference is fixed on the
                Staff page with a labelled adjustment — never silently here.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-[.06em] text-gray-500">
                <tr>
                  <th className="text-left px-5 py-2">Person</th>
                  <th className="text-right px-3 py-2">Holiday left now</th>
                  <th className="text-right px-3 py-2">{done ? 'Holiday left' : 'After import'}</th>
                  <th className="text-right px-3 py-2">Overtime bank now</th>
                  <th className="text-right px-5 py-2">{done ? 'Overtime bank' : 'After import'}</th>
                </tr>
              </thead>
              <tbody>
                {shown.people.map(p => (
                  <tr key={p.personId} className="border-t border-gray-100">
                    <td className="px-5 py-2.5">
                      <Link to={`/staff/admin?person=${p.personId}&tab=employment`} className="text-ooosh-600 hover:underline">{p.name}</Link>
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-500">{fmtH(p.holidayNow)}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums font-semibold">{fmtH(p.holidayAfter)}{days(p.holidayAfter, p.nominalDayMinutes)}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-500">{fmtH(p.overtimeNow)}</td>
                    <td className="text-right px-5 py-2.5 tabular-nums font-semibold">{fmtH(p.overtimeAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="text-[17px] font-semibold text-gray-900">Every row</h2>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-[.06em] text-gray-500">
                <tr>
                  <th className="text-left px-5 py-2">Line</th>
                  <th className="text-left px-3 py-2">Person</th>
                  <th className="text-left px-3 py-2">What</th>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-5 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {shown.results.map(r => (
                  <tr key={r.index} className={`border-t border-gray-100 ${r.outcome === 'error' ? 'bg-red-50' : ''}`}>
                    <td className="px-5 py-2 text-gray-400 tabular-nums">{r.index + 2}</td>
                    <td className="px-3 py-2">{r.person}</td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind]}</td>
                    <td className="px-3 py-2 tabular-nums whitespace-nowrap">{r.date}</td>
                    <td className="px-5 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full mr-2 ${
                        r.outcome === 'ok' ? 'bg-emerald-100 text-emerald-800'
                          : r.outcome === 'skip' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-800'}`}>
                        {r.outcome === 'ok' ? (done ? 'Imported' : 'Ready') : r.outcome === 'skip' ? 'Already in' : 'Problem'}
                      </span>
                      <span className="text-gray-700">{r.message}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
