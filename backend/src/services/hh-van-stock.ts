/**
 * Fill a fleet van's type and gearbox from HireHop (jon, Nov 2026).
 *
 * Every van is an asset in HireHop whose barcode is its reg (book-out and
 * check-in scan it), filed under the stock line it is hired as:
 * "Premium LWB Splitter Van - auto gearbox". That stock line is what clients
 * are quoted, so it is the most reliable record of a van's class and gearbox
 * OP has. The fleet's own `gearbox` was often blank, so the fleet board showed
 * no auto/manual and the matcher offered the van for both.
 *
 * Only BLANKS are filled. A value someone set is never overwritten; when it
 * disagrees with HireHop it is reported for a person to decide.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';

export type VanGearbox = 'auto' | 'manual';

/**
 * The fleet type and gearbox a HireHop van stock line's NAME describes.
 * "Standard" is tested before "MWB", or a Standard MWB reads as a Basic.
 * Frontend twin: the name fallback in `extractVanRequirements()`
 * (modules/vehicles/lib/hirehop-api.ts) — keep the two in step.
 */
export function vanTypeFromStockTitle(title: string): { simpleType: string | null; gearbox: VanGearbox | null } {
  const t = title.toLowerCase();
  let simpleType: string | null = null;
  if (t.includes('standard')) simpleType = 'Standard';
  else if (t.includes('premium')) simpleType = 'Premium';
  else if (t.includes('basic') || t.includes('mwb')) simpleType = 'Basic';
  else if (t.includes('vito')) simpleType = 'Vito';
  else if (t.includes('panel')) simpleType = 'Panel';
  const gearbox: VanGearbox | null = /\bmanual\b/.test(t) ? 'manual' : /\bauto(matic)?\b/.test(t) ? 'auto' : null;
  return { simpleType, gearbox };
}

/** The HireHop stock line a reg (asset barcode) is filed under, or null when HireHop doesn't know it. */
export async function lookupVanStockLine(reg: string): Promise<{ stockId: number; title: string } | null> {
  const res = await hhBroker.get<Record<string, unknown>>(
    '/modules/maintenance/get_assets_details.php',
    { BARCODES: reg },
    { priority: 'low', cacheTTL: 0 },
  );
  if (!res.success) throw new Error(res.error || 'HireHop did not answer');
  const d = (res.data || {}) as Record<string, unknown>;
  if (d.error) return null;
  const stockId = Number(d.STOCK_ID ?? 0);
  const title = typeof d.TITLE === 'string' ? d.TITLE : '';
  if (!stockId || !title) return null;
  return { stockId, title };
}

export interface FillFromHireHopResult {
  checked: number;
  filled: Array<{ reg: string; set: string[]; stockTitle: string }>;
  disagrees: Array<{ reg: string; op: string; hirehop: string; stockTitle: string }>;
  notInHireHop: string[];
  unclear: Array<{ reg: string; stockTitle: string }>;
  failed: Array<{ reg: string; error: string }>;
  remaining: number;
}

/** At ~2s a HireHop call, 20 vans stays well inside the 60s a request may take. */
const MAX_PER_RUN = 20;

/**
 * Look up every active van missing its type, or its gearbox (Panel vans don't
 * have one), and fill the blanks from HireHop. Run again for the rest.
 */
export async function fillVanTypesFromHireHop(): Promise<FillFromHireHopResult> {
  const rows = await query(
    `SELECT id, reg, simple_type, gearbox
       FROM fleet_vehicles
      WHERE is_active = true AND COALESCE(fleet_group, '') <> 'old_sold'
        AND (COALESCE(simple_type, '') = ''
             OR (gearbox IS NULL AND COALESCE(simple_type, '') <> 'Panel'))
      ORDER BY reg`,
  );
  const out: FillFromHireHopResult = {
    checked: 0, filled: [], disagrees: [], notInHireHop: [], unclear: [], failed: [],
    remaining: Math.max(0, rows.rows.length - MAX_PER_RUN),
  };

  for (const van of rows.rows.slice(0, MAX_PER_RUN)) {
    out.checked++;
    let line: { stockId: number; title: string } | null;
    try {
      line = await lookupVanStockLine(van.reg);
    } catch (err) {
      out.failed.push({ reg: van.reg, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!line) { out.notInHireHop.push(van.reg); continue; }

    const hh = vanTypeFromStockTitle(line.title);
    const currentType = (van.simple_type || '').trim();
    const setType = !currentType && hh.simpleType ? hh.simpleType : null;
    const typeAfter = setType ?? currentType;
    const setGearbox = !van.gearbox && typeAfter !== 'Panel' && hh.gearbox ? hh.gearbox : null;

    if (currentType && hh.simpleType && currentType !== hh.simpleType) {
      out.disagrees.push({ reg: van.reg, op: currentType, hirehop: hh.simpleType, stockTitle: line.title });
    }
    if (!setType && !setGearbox) {
      if (!currentType || (!van.gearbox && typeAfter !== 'Panel')) out.unclear.push({ reg: van.reg, stockTitle: line.title });
      continue;
    }

    // COALESCE: only ever fills a blank, even if someone set it a moment ago.
    await query(
      `UPDATE fleet_vehicles
          SET simple_type = COALESCE(NULLIF(simple_type, ''), $2),
              gearbox = COALESCE(gearbox, $3)
        WHERE id = $1`,
      [van.id, setType, setGearbox],
    );
    out.filled.push({
      reg: van.reg,
      set: [setType ? `type ${setType}` : null, setGearbox ? `gearbox ${setGearbox}` : null].filter(Boolean) as string[],
      stockTitle: line.title,
    });
  }
  return out;
}
