import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuthStore } from '../../hooks/useAuthStore';
import { hasManagerRole } from '../../lib/roles';
import { type GoodwillCredit, money, plusVat, gwDay, hireHopNote, copyText } from '../../lib/goodwillCopy';

/**
 * Goodwill credits for whoever is on this enquiry / job — the Client History
 * sidebar, above Endorsed artists (docs/GOODWILL-CREDIT-SPEC.md §4.3). Renders
 * nothing when there are none. Fetches its own data so the two pages that show
 * it only pass ids.
 *
 * `jobId` is the saved job; without one (a New Enquiry not saved yet) a credit can
 * be seen but not reserved.
 */
export default function GoodwillNote({ orgIds, personIds = [], jobId }: {
  orgIds: Array<string | null | undefined>;
  personIds?: string[];
  jobId?: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(user?.role);
  const [credits, setCredits] = useState<GoodwillCredit[]>([]);
  const [using, setUsing] = useState<GoodwillCredit | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(jobId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const orgKey = orgIds.filter(Boolean).join(',');
  const personKey = personIds.filter(Boolean).join(',');
  const load = useCallback(() => {
    if (!orgKey && !personKey && !jobId) { setCredits([]); return; }
    const p = new URLSearchParams();
    if (orgKey) p.set('org_ids', orgKey);
    if (personKey) p.set('person_ids', personKey);
    if (jobId) p.set('job_id', jobId);
    api.get<{ data: GoodwillCredit[] }>(`/goodwill/context?${p}`)
      .then((r) => setCredits(r.data))
      .catch(() => setCredits([]));
  }, [orgKey, personKey, jobId]);
  useEffect(() => { load(); }, [load]);

  const shown = credits.filter((c) => c.status === 'reserved' || !hidden.has(c.id));
  if (shown.length === 0 && !using) return null;

  async function act(c: GoodwillCredit, path: 'applied' | 'unreserve', body: unknown = {}) {
    setBusy(c.id);
    setError('');
    try {
      await api.post(`/goodwill/${c.id}/${path}`, body);
      load();
    } catch (e) {
      setError((e as { body?: { error?: string } })?.body?.error || 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  function hide(c: GoodwillCredit) {
    const next = new Set(hidden).add(c.id);
    setHidden(next);
    writeHidden(jobId, next);
  }

  return (
    <div className="mb-3 p-2.5 bg-green-50 border border-green-200 rounded-lg">
      <div className="text-xs font-semibold text-green-800 uppercase mb-1">Goodwill credit</div>
      <ul className="space-y-2.5">
        {shown.map((c) => (
          <li key={c.id} className="text-xs text-gray-700">
            <div className="text-sm font-bold text-gray-900">{plusVat(c.amount_ex_vat)}</div>
            <div>
              For {c.owner_name} · <span className="font-mono">{c.ref}</span> · offered {gwDay(c.offered_at)}
              {c.source_job_id && c.source_job_number && <> after <Link to={`/jobs/${c.source_job_id}`} className="text-ooosh-600 hover:underline">job {c.source_job_number}</Link></>}
              {c.offered_by_name && <> by {c.offered_by_name}</>}. Use by {gwDay(c.expires_on)}.
            </div>
            <div className="italic text-gray-600">“{c.reason}”</div>

            {c.status === 'reserved' ? (
              <div className="mt-1.5 p-2 bg-amber-50 border border-amber-200 rounded">
                <div className="text-amber-900">
                  <b>Reserved on this job</b>: {money(c.reserved_amount_ex_vat ?? c.amount_ex_vat)} + VAT{' '}
                  {c.reserved_for === 'invoice' ? `against ${c.reserved_invoice_number || 'an invoice'} (a credit note in HireHop)` : 'off the hire (a discount in HireHop)'}.
                  {' '}Put <b className="font-mono">{hireHopNote(c.ref)}</b> in {c.reserved_for === 'invoice' ? 'the credit note\'s description' : 'the line\'s note'}.
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <button type="button" onClick={async () => { if (await copyText(hireHopNote(c.ref))) setCopied(c.id); }}
                    className="px-2 py-1 text-xs border border-gray-300 bg-white rounded hover:bg-gray-50">{copied === c.id ? '✓ Copied' : 'Copy note text'}</button>
                  <button type="button" disabled={busy === c.id}
                    onClick={() => { if (confirm(`Mark ${c.ref} as applied in HireHop? Anything it didn't take lapses.`)) void act(c, 'applied'); }}
                    className="px-2 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-800 disabled:opacity-50">Mark as applied</button>
                  {isManager && (
                    <button type="button" disabled={busy === c.id}
                      onClick={() => { if (confirm(`Take ${c.ref} off this job? It goes back to being free to use.`)) void act(c, 'unreserve'); }}
                      className="px-2 py-1 text-xs border border-gray-300 bg-white rounded hover:bg-gray-50 disabled:opacity-50">Take off this job</button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {jobId ? (
                  <button type="button" onClick={() => setUsing(c)}
                    className="px-2 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-800">Use on this job</button>
                ) : (
                  <span className="text-[11px] text-gray-500">Save the enquiry to use it on this job.</span>
                )}
                <button type="button" onClick={() => hide(c)}
                  className="px-2 py-1 text-xs border border-gray-300 bg-white rounded hover:bg-gray-50">Not this time</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
      {using && jobId && (
        <UseGoodwillModal credit={using} jobId={jobId} onClose={() => setUsing(null)} onDone={() => { setUsing(null); load(); }} />
      )}
    </div>
  );
}

// "Not this time" hides a credit on THIS job, for this viewer only — a per-viewer
// convenience, so localStorage (frontend.md), every read guarded.
const hiddenKey = (jobId?: string | null) => `goodwill-hidden:${jobId || 'new'}`;
function readHidden(jobId?: string | null): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(hiddenKey(jobId)) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function writeHidden(jobId: string | null | undefined, ids: Set<string>) {
  try { localStorage.setItem(hiddenKey(jobId), JSON.stringify(Array.from(ids))); } catch { /* ignore */ }
}

/** "Use on this job" — where it goes, how much, then Reserve (spec §4.3). Any staff. */
function UseGoodwillModal({ credit, jobId, onClose, onDone }: {
  credit: GoodwillCredit; jobId: string; onClose: () => void; onDone: () => void;
}) {
  const [where, setWhere] = useState<'hire' | 'invoice'>('hire');
  const [amount, setAmount] = useState(String(credit.amount_ex_vat));
  const [invoice, setInvoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const net = Number(amount);
  const amountOk = Number.isFinite(net) && net > 0 && net <= credit.amount_ex_vat + 0.004;

  async function reserve() {
    if (!amountOk) { setError(`Between £0.01 and ${money(credit.amount_ex_vat)}`); return; }
    setSaving(true);
    setError('');
    try {
      await api.post(`/goodwill/${credit.id}/reserve`, {
        job_id: jobId, reserved_for: where, amount_ex_vat: Math.round(net * 100) / 100,
        invoice_number: where === 'invoice' ? (invoice.trim() || null) : null,
      });
      onDone();
    } catch (e) {
      setError((e as { body?: { error?: string } })?.body?.error || 'Could not reserve it');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!saving) onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">Use {credit.ref} on this job</h3>
          <p className="text-sm text-gray-500 mt-0.5">Up to {plusVat(credit.amount_ex_vat)}, for {credit.owner_name}. Use by {gwDay(credit.expires_on)}.</p>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm">
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-gray-700 mb-1">Where does it go?</legend>
            <label className={`flex items-start gap-2 border rounded-lg p-2.5 cursor-pointer ${where === 'hire' ? 'border-ooosh-600' : 'border-gray-200'}`}>
              <input type="radio" name="gw-where" checked={where === 'hire'} onChange={() => setWhere('hire')} className="mt-0.5" />
              <span><b>Off this job's hire</b><span className="block text-xs text-gray-500">Not invoiced yet. A discount on the line(s) it's for, in HireHop.</span></span>
            </label>
            <label className={`flex items-start gap-2 border rounded-lg p-2.5 cursor-pointer ${where === 'invoice' ? 'border-ooosh-600' : 'border-gray-200'}`}>
              <input type="radio" name="gw-where" checked={where === 'invoice'} onChange={() => setWhere('invoice')} className="mt-0.5" />
              <span><b>Against money they already owe</b><span className="block text-xs text-gray-500">An invoice already raised. A credit note on it, in HireHop.</span></span>
            </label>
          </fieldset>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="gw-use-amount" className="block text-xs font-semibold text-gray-700 mb-1">Amount (ex VAT)</label>
              <div className="flex items-center border border-gray-300 rounded-lg px-3 w-36">
                <span className="text-gray-500">£</span>
                <input id="gw-use-amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount}
                  onChange={(e) => setAmount(e.target.value)} className="w-full py-2 pl-1 outline-none" />
              </div>
            </div>
            {where === 'invoice' && (
              <div>
                <label htmlFor="gw-use-inv" className="block text-xs font-semibold text-gray-700 mb-1">Invoice</label>
                <input id="gw-use-inv" value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="OT-INV-…"
                  className="border border-gray-300 rounded-lg px-3 py-2 w-40" />
              </div>
            )}
          </div>
          {amountOk && net < credit.amount_ex_vat - 0.004 && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              The other {money(credit.amount_ex_vat - net)} + VAT lapses once it's applied.
            </div>
          )}

          <div className="border border-gray-200 rounded-lg p-3 space-y-1.5">
            <div className="text-xs font-semibold text-gray-700">Then in HireHop</div>
            <p className="text-xs text-gray-600">
              {where === 'hire'
                ? `Discount the line(s) it's for by ${money(amountOk ? net : credit.amount_ex_vat)} in all, and put this in that line's note:`
                : `Raise a credit note for ${money(amountOk ? net : credit.amount_ex_vat)} + VAT on the invoice, with this in its description:`}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-gray-50 rounded px-2 py-1.5 text-xs">{hireHopNote(credit.ref)}</code>
              <button type="button" onClick={async () => setCopied(await copyText(hireHopNote(credit.ref)))}
                className="px-2.5 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <p className="text-[11px] text-gray-500">The code is what OP will look for — keep it in, word for word. Once it's in HireHop, press "Mark as applied" on the job.</p>
          </div>

          {error && <div className="text-red-600">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={reserve} disabled={saving}
              className="px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-800 disabled:opacity-50">{saving ? 'Reserving…' : 'Reserve for this job'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
