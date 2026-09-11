/**
 * Prep-readiness pill for an allocated van, derived from its fleet
 * `hire_status` projection (`fleet_vehicles.hire_status`).
 *
 * jon's call (Jul 2026): only the two pre-hire states staff care about —
 * "is this van clean / had its checks done, or is it sat full of litter from
 * the last hire?" — surface a pill:
 *   - `Prep Needed` → amber "Prep needed"
 *   - `Available`   → green "Ready"
 * Every other state (`On Hire` / `Not Ready` / `Sold`) returns null so callers
 * show just the reg with no status noise. "On Hire" in particular reads as
 * confusing clutter on a going-out row, so it's deliberately dropped.
 *
 * Shared by the Job Detail "Vehicles on this job" strip and the dashboard
 * Today section so the two surfaces can't drift.
 */
export interface VehiclePrepPill {
  label: string;
  cls: string;
}

export function vehiclePrepPill(hireStatus: string | null | undefined): VehiclePrepPill | null {
  switch (hireStatus) {
    case 'Prep Needed':
      return { label: 'Prep needed', cls: 'bg-amber-100 text-amber-700' };
    case 'Available':
      return { label: 'Ready', cls: 'bg-green-100 text-green-700' };
    default:
      return null;
  }
}
