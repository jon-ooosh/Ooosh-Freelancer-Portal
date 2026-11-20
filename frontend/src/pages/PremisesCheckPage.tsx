/**
 * One premises check — what it is, its history, and recording it
 * (docs/PREMISES-COMPLIANCE-SPEC.md §2). Keyed by its id (frontend.md
 * "Detail pages"): nothing carries over from one check to the next.
 *
 * Anyone who can see the check can record it and add a file to a record;
 * changing, retiring and removing are manager-tier (the server decides —
 * these buttons are a convenience only).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { openR2Key } from '../lib/openAuthedFile';
import CheckFormModal from '../components/premises/CheckFormModal';
import RecordModal, { uploadRecordFiles } from '../components/premises/RecordModal';
import PastRecordsModal from '../components/premises/PastRecordsModal';
import UsageChart from '../components/premises/UsageChart';
import LinkCostModal from '../components/premises/LinkCostModal';
import {
  KIND_LABEL, OUTCOME_CLASS, OUTCOME_LABEL, PremisesCheck, PremisesMeta, PremisesRecord, TEST_OUTCOME_LABEL,
  VISIBILITY_LABEL, advisoryDone, fmtDate, fmtMoney, fmtNumber, statusPill,
} from '../components/premises/premisesCopy';

export default function PremisesCheckPage() {
  const { id } = useParams<{ id: string }>();
  return <PremisesCheckContent key={id} id={id ?? ''} />;
}

function PremisesCheckContent({ id }: { id: string }) {
  const navigate = useNavigate();
  const [check, setCheck] = useState<PremisesCheck | null>(null);
  const [meta, setMeta] = useState<PremisesMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [filingPast, setFilingPast] = useState(false);
  const [linkingRecord, setLinkingRecord] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<{ data: PremisesCheck }>(`/premises/checks/${id}`);
    setCheck(res.data);
  }, [id]);

  useEffect(() => {
    Promise.all([load(), api.get<{ data: PremisesMeta }>('/premises/meta').then(r => setMeta(r.data))])
      .catch(err => {
        if ((err as { status?: number }).status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : 'Could not load this check');
      })
      .finally(() => setLoading(false));
  }, [load]);

  async function act(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (err) { setError(err instanceof Error ? err.message : fallback); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-6 text-sm text-gray-500">Loading…</div>;
  if (notFound || !check) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <p className="text-sm text-gray-700 mb-3">{error ?? 'This check doesn’t exist, or you can’t see it.'}</p>
        <Link to="/operations/premises" className="text-sm text-ooosh-600 hover:underline">Go to Premises &amp; compliance</Link>
      </div>
    );
  }

  const canManage = !!meta?.can.manage;
  const pill = statusPill(check);
  const retired = !!check.retired_at;

  function retire() {
    const reason = window.prompt(`Retire “${check!.title}”? It comes off the register and stops reminding anyone. Its records and certificates are kept. Why (optional)?`);
    if (reason === null) return;
    void act(() => api.post(`/premises/checks/${id}/retire`, { reason: reason.trim() || null }), 'Could not retire it');
  }
  function remove() {
    if (!window.confirm(`Delete “${check!.title}”? Only for a check added by mistake — nothing has been recorded on it.`)) return;
    setBusy(true);
    api.delete(`/premises/checks/${id}`)
      .then(() => navigate('/operations/premises'))
      .catch(err => { setError(err instanceof Error ? err.message : 'Could not delete it'); setBusy(false); });
  }

  const dueLine = check.next_due
    ? `${fmtDate(check.next_due)}${check.next_due_source === 'certificate' ? ' (from the certificate)' : check.next_due_source === 'typed' ? ' (set by hand)' : ''}`
    : 'Not set — it fills in when it’s first recorded';
  const remindLine = check.remind_days_before === 0 ? 'On the day it’s due' : `${check.remind_days_before} days before it’s due`;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="text-xs text-gray-500 mb-1">
        <Link to="/operations/premises" className="hover:underline">Premises &amp; compliance</Link> · {check.heading_name} · {check.place_name}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{check.title}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${pill.cls}`}>{pill.text}</span>
            <span className="text-xs text-gray-500">{KIND_LABEL[check.kind]}</span>
            {check.visibility !== 'all' && (
              <span className="text-[11px] text-gray-500 border border-gray-200 rounded px-1 whitespace-nowrap">{VISIBILITY_LABEL[check.visibility]}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && !retired && (
            <>
              <button type="button" disabled={busy} onClick={() => setEditing(true)}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">Change</button>
              <button type="button" disabled={busy} onClick={retire}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">Retire</button>
            </>
          )}
          {canManage && retired && (
            <button type="button" disabled={busy} onClick={() => void act(() => api.post(`/premises/checks/${id}/unretire`, {}), 'Could not bring it back')}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">Bring it back</button>
          )}
          {canManage && (check.records?.length ?? 0) === 0 && (
            <button type="button" disabled={busy} onClick={remove}
              className="px-3 py-1.5 text-sm rounded border border-red-200 text-red-700 bg-white hover:bg-red-50 disabled:opacity-40">Delete</button>
          )}
          {!retired && (
            <button type="button" disabled={busy} onClick={() => setFilingPast(true)}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">Add past records</button>
          )}
          {!retired && (
            <button type="button" disabled={busy} onClick={() => setRecording(true)}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
              {check.kind === 'renewal' ? 'Record the renewal' : check.kind === 'test' ? 'Record the test'
                : check.kind === 'reading' ? 'Enter a reading' : 'Record a visit'}
            </button>
          )}
        </div>
      </div>

      {retired && (
        <div className="mb-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
          Retired {fmtDate(String(check.retired_at).slice(0, 10))}{check.retired_reason ? ` — ${check.retired_reason}` : ''}. Off the register and no reminders; its history is kept.
        </div>
      )}
      {error && <p className="text-sm text-red-700 mb-4">{error}</p>}

      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-start">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">About this check</h2>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-gray-500">How often</dt><dd>{check.repeat_text}</dd>
            <dt className="text-gray-500">Next due</dt><dd>{dueLine}</dd>
            <dt className="text-gray-500">Looks after it</dt>
            <dd>{check.owner_name ?? <span className="text-amber-700">Nobody yet — no reminders until someone does</span>}</dd>
            <dt className="text-gray-500">Reminder</dt>
            <dd>
              {check.owner_name ? `A To Do for ${check.owner_name}, ${remindLine.toLowerCase()}` : remindLine}
              {check.open_reminder && <span className="block text-xs text-gray-500">Open now{check.open_reminder.due_date ? `, due ${fmtDate(check.open_reminder.due_date)}` : ''}</span>}
            </dd>
            <dt className="text-gray-500">Whose job</dt>
            <dd>{check.responsibility === 'landlord' ? 'The landlord’s — we keep the copy' : 'Ours'}</dd>
            {check.contractor_org_id && (
              <>
                <dt className="text-gray-500">Contractor</dt>
                <dd><Link to={`/organisations/${check.contractor_org_id}`} className="text-ooosh-600 hover:underline">{check.contractor_name}</Link></dd>
              </>
            )}
            {check.location_note && (<><dt className="text-gray-500">Where</dt><dd>{check.location_note}</dd></>)}
            {check.why_note && (<><dt className="text-gray-500">Why we do it</dt><dd>{check.why_note}</dd></>)}
            {check.kind === 'reading' && (
              <>
                <dt className="text-gray-500">Meter</dt>
                <dd>{check.unit ?? '—'}{check.meter_serial ? ` · serial ${check.meter_serial}` : ''}</dd>
              </>
            )}
            {check.kind === 'test' && check.points.length > 0 && (
              <>
                <dt className="text-gray-500">Call points</dt>
                <dd>
                  {check.points.join(' · ')}
                  {check.next_point && <span className="block text-xs text-gray-500">Next in turn: {check.next_point}</span>}
                </dd>
              </>
            )}
            {(check.cost_by_year?.length ?? 0) > 0 && (
              <>
                <dt className="text-gray-500">What it's cost</dt>
                <dd>
                  {check.cost_by_year!.map(y => (
                    <span key={y.year} className="block tabular-nums">{y.year}: {fmtMoney(y.net)} + VAT
                      <span className="text-xs text-gray-500"> · {y.bills} bill{y.bills === 1 ? '' : 's'}</span></span>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-gray-500">Who can see it</dt><dd>{VISIBILITY_LABEL[check.visibility]}</dd>
            {check.notes && (<><dt className="text-gray-500">Notes</dt><dd className="whitespace-pre-wrap">{check.notes}</dd></>)}
          </dl>
          {check.kind === 'reading' && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Use per week</h3>
              <UsageChart usage={check.usage ?? []} unit={check.unit} />
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg">
          <h2 className="text-sm font-semibold text-gray-900 px-4 pt-4 pb-2">History</h2>
          {(check.records?.length ?? 0) === 0 ? (
            <p className="px-4 pb-4 text-sm text-gray-500">Nothing recorded yet. Record the last one done to start the clock.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {check.records!.map(r => (
                <RecordRow key={r.id} record={r} check={check} canManage={canManage} busy={busy}
                  onChanged={() => act(async () => undefined, 'Could not reload')} onError={setError}
                  onLinkCost={() => setLinkingRecord(r.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {editing && meta && (
        <CheckFormModal meta={meta} check={check} onClose={() => setEditing(false)}
          onSaved={saved => { setEditing(false); setCheck(prev => ({ ...prev, ...saved })); }} />
      )}
      {recording && (
        <RecordModal check={check} onClose={() => setRecording(false)}
          onSaved={() => { setRecording(false); void act(async () => undefined, 'Could not reload'); }} />
      )}
      {filingPast && (
        <PastRecordsModal check={check} onClose={() => setFilingPast(false)}
          onSaved={() => { setFilingPast(false); void act(async () => undefined, 'Could not reload'); }} />
      )}
      {linkingRecord && (
        <LinkCostModal checkId={check.id} recordId={linkingRecord} contractorName={check.contractor_name}
          onClose={() => setLinkingRecord(null)}
          onLinked={() => { setLinkingRecord(null); void act(async () => undefined, 'Could not reload'); }} />
      )}
    </div>
  );
}

function RecordRow({ record: r, check, canManage, busy, onChanged, onError, onLinkCost }: {
  record: PremisesRecord;
  check: PremisesCheck;
  canManage: boolean;
  busy: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onLinkCost: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [newAdvisory, setNewAdvisory] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, fallback: string) {
    onError(null);
    try { await fn(); await onChanged(); } catch (err) { onError(err instanceof Error ? err.message : fallback); }
  }
  const outcomeText = r.outcome
    ? (check.kind === 'test' ? TEST_OUTCOME_LABEL[r.outcome] ?? OUTCOME_LABEL[r.outcome] : OUTCOME_LABEL[r.outcome])
    : null;
  // A reading's use since the one before (from the server's series, ending on this date).
  const use = r.reading_value !== null ? (check.usage ?? []).find(u => u.to === r.done_on) : undefined;

  async function addFiles(files: File[]) {
    if (!files.length) return;
    setUploading(true); onError(null);
    const failed = await uploadRecordFiles(r.id, files);
    setUploading(false);
    if (failed.length) onError(`Didn't upload: ${failed.join(', ')}`);
    await onChanged();
  }

  async function removeRecord() {
    const reason = window.prompt('Remove this record? Use it for a mistake. The next due date is left as it is — change it on the check if it needs to move. Why (optional)?');
    if (reason === null) return;
    try { await api.post(`/premises/records/${r.id}/remove`, { reason: reason.trim() || null }); await onChanged(); }
    catch (err) { onError(err instanceof Error ? err.message : 'Could not remove it'); }
  }

  async function removeFile(fileId: string, name: string) {
    if (!window.confirm(`Take “${name}” off this record?`)) return;
    try { await api.post(`/premises/files/${fileId}/archive`, {}); await onChanged(); }
    catch (err) { onError(err instanceof Error ? err.message : 'Could not remove the file'); }
  }

  return (
    <li className="px-4 py-3 grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <div className="text-sm font-semibold text-gray-900">{fmtDate(r.done_on)}</div>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {r.reading_value !== null && (
            <span className="text-sm font-semibold text-gray-900 tabular-nums">
              {fmtNumber(r.reading_value, 3)}{check.unit ? ` ${check.unit}` : ''}
              {use && <span className="ml-1.5 text-xs font-normal text-gray-500">+{fmtNumber(use.used)} since {fmtDate(use.from)}</span>}
            </span>
          )}
          {r.meter_replaced && <span className="text-xs text-amber-700">meter replaced</span>}
          {r.point && <span className="text-xs text-gray-700 border border-gray-200 rounded px-1.5">{r.point}</span>}
          {r.outcome && outcomeText && <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${OUTCOME_CLASS[r.outcome]}`}>{outcomeText}</span>}
          {r.backfilled && <span className="text-xs text-gray-500 border border-gray-200 rounded px-1.5">filed later</span>}
          {r.done_by_org_name && <span className="text-xs text-gray-600">{r.done_by_org_name}</span>}
          {r.recorded_by_name && <span className="text-xs text-gray-400">recorded by {r.recorded_by_name}</span>}
        </div>
        {r.notes && <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.notes}</p>}
        {r.advisories.length > 0 && (
          <ul className="space-y-1">
            {r.advisories.map(a => {
              const done = advisoryDone(a);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="checkbox" checked={done} aria-label={`Done: ${a.text}`}
                    onChange={e => void run(() => api.post(`/premises/advisories/${a.id}/done`, { done: e.target.checked }), 'Could not change it')} />
                  <span className={done ? 'text-gray-400 line-through' : 'text-gray-800'}>{a.text}</span>
                  {a.task_id && a.task_status === 'open' && (
                    <span className="text-xs text-ooosh-700 bg-ooosh-50 rounded px-1.5">To Do for {a.task_owner ?? 'someone'}</span>
                  )}
                  {!done && (!a.task_id || a.task_status === 'cancelled') && (
                    <button type="button" className="text-xs text-ooosh-600 hover:underline"
                      onClick={() => void run(() => api.post(`/premises/advisories/${a.id}/task`, {}), 'Could not make the To Do')}>
                      Make it a To Do
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {newAdvisory !== null && (
          <form className="flex gap-2" onSubmit={e => {
            e.preventDefault();
            const text = newAdvisory.trim();
            if (!text) return;
            void run(async () => { await api.post(`/premises/records/${r.id}/advisories`, { texts: [text] }); setNewAdvisory(null); }, 'Could not add it');
          }}>
            <input autoFocus value={newAdvisory} onChange={e => setNewAdvisory(e.target.value)} maxLength={500}
              placeholder="An advisory from this visit" aria-label="New advisory"
              className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm" />
            <button type="submit" className="px-2 py-1 text-xs rounded bg-ooosh-600 text-white">Add</button>
            <button type="button" onClick={() => setNewAdvisory(null)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
          </form>
        )}
        {r.cost ? (
          <p className="text-xs text-gray-600">
            Bill: <span className="tabular-nums">{fmtMoney(r.cost.amount_net)} + VAT</span>
            {[r.cost.supplier_name, r.cost.invoice_number].filter(Boolean).map(t => ` · ${t}`).join('')}
            <button type="button" className="ml-2 text-gray-400 hover:text-gray-700"
              onClick={() => void run(() => api.post(`/premises/records/${r.id}/cost`, { cost_id: null }), 'Could not unlink it')}>Unlink</button>
          </p>
        ) : r.reading_value === null && (
          <button type="button" onClick={onLinkCost} className="text-xs text-ooosh-600 hover:underline">Link the bill from Costs</button>
        )}
        {r.next_due_set && (
          <p className="text-xs text-gray-500">
            Next due set to {fmtDate(r.next_due_set)}{r.next_due_source === 'certificate' ? ' from the certificate' : ''}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {r.files.map(f => (
            <span key={f.id} className="inline-flex items-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
              <button type="button" className="text-ooosh-600 hover:underline truncate max-w-[220px]"
                onClick={() => void openR2Key(f.r2_key, f.filename).catch(() => onError('Could not open that file'))}>
                {f.filename}
              </button>
              {canManage && (
                <button type="button" className="text-gray-400 hover:text-gray-700" aria-label={`Remove ${f.filename}`}
                  onClick={() => void removeFile(f.id, f.filename)}>×</button>
              )}
            </span>
          ))}
          {check.kind === 'visit' && newAdvisory === null && (
            <button type="button" onClick={() => setNewAdvisory('')} className="text-xs text-ooosh-600 hover:underline">+ Add an advisory</button>
          )}
          <label className={`text-xs text-ooosh-600 hover:underline cursor-pointer ${uploading || busy ? 'opacity-50 pointer-events-none' : ''}`}>
            {uploading ? 'Uploading…' : '+ Add a file'}
            <input type="file" multiple className="hidden" onChange={e => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addFiles(picked);
            }} />
          </label>
          {canManage && (
            <button type="button" onClick={() => void removeRecord()} className="text-xs text-gray-400 hover:text-gray-700 ml-auto">Remove record</button>
          )}
        </div>
      </div>
    </li>
  );
}
