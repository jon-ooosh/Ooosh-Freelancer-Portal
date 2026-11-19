/**
 * Record that a premises check was done — a visit, an in-house test or a
 * renewal (docs/PREMISES-COMPLIANCE-SPEC.md §3).
 *
 * The next due date is the SERVER's (GET /premises/checks/:id/next-due); this
 * form shows it and lets it be changed when the certificate gives another
 * date, in which case that date wins. Certificates are uploaded after the
 * record is saved, one at a time; a file that fails is named and the record
 * stands — it can be added again from the check's page.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import SearchPicker, { PickerOption } from '../SearchPicker';
import {
  OUTCOME_LABEL, Outcome, PremisesCheck, ReadingAssessment, TEST_OUTCOME_LABEL, fmtDate, fmtNumber, readingWarning,
} from './premisesCopy';

async function searchOrgs(q: string): Promise<PickerOption[]> {
  const res = await api.get<{ data: { id: string; name: string; type: string | null }[] }>(
    `/organisations?search=${encodeURIComponent(q)}&limit=10`);
  return (res.data || []).map(o => ({ value: o.id, label: o.name, hint: o.type ?? undefined }));
}

/** Upload files to a record, one by one. Returns the names that failed. */
export async function uploadRecordFiles(recordId: string, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.upload(`/premises/records/${recordId}/files`, fd);
    } catch {
      failed.push(file.name);
    }
  }
  return failed;
}

export default function RecordModal({ check, onClose, onSaved }: {
  check: PremisesCheck;
  onClose: () => void;
  /** Called once the record is saved (files too, or with the ones that failed). */
  onSaved: () => void;
}) {
  const today = ukToday();
  const [doneOn, setDoneOn] = useState(today);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [doneBy, setDoneBy] = useState<PickerOption | null>(
    check.contractor_org_id ? { value: check.contractor_org_id, label: check.contractor_name ?? 'Contractor' } : null);
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{ next_due: string | null; moves: boolean } | null>(null);
  const [nextDue, setNextDue] = useState('');
  const [touchedDue, setTouchedDue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedFiles, setFailedFiles] = useState<string[] | null>(null);
  // A meter reading, and the server's view of it (a warning, never a refusal).
  const [reading, setReading] = useState('');
  const [replaced, setReplaced] = useState(false);
  const [assessment, setAssessment] = useState<ReadingAssessment | null>(null);
  // A rotating test: which call point (the next one along, unless changed).
  const [point, setPoint] = useState(check.next_point ?? '');
  const readingValue = reading.trim() === '' ? null : Number(reading);
  const readingOk = readingValue !== null && Number.isFinite(readingValue);

  useEffect(() => {
    if (check.kind !== 'reading' || !readingOk || !/^\d{4}-\d{2}-\d{2}$/.test(doneOn)) { setAssessment(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ data: ReadingAssessment }>(
        `/premises/checks/${check.id}/reading-check?value=${readingValue}&done_on=${doneOn}&replaced=${replaced ? 1 : 0}`)
        .then(res => { if (live) setAssessment(res.data); })
        .catch(() => { if (live) setAssessment(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [check.id, check.kind, readingOk, readingValue, doneOn, replaced]);

  // Ask the server what the next due date becomes for this done date.
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOn)) return;
    let live = true;
    api.get<{ data: { next_due: string | null; moves: boolean } }>(`/premises/checks/${check.id}/next-due?done_on=${doneOn}`)
      .then(res => {
        if (!live) return;
        setPreview(res.data);
        if (!touchedDue) setNextDue(res.data.next_due ?? '');
      })
      .catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
    // touchedDue is read, not watched: a typed date must survive a done-date change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneOn, check.id]);

  const needsOutcome = check.kind === 'visit' || check.kind === 'test';
  const outcomeChoices: [Outcome, string][] = check.kind === 'test'
    ? Object.entries(TEST_OUTCOME_LABEL) as [Outcome, string][]
    : Object.entries(OUTCOME_LABEL) as [Outcome, string][];
  // A date typed that differs from the rule's is the certificate's — it wins.
  const certificateDate = preview?.moves && nextDue && nextDue !== (preview.next_due ?? '') ? nextDue : null;
  const dueBeforeDone = !!certificateDate && certificateDate <= doneOn;

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await api.post<{ data: { id: string } }>(`/premises/checks/${check.id}/records`, {
        done_on: doneOn,
        outcome: needsOutcome ? outcome : null,
        done_by_org_id: check.kind === 'visit' ? doneBy?.value ?? null : null,
        notes: notes.trim() || null,
        next_due: certificateDate,
        reading_value: check.kind === 'reading' ? readingValue : null,
        meter_replaced: check.kind === 'reading' ? replaced : false,
        point: check.kind === 'test' && point ? point : null,
      });
      const failed = files.length ? await uploadRecordFiles(res.data.id, files) : [];
      if (failed.length) { setFailedFiles(failed); setSaving(false); return; }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record it');
      setSaving(false);
    }
  }

  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const input = 'w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white';
  const dueLabel = check.kind === 'renewal' ? 'Next renewal date' : 'Next due';

  if (failedFiles) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Recorded — but some files didn't upload</h3>
          <p className="text-sm text-gray-700">The record is saved. These didn't make it:</p>
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
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {check.kind === 'renewal' ? 'Record the renewal' : check.kind === 'test' ? 'Record the test'
            : check.kind === 'reading' ? 'Enter the reading' : 'Record a visit'}
        </h3>
        <p className="text-sm text-gray-500 mb-4">{check.title}</p>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="pr-done">{check.kind === 'renewal' ? 'Renewed on' : 'Done on'}</label>
              <input id="pr-done" type="date" max={today} value={doneOn} onChange={e => setDoneOn(e.target.value)} className={input} />
            </div>
            {check.kind === 'visit' && (
              <div>
                <span className={label}>Done by</span>
                <SearchPicker value={doneBy} onChange={setDoneBy} loadOptions={searchOrgs} minChars={2} placeholder="Search the address book…" />
              </div>
            )}
          </div>

          {check.kind === 'reading' && (
            <div>
              <label className={label} htmlFor="pr-reading">Reading{check.unit ? ` (${check.unit})` : ''}</label>
              <input id="pr-reading" inputMode="decimal" value={reading} onChange={e => setReading(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="As it shows on the meter" className={`${input} text-lg tabular-nums tracking-wide`} autoFocus />
              {assessment?.previous && !assessment.flag && assessment.used !== null && (
                <p className="text-xs text-gray-500 mt-1">
                  {fmtNumber(assessment.used)}{check.unit ? ` ${check.unit}` : ''} since {fmtDate(assessment.previous.done_on)}
                </p>
              )}
              {readingWarning(assessment, check.unit) && (
                <p className="text-xs mt-1 rounded bg-amber-50 text-amber-800 px-2 py-1.5">{readingWarning(assessment, check.unit)}</p>
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 mt-2">
                <input type="checkbox" checked={replaced} onChange={e => setReplaced(e.target.checked)} />
                The meter was replaced (its count starts again)
              </label>
            </div>
          )}

          {check.kind === 'test' && check.points.length > 0 && (
            <div>
              <label className={label} htmlFor="pr-point">Call point tested</label>
              <select id="pr-point" value={point} onChange={e => setPoint(e.target.value)} className={input}>
                {point && !check.points.includes(point) && <option value={point}>{point}</option>}
                {check.points.map(p => <option key={p} value={p}>{p}{p === check.next_point ? ' (next in turn)' : ''}</option>)}
              </select>
            </div>
          )}

          {needsOutcome && (
            <div>
              <span className={label}>How did it go</span>
              <div className="flex flex-wrap gap-2">
                {outcomeChoices.map(([value, text]) => (
                  <button key={value} type="button" onClick={() => setOutcome(value)}
                    className={`px-3 py-1.5 rounded border text-sm ${outcome === value
                      ? (value === 'fail' ? 'border-red-600 bg-red-50 text-red-800' : 'border-ooosh-600 bg-ooosh-50 text-ooosh-700')
                      : 'border-gray-300 hover:bg-gray-50'}`}>
                    {text}
                  </button>
                ))}
              </div>
              {outcome === 'fail' && (
                <p className="text-xs text-red-700 mt-1">A To Do to get it fixed goes to {check.owner_name ?? 'you'} straight away.</p>
              )}
            </div>
          )}

          {check.kind !== 'test' && (
            <div>
              <label className={label} htmlFor="pr-files">
                {check.kind === 'renewal' ? 'Policy, schedule or certificate' : check.kind === 'reading' ? 'Photo of the meter' : 'Certificate or report'}
              </label>
              <input id="pr-files" type="file" multiple accept={check.kind === 'reading' ? 'image/*' : undefined}
                onChange={e => {
                  // Capture before resetting (frontend.md "File inputs").
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  setFiles(prev => [...prev, ...picked]);
                }}
                className="block w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-gray-100 file:text-gray-700" />
              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((file, i) => (
                    <li key={`${file.name}-${i}`} className="flex items-center justify-between text-sm bg-gray-50 rounded px-2 py-1">
                      <span className="truncate">{file.name}</span>
                      <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-gray-700 ml-2" aria-label={`Remove ${file.name}`}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {preview && !preview.moves && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded px-3 py-2">
              This is older than the latest record, so it goes into the history and doesn't change when it's next due.
            </p>
          )}
          {preview?.moves && (
            <div>
              <label className={label} htmlFor="pr-next">{dueLabel}</label>
              <input id="pr-next" type="date" value={nextDue}
                onChange={e => { setNextDue(e.target.value); setTouchedDue(true); }} className={input} />
              <p className="text-xs text-gray-500 mt-1">
                {certificateDate
                  ? 'Taken from the certificate — this date wins.'
                  : preview.next_due
                    ? `Worked out from "${check.repeat_text}". Change it if the certificate gives a different date.`
                    : 'Nothing further is due unless you give a date.'}
              </p>
              {dueBeforeDone && <p className="text-xs text-red-700 mt-1">The next due date must be after {fmtDate(doneOn)}.</p>}
            </div>
          )}

          <div>
            <label className={label} htmlFor="pr-notes">{check.kind === 'visit' ? 'Notes or advisories' : 'Notes'}</label>
            <textarea id="pr-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} maxLength={4000}
              placeholder={check.kind === 'visit' ? 'Anything the engineer flagged…' : ''} className={input} />
          </div>
        </div>

        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()}
            disabled={saving || !doneOn || doneOn > today || (needsOutcome && !outcome) || dueBeforeDone
              || (check.kind === 'reading' && !readingOk)}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? (files.length ? 'Saving and uploading…' : 'Saving…') : 'Record it'}
          </button>
        </div>
      </div>
    </div>
  );
}
