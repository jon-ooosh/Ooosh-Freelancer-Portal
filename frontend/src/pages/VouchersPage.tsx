/**
 * Money › Vouchers (docs/GOODWILL-CREDIT-SPEC.md §16) — admin and managers.
 *
 * A voucher is a goodwill credit with a code: £X inc VAT, single use, off a hire or at the
 * shop till; whatever it doesn't cover lapses. Made here by hand (a promo, a prize, a
 * sorry), or by the referral scheme. Staff check a code at the till ("Voucher") or on a job
 * ("Have a voucher code?") — there is no public lookup, so a code can't be guessed at.
 * Backend: routes/vouchers.ts; withdraw is the usual goodwill route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import ModalShell from '../components/ModalShell';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { ukDatePlus, ukToday } from '../lib/ukDate';
import { type GoodwillCredit, STATUS_LABEL, STATUS_PILL, gwDay, voucherMoney, copyText } from '../lib/goodwillCopy';
import EmailPointsModal from '../components/goodwill/EmailPointsModal';

type Filter = 'live' | 'used' | 'all';

// Only a referral's voucher says where it came from; one made on this page needs no label.
const SOURCE_LABEL: Record<string, string> = { referral: 'Referral' };

export default function VouchersPage() {
  const role = useAuthStore((s) => s.user?.role);
  const isManager = hasManagerRole(role);
  const [rows, setRows] = useState<GoodwillCredit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('live');
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<GoodwillCredit[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pointsFor, setPointsFor] = useState<GoodwillCredit | null>(null);

  const load = useCallback(async () => {
    try { setRows((await api.get<{ data: GoodwillCredit[] }>('/vouchers')).data); setError(null); }
    catch (e) { setError((e as { body?: { error?: string } })?.body?.error || 'Could not load the vouchers.'); }
  }, []);
  useEffect(() => { if (isManager) load(); }, [isManager, load]);

  const shown = useMemo(() => (rows || []).filter((g) =>
    filter === 'all' ? true : filter === 'used' ? g.status === 'used' : g.status === 'offered' || g.status === 'reserved'), [rows, filter]);

  if (!isManager) return <div className="p-6 text-sm text-gray-600">Vouchers are for managers and admins.</div>;

  const copy = async (key: string, text: string) => { if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1500); } };
  const withdraw = async (g: GoodwillCredit) => {
    const why = window.prompt(`Withdraw voucher ${g.voucher_code}? It stops working. Say why (staff only):`);
    if (!why || !why.trim()) return;
    setBusy(g.id);
    try { await api.post(`/goodwill/${g.id}/withdraw`, { reason: why.trim() }); await load(); }
    catch (e) { setError((e as { body?: { error?: string } })?.body?.error || 'Could not withdraw it.'); }
    finally { setBusy(null); }
  };
  const live = (rows || []).filter((g) => g.status === 'offered' || g.status === 'reserved');

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Vouchers</h1>
          <p className="text-sm text-gray-600 mt-0.5 max-w-3xl">
            Money off a hire or at the shop till, with its own code. Single use — whatever it doesn't cover lapses. Amounts are inc VAT.
            Staff check a code at the <Link to="/money/shop" className="text-ooosh-700 hover:underline">Shop Till</Link> ("Voucher") or on the job ("Have a voucher code?").
          </p>
        </div>
        <button type="button" onClick={() => { setMade(null); setMaking(true); }} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">+ Make vouchers</button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
          {([['live', 'To use'], ['used', 'Used'], ['all', 'All']] as [Filter, string][]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              className={`px-3 py-1.5 rounded-md ${filter === k ? 'bg-ooosh-600 text-white' : 'text-gray-700 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        {rows && <span className="text-sm text-gray-500">{live.length} out there, worth {voucherMoney(live.reduce((s, g) => s + (g.voucher_value_inc_vat || 0), 0))} inc VAT</span>}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {rows === null ? <p className="text-sm text-gray-500">Loading…</p> : shown.length === 0 ? (
        <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">No vouchers here.</p>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-gray-500 whitespace-nowrap bg-gray-50">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Code</th>
                <th className="text-left font-semibold px-3 py-2">Value</th>
                <th className="text-left font-semibold px-3 py-2">For</th>
                <th className="text-left font-semibold px-3 py-2">Why</th>
                <th className="text-left font-semibold px-3 py-2">Use by</th>
                <th className="text-left font-semibold px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((g) => {
                const isLive = g.status === 'offered' || g.status === 'reserved';
                const ownerLink = g.person_id ? `/people/${g.person_id}?tab=goodwill` : g.organisation_id ? `/organisations/${g.organisation_id}?tab=goodwill` : null;
                return (
                  <tr key={g.id} className={`align-top ${isLive ? '' : 'text-gray-500'}`}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-mono text-gray-900">{g.voucher_code}</span>
                      <div className="text-xs text-gray-400 font-mono">{g.ref}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold">{voucherMoney(g.voucher_value_inc_vat || 0)}</td>
                    <td className="px-3 py-2">{ownerLink ? <Link to={ownerLink} className="text-ooosh-700 hover:underline">{g.owner_name}</Link> : <span className="text-gray-500">{g.owner_name}</span>}</td>
                    <td className="px-3 py-2 max-w-xs">
                      {g.reason}
                      <div className="text-xs text-gray-400">
                        {[SOURCE_LABEL[g.source_kind], gwDay(g.offered_at), g.offered_by_name].filter(Boolean).join(' · ')}
                        {g.withdrawn_reason && <span className="block text-gray-500">Withdrawn: {g.withdrawn_reason}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{gwDay(g.expires_on)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_PILL[g.status]}`}>{STATUS_LABEL[g.status]}</span>
                      {g.status === 'used' && g.used_how === 'shop' && <div className="text-xs mt-1">At the shop till{g.used_hh_ref ? ` (${g.used_hh_ref})` : ''}</div>}
                      {(g.status === 'reserved' || g.status === 'used') && g.reserved_job_id && (
                        <div className="text-xs mt-1">{g.status === 'reserved' ? 'Held for ' : 'On '}<Link to={`/jobs/${g.reserved_job_id}`} className="text-ooosh-700 hover:underline">{g.reserved_job_number ? `job ${g.reserved_job_number}` : 'the job'}</Link></div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-xs space-x-2">
                      {isLive && <button type="button" onClick={() => copy(`c${g.id}`, g.voucher_code || '')} className="text-ooosh-700 hover:underline">{copied === `c${g.id}` ? '✓ Copied' : 'Copy code'}</button>}
                      {isLive && <button type="button" onClick={() => setPointsFor(g)} className="text-ooosh-700 hover:underline">Email points</button>}
                      {isLive && <button type="button" disabled={busy === g.id} onClick={() => withdraw(g)} className="text-red-600 hover:underline disabled:opacity-50">Withdraw</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pointsFor && <EmailPointsModal credit={pointsFor} onClose={() => setPointsFor(null)} />}
      {making && (
        <MakeVouchersModal
          onClose={() => setMaking(false)}
          onMade={(list) => { setMade(list); setMaking(false); load(); }}
        />
      )}
      {made && made.length > 0 && (
        <ModalShell title={made.length === 1 ? 'Voucher made' : `${made.length} vouchers made`} subtitle={`${voucherMoney(made[0].voucher_value_inc_vat || 0)} inc VAT each, use by ${gwDay(made[0].expires_on)}`} onClose={() => setMade(null)} width="max-w-md">
          <div className="space-y-3 text-sm">
            <ul className="max-h-72 overflow-y-auto rounded border border-gray-200 divide-y font-mono">
              {made.map((g) => <li key={g.id} className="px-3 py-1.5 flex justify-between"><span>{g.voucher_code}</span><span className="text-gray-400">{g.ref}</span></li>)}
            </ul>
            <p className="text-xs text-gray-500">Each code works once. They stay on this page, so you can copy them again later.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => copy('all', made.map((g) => g.voucher_code).join('\n'))} className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">{copied === 'all' ? '✓ Copied' : made.length === 1 ? 'Copy code' : 'Copy all codes'}</button>
              <button type="button" onClick={() => setMade(null)} className="px-3 py-1.5 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">Done</button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function MakeVouchersModal({ onClose, onMade }: { onClose: () => void; onMade: (made: GoodwillCredit[]) => void }) {
  const [value, setValue] = useState('20');
  const [count, setCount] = useState('1');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(ukDatePlus(365));
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Array<{ id: string; first_name: string; last_name: string; email?: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const n = Math.floor(Number(count) || 0);

  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ data: Array<{ id: string; first_name: string; last_name: string; email?: string | null }> }>(`/people?search=${encodeURIComponent(search.trim())}&limit=8`)
        .then((r) => setResults(r.data)).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  async function save() {
    const v = Number(value.replace(/^£/, ''));
    if (!(v > 0)) { setError('Say how much each voucher is worth'); return; }
    if (!(n >= 1 && n <= 50)) { setError('Between 1 and 50 vouchers at a time'); return; }
    if (!reason.trim()) { setError('Say what they are for — it shows on the list and the timelines'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < ukToday()) { setError('The use-by date must be today or later'); return; }
    setSaving(true);
    setError('');
    try {
      const r = await api.post<{ data: GoodwillCredit[] }>('/vouchers', {
        value_inc_vat: Math.round(v * 100) / 100, count: n, reason: reason.trim(), expires_on: until,
        person_id: n === 1 && person ? person.id : null,
      });
      onMade(r.data);
    } catch (e) {
      setError((e as { body?: { error?: string } })?.body?.error || 'Could not make them');
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Make vouchers" subtitle="Each one gets its own code and works once." onClose={() => { if (!saving) onClose(); }} width="max-w-lg">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-4">
          <label className="block"><span className="text-gray-600">Worth, £ inc VAT</span>
            <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="mt-0.5 block w-24 border border-gray-300 rounded px-2 py-1.5" /></label>
          <label className="block"><span className="text-gray-600">How many</span>
            <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} className="mt-0.5 block w-20 border border-gray-300 rounded px-2 py-1.5" /></label>
          <label className="block"><span className="text-gray-600">Use by</span>
            <input type="date" min={ukToday()} value={until} onChange={(e) => setUntil(e.target.value)} className="mt-0.5 block border border-gray-300 rounded px-2 py-1.5" /></label>
        </div>
        <label className="block"><span className="text-gray-600">What for?</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Festival raffle prize / sorry for the late van / Instagram giveaway"
            className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1.5" /></label>
        {n === 1 && (
          <div>
            <span className="text-gray-600">For someone in particular? <span className="text-gray-400">(optional — otherwise anyone with the code)</span></span>
            {person ? (
              <div className="mt-1 flex items-center gap-2"><span className="font-medium">{person.name}</span>
                <button type="button" onClick={() => setPerson(null)} className="text-xs text-gray-400 hover:text-gray-600">✕</button></div>
            ) : (
              <div className="relative mt-0.5">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="w-full border border-gray-300 rounded px-2 py-1.5" />
                {results.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                    {results.map((p) => (
                      <button key={p.id} type="button" onClick={() => { setPerson({ id: p.id, name: `${p.first_name} ${p.last_name}`.trim() }); setSearch(''); setResults([]); }}
                        className="block w-full text-left px-3 py-1.5 hover:bg-gray-50">
                        {p.first_name} {p.last_name}{p.email && <span className="text-gray-400"> · {p.email}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-1">A named voucher shows on their page and on any job they're a contact on.</p>
          </div>
        )}
        <p className="text-xs text-gray-500">
          Every voucher is single use, for one person. A code printed for many people to use (a magazine ad) isn't this — ask for a promo code if you need one.
        </p>
        {error && <div className="text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="px-3 py-1.5 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Making…' : n > 1 ? `Make ${n} vouchers` : 'Make voucher'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
