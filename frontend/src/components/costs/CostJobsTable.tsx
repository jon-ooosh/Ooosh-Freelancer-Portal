import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import type { FreelancerWorkItem, PickedPerson } from './FreelancerInvoiceLinks';
import { type JobChoice, type WhoPays, type SplitPlan, jobLabel, lockedLabel, newChoice, parseJobSearchName, rowVerdict } from './costJobs';
import type { JobInfo } from './useJobInfo';

// ---------------------------------------------------------------------------
// "Jobs and who pays" — the capture form's one place for which job(s) a cost is
// on and who pays for each (docs/design/cost-capture-redesign/DECISIONS.md).
// It replaced "Which work does it cover?", "Link to job", "Is this part of a
// quote?", the recharge selects and the separate split modal.
//
// A freelancer's invoice lists their booked work: ticking a row links the cost
// to that job, ticking several splits it. Any other cost lists the jobs added
// by hand, each with its share. Every job gets ONE who-pays answer. The logic
// lives in costJobs.ts; this file only draws it.
// ---------------------------------------------------------------------------

interface JobSuggestion { id: string; type: string; name: string; subtitle?: string }

export interface FreelancerTable {
  person: PickedPerson | null;
  items: FreelancerWorkItem[];
  tolerance: { gbp: number; pct: number };
  loading: boolean;
  error: string;
  ticked: string[];
  onToggle: (key: string) => void;
  /** Invoiced figures staff typed, per row (gross). */
  typed: Record<string, string>;
  onTyped: (key: string, value: string | undefined) => void;
  /** Each ticked row's share of the invoice (gross): typed, else in proportion. */
  amounts: Record<string, number>;
  showInvoiced: boolean;
  onShowInvoiced: (v: boolean) => void;
  /** Adds a line to the question for the freelancer. */
  onAsk: (text: string) => void;
}

const gbp = (n: number) => `£${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function fmtDay(ymd: string): string {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (Number.isNaN(dt.getTime())) return String(ymd);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const WHO_PAYS: { v: WhoPays; label: string }[] = [
  { v: 'quote', label: 'Already in quote' },
  { v: 'charge', label: 'Charge to client' },
  { v: 'ours', label: 'We cover it' },
];

const CHIP: Record<'ok' | 'over' | 'under', string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  over: 'bg-red-50 text-red-700',
  under: 'bg-sky-50 text-sky-700',
};

export default function CostJobsTable({
  gross, netRatio, choices, onChoices, whoPaysOf, partOf, amounts, plan, info, wholeLocked, readOnly,
  freelancer, suggestedJobNumber, onDismissSuggestion, sectionRef,
}: {
  gross: number;
  /** Net ÷ gross of the invoice, to compare and recharge before VAT. */
  netRatio: number;
  choices: JobChoice[];
  onChoices: (next: JobChoice[]) => void;
  /** Each job's answer (its own, or the default while nobody has chosen). */
  whoPaysOf: (c: JobChoice) => WhoPays;
  /** The "Only part?" figure in force (a freelancer's defaults to what they invoiced over their fee). */
  partOf: (c: JobChoice) => string;
  /** Gross per job, from choiceAmounts(). */
  amounts: Map<string, number>;
  plan: SplitPlan;
  info: Record<string, JobInfo>;
  /** Set when the cost is recharged as a whole and that has to stand: who pays per job is fixed. */
  wholeLocked: string | null;
  /** Set while the jobs can't be changed (an edit whose split hasn't loaded). */
  readOnly: string | null;
  freelancer: FreelancerTable | null;
  suggestedJobNumber: string | null;
  onDismissSuggestion: () => void;
  sectionRef?: React.Ref<HTMLDivElement>;
}) {
  const [adding, setAdding] = useState(false);
  const [jobSearch, setJobSearch] = useState('');
  const [jobSuggestions, setJobSuggestions] = useState<JobSuggestion[]>([]);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const amountRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [focusJob, setFocusJob] = useState<string | null>(null);

  // Job search — the global search, jobs only.
  useEffect(() => {
    if (jobSearch.trim().length < 2) { setJobSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(jobSearch.trim())}&limit=10`);
        setJobSuggestions((r.results || []).filter((x) => x.type === 'job').slice(0, 8));
      } catch { setJobSuggestions([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [jobSearch]);

  // A job just added by hand: put the cursor in its amount.
  useEffect(() => {
    if (!focusJob) return;
    amountRefs.current[focusJob]?.focus();
    setFocusJob(null);
  }, [focusJob, choices]);

  const patch = (jobId: string, p: Partial<JobChoice>) =>
    onChoices(choices.map((c) => (c.jobId === jobId ? { ...c, ...p } : c)));

  function addJob(s: { id: string; name: string }) {
    setJobSearch(''); setJobSuggestions([]); setAdding(false); setLinkError('');
    if (choices.some((c) => c.jobId === s.id)) return;
    const c = newChoice({ jobId: s.id, ...parseJobSearchName(s.name) }, true);
    // A new row takes whatever isn't on a job yet, when every job's share is
    // typed (a blank job already takes the rest, and ticked work fills its pot).
    const allTyped = choices.length > 0 && choices.every((x) => x.amount.trim() !== '');
    if (!freelancer && allTyped && plan.overheads > 0) c.amount = plan.overheads.toFixed(2);
    onChoices([...choices, c]);
    if (choices.length > 0) setFocusJob(s.id);
  }

  async function linkSuggested() {
    if (!suggestedJobNumber) return;
    setLinking(true); setLinkError('');
    try {
      const r = await api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(suggestedJobNumber)}&limit=10`);
      const job = (r.results || []).find((x) => x.type === 'job' && parseJobSearchName(x.name).hhJobNumber === Number(suggestedJobNumber));
      if (job) { addJob(job); onDismissSuggestion(); }
      else setLinkError(`Couldn't find job #${suggestedJobNumber}. Search for it instead.`);
    } catch {
      setLinkError('The job lookup failed. Search for it instead.');
    } finally {
      setLinking(false);
    }
  }

  function removeJob(c: JobChoice) {
    if (c.allocationId && c.touched && c.whoPays === 'charge'
      && !window.confirm(`${jobLabel(c)} is waiting to be recharged to the client. Take it off this cost anyway? Its recharge goes with it.`)) return;
    onChoices(choices.filter((x) => x.jobId !== c.jobId));
  }

  const onWork = new Set<string>();
  if (freelancer) {
    for (const it of freelancer.items) {
      if (!freelancer.ticked.includes(it.key)) continue;
      for (const p of (it.parts?.length ? it.parts : [{ jobId: it.jobId }])) if (p.jobId) onWork.add(p.jobId);
    }
  }
  // Ticked work on no job (studio evenings, yard days): overheads by design.
  const noJobWork = freelancer
    ? round2(freelancer.items
      .filter((it) => freelancer.ticked.includes(it.key) && !(it.parts?.length ? it.parts : [{ jobId: it.jobId }]).some((p) => p.jobId))
      .reduce((t, it) => t + (freelancer.amounts[it.key] ?? 0), 0))
    : 0;

  const searchBox = (
    <div className="relative mt-2">
      <input autoFocus className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
        value={jobSearch} onChange={(e) => setJobSearch(e.target.value)}
        onBlur={() => setTimeout(() => { if (!jobSearch.trim()) setAdding(false); }, 200)}
        placeholder="Search by job number or name" autoComplete="off" />
      {jobSuggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
          {jobSuggestions.map((s) => (
            <button key={s.id} type="button" onMouseDown={(e) => { e.preventDefault(); addJob(s); }}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
              {s.name}{s.subtitle ? <span className="text-gray-400"> · {s.subtitle}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const hint = freelancer?.person ? 'Tick the work this invoice covers' : choices.length ? 'Add another job to split the cost' : '';

  return (
    <div ref={sectionRef} className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 border-b border-gray-100 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Jobs and who pays</h3>
        {hint && !readOnly && <span className="text-xs text-gray-400">{hint}</span>}
      </div>

      {readOnly ? (
        <p className="text-sm text-gray-500">{readOnly}</p>
      ) : (
        <>
          {wholeLocked && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-3 py-2">{wholeLocked}</p>
          )}

          {suggestedJobNumber && choices.length === 0 && (
            <button type="button" onClick={linkSuggested} disabled={linking}
              className="w-full px-3 py-2 text-sm text-left rounded-md border border-purple-200 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-50">
              📎 Looks like <strong>job #{suggestedJobNumber}</strong> on this document. {linking ? 'Linking…' : 'Link it'}
            </button>
          )}
          {linkError && <p className="text-xs text-red-600">{linkError}</p>}

          {/* A freelancer's booked work. Ticking is what links the jobs. */}
          {freelancer && !freelancer.person && (
            <p className="text-sm text-gray-500">Say whose invoice it is (above) to list their booked work.</p>
          )}
          {freelancer?.person && (
            <WorkRows f={freelancer} netRatio={netRatio} gross={gross} open={open} setOpen={setOpen} />
          )}

          {/* One row per job: its share and who pays for it. */}
          {choices.length > 0 && (
            <div className="rounded-md border border-gray-200 divide-y divide-gray-100">
              {choices.map((c) => {
                const ji = info[c.jobId];
                const amount = amounts.get(c.jobId) ?? 0;
                const fromWork = onWork.has(c.jobId);
                const w = whoPaysOf(c);
                const isFreelance = Boolean(freelancer);
                const blankIsRest = !fromWork && c.amount.trim() === '' && amount > 0;
                return (
                  <div key={c.jobId} className="px-3 py-2.5 space-y-2">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate" title={jobLabel(c)}>
                          {c.hhJobNumber ? <span className="text-purple-700">#{c.hhJobNumber}</span> : null}
                          {c.hhJobNumber ? ' ' : ''}{c.jobName || (c.hhJobNumber ? '' : 'Job (no HireHop number)')}
                        </div>
                        {ji?.loaded && (ji.clientQuoted > 0 || ji.costsSoFar > 0 || ji.rechargesRunningCosts || ji.rechargeExpected.length > 0) && (
                          <div className="text-xs text-gray-500">
                            {[
                              ji.clientQuoted > 0 ? `Quote ${gbp(ji.clientQuoted)}` : null,
                              `costs so far ${gbp(ji.costsSoFar)}`,
                              ji.rechargesRunningCosts ? 'recharges running costs' : null,
                              ji.rechargeExpected.length ? `expects to recharge ${ji.rechargeExpected.join(', ')}` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        {fromWork ? (
                          <>
                            <div className="text-sm font-semibold text-gray-800 tabular-nums">{gbp(amount)}</div>
                            <div className="text-[11px] text-gray-400">from the ticked work</div>
                          </>
                        ) : (
                          <input type="number" step="0.01" min="0" inputMode="decimal"
                            ref={(el) => { amountRefs.current[c.jobId] = el; }}
                            className="w-28 border border-gray-300 rounded-md px-2 py-1 text-sm text-right tabular-nums"
                            value={c.amount}
                            placeholder={blankIsRest ? `${amount.toFixed(2)}${choices.length > 1 ? ' (rest)' : ''}` : '0.00'}
                            title="This job's share of the invoice, VAT included. Leave one blank and it takes the rest."
                            onChange={(e) => patch(c.jobId, { amount: e.target.value })} />
                        )}
                      </div>
                      {c.manual && !c.locked && !fromWork && (
                        <button type="button" onClick={() => removeJob(c)} title="Take this job off the cost"
                          className="px-1 text-gray-400 hover:text-red-600 shrink-0">&times;</button>
                      )}
                    </div>

                    {c.locked ? (
                      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-800">
                        {lockedLabel(c.locked)}: who pays can&apos;t change here
                      </span>
                    ) : wholeLocked ? null : (
                      <div>
                        <div className="inline-flex rounded-md bg-gray-100 p-0.5 text-xs">
                          {WHO_PAYS.map((o) => (
                            <button key={o.v} type="button"
                              onClick={() => patch(c.jobId, {
                                whoPays: o.v, touched: true,
                                // A freelancer's fee is in the quote: only part of it is ever charged.
                                ...(o.v === 'charge' && isFreelance ? { partOpen: true } : {}),
                              })}
                              className={`px-2.5 py-1 rounded ${w === o.v ? 'bg-purple-600 text-white font-medium' : 'text-gray-700 hover:bg-white'}`}>
                              {o.label}
                            </button>
                          ))}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {w === 'quote' && 'Client has already been charged for this.'}
                          {w === 'ours' && <><strong>Not in quote</strong>, but we&apos;re not recharging the client.</>}
                          {w === 'charge' && !isFreelance && !c.partOpen && (
                            <>
                              <strong>Not in quote:</strong> recharged with the markup after the hire.{' '}
                              <button type="button" className="text-purple-700 hover:underline" onClick={() => patch(c.jobId, { partOpen: true })}>Only part?</button>
                            </>
                          )}
                          {w === 'charge' && (isFreelance || c.partOpen) && (
                            <span className="inline-flex items-center gap-1.5 flex-wrap">
                              <strong>{isFreelance ? 'Their fee is already in the quote.' : 'Not in quote.'}</strong>
                              Charge the client £
                              <input type="number" step="0.01" min="0" inputMode="decimal"
                                className="w-24 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right"
                                value={isFreelance && c.part === '' ? partOf(c) : c.part}
                                placeholder="0.00"
                                onChange={(e) => patch(c.jobId, { part: e.target.value, touched: true })} />
                              <span>before VAT{isFreelance ? ' (what they invoiced over their fee)' : ''}; markup added when it&apos;s billed.</span>
                              {!isFreelance && (
                                <button type="button" className="text-purple-700 hover:underline"
                                  onClick={() => patch(c.jobId, { partOpen: false, part: '' })}>Charge all of it</button>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {choices.length === 0 && !adding && (
            <div className="rounded-md border border-dashed border-gray-300 px-3 py-3 text-sm text-gray-500 flex items-center justify-between gap-2 flex-wrap">
              <span>Not linked to a job, so it goes to overheads.</span>
              <button type="button" onClick={() => setAdding(true)} className="text-purple-700 hover:underline">+ Link to a job</button>
            </div>
          )}
          {choices.length > 0 && !adding && (
            <button type="button" onClick={() => setAdding(true)} className="text-sm text-purple-700 hover:underline">
              {freelancer?.person ? '+ Add a job not in their booked work' : '+ Add another job'}
            </button>
          )}
          {adding && searchBox}

          {/* Where the invoice lands. Over is refused (the server refuses it too). */}
          {(choices.length > 1 || plan.over > 0.005 || (choices.length > 0 && plan.overheads > 0.005)) && (
            plan.over > 0.005 ? (
              <div className="text-xs rounded px-3 py-2 bg-red-50 text-red-700">
                The jobs add up to {gbp(plan.onJobs)}: {gbp(plan.over)} more than the invoice ({gbp(gross)}). Take some off a job.
              </div>
            ) : plan.overheads > 0.005 ? (
              Math.abs(plan.overheads - noJobWork) < 0.01 ? (
                <div className="text-xs rounded px-3 py-2 bg-gray-50 text-gray-600">
                  {gbp(plan.overheads)} is studio evenings or yard days, which stay with overheads.
                </div>
              ) : (
                <div className="text-xs rounded px-3 py-2 bg-amber-50 text-amber-800">
                  {gbp(plan.overheads)} of {gbp(gross)} isn&apos;t on a job. Fine if it&apos;s overheads; otherwise tick or add a job.
                </div>
              )
            ) : (
              <div className="text-xs rounded px-3 py-2 bg-emerald-50 text-emerald-800">
                ✓ Invoice {gbp(gross)} · on jobs {gbp(plan.onJobs)}
              </div>
            )
          )}
          {plan.empty.length > 0 && (
            <div className="text-xs rounded px-3 py-2 bg-amber-50 text-amber-800">
              Type {plan.empty.map(jobLabel).join(', ')}&apos;s share, or take {plan.empty.length === 1 ? 'it' : 'them'} off.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A freelancer's booked work: tick, the invoiced figure per row, and the booked-vs-invoiced check. */
function WorkRows({ f, netRatio, gross, open, setOpen }: {
  f: FreelancerTable; netRatio: number; gross: number;
  open: Record<string, boolean>; setOpen: (o: Record<string, boolean>) => void;
}) {
  const tickedItems = f.items.filter((i) => f.ticked.includes(i.key));
  const fees = round2(tickedItems.reduce((t, i) => t + i.fee, 0));
  const estimate = round2(tickedItems.reduce((t, i) => t + i.estimate, 0));
  const allowed = round2(Math.max(f.tolerance.gbp, (estimate * f.tolerance.pct) / 100));
  const invoiceNet = round2(gross * netRatio);
  const over = round2(invoiceNet - fees - estimate);

  return (
    <div>
      <div className="flex justify-end mb-1">
        <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
          <input type="checkbox" checked={f.showInvoiced} onChange={(e) => f.onShowInvoiced(e.target.checked)} />
          Show work already on another invoice
        </label>
      </div>
      {f.loading && <p className="text-xs text-gray-400">Loading their work…</p>}
      {f.error && <p className="text-xs text-red-600">{f.error}</p>}
      {!f.loading && !f.error && f.items.length === 0 && (
        <p className="text-xs text-gray-500">
          Nothing finished in the last 12 months that isn&apos;t already invoiced.
          {!f.showInvoiced && ' Tick "Show work already on another invoice" to see the rest.'}
        </p>
      )}
      {f.items.length > 0 && (
        <div className="max-h-96 overflow-y-auto rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
          {f.items.map((it) => {
            const on = f.ticked.includes(it.key);
            const amt = f.amounts[it.key] ?? 0;
            const typed = f.typed[it.key] !== undefined && f.typed[it.key].trim() !== '';
            const verdict = on && typed ? rowVerdict(round2(amt * netRatio), it.fee, it.estimate, f.tolerance) : null;
            const noJob = !(it.parts?.length ? it.parts : [{ jobId: it.jobId }]).some((p) => p.jobId);
            const isOpen = open[it.key] ?? (verdict?.tone === 'over');
            return (
              <div key={it.key} className={on ? 'bg-purple-50/60' : ''}>
                <div className="flex items-start gap-2 px-2.5 py-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={on} onChange={() => f.onToggle(it.key)}
                    aria-label={`${it.title}, ${fmtDay(it.date)}`} />
                  {/* Date with the job number under it, always in this column, so the
                      numbers line up to match against the invoice (jon, Oct 2026). */}
                  <span className="w-[5.5rem] shrink-0 tabular-nums">
                    <span className="block text-gray-500">{fmtDay(it.date)}</span>
                    {it.hhJobNumber
                      ? <span className="block text-xs text-purple-700" title={it.jobName || undefined}>#{it.hhJobNumber}</span>
                      : noJob ? <span className="block text-[11px] text-gray-400">no job</span> : null}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-gray-800">{it.title}</span>
                    {it.detail && <span className="block text-xs text-gray-500 truncate">{it.detail}</span>}
                    {noJob && <span className="block text-xs text-gray-400">Not on a job, so it stays with overheads.</span>}
                    {it.invoicedOn.length > 0 && (
                      <span className="block text-xs text-amber-700">
                        Already on {it.invoicedOn.map((o) => o.invoiceNumber ? `#${o.invoiceNumber}` : (o.supplierName || 'another invoice')).join(', ')}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {on ? (
                      <span className="flex items-center gap-1 justify-end">
                        <input type="number" step="0.01" min="0" inputMode="decimal"
                          className={`w-24 border rounded px-1.5 py-0.5 text-sm text-right ${typed ? 'border-purple-400' : 'border-gray-300 text-gray-500'}`}
                          value={typed ? f.typed[it.key] : amt.toFixed(2)}
                          title="What this invoice charges for this work, VAT included. Filled in from what was booked until you type their figure."
                          onChange={(e) => f.onTyped(it.key, e.target.value)} />
                        {typed && (
                          <button type="button" title="Back to the share worked out from the booking"
                            className="text-xs text-gray-400 hover:text-purple-700" onClick={() => f.onTyped(it.key, undefined)}>↺</button>
                        )}
                      </span>
                    ) : (
                      <span className="block text-gray-800">{gbp(it.fee)}</span>
                    )}
                    {!on && it.estimate > 0 && <span className="block text-xs text-gray-500">+ {gbp(it.estimate)} est.</span>}
                    {verdict && <span className={`inline-block mt-0.5 px-1.5 py-0.5 text-[11px] rounded ${CHIP[verdict.tone]}`}>{verdict.text}</span>}
                  </span>
                  <button type="button" onClick={() => setOpen({ ...open, [it.key]: !isOpen })}
                    className="text-gray-400 hover:text-gray-700 text-xs mt-1 w-4 shrink-0" title={isOpen ? 'Hide what was booked' : 'Show what was booked'}>
                    {isOpen ? '▾' : '▸'}
                  </button>
                </div>
                {isOpen && (
                  <div className="pl-9 pr-3 pb-2 text-xs text-gray-600 space-y-1">
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>Booked: fee <strong>{gbp(it.fee)}</strong></span>
                      {it.estimateParts.map((p, i) => <span key={i}>{p.label} {gbp(p.amount)} (est.)</span>)}
                      <span className="text-gray-400">= {gbp(round2(it.fee + it.estimate))} before VAT</span>
                    </div>
                    {verdict?.tone === 'over' && (
                      <div className="flex items-center gap-2 flex-wrap rounded bg-red-50 text-red-800 px-2 py-1.5">
                        <span>Invoiced {gbp(round2(amt * netRatio))} before VAT against {gbp(round2(it.fee + it.estimate))} booked.</span>
                        <button type="button"
                          className="px-2 py-0.5 rounded border border-red-300 bg-white text-red-700 hover:bg-red-50"
                          onClick={() => f.onAsk(`${fmtDay(it.date)}${it.hhJobNumber ? ` (job #${it.hhJobNumber})` : ''}, ${it.title}: you've invoiced ${gbp(round2(amt * netRatio))} but it was booked at ${gbp(it.fee)}${it.estimate > 0 ? ` plus about ${gbp(it.estimate)} of expenses` : ''}. Can you explain the difference?`)}>
                          Ask them about it
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
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
              {gbp(over)} more than the booked fees and estimated expenses ({gbp(allowed)} is allowed). Worth a look before it&apos;s approved:
              type their figure on each row to see which, and ask them about it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
