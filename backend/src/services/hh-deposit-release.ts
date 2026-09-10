/**
 * Releasing money back off a HireHop invoice so a deposit can be refunded.
 *
 * THE PROBLEM (job 15628, Sep 2026)
 * ---------------------------------
 * `billing_payments_save.php` with `OWNER: 0, deposit: <id>` means "take money
 * back OUT of this deposit". HireHop rejects it with **error 370** once the
 * deposit has been fully APPLIED to an invoice — there is nothing unallocated
 * left to refund. On 15628 that surfaced as a real £91.12 Stripe refund whose
 * HireHop leg failed, leaving money moved and recorded nowhere.
 *
 * The fix is to release the amount back off the invoice first, which returns it
 * to the deposit's unallocated balance, and then refund normally.
 *
 * WHAT THE API ACTUALLY DOES (probed against job 16668, 10 Sep 2026)
 * -----------------------------------------------------------------
 *   • A deposit's refundable balance is its `owing` field NEGATED
 *     (`available = -owing`). The kind=6 row also carries `paid` (how much has
 *     been spent), so `credit - paid` is an independent second reading.
 *
 *   • ⚠️ Posting a NEGATIVE application (`paid: -10`) DOES NOT WORK, and fails
 *     SILENTLY: HireHop returns `success: true`, creates a real application row,
 *     and clamps the amount to £0.00. Nothing moves. This was the preferred
 *     approach going in — append-only, clean audit trail — and it is the reason
 *     `releaseFromInvoice` VERIFIES by re-reading rather than trusting the
 *     response. A caller that trusted it would refund the client in Stripe and
 *     then hit 370 anyway: the original incident, automated.
 *
 *   • EDITING the existing application down (`id: <appId>, paid: <reduced>`)
 *     DOES work. Destructive, but it is the only variant that does.
 *
 *   • The release needs its own `accounting/tasks.php` `post_payment` call.
 *     Without it the amended application never reaches Xero and HireHop/Xero
 *     disagree — worse than the problem being fixed. Every save response names
 *     its own sync parameters (`hh_task`, `hh_id`, `hh_acc_package_id`,
 *     `hh_package_type`), so read them back rather than assuming.
 *
 * See docs/reference/MONEY-AND-EXCESS.md for the full incident + runbook.
 */
import { hhBroker } from './hirehop-broker';

/** One movement of money OFF a deposit — an invoice application or a refund. */
export interface DepositApplication {
  applicationId: number;
  invoiceId: number;
  invoiceNumber: string | null;
  /** Positive = this much left the deposit. */
  amount: number;
  date: string;
  bankId: number | null;
  description: string;
  memo: string;
}

export interface DepositAvailability {
  depositId: number;
  /** Cash received on the deposit. */
  credit: number;
  /** Unallocated money, i.e. what can be refunded right now. */
  available: number;
  /** Invoice applications, newest last. Refunds are excluded. */
  applications: DepositApplication[];
  /** True when HireHop's `owing` and `credit - paid` agreed. */
  readingsAgree: boolean;
}

type Row = Record<string, any>;

/** Read the job's billing rows fresh — a stale read here would be a wrong refund. */
async function readBillingRows(hhJobNumber: number): Promise<Row[]> {
  const res = await hhBroker.get<{ rows?: Row[] }>(
    '/php_functions/billing_list.php',
    { main_id: hhJobNumber, type: 1 },
    { priority: 'high', cacheTTL: 0, skipCache: true },
  );
  if (!res.success) throw new Error(res.error || 'HireHop billing read failed');
  return res.data?.rows || [];
}

/**
 * How much of `depositId` is unallocated, and what it is applied to.
 *
 * Availability is taken as the MINIMUM of HireHop's two readings (`-owing` and
 * `credit - paid`). They agreed on every deposit probed, but if they ever
 * diverge the smaller figure is the safe one: over-stating availability means
 * moving Stripe money and then hitting 370, which is the bug being fixed.
 */
export function readDepositAvailability(rows: Row[], depositId: number): DepositAvailability | null {
  const depRow = rows.find((r) => {
    if (parseInt(r.kind ?? '0') !== 6) return false;
    const d = r.data || {};
    return parseInt(d.ID || r.number || '0') === Number(depositId);
  });
  if (!depRow) return null;

  const d = depRow.data || {};
  const credit = parseFloat(depRow.credit ?? d.credit ?? '0');
  const rawOwing = depRow.owing ?? d.owing;
  const rawPaid = depRow.paid ?? d.paid;

  const viaOwing = rawOwing == null || rawOwing === '' ? null : -parseFloat(String(rawOwing));
  const viaPaid = rawPaid == null || rawPaid === '' ? null : credit - parseFloat(String(rawPaid));
  const readings = [viaOwing, viaPaid].filter((v): v is number => v != null && Number.isFinite(v));
  const available = readings.length > 0 ? Math.max(Math.min(...readings), 0) : 0;
  const readingsAgree = readings.length < 2 || Math.abs(readings[0] - readings[1]) < 0.005;
  if (!readingsAgree) {
    console.warn(`[hh-release] Deposit ${depositId}: HireHop's two availability readings disagree ` +
      `(-owing=${viaOwing}, credit-paid=${viaPaid}). Using the smaller.`);
  }

  // Applications: the DEPOSIT-SIDE twin only. HireHop dual-publishes each
  // application as deposit-side (credit < 0) and invoice-side (credit > 0)
  // rows sharing one data.ID; keying on the side keeps the sign meaningful,
  // where the Math.abs() dedup used in routes/money.ts would not.
  // OWNER = 0 is a refund out to the client, not an invoice application — it
  // spends the deposit but there is nothing to release from it.
  const applications: DepositApplication[] = [];
  for (const row of rows) {
    if (parseInt(row.kind ?? '0') !== 3) continue;
    const rd = row.data || {};
    if (String(row.parent_is ?? rd.parent_is ?? '') !== 'deposit') continue;
    if (Number(rd.OWNER_DEPOSIT ?? 0) !== Number(depositId)) continue;
    const invoiceId = rd.OWNER != null ? parseInt(String(rd.OWNER)) : 0;
    if (invoiceId <= 0) continue;
    const amount = -parseFloat(row.credit ?? rd.credit ?? '0');
    if (!(amount > 0.005)) continue;   // £0 rows include the clamped no-ops
    applications.push({
      applicationId: parseInt(rd.ID || '0'),
      invoiceId,
      invoiceNumber: rd.INVOICE_NUMBER ? String(rd.INVOICE_NUMBER) : null,
      amount,
      date: String(rd.DATE || row.date || ''),
      bankId: rd.ACC_ACCOUNT_ID != null ? Number(rd.ACC_ACCOUNT_ID) : null,
      description: String(rd.DESCRIPTION || row.desc || ''),
      memo: String(rd.MEMO || ''),
    });
  }

  return { depositId, credit, available, applications, readingsAgree };
}

/** Convenience wrapper — fetch the rows and read one deposit's availability. */
export async function fetchDepositAvailability(
  hhJobNumber: number,
  depositId: number,
): Promise<DepositAvailability | null> {
  return readDepositAvailability(await readBillingRows(hhJobNumber), depositId);
}

/** Fire HireHop's accounting sync, using the parameters HireHop itself returned. */
async function syncSavedRowToXero(label: string, data: Record<string, any> | undefined): Promise<boolean> {
  const hhId = data?.hh_id ?? data?.id ?? data?.ID ?? null;
  if (!hhId) {
    console.error(`[hh-release] ${label}: no hh_id in the save response — cannot sync to Xero.`);
    return false;
  }
  try {
    const res = await hhBroker.post('/php_functions/accounting/tasks.php', {
      hh_package_type: data?.hh_package_type ?? 1,
      hh_acc_package_id: data?.hh_acc_package_id ?? 3,
      hh_task: data?.hh_task ?? 'post_payment',
      hh_id: hhId,
      hh_acc_id: '',
    }, { priority: 'high' });
    if (!res.success) console.error(`[hh-release] ${label}: Xero sync failed — ${res.error}`);
    return res.success;
  } catch (e) {
    console.error(`[hh-release] ${label}: Xero sync threw —`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Set an existing deposit→invoice application to `newAmount`, then sync it.
 * Every other field is carried over from the row as HireHop published it, so an
 * edit never silently blanks a description, memo, date or bank.
 */
async function setApplicationAmount(
  app: DepositApplication,
  depositId: number,
  newAmount: number,
): Promise<{ ok: boolean; error: string | null }> {
  const res = await hhBroker.post<Record<string, any>>('/php_functions/billing_payments_save.php', {
    id: app.applicationId,
    date: app.date ? String(app.date).split(' ')[0] : new Date().toISOString().split('T')[0],
    desc: app.description,
    paid: Number(newAmount.toFixed(2)),
    memo: app.memo,
    bank: app.bankId ?? 265,
    OWNER: app.invoiceId,
    deposit: depositId,
    correction: 0,
    no_webhook: 1,
  }, { priority: 'high' });
  if (!res.success || !res.data) {
    return { ok: false, error: res.error || 'HireHop did not accept the application edit' };
  }
  await syncSavedRowToXero(`application ${app.applicationId} -> ${newAmount.toFixed(2)}`, res.data);
  return { ok: true, error: null };
}

export interface ReleaseResult {
  released: boolean;
  /** Availability after the release — re-read from HireHop, never assumed. */
  availableAfter: number;
  /** Set when the release could not be completed. */
  error: string | null;
  /** What was changed, so the caller can put it back if a later step fails. */
  undo: { application: DepositApplication; originalAmount: number } | null;
}

/**
 * Release `shortfall` from the deposit's single invoice application so at least
 * `requiredAvailable` becomes refundable.
 *
 * VERIFIES BY RE-READING. HireHop has been observed returning `success: true`
 * for a write it silently clamped to zero, so the save response is not evidence
 * that anything moved — only the re-read is.
 */
export async function releaseFromInvoice(opts: {
  hhJobNumber: number;
  depositId: number;
  application: DepositApplication;
  shortfall: number;
  requiredAvailable: number;
}): Promise<ReleaseResult> {
  const { hhJobNumber, depositId, application, shortfall, requiredAvailable } = opts;
  const target = Number((application.amount - shortfall).toFixed(2));
  if (target < -0.005) {
    return { released: false, availableAfter: 0, undo: null,
      error: `Cannot release £${shortfall.toFixed(2)} — the application to invoice ${application.invoiceId} is only £${application.amount.toFixed(2)}.` };
  }

  console.log(`[hh-release] Releasing £${shortfall.toFixed(2)} from invoice ${application.invoiceId} ` +
    `back onto deposit ${depositId} (application ${application.applicationId}: £${application.amount.toFixed(2)} -> £${target.toFixed(2)})`);
  const edit = await setApplicationAmount(application, depositId, target);
  if (!edit.ok) {
    return { released: false, availableAfter: 0, undo: null, error: edit.error };
  }

  const after = await fetchDepositAvailability(hhJobNumber, depositId);
  const availableAfter = after?.available ?? 0;
  if (availableAfter + 0.005 < requiredAvailable) {
    // The write reported success but the money did not move. Put it back —
    // leaving a half-done release on an untouched refund helps nobody.
    console.error(`[hh-release] Release did not land: deposit ${depositId} shows £${availableAfter.toFixed(2)} ` +
      `available, needed £${requiredAvailable.toFixed(2)}. Reverting.`);
    const revert = await setApplicationAmount(application, depositId, application.amount);
    return {
      released: false,
      availableAfter,
      undo: null,
      error: `HireHop accepted the release but the money did not move (deposit shows £${availableAfter.toFixed(2)} available, £${requiredAvailable.toFixed(2)} needed).` +
        (revert.ok ? ' The change has been reverted; nothing was refunded.'
                   : ` Reverting it ALSO failed (${revert.error}) — check HireHop application ${application.applicationId} by hand. Nothing was refunded.`),
    };
  }

  return { released: true, availableAfter, error: null, undo: { application, originalAmount: application.amount } };
}

/**
 * Put a release back after a later step failed. Tried twice (the second attempt
 * covers a transient HireHop blip); if both fail the caller must tell a human,
 * because HireHop will show the invoice owing money the client has already paid.
 */
export async function revertRelease(
  depositId: number,
  undo: NonNullable<ReleaseResult['undo']>,
): Promise<{ ok: boolean; error: string | null }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await setApplicationAmount(undo.application, depositId, undo.originalAmount);
    if (res.ok) {
      console.log(`[hh-release] Reverted application ${undo.application.applicationId} to £${undo.originalAmount.toFixed(2)} (attempt ${attempt})`);
      return { ok: true, error: null };
    }
    console.error(`[hh-release] Revert attempt ${attempt} failed: ${res.error}`);
  }
  return { ok: false, error: `Could not restore HireHop application ${undo.application.applicationId} to £${undo.originalAmount.toFixed(2)}` };
}
