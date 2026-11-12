/**
 * The Money card — one card for a Problem and for an insurance claim
 * (docs/INCIDENT-CLAIMS-SPEC.md §23). It mostly READS what already exists:
 *   - the estimate (a Problem's own, or the claim's broker-form figure)
 *   - the bills and receipts in Money › Costs linked to the Problem(s)
 *   - the hire's excess, from the Money tab
 * and adds the two things that had nowhere to live: what the client paid for
 * this damage, and (claims only) what the insurer paid.
 *
 * Everything is compared ex VAT. Nothing here moves money — excess and
 * invoices stay on the job's Money tab, bills in Money › Costs.
 *
 * A Problem that is on a claim shows its costs and a pointer to the claim,
 * where its money is added up with the claim's other Problems.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { gbp } from '../../lib/cashflow';
import { ukToday } from '../../lib/ukDate';
import CostCaptureModal from '../CostCaptureModal';
import {
  AmountInputs, EMPTY_AMOUNTS, amountsAddUp, amountsFromNumbers, inferVatMode, readAmounts,
  type AmountStrings, type VatMode,
} from './AmountInputs';

type Kind = 'client_recovery' | 'insurer_payment';

interface CostRow {
  id: string;
  supplier_name: string | null;
  description: string | null;
  cost_date: string | null;
  amount_net: number | null;
  amount_vat: number | null;
  amount_gross: number | null;
  payment_status: string;
  job_issue_id: string;
  problem_summary: string | null;
}

interface MoneyLine {
  id: string;
  issue_id: string | null;
  claim_id: string | null;
  kind: Kind;
  source: 'excess' | 'invoice' | 'other' | null;
  paid_to: 'ooosh' | 'repairer' | null;
  description: string | null;
  amount_net: number;
  amount_vat: number;
  amount_gross: number;
  entry_date: string | null;
  problem_summary: string | null;
}

interface Summary {
  scope: 'problem' | 'claim';
  on_claim: { id: string; label: string } | null;
  estimate_net: number | null;
  problems_estimate_net: number | null;
  problems: Array<{ id: string; summary: string }>;
  costs: CostRow[];
  lines: MoneyLine[];
  legacy_actual: Array<{ issue_id: string; summary: string; actual_cost: number }>;
  hire: { job_id: string; hh_job_number: number | null } | null;
  excess: { kept_gross: number; held_gross: number; against_damage_gross: number; unassigned_gross: number } | null;
  totals: {
    costs_net: number; costs_gross: number; recovered_net: number; recovered_gross: number;
    insurer_to_us: number; insurer_to_repairer: number; net_cost: number | null; net_cost_is_estimate: boolean;
  };
}

const SOURCE_LABEL: Record<string, string> = { excess: 'From the excess', invoice: 'On an invoice', other: 'Paid another way' };
const PAID_TO_LABEL: Record<string, string> = { ooosh: 'Paid to us', repairer: 'Paid straight to the repairer' };
const PAYMENT_STATUS_LABEL: Record<string, string> = { awaiting_payment: 'to pay', awaiting_invoice: 'awaiting invoice' };

const money = (n: number | null | undefined) => gbp(n ?? null, true);
const ukDate = (ymd: string | null) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd.split('-').reverse().join('/') : '');
const errMsg = (e: unknown, fallback: string) =>
  ((e as { body?: { error?: string } })?.body?.error) || fallback;

export default function DamageMoneyCard({ problemId, claimId, jobId, vehicleId, reloadToken, onChanged }: {
  /** Exactly one of problemId / claimId. */
  problemId?: string;
  claimId?: string;
  /** Pre-fill for "+ Add cost". */
  jobId?: string | null;
  vehicleId?: string | null;
  /** Change this to make the card read again (e.g. the page reloaded after linking a Problem). */
  reloadToken?: unknown;
  /** Called after this card saved something (only where the page's reload doesn't blank the page). */
  onChanged?: () => void;
}) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [addingCostFor, setAddingCostFor] = useState<string | null>(null);
  const [pickingProblem, setPickingProblem] = useState(false);
  const [editing, setEditing] = useState<{ kind: Kind; line: MoneyLine | null } | null>(null);
  const [editingEstimate, setEditingEstimate] = useState(false);

  const url = claimId ? `/damage-money/claim/${claimId}` : `/damage-money/problem/${problemId}`;
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: Summary }>(url);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(errMsg(e, 'Could not load the money'));
    }
  }, [url]);

  useEffect(() => { load(); }, [load, reloadToken]);

  const saved = async () => {
    await load();
    onChanged?.();
  };

  const removeLine = async (l: MoneyLine) => {
    if (!confirm('Remove this line? (It stays on the timeline.)')) return;
    try {
      await api.delete(`/damage-money/lines/${l.id}`);
      await saved();
    } catch (e) {
      setError(errMsg(e, 'Could not remove that line'));
    }
  };

  const startAddCost = () => {
    if (!data) return;
    if (problemId) { setAddingCostFor(problemId); return; }
    if (data.problems.length === 1) { setAddingCostFor(data.problems[0].id); return; }
    setPickingProblem(true);
  };

  if (!data) {
    return (
      <Shell>
        {error ? <div className="text-xs text-red-600">{error}</div> : <div className="text-xs text-slate-400">Loading…</div>}
      </Shell>
    );
  }

  const onClaim = data.scope === 'problem' && data.on_claim;
  const recoveries = data.lines.filter((l) => l.kind === 'client_recovery');
  const insurer = data.lines.filter((l) => l.kind === 'insurer_payment');
  const manyProblems = data.scope === 'claim' && data.problems.length > 1;
  const t = data.totals;

  return (
    <Shell>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

      {onClaim && (
        <div className="mb-3 text-xs px-3 py-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-800">
          This damage is on claim <Link to={`/vehicles/claims/${data.on_claim!.id}`} className="font-medium underline">{data.on_claim!.label}</Link>
          {' '}— its estimate, what the client paid and the insurer are tracked there, with the claim's other Problems.
        </div>
      )}

      {/* Estimate */}
      {!onClaim && (
        <Section title="Estimate (ex VAT)">
          {editingEstimate ? (
            <EstimateEditor
              initial={data.estimate_net}
              suggestion={data.scope === 'claim' ? data.problems_estimate_net : null}
              onCancel={() => setEditingEstimate(false)}
              onSave={async (net) => {
                if (claimId) await api.put(`/damage-money/claim/${claimId}/estimate`, { amount_net: net });
                else await api.patch(`/problems/${problemId}`, { estimated_cost: net });
                setEditingEstimate(false);
                await saved();
              }}
            />
          ) : (
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm text-slate-800">
                {data.estimate_net === null
                  ? <span className="text-slate-400">None yet</span>
                  : <>{money(data.estimate_net)} <span className="text-xs text-slate-400">({money(data.estimate_net * 1.2)} inc VAT)</span></>}
              </div>
              <button type="button" onClick={() => setEditingEstimate(true)} className="text-xs text-ooosh-600 hover:underline shrink-0">
                {data.estimate_net === null ? 'Add' : 'Change'}
              </button>
            </div>
          )}
          {data.scope === 'claim' && (
            <p className="text-[11px] text-slate-400 mt-1">The repair cost the broker form prints.</p>
          )}
        </Section>
      )}

      {/* Costs */}
      <Section
        title={`Our costs (${data.costs.length})`}
        action={<button type="button" onClick={startAddCost} className="text-xs text-ooosh-600 hover:underline">+ Add cost</button>}
      >
        {pickingProblem && (
          <div className="mb-2 p-2 rounded border bg-slate-50 text-xs space-y-1">
            <div className="text-slate-600">Which Problem is this cost for?</div>
            {data.problems.map((p) => (
              <button key={p.id} type="button" onClick={() => { setPickingProblem(false); setAddingCostFor(p.id); }}
                className="block text-left text-ooosh-700 hover:underline">
                {p.summary}
              </button>
            ))}
            <button type="button" onClick={() => setPickingProblem(false)} className="text-slate-500">Cancel</button>
          </div>
        )}
        {data.costs.length === 0 ? (
          <p className="text-xs text-slate-400">No bills or receipts yet. Anything added here is saved in Money › Costs like any other cost.</p>
        ) : (
          <ul className="space-y-1">
            {data.costs.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div className="text-slate-800 truncate">{c.supplier_name || 'Cost'}{c.description ? ` — ${c.description}` : ''}</div>
                  <div className="text-[11px] text-slate-400">
                    {[ukDate(c.cost_date), manyProblems ? c.problem_summary : null, PAYMENT_STATUS_LABEL[c.payment_status]].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-slate-800">{money(c.amount_net ?? ((c.amount_gross ?? 0) - (c.amount_vat ?? 0)))}</div>
                  {c.amount_gross !== null && <div className="text-[11px] text-slate-400">{money(c.amount_gross)} inc VAT</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.costs.length > 0 && (
          <div className="mt-1 text-[11px] text-slate-400">
            In <Link to="/money/costs" className="hover:underline">Money › Costs</Link>.
          </div>
        )}
      </Section>

      {/* What the client paid */}
      {!onClaim && (
        <Section
          title="Recovered from the client"
          action={<button type="button" onClick={() => setEditing({ kind: 'client_recovery', line: null })} className="text-xs text-ooosh-600 hover:underline">+ Add</button>}
        >
          {editing?.kind === 'client_recovery' && !editing.line && (
            <LineEditor kind="client_recovery" owner={{ problemId, claimId }} line={null}
              onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await saved(); }} />
          )}
          {recoveries.length === 0 && editing?.kind !== 'client_recovery' && (
            <p className="text-xs text-slate-400">
              What we charged the client for this damage — from their excess, on an invoice, or another way. Add a line for each.
            </p>
          )}
          <LineList lines={recoveries} showProblem={data.scope === 'claim'} editing={editing} setEditing={setEditing}
            onRemove={removeLine} owner={{ problemId, claimId }} onSaved={async () => { setEditing(null); await saved(); }} />
        </Section>
      )}

      {/* Insurer — claims only */}
      {data.scope === 'claim' && (
        <Section
          title="Insurer"
          action={<button type="button" onClick={() => setEditing({ kind: 'insurer_payment', line: null })} className="text-xs text-ooosh-600 hover:underline">+ Add</button>}
        >
          {editing?.kind === 'insurer_payment' && !editing.line && (
            <LineEditor kind="insurer_payment" owner={{ problemId, claimId }} line={null}
              onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await saved(); }} />
          )}
          {insurer.length === 0 && editing?.kind !== 'insurer_payment' && (
            <p className="text-xs text-slate-400">
              What the insurer paid — to us, or straight to the repairer (a letter of authorisation: file it under Files).
              The repairer's bill to us for the excess goes under Our costs.
            </p>
          )}
          <LineList lines={insurer} showProblem={false} editing={editing} setEditing={setEditing}
            onRemove={removeLine} owner={{ problemId, claimId }} onSaved={async () => { setEditing(null); await saved(); }} />
        </Section>
      )}

      {/* The hire's excess, as a check */}
      {!onClaim && data.excess && data.hire && (
        <div className="mt-3 text-[11px] text-slate-600 bg-slate-50 border rounded px-2.5 py-2 space-y-0.5">
          <div>
            Excess on hire{data.hire.hh_job_number ? ` #${data.hire.hh_job_number}` : ''}:{' '}
            <b>{money(data.excess.kept_gross)}</b> kept
            {' · '}{money(data.excess.against_damage_gross)} put against damage (here and on the hire's other Problems)
          </div>
          {data.excess.unassigned_gross > 0.004 && (
            <div>{money(data.excess.unassigned_gross)} not against any damage — fuel, lost items and the like.</div>
          )}
          {data.excess.unassigned_gross < -0.004 && (
            <div className="text-amber-700">
              {money(-data.excess.unassigned_gross)} more has been put against damage than the excess kept — check the lines.
            </div>
          )}
          {data.excess.held_gross > 0.004 && (
            <div className="text-amber-700">{money(data.excess.held_gross)} still held — not yet kept or paid back.</div>
          )}
          <Link to={`/jobs/${data.hire.job_id}?tab=money`} className="text-ooosh-600 hover:underline">Open the job's Money tab →</Link>
        </div>
      )}

      {data.legacy_actual.length > 0 && (
        <div className="mt-3 text-[11px] text-slate-400">
          Noted before costs were linked:{' '}
          {data.legacy_actual.map((a) => `${data.scope === 'claim' ? `${a.summary} ` : ''}"Actual" ${money(a.actual_cost)}`).join(' · ')}
          {' '}— add the bill under Our costs, or what the client paid above, and this can be ignored.
        </div>
      )}

      {/* What it cost us */}
      {!onClaim && (
        <div className="mt-3 pt-3 border-t">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-slate-700">What it cost Ooosh <span className="font-normal text-xs text-slate-400">(ex VAT)</span></span>
            <span className={`text-lg font-semibold ${t.net_cost !== null && t.net_cost < -0.004 ? 'text-green-700' : 'text-slate-800'}`}>
              {t.net_cost === null ? '—' : money(t.net_cost)}
            </span>
          </div>
          {t.net_cost === null ? (
            <p className="text-[11px] text-slate-400">Add an estimate or a cost to see this.</p>
          ) : (
            <p className="text-[11px] text-slate-500">
              {t.net_cost_is_estimate ? <span className="text-amber-700 font-medium">Estimated — no bill or receipt yet. </span> : null}
              {t.net_cost_is_estimate ? `Estimate ${money(data.estimate_net)}` : `Costs ${money(t.costs_net)}`}
              {' − recovered from the client '}{money(t.recovered_net)}
              {t.insurer_to_us > 0.004 ? <> − insurer paid us {money(t.insurer_to_us)}</> : null}
            </p>
          )}
          {t.insurer_to_repairer > 0.004 && (
            <p className="text-[11px] text-slate-400 mt-0.5">
              The insurer also paid the repairer {money(t.insurer_to_repairer)} directly — not our money, so not taken off.
            </p>
          )}
        </div>
      )}

      {addingCostFor && (
        <CostCaptureModal
          presetIssueId={addingCostFor}
          presetJobId={jobId || null}
          presetVehicleId={vehicleId || null}
          onClose={() => setAddingCostFor(null)}
          onSaved={async () => { setAddingCostFor(null); await saved(); }}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Money</h3>
      {children}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function LineList({ lines, showProblem, editing, setEditing, onRemove, owner, onSaved }: {
  lines: MoneyLine[];
  showProblem: boolean;
  editing: { kind: Kind; line: MoneyLine | null } | null;
  setEditing: (e: { kind: Kind; line: MoneyLine | null } | null) => void;
  onRemove: (l: MoneyLine) => void;
  owner: { problemId?: string; claimId?: string };
  onSaved: () => void;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {lines.map((l) => (
        editing?.line?.id === l.id ? (
          <li key={l.id}>
            <LineEditor kind={l.kind} owner={owner} line={l} onCancel={() => setEditing(null)} onSaved={onSaved} />
          </li>
        ) : (
          <li key={l.id} className="flex items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <div className="text-slate-800">
                {l.kind === 'client_recovery' ? SOURCE_LABEL[l.source || ''] : PAID_TO_LABEL[l.paid_to || '']}
                {l.description ? <span className="text-slate-500"> — {l.description}</span> : null}
              </div>
              <div className="text-[11px] text-slate-400">
                {[ukDate(l.entry_date), showProblem && l.problem_summary ? `on Problem: ${l.problem_summary}` : null].filter(Boolean).join(' · ')}
                {' '}
                <button type="button" onClick={() => setEditing({ kind: l.kind, line: l })} className="text-ooosh-600 hover:underline">edit</button>
                {' · '}
                <button type="button" onClick={() => onRemove(l)} className="hover:text-red-600">remove</button>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-slate-800">{money(l.amount_net)}</div>
              {l.amount_vat > 0.004 && <div className="text-[11px] text-slate-400">{money(l.amount_gross)} inc VAT</div>}
            </div>
          </li>
        )
      ))}
    </ul>
  );
}

function LineEditor({ kind, owner, line, onCancel, onSaved }: {
  kind: Kind;
  owner: { problemId?: string; claimId?: string };
  line: MoneyLine | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState<string>(line?.source || 'excess');
  const [paidTo, setPaidTo] = useState<string>(line?.paid_to || 'repairer');
  const [description, setDescription] = useState(line?.description || '');
  const [date, setDate] = useState(line?.entry_date || ukToday());
  // Ooosh's damage charges are plus VAT; an insurer's payment usually isn't.
  const [mode, setMode] = useState<VatMode>(line ? inferVatMode(line.amount_net, line.amount_vat) : kind === 'client_recovery' ? 'vat20' : 'none');
  const [amounts, setAmounts] = useState<AmountStrings>(line ? amountsFromNumbers(line.amount_net, line.amount_vat, line.amount_gross) : EMPTY_AMOUNTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const a = readAmounts(amounts);
    if (!a || a.amount_gross <= 0) { setError('Give an amount'); return; }
    if (!amountsAddUp(amounts)) { setError('Net + VAT doesn’t add up to the gross'); return; }
    setBusy(true); setError('');
    const body: Record<string, unknown> = {
      ...a,
      description: description.trim() || null,
      entry_date: date || null,
      ...(kind === 'client_recovery' ? { source } : { paid_to: paidTo }),
    };
    try {
      if (line) {
        await api.patch(`/damage-money/lines/${line.id}`, body);
      } else {
        await api.post('/damage-money/lines', {
          ...body,
          kind,
          ...(owner.claimId ? { claim_id: owner.claimId } : { issue_id: owner.problemId }),
        });
      }
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Could not save'));
      setBusy(false);
    }
  };

  const box = 'w-full border border-slate-300 rounded px-2 py-1 text-sm';
  return (
    <div className="p-2.5 mb-2 rounded border border-ooosh-200 bg-ooosh-50/30 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] text-slate-500">{kind === 'client_recovery' ? 'How they paid' : 'Paid to'}</span>
          {kind === 'client_recovery' ? (
            <select value={source} onChange={(e) => setSource(e.target.value)} className={box}>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          ) : (
            <select value={paidTo} onChange={(e) => setPaidTo(e.target.value)} className={box}>
              {Object.entries(PAID_TO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          )}
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-500">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={box} />
        </label>
      </div>
      <label className="block">
        <span className="text-[11px] text-slate-500">{kind === 'client_recovery' ? 'What for' : 'Note'}</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500}
          placeholder={kind === 'client_recovery' ? 'e.g. NS bumper' : 'e.g. letter of authorisation, settlement'} className={box} />
      </label>
      <AmountInputs value={amounts} mode={mode} onChange={setAmounts} onModeChange={setMode} />
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-xs border rounded">Cancel</button>
        <button type="button" onClick={save} disabled={busy} className="px-3 py-1 text-xs rounded bg-ooosh-600 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** The estimate, ex VAT — typed either way, saved as the net. */
function EstimateEditor({ initial, suggestion, onCancel, onSave }: {
  initial: number | null;
  suggestion: number | null;
  onCancel: () => void;
  onSave: (net: number | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<VatMode>('vat20');
  const [amounts, setAmounts] = useState<AmountStrings>(
    initial === null ? EMPTY_AMOUNTS : amountsFromNumbers(initial, Math.round(initial * 20) / 100, Math.round(initial * 120) / 100),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (net: number | null) => {
    setBusy(true); setError('');
    try {
      await onSave(net);
    } catch (e) {
      setError(errMsg(e, 'Could not save the estimate'));
      setBusy(false);
    }
  };
  const save = () => {
    const a = readAmounts(amounts);
    if (!a || a.amount_net <= 0) { setError('Give an amount, or Clear'); return; }
    run(a.amount_net);
  };

  return (
    <div className="p-2.5 rounded border border-ooosh-200 bg-ooosh-50/30 space-y-2">
      <AmountInputs value={amounts} mode={mode} onChange={setAmounts} onModeChange={setMode} />
      <p className="text-[11px] text-slate-400">Saved as the ex-VAT figure.</p>
      {suggestion !== null && (
        <button type="button" onClick={() => setAmounts(amountsFromNumbers(suggestion, Math.round(suggestion * 20) / 100, Math.round(suggestion * 120) / 100))}
          className="text-[11px] text-ooosh-600 hover:underline">
          Use what the Problems' own estimates add up to: {money(suggestion)}
        </button>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex justify-end gap-2">
        {initial !== null && (
          <button type="button" onClick={() => run(null)} disabled={busy} className="px-3 py-1 text-xs border rounded mr-auto text-slate-500">Clear</button>
        )}
        <button type="button" onClick={onCancel} className="px-3 py-1 text-xs border rounded">Cancel</button>
        <button type="button" onClick={save} disabled={busy} className="px-3 py-1 text-xs rounded bg-ooosh-600 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
