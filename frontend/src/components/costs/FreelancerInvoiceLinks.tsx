import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { displayFullName } from '../../lib/displayName';

// ---------------------------------------------------------------------------
// "Whose invoice? Which work?" — the freelancer half of capturing a freelancer
// invoice (docs/FREELANCER-PORTAL-SPEC.md §5, jon, Oct 2026).
//
// The freelancer still emails their invoice (PDF) to whoever booked them; the
// office uploads it here and says whose it is and which of their work it
// covers. That is what the portal's Earnings tab reads, so a freelancer can
// see "Invoice FL-101: approved, paid Fri 7 Nov" instead of chasing.
//
// - "Whose invoice?" is filled in from the letterhead when it can be
//   (remembered from last time → an earlier remittance → one freelancer by
//   name). A suggestion: staff confirm it.
// - "Which work?" lists their finished work with the fee they were booked at
//   and the quote's expense estimate. Ticking is all staff do: each item's
//   share of the invoice is worked out in proportion to what was booked.
// - Booked vs invoiced: fees are fixed, expenses are estimates, so the invoice
//   is "about right" up to the larger of £X or Y% over the estimate (Settings).
//   Amber past that. Never blocks the save.
// ---------------------------------------------------------------------------

export interface FreelancerWorkItem {
  key: string;
  kind: 'booking' | 'run' | 'sitter' | 'yard';
  date: string;
  title: string;
  detail: string | null;
  jobId: string | null;
  hhJobNumber: number | null;
  jobName: string | null;
  fee: number;
  estimate: number;
  estimateParts: { label: string; amount: number }[];
  invoicedOn: { costId: string; invoiceNumber: string | null; supplierName: string | null; amount: number }[];
  linkedAmount: number | null;
}

export interface PickedPerson { id: string; name: string }

/**
 * Why a freelancer invoice was saved with no work ticked: asked on save, not
 * required (jon, Oct 2026). Stored on `costs.work_unmatched_reason` and shown
 * in the Costs list. "Later" is asked again on the next save.
 */
export const UNMATCHED_REASONS: { code: string; label: string; short: string }[] = [
  { code: 'person_not_in_op', label: 'The freelancer isn’t in OP', short: 'Not matched: freelancer not in OP' },
  { code: 'work_not_in_op', label: 'The work isn’t in OP', short: 'Not matched: work not in OP' },
  { code: 'later', label: 'I’ll match it later', short: 'Not matched yet' },
];

interface Suggestion { person: { id: string; name: string; email: string | null } | null; source: 'remembered' | 'remittance' | 'name' | 'none' }

const SOURCE_NOTE: Record<string, string> = {
  remembered: 'Same letterhead as an earlier invoice of theirs.',
  remittance: 'A remittance for this letterhead went to them before.',
  name: 'Matched by name.',
};

const gbp = (n: number) => `£${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (Number.isNaN(dt.getTime())) return ymd;
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Each ticked item's share of the invoice, in proportion to what was booked
 * (fee + estimate). Pennies, the last item takes the odd one, so the shares
 * always add back to the invoice.
 */
export function shareInvoice(items: FreelancerWorkItem[], gross: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!items.length) return out;
  const weights = items.map((it) => Math.max(0, it.fee + it.estimate) || 1);
  const total = weights.reduce((t, w) => t + w, 0);
  const pence = Math.round(Math.max(0, gross) * 100);
  let given = 0;
  items.forEach((it, i) => {
    const share = i === items.length - 1 ? pence - given : Math.round((pence * weights[i]) / total);
    given += share;
    out[it.key] = share / 100;
  });
  return out;
}

export default function FreelancerInvoiceLinks({
  costId, supplierName, person, personTouched, onPersonChange, ticked, ticksTouched, onTickedChange,
  invoiceGross, invoiceNet, onWorkLoaded,
}: {
  costId: string | null;
  supplierName: string;
  person: PickedPerson | null;
  /** True once staff picked or cleared the person themselves: suggestions stop. */
  personTouched: boolean;
  onPersonChange: (p: PickedPerson | null, byUser: boolean) => void;
  ticked: string[];
  ticksTouched: boolean;
  /** byUser false = the edit modal's existing links arriving, not a change. */
  onTickedChange: (keys: string[], byUser: boolean) => void;
  invoiceGross: number;
  /** Before VAT; the comparison with booked fees is net (VAT-registered freelancers add VAT). */
  invoiceNet: number;
  /** The loaded work, so the modal can share the invoice across it at save. */
  onWorkLoaded: (items: FreelancerWorkItem[]) => void;
}) {
  const [suggestNote, setSuggestNote] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PickedPerson[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [items, setItems] = useState<FreelancerWorkItem[]>([]);
  const [tolerance, setTolerance] = useState<{ gbp: number; pct: number }>({ gbp: 10, pct: 25 });
  const [showInvoiced, setShowInvoiced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seededFor = useRef<string | null>(null);

  // "Whose invoice?" from the letterhead, until staff choose for themselves.
  useEffect(() => {
    if (personTouched || person || !supplierName.trim()) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ supplier_name: supplierName.trim(), ...(costId ? { cost_id: costId } : {}) });
        const r = await api.get<{ data: Suggestion }>(`/costs/freelancer-person-suggest?${qs}`);
        if (cancelled || !r.data.person) return;
        onPersonChange({ id: r.data.person.id, name: r.data.person.name }, false);
        setSuggestNote(SOURCE_NOTE[r.data.source] || '');
      } catch { /* a suggestion is optional */ }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [supplierName, personTouched, person, costId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Person search.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<{ id: string; first_name: string; last_name: string; preferred_name?: string | null; email?: string | null }> }>(
          `/people?search=${encodeURIComponent(q)}&is_freelancer=true&limit=8`);
        if (!cancelled) setResults(r.data.map((p) => ({ id: p.id, name: displayFullName(p) })));
      } catch { if (!cancelled) setResults([]); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  // Their work.
  useEffect(() => {
    if (!person) { setItems([]); onWorkLoaded([]); return; }
    let cancelled = false;
    setLoading(true); setError('');
    const qs = new URLSearchParams({ person_id: person.id, ...(costId ? { cost_id: costId } : {}), ...(showInvoiced ? { include_invoiced: '1' } : {}) });
    api.get<{ data: { items: FreelancerWorkItem[]; tolerance: { gbp: number; pct: number } } }>(`/costs/freelancer-work?${qs}`)
      .then((r) => {
        if (cancelled) return;
        setItems(r.data.items);
        setTolerance(r.data.tolerance);
        onWorkLoaded(r.data.items);
        // The edit modal: tick what this invoice is already linked to, once.
        if (!ticksTouched && seededFor.current !== person.id) {
          seededFor.current = person.id;
          onTickedChange(r.data.items.filter((i) => i.linkedAmount != null).map((i) => i.key), false);
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load their work'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [person?.id, costId, showInvoiced]); // eslint-disable-line react-hooks/exhaustive-deps

  const tickedItems = useMemo(() => items.filter((i) => ticked.includes(i.key)), [items, ticked]);
  const shares = useMemo(() => shareInvoice(tickedItems, invoiceGross), [tickedItems, invoiceGross]);
  const fees = round2(tickedItems.reduce((t, i) => t + i.fee, 0));
  const estimate = round2(tickedItems.reduce((t, i) => t + i.estimate, 0));
  const allowed = round2(Math.max(tolerance.gbp, (estimate * tolerance.pct) / 100));
  const over = round2(invoiceNet - fees - estimate);

  const toggle = (key: string) => {
    onTickedChange(ticked.includes(key) ? ticked.filter((k) => k !== key) : [...ticked, key], true);
  };

  return (
    <div className="rounded-md border border-purple-200 bg-purple-50/40 px-3 py-3 space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Whose invoice?</label>
        {person ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-3 py-1.5 text-sm bg-white text-purple-800 rounded-md border border-purple-200">{person.name}</span>
            <button type="button" className="text-xs text-red-600 hover:underline"
              onClick={() => { onPersonChange(null, true); setSuggestNote(''); onTickedChange([], true); }}>
              Change
            </button>
            {suggestNote && !personTouched && <span className="text-xs text-gray-500">{suggestNote} Check it&apos;s right.</span>}
          </div>
        ) : (
          <div className="relative">
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              value={search} onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)} onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              placeholder="Search freelancers by name" autoComplete="off" />
            {searchOpen && results.length > 0 && (
              <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                {results.map((p) => (
                  <button key={p.id} type="button"
                    onMouseDown={(e) => { e.preventDefault(); onPersonChange(p, true); setSearch(''); setResults([]); setSuggestNote(''); }}
                    className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-400 mt-1">Their Earnings page in the portal shows this invoice once it&apos;s linked.</p>
          </div>
        )}
      </div>

      {person && (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <label className="block text-sm font-medium text-gray-700">Which work does it cover?</label>
            <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showInvoiced} onChange={(e) => setShowInvoiced(e.target.checked)} />
              Show work already on another invoice
            </label>
          </div>
          {loading && <p className="text-xs text-gray-400">Loading their work…</p>}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {!loading && !error && items.length === 0 && (
            <p className="text-xs text-gray-500">
              Nothing finished in the last 12 months that isn&apos;t already invoiced.
              {!showInvoiced && ' Tick "Show work already on another invoice" to see the rest.'}
            </p>
          )}
          {items.length > 0 && (
            <div className="max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
              {items.map((it) => {
                const on = ticked.includes(it.key);
                return (
                  <label key={it.key} className={`flex items-start gap-2 px-2.5 py-2 text-sm cursor-pointer ${on ? 'bg-purple-50' : 'hover:bg-gray-50'}`}>
                    <input type="checkbox" className="mt-0.5" checked={on} onChange={() => toggle(it.key)} />
                    {/* Date with the job number under it, always in this column, so the
                        numbers line up to match against the invoice (jon, Oct 2026). */}
                    <span className="w-[5.5rem] shrink-0 tabular-nums">
                      <span className="block text-gray-500">{fmtDay(it.date)}</span>
                      {it.hhJobNumber && <span className="block text-xs text-purple-700" title={it.jobName || undefined}>#{it.hhJobNumber}</span>}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-gray-800">{it.title}</span>
                      {it.detail && <span className="block text-xs text-gray-500 truncate">{it.detail}</span>}
                      {it.invoicedOn.length > 0 && (
                        <span className="block text-xs text-amber-700">
                          Already on {it.invoicedOn.map((o) => o.invoiceNumber ? `#${o.invoiceNumber}` : (o.supplierName || 'another invoice')).join(', ')}
                        </span>
                      )}
                    </span>
                    <span className="text-right shrink-0 tabular-nums">
                      <span className="block text-gray-800">{gbp(it.fee)}</span>
                      {it.estimate > 0 && (
                        <span className="block text-xs text-gray-500" title={it.estimateParts.map((p) => `${p.label} ${gbp(p.amount)}`).join(' · ')}>
                          + {gbp(it.estimate)} est.
                        </span>
                      )}
                      {on && invoiceGross > 0 && <span className="block text-[11px] text-purple-700">{gbp(shares[it.key] ?? 0)} of this</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {tickedItems.length > 0 && (
            <div className="mt-2 text-xs space-y-1">
              <div className="text-gray-600">
                Booked fees <strong>{gbp(fees)}</strong>
                {estimate > 0 && <> + expenses estimated <strong>{gbp(estimate)}</strong></>}
                {' '}= <strong>{gbp(round2(fees + estimate))}</strong> · invoice before VAT <strong>{gbp(invoiceNet)}</strong>
              </div>
              {invoiceNet <= 0 ? (
                <div className="text-gray-500">Enter the invoice amount to compare it with what was booked.</div>
              ) : invoiceNet < fees - 0.5 ? (
                <div className="rounded px-2 py-1 bg-sky-50 text-sky-800">
                  {gbp(round2(fees - invoiceNet))} less than the booked fees. Fine if that&apos;s what they charged; a missed job is the usual reason.
                </div>
              ) : over <= allowed ? (
                <div className="rounded px-2 py-1 bg-emerald-50 text-emerald-800">
                  About right{over > 0.5 ? `: ${gbp(over)} over the estimate, inside the ${gbp(allowed)} allowed` : ''}.
                </div>
              ) : (
                <div className="rounded px-2 py-1 bg-amber-50 text-amber-800">
                  {gbp(over)} more than the booked fees and estimated expenses ({gbp(allowed)} is allowed). Worth a look before it&apos;s approved: Query it below if you need to ask them.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
