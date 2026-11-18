/**
 * Credit on account (docs/CREDIT-ON-ACCOUNT-SPEC.md) — a client's overpayment kept on
 * the job it was paid on, for their next hire. The shape `services/account-credit.ts`
 * answers with, and the words every screen uses for it.
 *
 * Not a voucher: this is the client's own money (no VAT, no use-by date, nothing lapses).
 */
export type AccountCreditStatus = 'held' | 'reserved' | 'spent' | 'released';

export interface AccountCredit {
  id: string;
  source_job_id: string;
  source_job_number: number | null;
  organisation_id: string;
  client_name: string;
  amount: number;
  amount_checked_at: string;
  note: string | null;
  held_by_name: string | null;
  held_at: string;
  status: AccountCreditStatus;
  reserved_job_id: string | null;
  reserved_job_number: number | null;
  reserved_at: string | null;
  released_at: string | null;
  released_reason: string | null;
}

export const acMoney = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const acDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const acError = (e: unknown, fallback: string) =>
  (e as { body?: { error?: string } })?.body?.error || fallback;

/** "from job 16489" — where the money sits. */
export const fromJob = (c: Pick<AccountCredit, 'source_job_number'>) =>
  c.source_job_number ? `from job ${c.source_job_number}` : 'from an earlier job';

export const AC_STATUS_LABEL: Record<AccountCreditStatus, string> = {
  held: 'On account',
  reserved: 'Put aside for a job',
  spent: 'Used or refunded',
  released: 'No longer held',
};
