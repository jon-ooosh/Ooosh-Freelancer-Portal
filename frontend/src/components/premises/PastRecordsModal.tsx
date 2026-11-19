/**
 * Add past records — old certificates filed later (docs/PREMISES-COMPLIANCE-SPEC.md §14).
 *
 * jon, 19 Nov 2026: "I'd like to backfill historical certs since I have them
 * scattered in various locations". Several at once, in any order. The server
 * (POST /premises/checks/:id/history) saves them together: they never make a
 * "Get it fixed" To Do, and the due date moves once, from the newest — and only
 * if it is newer than anything already recorded. Files go up after, per record.
 */
import { useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import { uploadRecordFiles } from './RecordModal';
import { OUTCOME_LABEL, Outcome, PremisesCheck, TEST_OUTCOME_LABEL } from './premisesCopy';

interface Row {
  key: number;
  done_on: string;
  outcome: Outcome | '';
  reading: string;
  notes: string;
  files: File[];
}

let nextKey = 1;
const blankRow = (): Row => ({ key: nextKey++, done_on: '', outcome: '', reading: '', notes: '', files: [] });

export default function PastRecordsModal({ check, onClose, onSaved }: {
  check: PremisesCheck;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = ukToday();
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedFiles, setFailedFiles] = useState<string[] | null>(null);

  const isReading = check.kind === 'reading';
  const hasOutcome = check.kind === 'visit' || check.kind === 'test';
  const outcomeChoices = (check.kind === 'test' ? Object.entries(TEST_OUTCOME_LABEL) : Object.entries(OUTCOME_LABEL)) as [Outcome, string][];

  const setRow = (key: number, patch: Partial<Row>) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const filled = rows.filter(r => r.done_on);
  const rowProblem = (r: Row): string | null => {
    if (!r.done_on) return null;
    if (r.done_on > today) return 'That date is in the future';
    if (isReading && (r.reading.trim() === '' || !Number.isFinite(Number(r.reading)))) return 'Type the reading';
    return null;
  };
  const problems = filled.map(rowProblem).filter(Boolean);

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await api.post<{ data: { ids: string[] } }>(`/premises/checks/${check.id}/history`, {
        records: filled.map(r => ({
          done_on: r.done_on,
          outcome: hasOutcome && r.outcome ? r.outcome : null,
          notes: r.notes.trim() || null,
          reading_value: isReading ? Number(r.reading) : null,
        })),
      });
      const failed: string[] = [];
      for (let i = 0; i < filled.length; i++) {
        if (filled[i].files.length) failed.push(...await uploadRecordFiles(res.data.ids[i], filled[i].files));
      }
      if (failed.length) { setFailedFiles(failed); setSaving(false); return; }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save them');
      setSaving(false);
    }
  }

  const input = 'w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white';

  if (failedFiles) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Saved — but some files didn't upload</h3>
          <p className="text-sm text-gray-700">The records are in. These didn't make it:</p>
          <ul className="list-disc ml-5 my-2 text-sm text-red-700">{failedFiles.map(n => <li key={n}>{n}</li>)}</ul>
          <p className="text-sm text-gray-700">Add them again with "+ Add a file" on the record.</p>
          <div className="flex justify-end mt-4">
            <button type="button" onClick={onSaved} className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">OK</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Add past records</h3>
        <p className="text-sm text-gray-500 mb-1">{check.title}</p>
        <p className="text-xs text-gray-500 mb-4">
          Old certificates, in any order. They go into the history as "filed later". They never start a "get it fixed"
          To Do, and the next due date is worked out once, from the newest — only if it's newer than anything already
          recorded.
        </p>

        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={r.key} className="rounded border border-gray-200 p-3 space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-gray-600">
                  <span className="block mb-1 font-medium">{check.kind === 'renewal' ? 'Renewed on' : 'Done on'}</span>
                  <input type="date" max={today} value={r.done_on} onChange={e => setRow(r.key, { done_on: e.target.value })}
                    className={input} aria-label={`Date of record ${i + 1}`} />
                </label>
                {isReading && (
                  <label className="text-xs text-gray-600">
                    <span className="block mb-1 font-medium">Reading{check.unit ? ` (${check.unit})` : ''}</span>
                    <input inputMode="decimal" value={r.reading} onChange={e => setRow(r.key, { reading: e.target.value.replace(/[^0-9.]/g, '') })}
                      className={`${input} w-36 tabular-nums`} aria-label={`Reading ${i + 1}`} />
                  </label>
                )}
                {hasOutcome && (
                  <label className="text-xs text-gray-600">
                    <span className="block mb-1 font-medium">How it went (optional)</span>
                    <select value={r.outcome} onChange={e => setRow(r.key, { outcome: e.target.value as Outcome | '' })}
                      className={input} aria-label={`Outcome ${i + 1}`}>
                      <option value="">Not known</option>
                      {outcomeChoices.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </label>
                )}
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(prev => prev.filter(x => x.key !== r.key))}
                    className="ml-auto text-xs text-gray-400 hover:text-gray-700">Remove</button>
                )}
              </div>
              <input value={r.notes} onChange={e => setRow(r.key, { notes: e.target.value })} maxLength={4000}
                placeholder="Notes (optional)" className={input} aria-label={`Notes ${i + 1}`} />
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-ooosh-600 hover:underline cursor-pointer">
                  + {isReading ? 'Photo' : 'Certificate or file'}
                  <input type="file" multiple className="hidden" onChange={e => {
                    const picked = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    setRow(r.key, { files: [...r.files, ...picked] });
                  }} />
                </label>
                {r.files.map((f, j) => (
                  <span key={`${f.name}-${j}`} className="inline-flex items-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
                    <span className="truncate max-w-[200px]">{f.name}</span>
                    <button type="button" onClick={() => setRow(r.key, { files: r.files.filter((_, k) => k !== j) })}
                      className="text-gray-400 hover:text-gray-700" aria-label={`Remove ${f.name}`}>×</button>
                  </span>
                ))}
              </div>
              {rowProblem(r) && <p className="text-xs text-red-700">{rowProblem(r)}</p>}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setRows(prev => [...prev, blankRow()])}
          className="mt-3 text-sm text-ooosh-600 hover:underline">+ Another one</button>

        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || filled.length === 0 || problems.length > 0}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : filled.length > 1 ? `Save ${filled.length} records` : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
