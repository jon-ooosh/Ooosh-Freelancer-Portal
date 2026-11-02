/**
 * DVSA flags next to a van's MOT date — fleet board, cards, Key Dates, sale page.
 *
 * The MOT date itself is DVSA's (services/dvsa-mot.ts decideMotDue); these say
 * what else DVSA knows, and when the date showing is NOT DVSA's:
 *   Manual   — typed by hand and not DVSA's; stands only until the next DVSA
 *              check (07:30), when DVSA's date replaces it — amber, hover for DVSA's date
 *   Recall   — DVSA reports an outstanding manufacturer recall — red
 *   Failed   — the latest MOT test was a fail — red
 *   N adv    — advisories / minor items on the latest test nobody has marked
 *              done / noted yet (History › MOT, §18) — grey
 * Nothing renders for a van DVSA hasn't been asked about yet.
 */

import type { Vehicle } from '../../types/vehicle'

type MotFields = Pick<Vehicle, 'motDue' | 'motDueSource' | 'dvsaMotDue' | 'dvsaAdvisories' | 'dvsaAdvisoriesOpen' | 'dvsaRecall' | 'dvsaLatestResult' | 'dvsaLatestTestOn' | 'dvsaCheckedAt'>

function shortDate(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(d + 'T00:00:00')
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

export function MotFlags({ v, className = '' }: { v: MotFields; className?: string }) {
  if (!v.dvsaCheckedAt) return null
  const manual = v.motDueSource === 'manual' && !!v.dvsaMotDue && v.motDue !== v.dvsaMotDue
  const recall = v.dvsaRecall === 'Yes'
  const failed = v.dvsaLatestResult === 'FAILED'
  // Open ones only; a van not recounted since §18 falls back to all of them.
  const adv = v.dvsaAdvisoriesOpen ?? v.dvsaAdvisories ?? 0
  const total = v.dvsaAdvisories ?? adv
  if (!manual && !recall && !failed && adv === 0) return null

  const chip = 'inline-block whitespace-nowrap rounded px-1 py-px align-middle text-[10px] font-medium'
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className}`}>
      {manual && (
        <span className={`${chip} bg-amber-100 text-amber-800`}
          title={`Typed in by hand — DVSA says ${shortDate(v.dvsaMotDue)}. DVSA's date replaces it at the next check (07:30), or use it now under the van's Key Dates.`}>
          Manual
        </span>
      )}
      {recall && (
        <span className={`${chip} bg-red-100 text-red-800`} title="DVSA reports an outstanding manufacturer recall">
          Recall
        </span>
      )}
      {failed && (
        <span className={`${chip} bg-red-100 text-red-800`} title={`The latest MOT test (${shortDate(v.dvsaLatestTestOn)}) was a fail`}>
          Failed
        </span>
      )}
      {adv > 0 && (
        <span className={`${chip} bg-gray-100 text-gray-600`}
          title={`${adv} of ${total} advisor${total === 1 ? 'y' : 'ies'} on the last MOT (${shortDate(v.dvsaLatestTestOn)}) not yet marked done or noted — see History › MOT`}>
          {adv} adv
        </span>
      )}
    </span>
  )
}
