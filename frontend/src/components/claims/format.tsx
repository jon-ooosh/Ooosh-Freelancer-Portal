/**
 * Possible insurance claims — shared display surface (docs/INCIDENT-CLAIMS-SPEC.md).
 * Types, stage labels/colours, and the reusable ClaimsSection card that mounts
 * on job and driver pages (the vehicle module mounts its own, apiFetch-style).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';

export type ClaimStage = 'open' | 'form_out' | 'submitted' | 'reviewed' | 'with_broker' | 'closed';

export interface ClaimListRow {
  id: string;
  stage: ClaimStage;
  outcome: string | null;
  closed_at: string | null;
  origin_issue_id: string | null;
  job_id: string | null;
  vehicle_id: string | null;
  driver_id: string | null;
  hh_job_number: number | null;
  vehicle_reg: string | null;
  incident_at: string | null;
  incident_time_text: string | null;
  incident_location: string | null;
  notified_on: string | null;
  notified_via: string | null;
  broker_ref: string | null;
  insurer_ref: string | null;
  broker_sent_at: string | null;
  third_party_claim: boolean;
  liability_dispute: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  next_check_on: string | null;
  job_name: string | null;
  client_name: string | null;
  driver_name: string | null;
  problem_count: number;
  created_at: string;
  updated_at: string;
}

export const CLAIM_STAGE_LABEL: Record<ClaimStage, string> = {
  open: 'Open',
  form_out: 'Form out',
  submitted: 'Awaiting review',
  reviewed: 'Reviewed',
  with_broker: 'With broker',
  closed: 'Closed',
};

const STAGE_COLOUR: Record<ClaimStage, string> = {
  open: 'bg-slate-100 text-slate-700',
  form_out: 'bg-blue-100 text-blue-700',
  submitted: 'bg-amber-100 text-amber-800',
  reviewed: 'bg-purple-100 text-purple-700',
  with_broker: 'bg-indigo-100 text-indigo-700',
  closed: 'bg-green-100 text-green-700',
};

export const OUTCOME_LABEL: Record<string, string> = {
  not_claimed: 'Not claimed (dealt with internally)',
  settled: 'Settled',
  denied: 'Denied',
  defended: 'Defended (third-party claim failed)',
  withdrawn: 'Withdrawn',
};

export function ClaimStagePill({ stage, outcome }: { stage: ClaimStage; outcome?: string | null }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STAGE_COLOUR[stage] || 'bg-slate-100 text-slate-700'}`}>
      {CLAIM_STAGE_LABEL[stage] || stage}
      {stage === 'closed' && outcome ? ` · ${(OUTCOME_LABEL[outcome] || outcome).split(' (')[0]}` : ''}
    </span>
  );
}

/** "12/09/2026" from a YYYY-MM-DD or ISO string; "—" for anything unusable. */
export function fmtClaimDate(v: string | null | undefined): string {
  if (!v) return '—';
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
}

/** Today in UK terms as YYYY-MM-DD. */
export function ukToday(): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD `days` after today (UK). */
export function ukDatePlus(days: number): string {
  const [y, m, d] = ukToday().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Check-date cell: red when overdue or missing on a case that needs one. */
export function NextCheckCell({ row }: { row: Pick<ClaimListRow, 'stage' | 'next_check_on'> }) {
  if (row.stage === 'closed') return <span className="text-slate-400">—</span>;
  if (!row.next_check_on) return <span className="text-red-600 font-medium">not set</span>;
  const overdue = row.next_check_on < ukToday();
  const today = row.next_check_on === ukToday();
  return (
    <span className={overdue ? 'text-red-600 font-medium' : today ? 'text-amber-700 font-medium' : 'text-slate-700'}>
      {fmtClaimDate(row.next_check_on)}{overdue ? ' (overdue)' : today ? ' (today)' : ''}
    </span>
  );
}

/**
 * Case-file card for job / driver pages. `hideWhenEmpty` renders nothing when
 * there are no cases (the job page's conditional-card pattern).
 */
export function ClaimsSection({
  entityType,
  entityId,
  hideWhenEmpty,
}: {
  entityType: 'job' | 'driver' | 'vehicle';
  entityId: string;
  hideWhenEmpty?: boolean;
}) {
  const [rows, setRows] = useState<ClaimListRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ data: ClaimListRow[] }>(`/claims/by-${entityType}/${entityId}`)
      .then((r) => { if (alive) setRows(r.data); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [entityType, entityId]);

  if (rows === null) return hideWhenEmpty ? null : <div className="text-xs text-gray-400 py-2">Loading…</div>;
  if (rows.length === 0 && hideWhenEmpty) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">🛡️ Insurance claims</h3>
        <Link to="/vehicles/claims" className="text-xs text-ooosh-600 hover:underline">All claims →</Link>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 italic">No insurance claims.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <Link
              key={c.id}
              to={`/vehicles/claims/${c.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 px-3 py-2 text-sm hover:border-ooosh-300 hover:bg-ooosh-50/40"
            >
              <span className="font-medium text-gray-800">
                {c.vehicle_reg || 'No van'}
                {c.hh_job_number ? <span className="text-gray-500 font-normal"> · #{c.hh_job_number}</span> : null}
                {c.incident_at ? <span className="text-gray-500 font-normal"> · {fmtClaimDate(c.incident_at)}</span> : null}
                {c.third_party_claim ? <span className="ml-2 text-xs text-red-700">third-party claim</span> : null}
              </span>
              <ClaimStagePill stage={c.stage} outcome={c.outcome} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small badge for a Problem that sits on a claim. */
export function ClaimBadge({ claimId }: { claimId: string }) {
  return (
    <Link
      to={`/vehicles/claims/${claimId}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
      title="This Problem is part of a possible insurance claim"
    >
      🛡️ Insurance claim
    </Link>
  );
}
