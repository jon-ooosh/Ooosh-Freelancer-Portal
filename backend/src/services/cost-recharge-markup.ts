/**
 * Cost recharge markup — the figure billed to the client is the cost net plus a
 * markup, all ex VAT (HireHop adds the 20% on top of the pushed net line).
 *
 * Default rule (jon, Jun 2026): markup = greater of 20% of the net cost or a £10
 * floor. Configurable via system_settings (category `cost_recharge`). The resolve
 * modal pre-fills the suggested final from these and lets staff override.
 *
 * See docs/COST-CAPTURE-RECHARGE-SPEC.md — "Phase D".
 */
import { getSystemSettings } from '../routes/system-settings';

export type MarkupType = 'greater_of' | 'percent' | 'fixed' | 'none';
const MARKUP_TYPES: MarkupType[] = ['greater_of', 'percent', 'fixed', 'none'];

export interface MarkupConfig {
  type: MarkupType;
  percent: number; // % used by greater_of / percent
  floor: number;   // £ floor used by greater_of (ex VAT)
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function getRechargeMarkupDefaults(): Promise<MarkupConfig> {
  const s = await getSystemSettings([
    'cost_recharge_default_markup_type',
    'cost_recharge_default_markup_percent',
    'cost_recharge_default_markup_floor',
  ]);
  const rawType = (s.cost_recharge_default_markup_type || 'greater_of') as MarkupType;
  return {
    type: MARKUP_TYPES.includes(rawType) ? rawType : 'greater_of',
    percent: Number(s.cost_recharge_default_markup_percent ?? 20) || 0,
    floor: Number(s.cost_recharge_default_markup_floor ?? 10) || 0,
  };
}

/**
 * Markup amount (ex VAT) for a net base.
 *  - greater_of: max(base × value%, floor)   (value = percent, floor from config)
 *  - percent:    base × value%
 *  - fixed:      value (flat)
 *  - none:       0
 */
export function computeMarkup(base: number, type: MarkupType, value: number, floor = 0): number {
  const b = Math.max(0, Number(base) || 0);
  const v = Number(value) || 0;
  switch (type) {
    case 'percent': return round2(b * v / 100);
    case 'fixed': return round2(v);
    case 'greater_of': return round2(Math.max(b * v / 100, Number(floor) || 0));
    case 'none':
    default: return 0;
  }
}
