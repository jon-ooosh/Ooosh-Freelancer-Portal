export type PaymentState = 'paid_full' | 'deposit_secured' | 'deposit_short' | 'no_payment';

export function getPaymentState(f: {
  deposit_percent: number;
  deposit_paid: boolean;
  total_hire_deposits: number;
}): PaymentState {
  if (f.deposit_percent >= 100) return 'paid_full';
  if (f.deposit_paid) return 'deposit_secured';
  if (f.total_hire_deposits > 0) return 'deposit_short';
  return 'no_payment';
}

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  paid_full: 'Paid in full',
  deposit_secured: 'Deposit secured',
  deposit_short: 'Deposit short',
  no_payment: 'No payment yet',
};

export const PAYMENT_STATE_CLASSES: Record<PaymentState, { text: string; pill: string }> = {
  paid_full:       { text: 'text-green-600',  pill: 'bg-green-100 text-green-700 border-green-200' },
  deposit_secured: { text: 'text-green-600',  pill: 'bg-green-100 text-green-700 border-green-200' },
  deposit_short:   { text: 'text-amber-600',  pill: 'bg-amber-100 text-amber-700 border-amber-200' },
  no_payment:      { text: 'text-gray-500',   pill: 'bg-gray-100 text-gray-600 border-gray-200' },
};
