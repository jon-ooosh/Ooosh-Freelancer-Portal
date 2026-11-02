import { useEffect, useRef, useState } from 'react';
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
// - "Whose invoice?" (this file's picker) is filled in from the letterhead when
//   it can be (remembered from last time → an earlier remittance → one
//   freelancer by name). A suggestion: staff confirm it.
// - "Which work?" is the capture form's Jobs table (CostJobsTable.tsx), fed by
//   useFreelancerWork() below: their finished work with the fee they were
//   booked at and the quote's expense estimate. Ticking a row links the cost
//   to that job too (DECISIONS.md, Oct 2026).
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
  /** The bookings behind the row: a run's stops can be on different jobs; a studio evening or yard day is on none. */
  parts?: { kind: 'booking' | 'sitter' | 'yard'; id: string; weight: number; jobId: string | null; hhJobNumber?: number | null; jobName?: string | null }[];
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

/**
 * Their work, for the Jobs table. `onSeed` is called once per person with the
 * work this invoice is already linked to (the edit form ticks it), unless staff
 * have already ticked something themselves.
 */
export function useFreelancerWork(
  person: PickedPerson | null, costId: string | null, showInvoiced: boolean,
  ticksTouched: boolean, onSeed: (keys: string[], items: FreelancerWorkItem[]) => void,
) {
  const [items, setItems] = useState<FreelancerWorkItem[]>([]);
  const [tolerance, setTolerance] = useState<{ gbp: number; pct: number }>({ gbp: 10, pct: 25 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!person) { setItems([]); return; }
    let cancelled = false;
    setLoading(true); setError('');
    const qs = new URLSearchParams({ person_id: person.id, ...(costId ? { cost_id: costId } : {}), ...(showInvoiced ? { include_invoiced: '1' } : {}) });
    api.get<{ data: { items: FreelancerWorkItem[]; tolerance: { gbp: number; pct: number } } }>(`/costs/freelancer-work?${qs}`)
      .then((r) => {
        if (cancelled) return;
        setItems(r.data.items);
        setTolerance(r.data.tolerance);
        // The edit form: tick what this invoice is already linked to, once.
        if (!ticksTouched && seededFor.current !== person.id) {
          seededFor.current = person.id;
          onSeed(r.data.items.filter((i) => i.linkedAmount != null).map((i) => i.key), r.data.items);
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load their work'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [person?.id, costId, showInvoiced]); // eslint-disable-line react-hooks/exhaustive-deps

  return { items, tolerance, loading, error };
}

/** "Whose invoice?": the freelancer this bill is from. */
export default function FreelancerPersonPicker({
  costId, supplierName, person, personTouched, onPersonChange,
}: {
  costId: string | null;
  supplierName: string;
  person: PickedPerson | null;
  /** True once staff picked or cleared the person themselves: suggestions stop. */
  personTouched: boolean;
  onPersonChange: (p: PickedPerson | null, byUser: boolean) => void;
}) {
  const [suggestNote, setSuggestNote] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PickedPerson[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

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

  return (
    <div>
      <div className="text-xs text-gray-500 mb-0.5">Freelancer</div>
      {person ? (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium text-purple-800">{person.name}</span>
          <button type="button" className="text-xs text-purple-700 hover:underline"
            onClick={() => { onPersonChange(null, true); setSuggestNote(''); }}>
            Change
          </button>
          {suggestNote && !personTouched && <span className="text-xs text-gray-500">{suggestNote} Check it&apos;s right.</span>}
        </div>
      ) : (
        <div className="relative">
          <input className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            value={search} onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)} onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            placeholder="Whose invoice? Search freelancers by name" autoComplete="off" />
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
  );
}
