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
import { OUTCOME_LABEL, Outcome, PremisesCheck, TEST_OUTCOME_LABEL, fmtDate } from './premisesCopy';

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
          {check.kind === 'renewal' ? 'Record the renewal' : check.kind === 'test' ? 'Record the test' : 'Record a visit'}
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
              <label className={label} htmlFor="pr-files">{check.kind === 'renewal' ? 'Policy, schedule or certificate' : 'Certificate or report'}</label>
              <input id="pr-files" type="file" multiple
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
            disabled={saving || !doneOn || doneOn > today || (needsOutcome && !outcome) || dueBeforeDone}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? (files.length ? 'Saving and uploading…' : 'Saving…') : 'Record it'}
          </button>
        </div>
      </div>
    </div>
  );
}
