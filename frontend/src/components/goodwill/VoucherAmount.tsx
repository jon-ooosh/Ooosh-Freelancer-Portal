import { useState } from 'react';
import { AmountInputs, EMPTY_AMOUNTS, readAmounts, type AmountStrings } from '../damage-money/AmountInputs';

/**
 * A voucher's value, entered like the Costs form: Net (ex VAT) · VAT · Gross (inc VAT) at
 * 20% — type either side and the other follows (jon, 18 Nov 2026), so "£16.67 + VAT = £20"
 * is visible as you type. docs/GOODWILL-CREDIT-SPEC.md §17.
 */
export interface VoucherValue { amount_ex_vat: number; value_inc_vat: number }

export function useVoucherAmount(initial: AmountStrings = EMPTY_AMOUNTS) {
  const [amounts, setAmounts] = useState<AmountStrings>(initial);
  const read = readAmounts(amounts);
  const value: VoucherValue | null = read && read.amount_net > 0 && read.amount_gross > 0
    ? { amount_ex_vat: read.amount_net, value_inc_vat: read.amount_gross }
    : null;
  return { amounts, setAmounts, value };
}

export default function VoucherAmount({ amounts, onChange }: { amounts: AmountStrings; onChange: (a: AmountStrings) => void }) {
  return <AmountInputs value={amounts} mode="vat20" onChange={onChange} onModeChange={() => {}} only20 />;
}
