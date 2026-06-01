/**
 * ve103b-hh.ts — add the VE103B certificate line item to a HireHop job.
 *
 * Used by the book-out "surprise EU" path: a customer who wasn't flagged as
 * going abroad on the HH job decides at the desk they're taking the van to the
 * EU. We add the chargeable VE103B cert item (stock 1023, £25 one-off) to the
 * HH job so it's billed + recorded HH-side, then generate the cert.
 *
 * Modelled verbatim on hire-forms.ts `processAdditionalDriverCharge`:
 *   - count what's already on HH first (idempotent — never double-charge),
 *   - skip locked/closed jobs (return manualActionRequired),
 *   - post a confirming HH note.
 */
import { hhBroker } from './hirehop-broker';
import { isHireHopConfigured } from '../config/hirehop';

const VE103B_CERT_ITEM_ID = 1023;

export interface EnsureVe103bResult {
  existing: number;
  added: number;
  certsNeeded: number;
  message?: string;
  manualActionRequired?: boolean;
}

/**
 * Ensure the HH job carries at least `certsNeeded` units of the VE103B cert
 * item. Adds only the delta. `certsNeeded` = number of vans going abroad.
 */
export async function ensureVe103bCertItemOnJob(
  hhJobId: number,
  certsNeeded: number
): Promise<EnsureVe103bResult> {
  if (!isHireHopConfigured()) {
    return { existing: 0, added: 0, certsNeeded, message: 'HireHop not configured', manualActionRequired: true };
  }
  if (certsNeeded <= 0) {
    return { existing: 0, added: 0, certsNeeded, message: 'No certs needed' };
  }

  // Count existing VE103B cert lines on the job. Same envelope-unwrap +
  // LIST_ID stock-id match the additional-driver counter uses (ITEM_ID is the
  // per-LINE id and would never match the stable stock id).
  const itemsResponse = await hhBroker.get<unknown>(
    '/frames/items_to_supply_list.php',
    { job: hhJobId },
    { priority: 'high', cacheTTL: 30 }
  );
  const rawItems: unknown = (itemsResponse as { data?: unknown })?.data;
  const items: unknown[] = Array.isArray(rawItems)
    ? rawItems
    : ((rawItems as { items?: unknown[]; rows?: unknown[] } | undefined)?.items
       || (rawItems as { items?: unknown[]; rows?: unknown[] } | undefined)?.rows
       || []);

  let existing = 0;
  for (const item of items as Record<string, unknown>[]) {
    const stockId = parseInt(String(item.LIST_ID || item.ITEM_ID || item.ID || 0));
    const qty = parseFloat(String(item.qty || item.QTY || item.quantity || item.QUANTITY || 1));
    if (stockId === VE103B_CERT_ITEM_ID) existing += qty;
  }

  const toAdd = Math.max(0, certsNeeded - existing);
  if (toAdd <= 0) {
    return { existing, added: 0, certsNeeded, message: 'VE103B cert item already present' };
  }

  // Don't write to locked/closed jobs.
  const jobResp = await hhBroker.get<Record<string, unknown>>('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 30 });
  const jd = jobResp.data || {};
  const locked = jd.LOCKED === 1;
  const hhStatus = parseFloat(String(jd.STATUS || 0));
  const isClosed = [7, 9, 10, 11].includes(hhStatus);
  if (locked || isClosed) {
    return {
      existing, added: 0, certsNeeded,
      message: `Job is ${locked ? 'locked' : 'closed'} — add ${toAdd} VE103B cert item(s) manually in HireHop`,
      manualActionRequired: true,
    };
  }

  // Add the cert item via save_job.php (the "b<stockId>" item-key form).
  await hhBroker.post('/api/save_job.php', {
    job: hhJobId,
    items: JSON.stringify({ [`b${VE103B_CERT_ITEM_ID}`]: toAdd }),
    no_webhook: 1,
  }, { priority: 'high' });

  // Confirming note.
  await hhBroker.get('/api/job_note.php', {
    job: hhJobId,
    note: `VE103B certificate item added automatically (vehicle going to EU). Added: ${toAdd} × £25+VAT. (${new Date().toLocaleDateString('en-GB')})`,
  }, { priority: 'low' });

  return { existing, added: toAdd, certsNeeded };
}
