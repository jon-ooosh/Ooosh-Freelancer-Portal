/**
 * "For sale" pill — a WARNING, never a gate (docs/VEHICLE-SALES-SPEC.md D3).
 *
 * Shown wherever staff pick or look at a van: Vehicle Detail, the fleet board,
 * Allocations and Book-out. Turns amber when the van is booked past the sale's
 * "try not to hire it after" date. A plain <span> so it can sit inside the
 * links and buttons those pages already wrap each van in.
 */

import type { OpenSaleSummary } from '../../lib/vehicle-sales'
import { saleStageLabel } from '../../lib/vehicle-sales'

function shortDate(d: string): string {
  const date = new Date(d + 'T00:00:00')
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function ForSalePill({ sale, className = '' }: { sale: OpenSaleSummary | undefined; className?: string }) {
  if (!sale) return null
  const beyond = sale.bookedBeyondHold
  const title = beyond
    ? `For sale — booked until ${sale.bookedUntil}, past the hold date of ${sale.holdFromHire}`
    : sale.holdFromHire
      ? `For sale — try not to hire it after ${sale.holdFromHire}`
      : 'For sale'
  return (
    <span
      title={title}
      className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 align-middle text-[10px] font-medium ${
        beyond ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-700'
      } ${className}`}
    >
      For sale · {saleStageLabel(sale.status)}
      {sale.holdFromHire && ` · hold ${shortDate(sale.holdFromHire)}`}
      {beyond && ' ⚠'}
    </span>
  )
}
