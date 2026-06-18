/**
 * PCN history section, reusable across detail pages — mirrors
 * HeldItemsSection / StorageHistorySection / ExcessHistorySection.
 *
 * Reads from /api/pcns/by-{vehicle|driver|org|job}/:id and surfaces every PCN
 * anchored to that entity. Open (in-flight) PCNs first, resolved collapsed
 * below. Read-only — the full control panel lives at /vehicles/pcns/:id.
 *
 * Mounts:
 *   - Vehicle detail (by-vehicle)  — handled inline in the vehicle module
 *     (apiFetch convention); this component is used for the rest.
 *   - Driver detail  (by-driver)   — accountability / repeat-offender view (§7)
 *   - Organisation detail (by-org) — client/hirer view
 *   - Job detail overview (by-job) — conditional card, one row per PCN
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import {
  Pcn,
  PcnStatusPill,
  pcnTrafficLight,
  PCN_LIGHT_DOT,
  FINE_TYPE_LABEL,
  fmtPcnDate,
  fmtPcnMoney,
} from './pcn/format';

type EntityType = 'vehicle' | 'driver' | 'organisation' | 'job';

const ENDPOINT_BY_TYPE: Record<EntityType, string> = {
  vehicle: 'by-vehicle',
  driver: 'by-driver',
  organisation: 'by-org',
  job: 'by-job',
};

// A PCN is "resolved" once it reaches a green terminal state. Anything else is
// still in-flight (received / awaiting / chasing / under query / transferred).
const RESOLVED = new Set(['paid_by_driver', 'paid_recharged', 'internal_ooosh', 'internal_freelancer', 'closed']);

// Repeat-offender threshold for the driver view (§7): N+ PCNs in a rolling 12 months.
const REPEAT_THRESHOLD = 3;

export function PcnHistorySection({
  entityType,
  entityId,
  onCount,
  bare,
  hideWhenEmpty,
  heading,
  showRepeatFlag,
}: {
  entityType: EntityType;
  entityId: string;
  onCount?: (open: number, total: number) => void;
  bare?: boolean;            // no outer card wrapper (embedding in another panel)
  hideWhenEmpty?: boolean;   // render nothing instead of an empty card
  heading?: string;          // optional heading above the rows
  showRepeatFlag?: boolean;  // driver view — surface the repeat-offender chip
}) {
  const [pcns, setPcns] = useState<Pcn[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  // Hold onCount in a ref so an inline callback from the parent doesn't
  // re-trigger the fetch on every render.
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ data: Pcn[] }>(`/pcns/${ENDPOINT_BY_TYPE[entityType]}/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const rows = res.data || [];
        setPcns(rows);
        if (onCountRef.current) onCountRef.current(rows.filter((p) => !RESOLVED.has(p.status)).length, rows.length);
      })
      .catch(() => { if (!cancelled) setPcns([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  if (loading) return hideWhenEmpty ? null : <div className="text-sm text-gray-500 text-center py-8">Loading…</div>;

  const open = pcns.filter((p) => !RESOLVED.has(p.status));
  const resolved = pcns.filter((p) => RESOLVED.has(p.status));

  if (pcns.length === 0) {
    if (hideWhenEmpty) return null;
    const empty = <p className="text-sm text-gray-400 text-center py-6">No penalty charge notices.</p>;
    return bare ? empty : <div className="bg-white rounded-xl border border-gray-200 p-4">{empty}</div>;
  }

  // Repeat-offender count: PCNs in the rolling 12 months (by offence date,
  // falling back to created_at where the offence date wasn't captured).
  const yearAgo = Date.now() - 365 * 86_400_000;
  const recentCount = pcns.filter((p) => new Date(p.offence_at || p.created_at).getTime() >= yearAgo).length;
  const isRepeat = showRepeatFlag && recentCount >= REPEAT_THRESHOLD;

  const inner = (
    <>
      {(heading || isRepeat) && (
        <div className="flex items-center justify-between mb-2">
          {heading && <h3 className={bare ? 'text-xs font-semibold uppercase tracking-wide text-gray-500' : 'text-sm font-semibold text-gray-800'}>{heading}</h3>}
          {isRepeat && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
              ⚠ Repeat — {recentCount} in 12 months
            </span>
          )}
        </div>
      )}
      {open.length > 0 && (
        <div>
          {!heading && <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">In flight ({open.length})</h3>}
          <div className="space-y-2">{open.map((p) => <PcnRow key={p.id} p={p} context={entityType} />)}</div>
        </div>
      )}
      {resolved.length > 0 && (
        <div className={open.length > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}>
          <button type="button" onClick={() => setShowResolved((s) => !s)}
            className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-green-700 hover:text-green-800">
            <span>Resolved ({resolved.length})</span><span className="text-gray-400">{showResolved ? 'Hide' : 'Show'}</span>
          </button>
          {showResolved && <div className="space-y-2 mt-2">{resolved.map((p) => <PcnRow key={p.id} p={p} context={entityType} />)}</div>}
        </div>
      )}
    </>
  );

  return bare ? inner : <div className="bg-white rounded-xl border border-gray-200 p-4">{inner}</div>;
}

function PcnRow({ p, context }: { p: Pcn; context: EntityType }) {
  const light = pcnTrafficLight(p);
  // Context-aware sub-line: drop the field that names the surface we're on.
  const reg = p.fleet_reg || p.vehicle_reg;
  const sub = [
    context !== 'vehicle' && reg ? reg : null,
    p.offence_at ? `${fmtPcnDate(p.offence_at)}${p.offence_time_text ? ` ${p.offence_time_text}` : ''}` : null,
    context !== 'job' && p.hh_job_number ? `J-${p.hh_job_number}` : null,
    context === 'job' && p.driver_name ? p.driver_name : null,
    context !== 'organisation' && p.client_organisation_name ? p.client_organisation_name : null,
    p.fine_amount != null ? fmtPcnMoney(p.fine_amount) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Link to={`/vehicles/pcns/${p.id}`}
      className="block rounded border border-gray-200 bg-gray-50/40 px-3 py-2 hover:border-ooosh-300 hover:bg-ooosh-50/40">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${PCN_LIGHT_DOT[light]}`} title={light} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">
            {p.reference || '(no reference)'}
            <span className="ml-1.5 text-[10px] text-gray-400">{FINE_TYPE_LABEL[p.fine_type] || p.fine_type}</span>
          </div>
          {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
        </div>
        <PcnStatusPill status={p.status} />
      </div>
    </Link>
  );
}

export default PcnHistorySection;
