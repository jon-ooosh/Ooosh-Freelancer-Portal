/**
 * Money › Business figures — admin only (docs/BUSINESS-FIGURES-SPEC.md, step 2).
 *
 * Enquiries and what became of them: booking rate by month, channel, likelihood,
 * value, service and person; how fast we first emailed back and quoted; why they
 * were lost. Every figure is computed by the backend (services/business-figures.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { ENQUIRY_SOURCE_LABELS, HEARD_ABOUT_LABELS } from '../lib/enquirySource';

interface Tally {
  key: string;
  enquiries: number;
  booked: number;
  cancelled: number;
  lost: number;
  notFollowedUp: number;
  open: number;
  rate: number | null;
  bookedValue: number;
  medianReplyMins: number | null;
  replies: number;
  medianQuoteMins: number | null;
  quotes: number;
}

interface Figures {
  from: string;
  to: string;
  officeHours: string;
  coverage: { enquiries: number; withChannel: number; withReply: number; withQuote: number; withOwner: number; earliestEmail: string | null };
  summary: {
    total: Tally;
    byMonth: Tally[];
    byChannel: Tally[];
    byLikelihood: Tally[];
    byValue: Tally[];
    byService: Tally[];
    byOwner: Tally[];
    byReplier: Tally[];
    byReplySpeed: Tally[];
    byHeardAbout: Tally[];
    byTracked: Tally[];
    byClientType: Tally[];
    lostReasons: Array<{ reason: string; count: number }>;
  };
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
const gbp0 = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;

/** Office minutes, read as people say it. */
function officeTime(mins: number | null): string {
  if (mins === null) return '—';
  if (mins < 60) return `${mins} min`;
  if (mins < 9 * 60) return `${(mins / 60).toFixed(mins < 600 ? 1 : 0)} hrs`;
  const days = mins / (9 * 60);
  return `${days.toFixed(days < 10 ? 1 : 0)} office days`;
}

function monthLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' });
}

const LABELS: Record<string, string> = {
  ...ENQUIRY_SOURCE_LABELS,
  unknown: 'Not recorded',
  hot: 'Hot', warm: 'Warm', cold: 'Cold', unset: 'Not set',
  vans: 'Vans', backline: 'Backline', rehearsals: 'Rehearsals', other: 'Other / not known',
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1 text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  );
}

/** One breakdown: a row per key with the counts, the booking rate and the two times. */
function TallyTable({ title, note, rows, label = (k) => LABELS[k] || k, showValue = false }: {
  title: string;
  note?: string;
  rows: Tally[];
  label?: (key: string) => string;
  showValue?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
      <div className="overflow-x-auto mt-2">
        <table className="min-w-full text-sm">
          <thead className="text-xs text-gray-500 whitespace-nowrap">
            <tr>
              <th className="text-left font-semibold px-2 py-1" />
              <th className="text-right font-semibold px-2 py-1">Enquiries</th>
              <th className="text-right font-semibold px-2 py-1">Booked</th>
              <th className="text-right font-semibold px-2 py-1">Lost</th>
              <th className="text-right font-semibold px-2 py-1" title="Closed by the 09:00 sweep — start date passed with nobody deciding">Not followed up</th>
              <th className="text-right font-semibold px-2 py-1">Open</th>
              <th className="text-right font-semibold px-2 py-1" title="Booked ÷ (booked + lost + not followed up)">Booking rate</th>
              {showValue && <th className="text-right font-semibold px-2 py-1">Booked value</th>}
              <th className="text-right font-semibold px-2 py-1" title="Median, office hours, from first contact to our first email back">First reply</th>
              <th className="text-right font-semibold px-2 py-1" title="Median, office hours, from first contact to the first quote PDF sent">To quote</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 tabular-nums whitespace-nowrap">
            {rows.map((t) => (
              <tr key={t.key}>
                <td className="px-2 py-1.5 text-gray-900 whitespace-nowrap">{label(t.key)}</td>
                <td className="px-2 py-1.5 text-right">{t.enquiries}</td>
                <td className="px-2 py-1.5 text-right text-green-700">
                  {t.booked}
                  {t.cancelled > 0 && <span className="text-[11px] text-gray-400" title="Booked, then cancelled"> ({t.cancelled} cancelled)</span>}
                </td>
                <td className="px-2 py-1.5 text-right">{t.lost}</td>
                <td className="px-2 py-1.5 text-right text-amber-700">{t.notFollowedUp || '—'}</td>
                <td className="px-2 py-1.5 text-right text-gray-500">{t.open || '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{pct(t.rate)}</td>
                {showValue && <td className="px-2 py-1.5 text-right">{t.bookedValue > 0 ? gbp0(t.bookedValue) : '—'}</td>}
                <td className="px-2 py-1.5 text-right">
                  {officeTime(t.medianReplyMins)}
                  {t.replies > 0 && <span className="text-[11px] text-gray-400"> ({t.replies})</span>}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {officeTime(t.medianQuoteMins)}
                  {t.quotes > 0 && <span className="text-[11px] text-gray-400"> ({t.quotes})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function BusinessFiguresPage() {
  const role = useAuthStore((s) => s.user?.role);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [figures, setFigures] = useState<Figures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f?: string, t?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (f) qs.set('from', f);
      if (t) qs.set('to', t);
      const r = await api.get<{ data: Figures }>(`/business-figures/enquiries${qs.toString() ? `?${qs}` : ''}`);
      setFigures(r.data);
      setFrom(r.data.from);
      setTo(r.data.to);
    } catch (e) {
      setError((e as Error).message || 'Could not load the figures.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (role === 'admin') load(); }, [role, load]);

  if (role !== 'admin') {
    return <div className="p-6 text-sm text-gray-600">Business figures are for admins only.</div>;
  }

  const s = figures?.summary;
  const c = figures?.coverage;
  const decided = s ? s.total.booked + s.total.lost + s.total.notFollowedUp : 0;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Business figures <span className="ml-1 align-middle text-[11px] font-semibold text-violet-800 bg-violet-100 rounded-full px-2 py-0.5">Admin</span>
          </h1>
          <p className="text-sm text-gray-600 mt-0.5">
            Enquiries and what became of them · <Link to="/money/cashflow" className="text-ooosh-700 hover:underline">Cash forecast</Link>
            {loading && <span className="ml-2 text-gray-400">Updating…</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-600">
            <span className="block mb-0.5">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-gray-600">
            <span className="block mb-0.5">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <button type="button" onClick={() => load(from, to)} disabled={loading}
            className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">Show</button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {!figures && !error && <p className="text-sm text-gray-500">Counting…</p>}

      {s && c && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Enquiries" value={String(s.total.enquiries)} sub={`${s.total.open} still open`} />
            <Tile label="Booking rate" value={pct(s.total.rate)}
              sub={`${s.total.booked} booked of ${decided} decided${s.total.cancelled ? ` (${s.total.cancelled} later cancelled)` : ''}`} />
            <Tile label="Lost · not followed up" value={`${s.total.lost} · ${s.total.notFollowedUp}`}
              sub={decided ? `${pct(s.total.notFollowedUp / decided)} of decided enquiries were never followed up` : undefined} />
            <Tile label="First reply · to quote" value={`${officeTime(s.total.medianReplyMins)} · ${officeTime(s.total.medianQuoteMins)}`}
              sub={`Medians in office hours (${figures.officeHours})`} />
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-0.5">
            <p><b>How much to trust this.</b> {c.withChannel} of {c.enquiries} enquiries say how they got in touch (asked on every new enquiry since 6 Nov 2026).
              A first email back was found for {c.withReply}{c.earliestEmail ? ` (emails go back to ${new Date(`${c.earliestEmail}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})` : ''}; a quote PDF for {c.withQuote}.</p>
            <p>An enquiry made in HireHop is dated when it was keyed in, not when the client got in touch. "First reply" is our first <i>email</i> — a phone call back doesn't show.
              Fast replies also tend to go to the easy enquiries, so compare like with like (the same channel or likelihood) before reading anything into speed.</p>
          </div>

          <TallyTable title="By month" note="By the month the enquiry arrived." rows={s.byMonth} label={monthLabel} showValue />
          <div className="space-y-3">
            <TallyTable title="How they got in touch" rows={s.byChannel} />
            <TallyTable title="Likelihood" note="As set on the enquiry." rows={s.byLikelihood} />
            <TallyTable title="Job value (inc VAT)" rows={s.byValue} />
            <TallyTable title="What they wanted" note="A van + backline hire counts under both." rows={s.byService} />
          </div>
          <TallyTable title="Where they heard about us"
            note="What they told us — the website form's optional question, or staff on New Enquiry / the job page (asked from Nov 2026)."
            rows={s.byHeardAbout} label={(k) => (k === 'not_asked' ? 'Not asked / not answered' : HEARD_ABOUT_LABELS[k] || k)} showValue />
          <div className="space-y-3">
            <TallyTable title="What the website saw"
              note="Website enquiries only: the ad, campaign tag, tracked link or site that sent them on their first visit (stored only with cookie consent)."
              rows={s.byTracked} showValue />
            <TallyTable title="New or returning clients"
              note="Returning = the client had booked with us before this enquiry. Worked out from history, never asked."
              rows={s.byClientType} showValue />
          </div>
          <TallyTable title="Reply speed and booking"
            note="Enquiries we emailed back, by how long the first email took in office hours. Read with care — see above."
            rows={s.byReplySpeed} />
          <div className="space-y-3">
            <TallyTable title="Who took the enquiry" note="The job's Ooosh manager, else whoever created it in OP. HireHop-made jobs often have neither." rows={s.byOwner} />
            <TallyTable title="Who sent the first reply" note="By the address it came from. Replies from info@ can't be put to a person." rows={s.byReplier} />
          </div>

          {s.lostReasons.length > 0 && (
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-gray-900">Why they were lost</h2>
              <p className="text-xs text-gray-500 mt-0.5">Lost by a person. "Not followed up" is counted separately, above.</p>
              <div className="mt-2 space-y-1">
                {s.lostReasons.map((l) => (
                  <div key={l.reason} className="flex justify-between gap-3 text-sm">
                    <span className="text-gray-800">{l.reason}</span>
                    <span className="tabular-nums text-gray-600">{l.count} <span className="text-gray-400">({pct(l.count / Math.max(s.total.lost, 1))})</span></span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
