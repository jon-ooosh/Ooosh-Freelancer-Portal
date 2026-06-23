/**
 * PCN fine recharge → HireHop.
 *
 * Adds the actual PCN fine amount to the linked HireHop job as a custom-priced
 * billable hire line, so the client is billed for the fine (separate from the
 * fixed £35+VAT handling charge, which addHandlingCharge in pcn-actions.ts still
 * pushes). Because it lands as a real HH billable line, it automatically surfaces
 * on the OP Money tab (which reads HireHop billing live) — no extra Money-tab
 * wiring needed, same as the cost-capture recharge.
 *
 * Mirrors the proven services/cost-recharge-hh.ts mechanism verbatim:
 *   1. snapshot existing supply-list line IDs
 *   2. add the line via save_job.php (b<id>, qty 1)
 *   3. find the new line by stock LIST_ID
 *   4. set its unit price via items_save.php (vat_rate:0 → HireHop derives the
 *      VAT from the stock item's tax rules, exactly like the £35 handling line)
 *
 * VAT note: the fine line uses the SAME stock item as the handling charge
 * (`pcn_hh_charge_item`, default b1744 — a 20%-rated "PCN / fine handling"
 * item). So a recharged fine carries the same VAT treatment as the admin fee.
 * If a fine should be recharged at a different rate (e.g. zero-rated
 * disbursement), point this at a dedicated stock item — kept as the single
 * setting for now.
 *
 * Best-effort: a locked/closed HireHop job returns manualActionRequired so staff
 * add the line by hand; the PCN status + email still proceed.
 */
import { default as hhBroker } from './hirehop-broker';
import { getSystemSettings } from '../routes/system-settings';

// Sales nominal for the PCN recharge stock (matches cost-recharge-hh.ts '399').
const PCN_RECHARGE_NOMINAL = 22;
const CLOSED_HH_STATUSES = [7, 9, 10, 11];

export interface PcnFineRechargeResult {
  applied: boolean;
  amount?: number;
  message: string;
  lineId?: string;
  manualActionRequired?: boolean;
}

interface PcnForRecharge {
  reference: string | null;
  vehicle_reg: string | null;
}

/** Resolve the numeric stock id from the `pcn_hh_charge_item` setting (b1744 → 1744). */
async function resolveStockId(): Promise<number> {
  const settings = await getSystemSettings(['pcn_hh_charge_item']);
  const raw = String(settings.pcn_hh_charge_item || 'b1744').replace(/[^0-9]/g, '');
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : 1744;
}

export async function addPcnFineLine(
  hhJobNumber: number,
  fineAmount: number,
  pcn: PcnForRecharge,
): Promise<PcnFineRechargeResult> {
  if (!(fineAmount > 0)) return { applied: false, message: 'No fine amount to recharge.' };

  const stockId = await resolveStockId();
  const hhJobId = String(hhJobNumber);

  try {
    // Don't add lines to a locked/closed job — surface for manual handling.
    const jobResp = await hhBroker.get<Record<string, unknown>>('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 30 });
    const jd = (jobResp as { data?: Record<string, unknown> })?.data || {};
    const locked = (jd as { LOCKED?: unknown }).LOCKED === 1;
    const hhStatus = parseFloat(String((jd as { STATUS?: unknown }).STATUS || 0));
    if (locked || CLOSED_HH_STATUSES.includes(hhStatus)) {
      return {
        applied: false, manualActionRequired: true,
        message: `HireHop job #${hhJobNumber} is ${locked ? 'locked' : 'closed'} — add the £${fineAmount.toFixed(2)} PCN fine line manually.`,
      };
    }

    // Step 1 — snapshot existing line IDs
    const before = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as { data?: unknown };
    const beforeData = before?.data;
    const beforeItems = Array.isArray(beforeData) ? beforeData : ((beforeData as { items?: unknown[]; rows?: unknown[] })?.items || (beforeData as { rows?: unknown[] })?.rows || []);
    const existingIds = new Set((beforeItems as Array<{ ID: unknown }>).map((i) => i.ID));

    // Step 2 — add the hire line (b<id>) at qty 1
    const addResult = await hhBroker.post('/api/save_job.php', {
      job: hhJobId,
      items: JSON.stringify({ [`b${stockId}`]: 1 }),
      no_webhook: 1,
    }, { priority: 'high' }) as { success?: boolean; error?: unknown };
    if (!addResult?.success) {
      return { applied: false, message: `HireHop rejected the fine line: ${addResult?.error || 'unknown error'}` };
    }

    // Step 3 — find the new line by stock LIST_ID
    await new Promise((res) => setTimeout(res, 1000));
    const after = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as { data?: unknown };
    const afterData = after?.data;
    const afterItems = Array.isArray(afterData) ? afterData : ((afterData as { items?: unknown[]; rows?: unknown[] })?.items || (afterData as { rows?: unknown[] })?.rows || []);
    const newItem = (afterItems as Array<{ ID: unknown; LIST_ID?: unknown }>).find(
      (i) => !existingIds.has(i.ID) && String(i.LIST_ID) === String(stockId),
    );
    if (!newItem) {
      return { applied: false, message: 'Fine line added to HireHop but its ID could not be found — set the price manually.' };
    }

    // Step 4 — set the unit price + descriptive note (vat_rate:0 → HH derives VAT
    // from the stock's tax rules, same as the handling line).
    const note = `PCN fine recharge${pcn.reference ? ` — ${pcn.reference}` : ''}${pcn.vehicle_reg ? ` (${pcn.vehicle_reg})` : ''}`;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const editRes = await hhBroker.post('/php_functions/items_save.php', {
      job: hhJobId, kind: 2, id: newItem.ID, list_id: stockId,
      qty: 1, unit_price: fineAmount, price: fineAmount,
      price_type: 0, add: note, cust_add: '', memo: '', name: '',
      parent: 0, acc_nominal: PCN_RECHARGE_NOMINAL, acc_nominal_po: 0,
      vat_rate: 0, value: 0, cost_price: 0, weight: 0,
      start: '', end: '', duration: 0, country_origin: '', hs_code: '',
      flag: 0, priority_confirm: 0, no_shortfall: 1, no_availability: 0,
      ignore: 0, local: now,
    }, { priority: 'high' }) as { success?: boolean; error?: unknown };
    if (!editRes?.success) {
      return { applied: false, message: `Fine line added but pricing it failed: ${editRes?.error || 'unknown error'}. Set the price manually in HireHop.` };
    }

    return { applied: true, amount: fineAmount, lineId: String(newItem.ID), message: `PCN fine of £${fineAmount.toFixed(2)} recharged to the HireHop job.` };
  } catch (err) {
    return { applied: false, message: `HireHop fine recharge failed: ${(err as Error).message}` };
  }
}
