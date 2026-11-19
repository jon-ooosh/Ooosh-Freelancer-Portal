/**
 * "Referred by" on the job page (docs/BUSINESS-FIGURES-SPEC.md §8d). Shows who recommended
 * this client, or lets staff say so — picked from the address book, as a name they
 * mentioned or a referral card. Amber when "Heard about us" is Recommendation and nobody
 * is linked yet. The friend's welcome voucher is made automatically when the referral is
 * linked (held for this hire, emailed in Jon's words while the referral emails are on); a
 * manager can send the email by hand, or give the voucher for a referral linked before the
 * offer had one. Taking a referral off withdraws its unused voucher.
 * Backend: routes/referrals.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { hasManagerRole } from '../../lib/roles';

interface Referral {
  id: string;
  referrerPersonId: string;
  referrerName: string;
  how: 'link' | 'named' | 'card';
  status: string;
  stage: string;
  welcomeCreditRef: string | null;
  welcomeVoucherCode: string | null;
  welcomeEmailSentAt: string | null;
  offer: { friendVoucherIncVat: number | null };
}

const HOW: Record<string, string> = { link: 'their link', named: 'named by the client', card: 'referral card' };

function money(n: number): string {
  return `£${n.toFixed(n % 1 ? 2 : 0)}`;
}

/** "Give the £20 voucher": a tick for the welcome email, then Give. Managers only. */
function GiveVoucher({ amount, busy, onGive }: { amount: number; busy: boolean; onGive: (sendEmail: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(true);
  if (!open) {
    return <button type="button" disabled={busy} onClick={() => setOpen(true)} className="text-ooosh-700 hover:underline disabled:opacity-50">Give the {money(amount)} voucher</button>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded border border-green-200 bg-green-50 px-2 py-1">
      <span>A {money(amount)} voucher (inc VAT), held for this hire.</span>
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email them the code</label>
      <button type="button" disabled={busy} onClick={() => onGive(email)} className="rounded bg-green-700 px-2 py-0.5 text-white hover:bg-green-800 disabled:opacity-50">Give it</button>
      <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">Cancel</button>
    </span>
  );
}

export default function ReferredBy({ jobId, heardAbout, role }: { jobId: string; heardAbout: string | null; role: string | undefined }) {
  const [referral, setReferral] = useState<Referral | null>(null);
  const [creditAmount, setCreditAmount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Array<{ id: string; first_name: string; last_name: string; email?: string | null }>>([]);
  const [how, setHow] = useState<'named' | 'card'>('named');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isManager = hasManagerRole(role);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: { referral: Referral | null; offerVoucherIncVat: number | null } }>(`/referrals/job/${jobId}`);
      setReferral(r.data.referral);
      setCreditAmount(r.data.referral?.offer.friendVoucherIncVat ?? r.data.offerVoucherIncVat);
    } catch { /* the line just doesn't show */ }
    setLoaded(true);
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!picking || search.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ data: Array<{ id: string; first_name: string; last_name: string; email?: string | null }> }>(`/people?search=${encodeURIComponent(search.trim())}&limit=8`)
        .then((r) => setResults(r.data))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search, picking]);

  if (!loaded) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); await load(); } catch (e) { setError((e as { body?: { error?: string } })?.body?.error || (e instanceof Error ? e.message : 'Could not save')); }
    finally { setBusy(false); }
  };

  if (referral) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
        <span>🤝 Referred by <Link to={`/people/${referral.referrerPersonId}`} className="text-ooosh-700 hover:underline">{referral.referrerName}</Link></span>
        <span className="text-gray-400">({HOW[referral.how] || referral.how} · {referral.stage})</span>
        {referral.welcomeCreditRef && (
          <span className="text-gray-500">
            · welcome voucher <span className="font-mono">{referral.welcomeVoucherCode || referral.welcomeCreditRef}</span>{referral.welcomeEmailSentAt ? ' (emailed)' : ''}
            {isManager && !referral.welcomeEmailSentAt && (
              <> · <button type="button" disabled={busy} className="text-ooosh-700 hover:underline disabled:opacity-50"
                onClick={() => act(async () => { await api.post(`/referrals/${referral.id}/welcome-email`, {}); setNotice('Emailed.'); })}>Email them the code</button></>
            )}
          </span>
        )}
        {isManager && !referral.welcomeCreditRef && referral.status !== 'declined' && creditAmount && (
          <GiveVoucher amount={creditAmount} busy={busy} onGive={(sendEmail) => act(async () => {
            const r = await api.post<{ data: { emailed: boolean; emailProblem: string | null } }>(`/referrals/${referral.id}/welcome-credit`, { sendEmail });
            if (sendEmail && !r.data.emailed) setNotice(`Voucher given, but the email didn't go: ${r.data.emailProblem || 'unknown error'}`);
          })} />
        )}
        {notice && <span className="text-amber-700">{notice}</span>}
        {referral.status === 'open' && (
          <button type="button" disabled={busy} title="Linked by mistake? Take it off"
            onClick={() => { if (window.confirm(`Take ${referral.referrerName} off as the referrer?${referral.welcomeCreditRef ? ' Their friend\'s welcome voucher is withdrawn too.' : ''}`)) act(() => api.delete(`/referrals/${referral.id}`)); }}
            className="text-gray-400 hover:text-red-600 disabled:opacity-50">✕</button>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </span>
    );
  }

  const prompt = heardAbout === 'recommendation';
  if (!picking) {
    return (
      <button type="button" onClick={() => setPicking(true)}
        title="Who recommended them? Link the person — they may be due a thank-you"
        className={`text-xs rounded-md border px-1.5 py-1 ${prompt ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-200 text-gray-500 hover:text-gray-700'}`}>
        + Referred by…
      </button>
    );
  }
  return (
    <span className="relative inline-flex flex-wrap items-center gap-1.5 text-xs">
      <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Who recommended them?"
        className="border border-gray-300 rounded px-2 py-1 text-xs w-48" />
      <select value={how} onChange={(e) => setHow(e.target.value as 'named' | 'card')} className="border border-gray-200 rounded px-1 py-1 text-xs">
        <option value="named">They named them</option>
        <option value="card">Referral card</option>
      </select>
      <button type="button" onClick={() => { setPicking(false); setSearch(''); setError(null); }} className="text-gray-400 hover:text-gray-600">Cancel</button>
      {error && <span className="text-red-600">{error}</span>}
      {results.length > 0 && (
        <span className="absolute left-0 top-full mt-1 z-20 w-72 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {results.map((p) => (
            <button key={p.id} type="button" disabled={busy}
              onClick={() => act(async () => {
                await api.post('/referrals', { jobId, referrerPersonId: p.id, how });
                setPicking(false);
                setSearch('');
              })}
              className="block w-full text-left px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50">
              <span className="text-gray-800">{p.first_name} {p.last_name}</span>
              {p.email && <span className="text-gray-400"> · {p.email}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
