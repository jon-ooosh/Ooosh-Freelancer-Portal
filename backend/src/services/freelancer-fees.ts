/**
 * What a freelancer is paid for a delivery, collection or crew booking: THE
 * rule, shared by the portal's "Your fee", the Costs "Which jobs?" list and
 * (next) the portal's Earnings tab, so the three can never disagree
 * (docs/FREELANCER-PORTAL-SPEC.md §5).
 *
 * Their own agreed rate when staff set one, else the quote's fee. A crewed
 * quote for more than one person stores the WHOLE crew's fee
 * (applyCrewMultiplier), so without a personal rate it is split evenly — each
 * of a crew of three used to be shown the full three-person figure (Oct 2026).
 * jon (Oct 2026): rates are per JOB, divided by the people on it; a role paid
 * differently is its own crewed job, not a per-person rate card.
 */
export function personalFee(row: Record<string, unknown>): number {
  // Any rate staff typed wins, even £0 (NUMERIC arrives as a string, so the old
  // `agreed_rate || fee` honoured an explicit '0.00' too).
  if (row.agreed_rate != null && String(row.agreed_rate).trim() !== '') return Number(row.agreed_rate) || 0;
  const quoteFee = Number(row.freelancer_fee_rounded || row.freelancer_fee || 0);
  const crew = row.job_type === 'crewed' ? Math.max(1, Math.floor(Number(row.crew_count) || 1)) : 1;
  return Math.round((quoteFee / crew) * 100) / 100;
}
