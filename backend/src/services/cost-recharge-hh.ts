/**
 * Cost Capture → HireHop recharge push.
 *
 * Pushes an "extra" cost flagged for client recharge onto its HireHop job as a
 * billable hire line. Mirrors the proven quotes→HH pattern (add the line via
 * save_job.php, then items_save.php to set a custom unit price), adapted for
 * HIRE items (`b<id>` prefix, kind 2). The recharge stock items are 20%-rated,
 * so we push the NET amount as the unit price and HireHop adds the VAT —
 * matching the modal's "net of VAT, VAT added at HireHop" framing.
 *
 * Gated behind an explicit staff "Confirm recharge" click — never auto-fires.
 * Idempotent: a cost already recharged (recharged_to_hh_at set) is a no-op.
 *
 * Stock IDs supplied by jon (Jun 2026), all HIRE items at 20% VAT. Hardcoded
 * here (stable); move to system_settings + a Settings UI if they ever churn.
 */
import { query } from '../config/database';
import { default as hhBroker } from './hirehop-broker';

interface RechargeStock {
  stockId: number;   // HH stock LIST_ID (b<id> hire item)
  nominal: number;   // sales nominal group id (from the stock item)
  poNominal: number; // purchase nominal group id (0 = none)
  label: string;
}

// Map OP cost category (Xero account code) → HH recharge stock item.
const RECHARGE_STOCK: Record<string, RechargeStock> = {
  '410': { stockId: 1325, nominal: 31, poNominal: 18, label: 'Fuel recharge' },        // Fuel
  '411': { stockId: 1772, nominal: 29, poNominal: 0, label: 'Travel cost' },           // Parking
  '325': { stockId: 1772, nominal: 29, poNominal: 0, label: 'Travel cost' },           // Travel
  '399': { stockId: 1744, nominal: 22, poNominal: 0, label: 'PCN / fine handling' },   // Parking fines / PCNs
  '409': { stockId: 1741, nominal: 3, poNominal: 0, label: 'Vehicle damage cost' },    // Vehicle repairs
};
// Everything else (servicing, sub-hire, equipment, office, etc.) → catch-all.
const CATCH_ALL: RechargeStock = { stockId: 1796, nominal: 22, poNominal: 0, label: 'Cost / fee / recharge' };

function stockForCost(xeroAccountCode: string | null): RechargeStock {
  return (xeroAccountCode && RECHARGE_STOCK[String(xeroAccountCode)]) || CATCH_ALL;
}

export interface RechargePushResult {
  pushed: boolean;
  skipped?: string;
  error?: string;
  manualActionRequired?: boolean;
  hhJobNumber?: number;
  amount?: number;
  stockLabel?: string;
  lineId?: string;
}

const CLOSED_HH_STATUSES = [7, 9, 10, 11];

export async function pushRechargeToHH(costId: string): Promise<RechargePushResult> {
  const r = await query(
    `SELECT c.*, j.hh_job_number
       FROM costs c LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.id = $1`,
    [costId],
  );
  const cost = r.rows[0];
  if (!cost) return { pushed: false, error: 'Cost not found' };

  // Guards
  if (cost.recharge_mode === 'none' || !cost.recharge_mode) return { pushed: false, skipped: 'Cost is not flagged for recharge' };
  if (cost.recharged_to_hh_at) return { pushed: false, skipped: 'Already recharged to HireHop' };
  if (cost.cost_intent === 'quote_actual') return { pushed: false, skipped: 'Cost is part of a quote — not rechargeable' };
  if (!cost.job_id || !cost.hh_job_number) return { pushed: false, error: 'Cost must be linked to a HireHop job to recharge' };

  // NET amount to bill (HH adds 20% VAT). Full → the cost's net (ex-VAT cost to
  // us); partial → the staff-entered recharge_amount (entered net of VAT).
  const net = cost.recharge_mode === 'full'
    ? Number(cost.amount_net ?? cost.amount_gross ?? 0)
    : Number(cost.recharge_amount ?? 0);
  if (!(net > 0)) return { pushed: false, error: 'Recharge amount must be greater than zero' };

  const stock = stockForCost(cost.xero_account_code);
  const hhJobId = String(cost.hh_job_number);

  // Don't add lines to a locked/closed job — surface for manual handling.
  const jobResp = await hhBroker.get<Record<string, unknown>>('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 30 });
  const jd = jobResp?.data || {};
  const locked = jd.LOCKED === 1;
  const hhStatus = parseFloat(String(jd.STATUS || 0));
  if (locked || CLOSED_HH_STATUSES.includes(hhStatus)) {
    return {
      pushed: false, manualActionRequired: true, hhJobNumber: cost.hh_job_number,
      error: `HireHop job #${cost.hh_job_number} is ${locked ? 'locked' : 'closed'} — add the £${net.toFixed(2)} ${stock.label} line manually.`,
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
    items: JSON.stringify({ [`b${stock.stockId}`]: 1 }),
    no_webhook: 1,
  }, { priority: 'high' }) as { success?: boolean; error?: unknown };
  if (!addResult?.success) {
    return { pushed: false, error: `HireHop rejected the recharge line: ${addResult?.error || 'unknown error'}` };
  }

  // Step 3 — find the new line by stock LIST_ID
  await new Promise((res) => setTimeout(res, 1000));
  const after = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as { data?: unknown };
  const afterData = after?.data;
  const afterItems = Array.isArray(afterData) ? afterData : ((afterData as { items?: unknown[]; rows?: unknown[] })?.items || (afterData as { rows?: unknown[] })?.rows || []);
  const newItem = (afterItems as Array<{ ID: unknown; LIST_ID?: unknown }>).find(
    (i) => !existingIds.has(i.ID) && String(i.LIST_ID) === String(stock.stockId),
  );
  if (!newItem) {
    return { pushed: false, error: 'Recharge line added to HireHop but its ID could not be found — check the job and set the price manually.' };
  }

  // Step 4 — set the unit price + descriptive note (vat_rate:0 → HH derives the
  // 20% from the stock's tax rules, same as the quotes push).
  const supplier = (cost.supplier_name || '').toString().slice(0, 120);
  const note = `Recharge: ${stock.label}${supplier ? ` — ${supplier}` : ''} (£${net.toFixed(2)} + VAT)`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const editRes = await hhBroker.post('/php_functions/items_save.php', {
    job: hhJobId, kind: 2, id: newItem.ID, list_id: stock.stockId,
    qty: 1, unit_price: net, price: net,
    price_type: 0, add: note, cust_add: '', memo: '', name: '',
    parent: 0, acc_nominal: stock.nominal, acc_nominal_po: stock.poNominal,
    vat_rate: 0, value: 0, cost_price: 0, weight: 0,
    start: '', end: '', duration: 0, country_origin: '', hs_code: '',
    flag: 0, priority_confirm: 0, no_shortfall: 1, no_availability: 0,
    ignore: 0, local: now,
  }, { priority: 'high' }) as { success?: boolean; error?: unknown };
  if (!editRes?.success) {
    return { pushed: false, error: `Recharge line added but pricing it failed: ${editRes?.error || 'unknown error'}. Set the price manually in HireHop.` };
  }

  // Stamp the cost as recharged
  await query(
    `UPDATE costs SET recharged_to_hh_at = NOW(), recharge_hh_item_id = $1 WHERE id = $2`,
    [String(newItem.ID), costId],
  );

  // Best-effort HH job note
  try {
    await hhBroker.get('/api/job_note.php', {
      job: hhJobId,
      note: `Client recharge added: ${stock.label} £${net.toFixed(2)} + VAT (from cost capture${supplier ? ` — ${supplier}` : ''}). (${new Date().toLocaleDateString('en-GB')})`,
    }, { priority: 'low' });
  } catch (noteErr) {
    console.warn('[cost-recharge-hh] job note failed (non-fatal):', (noteErr as Error).message);
  }

  return { pushed: true, hhJobNumber: cost.hh_job_number, amount: net, stockLabel: stock.label, lineId: String(newItem.ID) };
}
