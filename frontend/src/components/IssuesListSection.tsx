/**
 * Issues list section reusable across entity detail pages.
 *
 * Reads from /api/problems/by-{entityType}/:entityId — endpoints
 * already exist for vehicle / organisation / person. Same layout
 * everywhere: open issues first, then collapsible Resolved/Closed.
 * Each row links through to /operations/problems/:id for the full
 * control panel.
 *
 * Used on OrganisationDetailPage (Issues tab) and ready to mount on
 * PersonDetailPage / VehicleDetailPage variants without duplicating
 * the fetch + render logic.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface OpIssueRow {
  id: string;
  category: string;
  severity: 'low' | 'normal' | 'urgent';
  status: string;
  summary: string;
  hh_job_number: number | null;
  job_name: string | null;
  vehicle_reg: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL = new Set(['resolved', 'written_off', 'cancelled']);

const SEVERITY_CHIP: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700',
  normal: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-600',
};

const CATEGORY_LABEL: Record<string, string> = {
  damaged: 'Damaged', missing: 'Missing', broken: 'Broken',
  dispute: 'Dispute', breakdown: 'Breakdown', other: 'Other',
};

const ENDPOINT_BY_TYPE: Record<string, string> = {
  organisation: 'by-organisation',
  person: 'by-person',
  vehicle: 'by-vehicle',
};

export function IssuesListSection({
  entityType,
  entityId,
  onCount,
}: {
  entityType: 'organisation' | 'person' | 'vehicle';
  entityId: string;
  onCount?: (count: number) => void;
}) {
  const [issues, setIssues] = useState<OpIssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const endpoint = ENDPOINT_BY_TYPE[entityType];
    api.get<{ data: OpIssueRow[] }>(`/problems/${endpoint}/${entityId}`)
      .then(res => {
        if (cancelled) return;
        setIssues(res.data || []);
        // Surface OPEN count to parent (drives the tab label).
        if (onCount) {
          const open = (res.data || []).filter(i => !TERMINAL.has(i.status)).length;
          onCount(open);
        }
      })
      .catch(err => {
        console.error('Failed to load issues:', err);
        if (!cancelled) setIssues([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, onCount]);

  if (loading) {
    return <div className="text-sm text-gray-500 text-center py-8">Loading issues…</div>;
  }

  const open = issues.filter(i => !TERMINAL.has(i.status));
  const resolved = issues.filter(i => TERMINAL.has(i.status));

  if (issues.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">
        No issues recorded.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      {open.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">
            Open ({open.length})
          </h3>
          <div className="space-y-2">
            {open.map(i => <IssueRow key={i.id} issue={i} />)}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div className={open.length > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}>
          <button
            type="button"
            onClick={() => setShowResolved(s => !s)}
            className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-green-700 hover:text-green-800"
          >
            <span>Resolved / Closed ({resolved.length})</span>
            <span className="text-gray-400">{showResolved ? 'Hide' : 'Show'}</span>
          </button>
          {showResolved && (
            <div className="space-y-2 mt-2">
              {resolved.map(i => <IssueRow key={i.id} issue={i} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: OpIssueRow }) {
  const sevClass = SEVERITY_CHIP[issue.severity] || SEVERITY_CHIP.normal;
  const catLabel = CATEGORY_LABEL[issue.category] || issue.category;
  return (
    <Link
      to={`/operations/problems/${issue.id}`}
      className="block rounded border border-gray-200 bg-gray-50/40 px-3 py-2 hover:border-ooosh-300 hover:bg-ooosh-50/40"
    >
      <div className="flex items-start gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${sevClass}`}>
          {issue.severity === 'urgent' ? '⚠ Urgent' : issue.severity === 'low' ? 'Low' : 'Normal'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">{issue.summary}</div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            {catLabel}
            {issue.vehicle_reg && ` · 🚐 ${issue.vehicle_reg}`}
            {issue.hh_job_number ? ` · J-${issue.hh_job_number}` : ''}
            {' · '}
            {new Date(issue.updated_at).toLocaleDateString('en-GB')}
          </div>
        </div>
      </div>
    </Link>
  );
}
