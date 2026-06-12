/**
 * Cost → Xero reconciliation sync.
 *
 * Closes the COT/spend-money loop: OP pushes a coded Spend Money into Xero
 * (`bill_created`/`attached`), the card's bank feed delivers the real bank
 * line a day or two later, and the bookkeeper one-click reconciles the match
 * IN XERO. Until this sync existed OP never found out — `xero_sync_state`
 * had a `reconciled` value that nothing set, so the /money/costs Reconcile
 * tab never counted down.
 *
 * Daily scheduler task: for every spend-money cost still in
 * bill_created/attached, ask Xero whether its BankTransaction is now
 * IsReconciled and flip our state. The tab then becomes a true exception
 * list — anything still on it after a few days is a card payment whose feed
 * line hasn't been matched (or a missing receipt) and is worth chasing.
 *
 * Xero usage: one GET per chunk of 15 candidates (OR'd BankTransactionID
 * filter), so a typical day is 1-3 calls. Voided/deleted transactions in
 * Xero are left alone here (state stays attached, visible on the tab).
 */
import { query } from '../config/database';
import { isXeroConfigured } from '../config/xero';
import { xeroBroker } from './xero-broker';
import { SPEND_MONEY_METHODS } from './cost-xero-push';

interface BankTxnLite {
  BankTransactionID?: string;
  IsReconciled?: boolean;
}

const CHUNK_SIZE = 15;

export async function runCostXeroReconcileSync(): Promise<{ checked: number; reconciled: number }> {
  if (!isXeroConfigured()) return { checked: 0, reconciled: 0 };

  const candidates = await query(
    `SELECT id, xero_object_id
     FROM costs
     WHERE xero_object_id IS NOT NULL
       AND xero_sync_state IN ('bill_created', 'attached')
       AND payment_method = ANY($1)`,
    [[...SPEND_MONEY_METHODS]]
  );
  const rows = candidates.rows as Array<{ id: string; xero_object_id: string }>;
  if (rows.length === 0) return { checked: 0, reconciled: 0 };

  const reconciledCostIds: string[] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const where = chunk.map((c) => `BankTransactionID==Guid("${c.xero_object_id}")`).join(' OR ');
    let txns: BankTxnLite[];
    try {
      txns = (await xeroBroker.getBankTransactions(where)) as BankTxnLite[];
    } catch (err) {
      // Xero blip — skip this chunk, the next daily run catches up.
      console.error('[cost-xero-reconcile] Xero fetch failed for chunk:', err instanceof Error ? err.message : err);
      continue;
    }
    const reconciledTxnIds = new Set(
      txns.filter((t) => t.IsReconciled === true && t.BankTransactionID).map((t) => t.BankTransactionID as string)
    );
    for (const c of chunk) {
      if (reconciledTxnIds.has(c.xero_object_id)) reconciledCostIds.push(c.id);
    }
  }

  if (reconciledCostIds.length > 0) {
    await query(
      `UPDATE costs
       SET xero_sync_state = 'reconciled', xero_synced_at = NOW(), xero_error = NULL
       WHERE id = ANY($1)`,
      [reconciledCostIds]
    );
  }
  return { checked: rows.length, reconciled: reconciledCostIds.length };
}
