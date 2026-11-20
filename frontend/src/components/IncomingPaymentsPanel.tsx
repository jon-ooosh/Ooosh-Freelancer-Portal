/**
 * Incoming bank payments (Wise) — the queue of transfers OP couldn't match on its own,
 * plus the last month of what it recorded or ignored. Lives on the Money overview.
 *
 * Resolving a row = pick the job (HireHop number) and whether it is hire money or the
 * excess; the backend then records it through the same path as "Record Payment"
 * (OP row, HireHop deposit on the Wise bank, client email). "Not a job payment" marks
 * it ignored with a note - nothing is deleted. Deep link: /money/overview?incoming=<id>.
 *
 * If the same money is already on the job (someone recorded it from the Money tab),
 * Record is refused with a 409 and the row offers "Link to that payment" (nothing is
 * recorded again) or "Record anyway" for a genuine second payment of the same amount.
 *
 * Payments come from the Wise API (every 5 minutes) and Wise's "Money received"
 * emails (the backup); `source` says which saw it first. "Add a Wise transfer by
 * number" brings in one that neither caught — it waits here, never recorded on its
 * own (services/wise-api-incoming.ts). The panel shows for anyone the list loads for
 * (admin + managers), even with nothing waiting, so that box is always there.
 *
 * "Split across jobs": one transfer paying several jobs (services/incoming-split.ts).
 * Lines must add up to the penny; each records like Record, or LINKS to a payment
 * someone already recorded by hand (the 409 names it per line). Once part of a
 * transfer is split, only the split can finish it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

interface Candidate {
  job_id: string;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
  via: string;
  expected?: { deposit: number; half: number; remaining: number; excess: number; invoice?: number };
}

/** A payment already on the job that looks like this transfer (409 from Record). */
interface ExistingPayment {
  id: string;
  amount: number;
  payment_type: string;
  payment_date: string;
  hirehop_deposit_id: number | null;
  recorded_by_name: string | null;
}

/** One line of a transfer split across jobs (incoming_bank_payment_splits). */
interface SplitDone {
  id: string;
  job_id: string | null;
  hh_job_number: number | null;
  payment_type: 'deposit' | 'balance' | 'excess';
  amount: number | string;
  status: 'recording' | 'recorded' | 'linked' | 'failed';
  hh_push_error: string | null;
  error: string | null;
}

/** Statuses that count towards the transfer — 'failed' never does. */
const SPLIT_COUNTING = ['recording', 'recorded', 'linked'];

interface IncomingRow {
  id: string;
  status: 'unmatched' | 'recorded' | 'ignored';
  /** Which saw it first: the Wise API poll or Wise's "Money received" email. */
  source: 'wise_api' | 'wise_email' | null;
  received_at: string;
  payer_name: string | null;
  amount: string;
  currency: string;
  fee: string | null;
  amount_credited: string | null;
  reference: string | null;
  transfer_number: string | null;
  match_method: string | null;
  match_notes: string | null;
  candidates: Candidate[] | null;
  matched_job_id: string | null;
  matched_hh_job_number: number | null;
  matched_job_name: string | null;
  payment_type: string | null;
  hh_deposit_id: number | null;
  hh_push_error: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  xero_invoice_id: string | null;
  xero_invoice_number: string | null;
  xero_payment_id: string | null;
  xero_invoices: Array<{ invoice_id: string; invoice_number: string; contact_name: string | null; status: string; amount_due: number }> | null;
  splits: SplitDone[] | null;
}

const money = (v: string | number | null | undefined) => `£${(parseFloat(String(v ?? 0)) || 0).toFixed(2)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const via = (source: IncomingRow['source']) => (source === 'wise_api' ? 'via Wise API' : 'via email');
/** Whole pence — 33.33 * 3 is not 99.99 in floating point. */
const toPence = (v: string | number | null | undefined) => Math.round((parseFloat(String(v ?? 0)) || 0) * 100);
const fromPence = (p: number) => `£${(p / 100).toFixed(2)}`;
const kindLabel = (t: string) => (t === 'excess' ? 'excess' : 'hire');

export default function IncomingPaymentsPanel() {
  const [rows, setRows] = useState<IncomingRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** The list loaded — admin / manager. Staff get a 403 and see no panel. */
  const [allowed, setAllowed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('incoming');

  const load = useCallback(async (): Promise<IncomingRow[]> => {
    try {
      const r = await api.get<{ data: IncomingRow[] }>('/money/incoming-payments');
      const list = r.data || [];
      setRows(list);
      setAllowed(true);
      return list;
    } catch {
      setRows([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /** After "Add a Wise transfer": reload, then point at its row (opening the history if it's settled). */
  const showAdded = useCallback(async (id: string) => {
    const list = await load();
    const row = list.find(r => r.id === id);
    if (row && row.status !== 'unmatched') setShowHistory(true);
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('incoming', id); return next; }, { replace: true });
  }, [load, setSearchParams]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!highlightId || loading) return;
    const el = document.getElementById(`incoming-${highlightId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, loading]);

  const unmatched = rows.filter(r => r.status === 'unmatched');
  const history = rows.filter(r => r.status !== 'unmatched');

  if (loading || !allowed) return null;

  return (
    <div className="mb-6 bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Incoming bank payments</h2>
          <p className="text-xs text-gray-500">
            Money into Wise, from the Wise API and Wise's emails. Matched ones are recorded automatically; these need a decision.
          </p>
        </div>
        <span className={`text-sm font-semibold px-2 py-0.5 rounded-full ${unmatched.length ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
          {unmatched.length ? `${unmatched.length} to match` : 'All matched'}
        </span>
      </div>

      {unmatched.length > 0 && (
        <div className="divide-y divide-gray-100">
          {unmatched.map(row => (
            <UnmatchedRow key={row.id} row={row} highlighted={row.id === highlightId} onDone={() => { void load(); }} />
          ))}
        </div>
      )}

      <AddFromWise onAdded={showAdded} />

      {history.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100">
          <button type="button" onClick={() => setShowHistory(v => !v)} className="text-xs text-ooosh-600 hover:text-ooosh-700 underline">
            {showHistory ? 'Hide' : 'Show'} the last 30 days ({history.length})
          </button>
          {showHistory && (
            <table className="mt-2 w-full text-xs">
              <tbody>
                {history.map(r => (
                  <tr key={r.id} id={`incoming-${r.id}`} className={`border-t border-gray-50 ${r.id === highlightId ? 'bg-amber-50' : ''}`}>
                    <td className="py-1 pr-2 text-gray-500 whitespace-nowrap" title={via(r.source)}>{when(r.received_at)}</td>
                    <td className="py-1 pr-2">{r.payer_name || '-'}</td>
                    <td className="py-1 pr-2 text-right font-medium whitespace-nowrap">{money(r.amount)}</td>
                    <td className="py-1 pr-2 text-gray-500 truncate max-w-[16rem]" title={r.reference || ''}>{r.reference || ''}</td>
                    <td className="py-1 pr-2">
                      {r.status === 'recorded' && r.match_method === 'split' ? (
                        <span className="text-gray-700">
                          split:{' '}
                          {(r.splits || []).filter(sp => SPLIT_COUNTING.includes(sp.status)).map((sp, i) => (
                            <span key={sp.id}>
                              {i > 0 && ', '}
                              {sp.job_id
                                ? <Link to={`/jobs/${sp.job_id}`} className="text-ooosh-600 hover:underline">#{sp.hh_job_number}</Link>
                                : `#${sp.hh_job_number}`}{' '}
                              {kindLabel(sp.payment_type)} {money(sp.amount)}{sp.status === 'linked' ? ' (linked)' : ''}
                            </span>
                          ))}
                        </span>
                      ) : r.status === 'recorded' && r.matched_job_id ? (
                        <Link to={`/jobs/${r.matched_job_id}`} className="text-ooosh-600 hover:underline">
                          #{r.matched_hh_job_number} {r.payment_type === 'excess' ? 'excess' : 'hire'}{r.match_method === 'linked_existing' ? ' (already recorded, linked)' : ''}
                        </Link>
                      ) : r.status === 'recorded' && r.xero_payment_id ? (
                        <span className="text-gray-700">Xero {r.xero_invoice_number}</span>
                      ) : r.status === 'ignored' ? (
                        <span className="text-gray-500" title={r.match_notes || ''}>ignored</span>
                      ) : null}
                      {r.hh_push_error && <span className="ml-1 text-amber-700" title={r.hh_push_error}>HH push failed</span>}
                    </td>
                    <td className="py-1 text-gray-400 whitespace-nowrap">{r.resolved_by_name || (r.status === 'recorded' ? 'auto' : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Money Wise shows but OP never saw (Wise skipped its email, or the poll was off):
 * type Wise's transfer number and it lands in the queue above for matching as usual.
 */
function AddFromWise({ onAdded }: { onAdded: (id: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const add = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api.post<{ data: { id: string; already: boolean } }>('/money/incoming-payments/add-from-wise', { transfer_number: number.trim() });
      setNotice(r.data.already ? 'Already in OP — highlighted.' : 'Added — match it above.');
      setNumber('');
      await onAdded(r.data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that transfer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-2 border-t border-gray-100 text-xs">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-ooosh-600 hover:text-ooosh-700 underline">
          Money in Wise that isn't here? Add a Wise transfer by number
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="add-wise-transfer" className="text-gray-600">Wise transfer number</label>
          <input
            id="add-wise-transfer"
            type="text"
            inputMode="numeric"
            value={number}
            onChange={e => setNumber(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && number.trim() && !busy) void add(); }}
            placeholder="2501093374"
            className="w-36 rounded border border-gray-300 px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !number.trim()}
            className="rounded bg-ooosh-600 px-2.5 py-1 font-medium text-white hover:bg-ooosh-700 disabled:opacity-50"
          >
            {busy ? 'Checking Wise…' : 'Add'}
          </button>
          <button type="button" onClick={() => { setOpen(false); setError(''); setNotice(''); }} className="text-gray-500 hover:text-gray-700">
            Cancel
          </button>
          <span className="w-full text-gray-500">On the payment in Wise, under "Transfer number". It waits here to be matched — nothing is recorded until you press Record.</span>
          {error && <span className="w-full text-red-600">{error}</span>}
          {notice && <span className="w-full text-green-700">{notice}</span>}
        </div>
      )}
    </div>
  );
}

function UnmatchedRow({ row, highlighted, onDone }: { row: IncomingRow; highlighted: boolean; onDone: () => void }) {
  // Pre-filled when the matcher (or a refused record) already settled on a job
  const [hhNumber, setHhNumber] = useState<string>(row.matched_hh_job_number ? String(row.matched_hh_job_number) : '');
  const [existing, setExisting] = useState<{ message: string; payment: ExistingPayment } | null>(null);
  const [paymentType, setPaymentType] = useState<'deposit' | 'balance' | 'excess'>('deposit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const unparsed = row.match_method === 'unparsed';
  // Once part of it is split, only the split can finish it (the server refuses the rest).
  const splitStarted = (row.splits || []).some(sp => SPLIT_COUNTING.includes(sp.status));
  const [splitOpen, setSplitOpen] = useState(false);

  const record = async (allowDuplicate = false) => {
    const n = parseInt(hhNumber, 10);
    if (!n) { setError('Enter the HireHop job number'); return; }
    if (allowDuplicate && !window.confirm(`Record ${money(row.amount)} on #${n} as a SECOND payment? This makes another HireHop deposit and another Xero payment.`)) return;
    setBusy(true); setError(''); setNotice(''); setExisting(null);
    try {
      const r = await api.post<{ data: { ok: boolean }; hh_push_error: string | null }>(
        `/money/incoming-payments/${row.id}/record`,
        { hh_job_number: n, payment_type: paymentType, ...(allowDuplicate ? { allow_duplicate: true } : {}) },
      );
      if (r.hh_push_error) {
        setNotice(`Recorded in OP, but the HireHop push failed: ${r.hh_push_error}`);
        setTimeout(onDone, 2500);
      } else {
        onDone();
      }
    } catch (e: unknown) {
      const err = e as { status?: number; body?: { existing_payment?: ExistingPayment } };
      if (err.status === 409 && err.body?.existing_payment) {
        setExisting({ message: e instanceof Error ? e.message : 'Already recorded on this job', payment: err.body.existing_payment });
      } else {
        setError(e instanceof Error ? e.message : 'Failed to record');
      }
    } finally {
      setBusy(false);
    }
  };

  const linkExisting = async () => {
    if (!existing) return;
    setBusy(true); setError('');
    try {
      await api.post(`/money/incoming-payments/${row.id}/link-existing`, { job_payment_id: existing.payment.id });
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to link');
    } finally {
      setBusy(false);
    }
  };

  const openXero = (row.xero_invoices || []).filter(i => i.status === 'AUTHORISED' && i.amount_due > 0);
  const xeroLabel = openXero.map(i => i.invoice_number).join(' + ');
  const xeroDue = openXero.reduce((s, i) => s + (Number(i.amount_due) || 0), 0);

  const recordXero = async () => {
    if (openXero.length === 0) return;
    if (!window.confirm(`Record ${money(row.amount)} in Xero against ${xeroLabel} (${money(xeroDue)} due)?`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.post(`/money/incoming-payments/${row.id}/record-xero`, {});
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to record in Xero');
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api.post(`/money/incoming-payments/${row.id}/rematch`, {});
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to re-check');
    } finally {
      setBusy(false);
    }
  };

  const ignore = async () => {
    const note = window.prompt('Why is this not a job payment? (kept on the record)');
    if (!note || !note.trim()) return;
    setBusy(true); setError('');
    try {
      await api.post(`/money/incoming-payments/${row.id}/ignore`, { note: note.trim() });
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to ignore');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={`incoming-${row.id}`} className={`px-4 py-3 ${highlighted ? 'bg-amber-50' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className="text-sm font-semibold text-gray-900">{unparsed ? 'Unreadable Wise email' : money(row.amount)}</span>
          <span className="text-sm text-gray-700"> from {row.payer_name || 'unknown'}</span>
          <span className="text-xs text-gray-500"> · {when(row.received_at)}{row.transfer_number ? ` · Wise #${row.transfer_number}` : ''} · {via(row.source)}</span>
          {row.fee && (
            <span className="text-xs text-gray-500"> · fee {money(row.fee)}, {money(row.amount_credited || row.amount)} landed</span>
          )}
        </div>
      </div>
      <div className="mt-1 text-sm">
        <span className="text-gray-500">Reference: </span>
        <span className="font-mono text-gray-900">{row.reference || '(none)'}</span>
      </div>
      {row.match_notes && <div className="mt-0.5 text-xs text-gray-500">{row.match_notes}</div>}

      {candidates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {candidates.map(c => (
            <button
              key={c.job_id}
              type="button"
              onClick={() => setHhNumber(String(c.hh_job_number))}
              className={`text-xs px-2 py-1 rounded border ${hhNumber === String(c.hh_job_number) ? 'border-ooosh-500 bg-ooosh-50 text-ooosh-800' : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300'}`}
              title={c.expected ? `Expects deposit ${money(c.expected.deposit)} · half ${money(c.expected.half)} · remaining ${money(c.expected.remaining)}${c.expected.invoice !== undefined ? ` · invoice owing ${money(c.expected.invoice)}` : ''} · excess ${money(c.expected.excess)}` : ''}
            >
              #{c.hh_job_number} {c.job_name ? `${c.job_name} ` : ''}<span className="text-gray-400">({c.client_name || '-'}, {c.via.replace('_', ' ')})</span>
            </button>
          ))}
        </div>
      )}

      {!unparsed && !splitStarted && !splitOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={hhNumber}
            onChange={e => setHhNumber(e.target.value.replace(/\D/g, ''))}
            placeholder="HireHop job no."
            className="w-36 px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
          <select
            value={paymentType}
            onChange={e => setPaymentType(e.target.value as 'deposit' | 'balance' | 'excess')}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            <option value="deposit">Hire payment (deposit)</option>
            <option value="balance">Hire payment (balance)</option>
            <option value="excess">Insurance excess</option>
          </select>
          <button
            type="button"
            onClick={() => record()}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded disabled:opacity-50"
          >
            {busy ? 'Recording…' : `Record ${money(row.amount)}`}
          </button>
          {openXero.length > 0 && (
            <button
              type="button"
              onClick={recordXero}
              disabled={busy || parseFloat(row.amount) > xeroDue + 0.02}
              className="px-3 py-1.5 text-sm font-medium text-ooosh-700 border border-ooosh-300 bg-white hover:bg-ooosh-50 rounded disabled:opacity-50"
              title={parseFloat(row.amount) > xeroDue + 0.02
                ? `More than the ${money(xeroDue)} due on ${xeroLabel} - Xero would reject the overpayment`
                : 'Xero-only invoice(s), not a HireHop job'}
            >
              Record in Xero against {xeroLabel} ({money(xeroDue)} due)
            </button>
          )}
          {row.currency === 'GBP' && !splitOpen && (
            <button
              type="button"
              onClick={() => { setSplitOpen(true); setExisting(null); setError(''); }}
              disabled={busy}
              className="px-3 py-1.5 text-sm text-ooosh-700 hover:text-ooosh-900 underline disabled:opacity-50"
              title="One transfer paying for several jobs"
            >
              Split across jobs
            </button>
          )}
          <button
            type="button"
            onClick={recheck}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 underline disabled:opacity-50"
            title="Run the matcher again on this payment (nothing is recorded)"
          >
            Re-check
          </button>
          <button
            type="button"
            onClick={ignore}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 underline disabled:opacity-50"
          >
            Not a job payment
          </button>
        </div>
      )}
      {unparsed && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-600">Open the email in jon@ and record the payment from the job's Money tab, then:</span>
          <button type="button" onClick={ignore} disabled={busy} className="text-sm text-gray-600 hover:text-gray-900 underline">Mark as handled</button>
        </div>
      )}
      {existing && (
        <div className="mt-2 p-2 rounded border border-amber-300 bg-amber-50 text-xs text-amber-900">
          <div>Not recorded: {existing.message}.</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={linkExisting}
              disabled={busy}
              className="px-2.5 py-1 text-xs font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded disabled:opacity-50"
              title="Close this transfer against that payment - nothing is recorded again"
            >
              Link to that payment
            </button>
            <button
              type="button"
              onClick={() => record(true)}
              disabled={busy}
              className="px-2.5 py-1 text-xs text-amber-900 underline disabled:opacity-50"
            >
              Record anyway (a second payment)
            </button>
          </div>
        </div>
      )}
      {!unparsed && (splitOpen || splitStarted) && (
        <SplitEditor row={row} onDone={onDone} onClose={splitStarted ? undefined : () => setSplitOpen(false)} />
      )}
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
      {notice && <div className="mt-1 text-xs text-amber-700">{notice}</div>}
    </div>
  );
}

interface DraftLine {
  key: number;
  hh: string;
  type: 'deposit' | 'balance' | 'excess';
  amount: string;
  /** Set once the server said this money looks already on the job. */
  conflict?: { message: string; payment: ExistingPayment };
  decision?: 'link' | 'record_anyway';
}

let draftKey = 0;
const blankLine = (): DraftLine => ({ key: ++draftKey, hh: '', type: 'deposit', amount: '' });

/**
 * Split one transfer across several jobs. Lines already done (an earlier, part-finished
 * split) are shown read-only; the new lines must make up exactly what is left.
 */
function SplitEditor({ row, onDone, onClose }: { row: IncomingRow; onDone: () => void; onClose?: () => void }) {
  const doneLines = row.splits || [];
  const totalP = toPence(row.amount);
  const doneP = doneLines.filter(sp => SPLIT_COUNTING.includes(sp.status)).reduce((s, sp) => s + toPence(sp.amount), 0);
  const [lines, setLines] = useState<DraftLine[]>(() => (doneP > 0 ? [blankLine()] : [blankLine(), blankLine()]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const newP = lines.reduce((s, l) => s + toPence(l.amount), 0);
  const leftP = totalP - doneP - newP;
  const badAmount = lines.some(l => l.amount.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(l.amount.trim()));
  const ready = !busy && !badAmount && leftP === 0 && lines.length > 0
    && lines.every(l => parseInt(l.hh, 10) > 0 && toPence(l.amount) > 0);

  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  // Changing a line's job or amount means its "already recorded" answer no longer applies.
  const edit = (key: number, patch: Partial<DraftLine>) => update(key, { ...patch, conflict: undefined, decision: undefined });

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post<{ data: { complete: boolean } }>(`/money/incoming-payments/${row.id}/split`, {
        lines: lines.map(l => ({
          hh_job_number: parseInt(l.hh, 10),
          payment_type: l.type,
          amount: toPence(l.amount) / 100,
          ...(l.decision === 'link' && l.conflict ? { decision: 'link', link_payment_id: l.conflict.payment.id } : {}),
          ...(l.decision === 'record_anyway' ? { decision: 'record_anyway' } : {}),
        })),
      });
      if (!r.data.complete) setError('Saved, but the split is not finished yet.');
      onDone();
    } catch (e: unknown) {
      const err = e as { status?: number; body?: { conflicts?: Array<{ index: number; message: string; existing: ExistingPayment }>; lines?: Array<{ index: number; status: string }> } };
      const msg = e instanceof Error ? e.message : 'Failed to split';
      if (err.status === 409 && err.body?.conflicts?.length) {
        const byIndex = new Map(err.body.conflicts.map(c => [c.index, c]));
        setLines(ls => ls.map((l, i) => {
          const c = byIndex.get(i);
          return c ? { ...l, conflict: { message: c.message, payment: c.existing }, decision: 'link' } : l;
        }));
        setError('Some of this money looks already recorded. Choose for each marked line, then press Record split again.');
      } else if (err.body?.lines) {
        // Part-done: drop the lines that were recorded (they now show above as done).
        const doneIdx = new Set(err.body.lines.filter(l => l.status === 'recorded' || l.status === 'linked').map(l => l.index));
        setLines(ls => ls.filter((_, i) => !doneIdx.has(i)));
        setError(msg);
        onDone();
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 p-3 rounded border border-gray-200 bg-gray-50 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-gray-900">Split {money(row.amount)} across jobs</span>
        {onClose && <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>}
      </div>

      {doneLines.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {doneLines.map(sp => (
            <li key={sp.id} className={sp.status === 'failed' ? 'text-red-700' : 'text-gray-700'}>
              {sp.status === 'failed' ? '✗' : sp.status === 'recording' ? '…' : '✓'} #{sp.hh_job_number} {kindLabel(sp.payment_type)} {money(sp.amount)}
              {' '}— {sp.status === 'linked' ? 'already recorded, linked' : sp.status === 'recording' ? 'being recorded' : sp.status}
              {sp.status === 'failed' && sp.error ? `: ${sp.error}` : ''}
              {sp.hh_push_error && <span className="text-amber-700"> (HireHop push failed: {sp.hh_push_error})</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-2">
        {lines.map(l => (
          <div key={l.key}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={l.hh}
                onChange={e => edit(l.key, { hh: e.target.value.replace(/\D/g, '') })}
                placeholder="HireHop job no."
                aria-label="HireHop job number"
                className="w-32 px-2 py-1 text-sm border border-gray-300 rounded"
              />
              <select
                value={l.type}
                onChange={e => update(l.key, { type: e.target.value as DraftLine['type'] })}
                aria-label="Hire or excess"
                className="px-2 py-1 text-sm border border-gray-300 rounded"
              >
                <option value="deposit">Hire payment (deposit)</option>
                <option value="balance">Hire payment (balance)</option>
                <option value="excess">Insurance excess</option>
              </select>
              <span className="text-gray-500">£</span>
              <input
                type="text"
                inputMode="decimal"
                value={l.amount}
                onChange={e => edit(l.key, { amount: e.target.value.replace(/[^\d.]/g, '') })}
                placeholder="0.00"
                aria-label="Amount"
                className="w-28 px-2 py-1 text-sm border border-gray-300 rounded"
              />
              {lines.length > 1 && (
                <button type="button" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} className="text-xs text-gray-500 hover:text-red-600">
                  Remove
                </button>
              )}
            </div>
            {l.conflict && (
              <div className="mt-1 ml-1 p-2 rounded border border-amber-300 bg-amber-50 text-xs text-amber-900">
                <div>{l.conflict.message}.</div>
                <label className="mr-3 inline-flex items-center gap-1">
                  <input type="radio" checked={l.decision === 'link'} onChange={() => update(l.key, { decision: 'link' })} />
                  It's that payment — link to it (nothing recorded again)
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" checked={l.decision === 'record_anyway'} onChange={() => update(l.key, { decision: 'record_anyway' })} />
                  Record anyway (a second payment)
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {lines.length + doneLines.filter(sp => SPLIT_COUNTING.includes(sp.status)).length < 10 && (
          <button type="button" onClick={() => setLines(ls => [...ls, blankLine()])} className="text-xs text-ooosh-600 hover:text-ooosh-700 underline">
            + Add a line
          </button>
        )}
        <span className={`text-xs ${leftP === 0 ? 'text-green-700' : 'text-amber-700'}`}>
          {leftP === 0 ? 'Adds up' : leftP > 0 ? `${fromPence(leftP)} still to split` : `${fromPence(-leftP)} too much`}
          {doneP > 0 ? ` · ${fromPence(doneP)} already done` : ''}
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ready}
          className="ml-auto px-3 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded disabled:opacity-50"
          title={badAmount ? 'Amounts are pounds and pence, like 787.88' : ''}
        >
          {busy ? 'Recording…' : 'Record split'}
        </button>
      </div>
      <div className="mt-1 text-xs text-gray-500">
        Each line is recorded like Record: a HireHop payment on the Wise bank and the client's email, per job.
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}
