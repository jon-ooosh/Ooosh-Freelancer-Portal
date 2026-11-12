/**
 * Net / VAT / gross, entered like the Costs form: "20% VAT" works the other
 * two out from whichever you type, "No VAT" keeps net = gross, "Manual" lets
 * you type all three (the save refuses three that don't add up).
 * Used by the damage Money card (docs/INCIDENT-CLAIMS-SPEC.md §23).
 */

export type VatMode = 'vat20' | 'none' | 'manual';
export interface AmountStrings { net: string; vat: string; gross: string }

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '');
const parse = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export const EMPTY_AMOUNTS: AmountStrings = { net: '', vat: '', gross: '' };

/** The mode an existing line was most likely entered in. */
export function inferVatMode(net: number, vat: number): VatMode {
  if (vat <= 0.004) return 'none';
  if (Math.abs(vat - net * 0.2) < 0.02) return 'vat20';
  return 'manual';
}

export function amountsFromNumbers(net: number, vat: number, gross: number): AmountStrings {
  return { net: fmt(net), vat: fmt(vat), gross: fmt(gross) };
}

/** The three as numbers, or null while any is missing / not a number. */
export function readAmounts(a: AmountStrings): { amount_net: number; amount_vat: number; amount_gross: number } | null {
  const net = parse(a.net);
  const vat = parse(a.vat);
  const gross = parse(a.gross);
  if (net === null || vat === null || gross === null) return null;
  return { amount_net: round2(net), amount_vat: round2(vat), amount_gross: round2(gross) };
}

/** True when the three add up (to a penny) — only a Manual entry can fail this. */
export function amountsAddUp(a: AmountStrings): boolean {
  const r = readAmounts(a);
  if (!r) return false;
  return Math.abs(Math.round(r.amount_gross * 100) - Math.round(r.amount_net * 100) - Math.round(r.amount_vat * 100)) <= 1;
}

/** Re-work the other two after one field is typed, for the given mode. */
function recalc(mode: VatMode, field: keyof AmountStrings, value: string, prev: AmountStrings): AmountStrings {
  const next = { ...prev, [field]: value };
  if (mode === 'manual') return next;
  const n = parse(value);
  if (n === null) {
    return mode === 'none' ? { net: value, vat: '0.00', gross: value } : { ...next, vat: '', [field === 'net' ? 'gross' : 'net']: '' };
  }
  if (mode === 'none') return { net: value, vat: '0.00', gross: value };
  // 20% VAT
  if (field === 'gross') {
    const net = round2(n / 1.2);
    return { net: fmt(net), vat: fmt(round2(n - net)), gross: value };
  }
  if (field === 'net') {
    const gross = round2(n * 1.2);
    return { net: value, vat: fmt(round2(gross - n)), gross: fmt(gross) };
  }
  return next;
}

export function AmountInputs({ value, mode, onChange, onModeChange }: {
  value: AmountStrings;
  mode: VatMode;
  onChange: (v: AmountStrings) => void;
  onModeChange: (m: VatMode) => void;
}) {
  const box = 'w-full border border-slate-300 rounded px-2 py-1 text-sm';
  const setMode = (m: VatMode) => {
    onModeChange(m);
    // Re-work from the net when switching, so the three stay consistent.
    if (m !== 'manual' && value.net.trim() !== '') onChange(recalc(m, 'net', value.net, value));
  };
  const field = (key: keyof AmountStrings, label: string, readOnly = false) => (
    <label className="block">
      <span className="text-[11px] text-slate-500">{label}</span>
      <input
        type="number" min={0} step="0.01" inputMode="decimal"
        value={value[key]}
        readOnly={readOnly}
        onChange={(e) => onChange(recalc(mode, key, e.target.value, value))}
        className={`${box} ${readOnly ? 'bg-slate-50 text-slate-500' : ''}`}
      />
    </label>
  );
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {([['vat20', '20% VAT'], ['none', 'No VAT'], ['manual', 'Manual']] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-2 py-0.5 text-[11px] rounded border ${mode === m ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-slate-600 border-slate-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {field('net', 'Net (ex VAT)')}
        {field('vat', 'VAT', mode !== 'manual')}
        {field('gross', 'Gross (inc VAT)', mode === 'none')}
      </div>
      {mode === 'manual' && readAmounts(value) && !amountsAddUp(value) && (
        <div className="text-[11px] text-red-600">Net + VAT doesn’t add up to the gross.</div>
      )}
    </div>
  );
}
