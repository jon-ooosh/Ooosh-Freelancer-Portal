import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuthStore } from '../../hooks/useAuthStore';
import { hasManagerRole } from '../../lib/roles';
import { ukToday } from '../../lib/ukDate';
import {
  type GoodwillCredit, type GoodwillOwner, STATUS_LABEL, STATUS_PILL, money, plusVat, gwDay, emailPoints, copyText,
} from '../../lib/goodwillCopy';
import OfferGoodwillModal from './OfferGoodwillModal';

/**
 * An org's or person's Goodwill tab (docs/GOODWILL-CREDIT-SPEC.md §4.4): every
 * credit they've been offered, kept forever. Managers can change the amount or
 * use-by date, take it off a job, or withdraw it; anyone can copy the email points.
 */
export default function GoodwillTab({ owner }: { owner: GoodwillOwner }) {
  const user = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(user?.role);
  const [rows, setRows] = useState<GoodwillCredit[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);

  const param = owner.kind === 'organisation' ? 'organisation_id' : 'person_id';
  const load = useCallback(() => {
    api.get<{ data: GoodwillCredit[] }>(`/goodwill?${param}=${owner.id}`)
      .then((r) => setRows(r.data))
      .catch(() => setError('Could not load goodwill credits'));
  }, [param, owner.id]);
  useEffect(() => { load(); }, [load]);

  async function run(g: GoodwillCredit, fn: () => Promise<unknown>) {
    setBusy(g.id);
    setError('');
    try { await fn(); load(); } catch (e) {
      setError((e as { body?: { error?: string } })?.body?.error || 'Could not save');
    } finally { setBusy(null); }
  }

  const edit = (g: GoodwillCredit) => {
    const amt = prompt(`Amount for ${g.ref}, ex VAT (£)`, String(g.amount_ex_vat));
    if (amt === null) return;
    const until = prompt(`Use by (YYYY-MM-DD) — today or later`, g.expires_on);
    if (until === null) return;
    const n = Number(amt);
    if (!Number.isFinite(n) || n <= 0) { setError('That amount isn\'t a number above £0'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until.trim()) || until.trim() < ukToday()) { setError('Use-by must be a date, today or later'); return; }
    void run(g, () => api.patch(`/goodwill/${g.id}`, { amount_ex_vat: Math.round(n * 100) / 100, expires_on: until.trim() }));
  };
  const withdraw = (g: GoodwillCredit) => {
    const why = prompt(`Withdraw ${g.ref}? Say why (staff only):`);
    if (!why || !why.trim()) return;
    void run(g, () => api.post(`/goodwill/${g.id}/withdraw`, { reason: why.trim() }));
  };
  const takeOff = (g: GoodwillCredit) => {
    if (!confirm(`Take ${g.ref} off job ${g.reserved_job_number ?? ''}? It goes back to being free to use.`)) return;
    void run(g, () => api.post(`/goodwill/${g.id}/unreserve`, {}));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">Money off a future hire or off what they owe — a promise, not money. Applied by hand in HireHop with the GW code.</p>
        {isManager && (
          <button type="button" onClick={() => setOffering(true)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 whitespace-nowrap">+ Offer goodwill credit</button>
        )}
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {rows === null ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500">No goodwill credits.</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Amount</th>
                <th className="text-left px-3 py-2">Offered</th>
                <th className="text-left px-3 py-2">Why</th>
                <th className="text-left px-3 py-2">Use by</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const live = g.status === 'offered' || g.status === 'reserved';
                return (
                  <tr key={g.id} className={`border-t border-gray-100 align-top ${live ? '' : 'text-gray-500'}`}>
                    <td className="px-3 py-2"><b>{money(g.amount_ex_vat)} + VAT</b><div className="text-xs text-gray-500 font-mono">{g.ref}</div></td>
                    <td className="px-3 py-2">
                      {gwDay(g.offered_at)}
                      <div className="text-xs">
                        {g.source_job_id && g.source_job_number
                          ? <Link to={`/jobs/${g.source_job_id}`} className="text-ooosh-600 hover:underline">job {g.source_job_number}</Link>
                          : <span className="text-gray-400">not from a job</span>}
                        {g.source_issue_id && <> · <Link to={`/operations/problems/${g.source_issue_id}`} className="text-ooosh-600 hover:underline">Problem</Link></>}
                        {g.offered_by_name && <span className="text-gray-400"> · {g.offered_by_name}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-xs">{g.reason}{g.withdrawn_reason && <div className="text-xs text-gray-500">Withdrawn: {g.withdrawn_reason}</div>}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{gwDay(g.expires_on)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_PILL[g.status]}`}>{STATUS_LABEL[g.status]}</span>
                      {(g.status === 'reserved' || g.status === 'used') && g.reserved_job_id && (
                        <div className="text-xs mt-1">
                          {g.status === 'used' ? `${money(g.used_amount_ex_vat ?? 0)} + VAT on ` : 'on '}
                          <Link to={`/jobs/${g.reserved_job_id}`} className="text-ooosh-600 hover:underline">job {g.reserved_job_number}</Link>
                          {g.reserved_for === 'invoice' && g.reserved_invoice_number ? ` (${g.reserved_invoice_number})` : ''}
                        </div>
                      )}
                      {g.check_problem && <div className="text-xs mt-1 text-amber-800">⚠ {g.check_problem}</div>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap space-x-2 text-xs">
                      {live && (
                        <button type="button" onClick={async () => { if (await copyText(emailPoints(g))) setCopied(g.id); }} className="text-ooosh-600 hover:underline">
                          {copied === g.id ? '✓ Copied' : 'Copy email points'}
                        </button>
                      )}
                      {isManager && live && <button type="button" disabled={busy === g.id} onClick={() => edit(g)} className="text-ooosh-600 hover:underline">Edit</button>}
                      {isManager && g.status === 'reserved' && <button type="button" disabled={busy === g.id} onClick={() => takeOff(g)} className="text-ooosh-600 hover:underline">Take off job</button>}
                      {isManager && live && <button type="button" disabled={busy === g.id} onClick={() => withdraw(g)} className="text-red-600 hover:underline">Withdraw</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.some((g) => g.status === 'offered') && (
        <p className="text-xs text-gray-500">To use one, open the job it's for — it shows in the Client History panel with “Use on this job”. Total still to use: {plusVat(rows.filter((g) => g.status === 'offered').reduce((s, g) => s + g.amount_ex_vat, 0))}.</p>
      )}
      {offering && (
        <OfferGoodwillModal owner={owner} sourceKind={owner.kind === 'organisation' ? 'organisation' : 'person'}
          onClose={() => setOffering(false)} onDone={() => load()} />
      )}
    </div>
  );
}
