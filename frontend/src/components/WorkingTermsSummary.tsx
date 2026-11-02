/**
 * Working Terms block on the Organisation / Person Details tab.
 *
 * When the record is Do Not Hire, the DNH line leads and the terms underneath
 * are faded ("on hold") rather than hidden — a manager can still choose to hire
 * them, and whoever quotes then needs to know what terms they were on.
 * DNH itself is set in the Edit panel's Working Terms section (managers).
 */
const TERMS_COLOUR: Record<string, string> = { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' };
const TERMS_LABEL: Record<string, string> = { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' };
const TERMS_HINT: Record<string, string> = { usual: '25% deposit, full balance before hire', flex_balance: '25% deposit, flexible balance', no_deposit: 'Balance by start of hire', credit: 'No deposit, flexible balance', custom: '' };

export default function WorkingTermsSummary({ type, creditDays, notes, doNotHire, doNotHireReason }: {
  type: string | null;
  creditDays: number | null;
  notes: string | null;
  doNotHire?: boolean;
  doNotHireReason?: string | null;
}) {
  return (
    <div className="mt-6 pt-4 border-t">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Working Terms</h3>
      {doNotHire && (
        <p className="mb-2 text-sm">
          <span className="inline-block px-2.5 py-1 rounded-full text-xs font-semibold text-white bg-red-600">DO NOT HIRE</span>
          {doNotHireReason && <span className="ml-2 text-red-600 text-xs">{doNotHireReason}</span>}
        </p>
      )}
      {type ? (
        <div className={`text-sm ${doNotHire ? 'opacity-50' : ''}`}>
          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold text-white ${TERMS_COLOUR[type] || 'bg-gray-500'}`}>
            {TERMS_LABEL[type] || type}
          </span>
          <span className="ml-2 text-gray-500 text-xs">{TERMS_HINT[type]}</span>
          {(type === 'flex_balance' || type === 'credit') && creditDays && (
            <span className="ml-1 text-gray-500 text-xs">({creditDays} day credit)</span>
          )}
          {doNotHire && <span className="ml-2 text-gray-500 text-xs italic">— on hold while Do Not Hire</span>}
          {notes && <p className="mt-1 text-gray-500 text-xs">{notes}</p>}
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">Not set — edit to configure</p>
      )}
    </div>
  );
}
