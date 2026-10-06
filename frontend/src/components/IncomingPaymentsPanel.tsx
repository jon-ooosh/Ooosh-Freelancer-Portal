/**
 * Incoming bank payments (Wise) — the queue of transfers OP couldn't match on its own,
 * plus the last month of what it recorded or ignored. Lives on the Money overview.
 *
 * Resolving a row = pick the job (HireHop number) and whether it is hire money or the
 * excess; the backend then records it through the same path as "Record Payment"
 * (OP row, HireHop deposit on the Wise bank, client email). "Not a job payment" marks
 * it ignored with a note - nothing is deleted. Deep link: /money?incoming=<id>.
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
  expected?: { deposit: number; half: number; remaining: number; excess: number };
}

interface IncomingRow {
  id: string;
  status: 'unmatched' | 'recorded' | 'ignored';
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
}

const money = (v: string | number | null | undefined) => `£${(parseFloat(String(v ?? 0)) || 0).toFixed(2)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function IncomingPaymentsPanel() {
  const [rows, setRows] = useState<IncomingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('incoming');

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: IncomingRow[] }>('/money/incoming-payments');
      setRows(r.data || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!highlightId || loading) return;
    const el = document.getElementById(`incoming-${highlightId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, loading]);

  const unmatched = rows.filter(r => r.status === 'unmatched');
  const history = rows.filter(r => r.status !== 'unmatched');

  if (loading) return null;
  if (unmatched.length === 0 && history.length === 0) return null;

  return (
    <div className="mb-6 bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Incoming bank payments</h2>
          <p className="text-xs text-gray-500">
            From Wise's "Money received" emails. Matched ones are recorded automatically; these need a decision.
          </p>
        </div>
        <span className={`text-sm font-semibold px-2 py-0.5 rounded-full ${unmatched.length ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
          {unmatched.length ? `${unmatched.length} to match` : 'All matched'}
        </span>
      </div>

      {unmatched.length > 0 && (
        <div className="divide-y divide-gray-100">
          {unmatched.map(row => (
            <UnmatchedRow key={row.id} row={row} highlighted={row.id === highlightId} onDone={load} />
          ))}
        </div>
      )}

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
                    <td className="py-1 pr-2 text-gray-500 whitespace-nowrap">{when(r.received_at)}</td>
                    <td className="py-1 pr-2">{r.payer_name || '-'}</td>
                    <td className="py-1 pr-2 text-right font-medium whitespace-nowrap">{money(r.amount)}</td>
                    <td className="py-1 pr-2 text-gray-500 truncate max-w-[16rem]" title={r.reference || ''}>{r.reference || ''}</td>
                    <td className="py-1 pr-2">
                      {r.status === 'recorded' && r.matched_job_id ? (
                        <Link to={`/jobs/${r.matched_job_id}`} className="text-ooosh-600 hover:underline">
                          #{r.matched_hh_job_number} {r.payment_type === 'excess' ? 'excess' : 'hire'}
                        </Link>
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

function UnmatchedRow({ row, highlighted, onDone }: { row: IncomingRow; highlighted: boolean; onDone: () => void }) {
  const [hhNumber, setHhNumber] = useState<string>('');
  const [paymentType, setPaymentType] = useState<'deposit' | 'balance' | 'excess'>('deposit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const unparsed = row.match_method === 'unparsed';

  const record = async () => {
    const n = parseInt(hhNumber, 10);
    if (!n) { setError('Enter the HireHop job number'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api.post<{ data: { ok: boolean }; hh_push_error: string | null }>(
        `/money/incoming-payments/${row.id}/record`,
        { hh_job_number: n, payment_type: paymentType },
      );
      if (r.hh_push_error) {
        setNotice(`Recorded in OP, but the HireHop push failed: ${r.hh_push_error}`);
        setTimeout(onDone, 2500);
      } else {
        onDone();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to record');
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
          <span className="text-xs text-gray-500"> · {when(row.received_at)}{row.transfer_number ? ` · Wise #${row.transfer_number}` : ''}</span>
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
              title={c.expected ? `Expects deposit ${money(c.expected.deposit)} · half ${money(c.expected.half)} · remaining ${money(c.expected.remaining)} · excess ${money(c.expected.excess)}` : ''}
            >
              #{c.hh_job_number} {c.job_name ? `${c.job_name} ` : ''}<span className="text-gray-400">({c.client_name || '-'}, {c.via.replace('_', ' ')})</span>
            </button>
          ))}
        </div>
      )}

      {!unparsed && (
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
            onClick={record}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded disabled:opacity-50"
          >
            {busy ? 'Recording…' : `Record ${money(row.amount)}`}
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
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
      {notice && <div className="mt-1 text-xs text-amber-700">{notice}</div>}
    </div>
  );
}
