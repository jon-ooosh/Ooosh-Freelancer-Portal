import { useState, useEffect, useMemo } from 'react';
import { CANCELLATION_REASON_OPTIONS } from '../../../shared/types';
import { api } from '../services/api';
import CancelOpenRequirementsSection from './CancelOpenRequirementsSection';

// Postgres NUMERIC columns come back as strings via the pg driver.
// Coerce defensively before any .toFixed / arithmetic.
const toNum = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};
const fmtMoney = (v: unknown): string => `£${toNum(v).toFixed(2)}`;

interface TransportCrewData {
  quotes: Array<{ id: string; job_type: string; venue_name: string; client_charge_total: number | string; ops_status: string }>;
  crew: Array<{ id: string; first_name: string; last_name: string; email: string; role: string; agreed_rate: number | string }>;
  vehicles: Array<{ id: string; registration: string; vehicle_name: string; status: string }>;
  excess: Array<{ id: string; excess_amount_required: number | string; excess_amount_taken?: number | string; excess_status: string }>;
}

interface MoneySummary {
  financial: {
    hire_value_ex_vat: number | string;
    hire_value_inc_vat: number | string;
    vat_amount: number | string;
    vat_adjusted: boolean;
    vat_saved: number | string;
    original_hire_value_inc_vat?: number | string;
    total_hire_deposits: number | string;
    total_deposits: number | string;
  };
}

interface ContactSummary {
  contacts: Array<{ name: string; email: string; source?: string }>;
}

interface CancellationCalcResult {
  fee: number;
  refund: number;
  tier: string;
  noticeDays: number;
  breakdown: string;
  feeBreakdown: Array<{ label: string; amount: number }>;
  summary: string;
  minimumApplied: boolean;
  transportIncluded: number;
}

interface Props {
  jobId: string;
  jobName: string;
  jobNumber: string | null;
  hireValue: number | null;          // Fallback only — we prefer the live Money summary
  hireStartDate: string | null;
  totalHireDays: number | null;
  userRole: string;
  onConfirm: (data: {
    cancellation_reason: string;
    cancellation_notes: string;
    cancellation_fee: number;
    cancellation_refund: number;
    cancellation_tier: string;
    cancellation_notice_days: number;
    transport_charges: number;
    breakdown: string;
    cancelled_at?: string;
    cancellation_outstanding_balance?: number;
    send_client_email?: boolean;
    keep_requirement_ids?: string[];
  }) => void;
  onCancel: () => void;
  saving: boolean;
}

// Format YYYY-MM-DD for <input type="date">
const isoDate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default function CancellationModal({
  jobId, jobName, jobNumber, hireValue, hireStartDate, totalHireDays,
  userRole, onConfirm, onCancel, saving,
}: Props) {
  const [reason, setReason] = useState<string>(CANCELLATION_REASON_OPTIONS[0]);
  const [notes, setNotes] = useState('');
  const [transportCharges, setTransportCharges] = useState(0);
  const [calcResult, setCalcResult] = useState<CancellationCalcResult | null>(null);
  const [transportCrew, setTransportCrew] = useState<TransportCrewData | null>(null);
  const [moneySummary, setMoneySummary] = useState<MoneySummary | null>(null);
  const [contacts, setContacts] = useState<ContactSummary['contacts']>([]);
  const [showRecipients, setShowRecipients] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualFee, setManualFee] = useState<string>('');
  const [useManual, setUseManual] = useState(false);
  const [keepRequirementIds, setKeepRequirementIds] = useState<Set<string>>(new Set());
  const [cancelledOn, setCancelledOn] = useState<string>(isoDate(new Date()));
  const [confirmText, setConfirmText] = useState('');
  // Default: send the email. The opt-out is here for the cases where
  // staff have already had the conversation by phone / out-of-band and
  // a templated confirmation would be redundant or odd.
  const [sendClientEmail, setSendClientEmail] = useState(true);

  const today = isoDate(new Date());
  const minDate = isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

  const canAction = userRole === 'admin' || userRole === 'manager';

  // Effective hire value: prefer live Money summary (ex-VAT, post-international-VAT-adjustment)
  // and fall back to the cached job.job_value if the summary couldn't be fetched.
  const liveHireValueExVat = moneySummary ? toNum(moneySummary.financial.hire_value_ex_vat) : 0;
  const fallbackHireValue = toNum(hireValue);
  const effectiveHireValueExVat = liveHireValueExVat > 0 ? liveHireValueExVat : fallbackHireValue;
  const effectiveHireValueIncVat = moneySummary ? toNum(moneySummary.financial.hire_value_inc_vat) : effectiveHireValueExVat * 1.2;
  const vatAdjusted = !!moneySummary?.financial.vat_adjusted;
  const vatSaved = toNum(moneySummary?.financial.vat_saved);

  // Initial fetch — Money summary + transport/crew + contacts (independent)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.get<{ data: MoneySummary }>(`/money/${jobId}/summary`)
      .then(res => { if (!cancelled) setMoneySummary(res.data); })
      .catch(err => console.warn('Failed to load money summary:', err));

    api.get<TransportCrewData>(`/cancellations/${jobId}/transport-crew`)
      .then(d => { if (!cancelled) setTransportCrew(d); })
      .catch(err => console.warn('Failed to load transport/crew:', err));

    api.get<ContactSummary>(`/hire-forms/email-contacts/${jobId}`)
      .then(d => { if (!cancelled) setContacts(d.contacts || []); })
      .catch(err => console.warn('Failed to load contacts:', err));

    // Loading flag clears once we've made our initial pass — calculator
    // useEffect (below) will populate calcResult independently.
    setLoading(false);
    return () => { cancelled = true; };
  }, [jobId]);

  // Run / re-run the calculator any time inputs the user can change drift.
  // Includes the cancelled-on date so backdating immediately reflects in the
  // tier / fee / refund.
  useEffect(() => {
    const cost = effectiveHireValueExVat;
    if (!cost || cost <= 0 || !hireStartDate) return;
    let cancelled = false;
    api.post<CancellationCalcResult>(`/cancellations/${jobId}/calculate`, {
      totalHireCost: cost,
      hireStartDate,
      cancellationDate: cancelledOn,
      transportCharges,
      totalHireDays: totalHireDays && totalHireDays > 0 ? totalHireDays : undefined,
    })
      .then(r => { if (!cancelled) setCalcResult(r); })
      .catch(err => console.error('Calculator failed:', err));
    return () => { cancelled = true; };
  }, [jobId, effectiveHireValueExVat, hireStartDate, totalHireDays, transportCharges, cancelledOn]);

  const effectiveFee = useManual && manualFee ? toNum(manualFee) : (calcResult?.fee ?? 0);

  // The calculator returns the THEORETICAL refund (full hire ex-VAT minus
  // retained fee). What actually needs to be returned to the client is
  // capped at what they've already paid us — paying a £4.5k refund on a
  // £1.8k deposit is nonsense, and was the wording confusion. Working in
  // inc-VAT here because that's what cash actually moves in.
  const calculatedRefundExVat = calcResult
    ? calcResult.refund
    : (useManual && manualFee ? Math.max(0, effectiveHireValueExVat - toNum(manualFee)) : 0);
  const totalHireDepositsPaid = toNum(moneySummary?.financial.total_hire_deposits);
  const feeIncVat = effectiveFee * 1.2;
  const actualRefund = totalHireDepositsPaid > 0
    ? Math.max(0, totalHireDepositsPaid - feeIncVat)
    : calculatedRefundExVat;
  const outstandingBalance = totalHireDepositsPaid > 0
    ? Math.max(0, feeIncVat - totalHireDepositsPaid)
    : 0;
  const allSquare = effectiveFee > 0
    && totalHireDepositsPaid > 0
    && Math.abs(feeIncVat - totalHireDepositsPaid) < 0.5;
  const haveDepositData = moneySummary !== null;

  // Type-to-confirm guard: kicks in for the 100% tier OR retained fee >= £500.
  // Big-money or short-notice cancellations are the ones we don't want misclicks on.
  const requiresTypeConfirm = (calcResult?.tier === '<2_days') || (effectiveFee >= 500);
  const expectedConfirm = jobNumber || 'CANCEL';
  const typeConfirmOk = !requiresTypeConfirm || confirmText.trim().toUpperCase() === String(expectedConfirm).toUpperCase();

  // Excess actually held with us (taken or pre-auth, partially paid counts).
  // Flagged on summary so staff aren't surprised by what needs refunding.
  const excessHeldRecords = useMemo(() => {
    if (!transportCrew) return [] as TransportCrewData['excess'];
    return transportCrew.excess.filter(e =>
      ['taken', 'pre_auth', 'partially_paid'].includes(e.excess_status)
    );
  }, [transportCrew]);
  const totalExcessHeld = excessHeldRecords.reduce((sum, e) => sum + toNum(e.excess_amount_taken ?? e.excess_amount_required), 0);

  const handleSubmit = () => {
    onConfirm({
      cancellation_reason: reason,
      cancellation_notes: notes,
      cancellation_fee: effectiveFee,
      cancellation_refund: actualRefund,
      cancellation_outstanding_balance: outstandingBalance > 0 ? outstandingBalance : undefined,
      cancellation_tier: calcResult?.tier || 'manual',
      cancellation_notice_days: calcResult?.noticeDays || 0,
      transport_charges: transportCharges,
      breakdown: calcResult?.breakdown || `Manual fee: ${fmtMoney(effectiveFee)}`,
      cancelled_at: cancelledOn !== today ? `${cancelledOn}T12:00:00Z` : undefined,
      send_client_email: sendClientEmail,
      keep_requirement_ids: keepRequirementIds.size > 0 ? Array.from(keepRequirementIds) : undefined,
    });
  };

  const tierLabel: Record<string, string> = {
    '>7_days': 'More than 7 days notice (10%)',
    '2_to_7_days': '2-7 days notice (25%)',
    '<2_days': 'Less than 2 days notice (100% capped)',
  };

  const noHireValue = effectiveHireValueExVat <= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">
            Cancel Job
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            {jobNumber ? (
              <a
                href={`https://myhirehop.com/job.php?id=${jobNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ooosh-600 hover:text-ooosh-700 hover:underline font-mono"
              >
                J-{jobNumber}
              </a>
            ) : null}
            {' '}{jobName}
          </p>

          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin h-6 w-6 border-4 border-red-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Cancelled-on date — backdating shifts the tier */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cancelled on
                </label>
                <input
                  type="date"
                  value={cancelledOn}
                  min={minDate}
                  max={today}
                  onChange={e => setCancelledOn(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                {cancelledOn !== today && (
                  <p className="text-xs text-amber-700 mt-1">
                    Backdated — the notice tier is recalculated from this date.
                  </p>
                )}
              </div>

              {/* Calculator Result */}
              {calcResult && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-sm font-medium text-red-800">Cancellation Fee (T&Cs)</span>
                    <span className="text-sm text-red-600">
                      {tierLabel[calcResult.tier] || calcResult.tier}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                    <div>
                      <span className="text-gray-500">Notice period</span>
                      <p className="font-semibold">{calcResult.noticeDays} day{calcResult.noticeDays !== 1 ? 's' : ''}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Hire value (ex-VAT)</span>
                      <p className="font-semibold">{fmtMoney(effectiveHireValueExVat)}</p>
                      <p className="text-xs text-gray-500">
                        inc-VAT {fmtMoney(effectiveHireValueIncVat)}
                        {vatAdjusted && <span className="ml-1 text-emerald-700">· VAT-adjusted (saved {fmtMoney(vatSaved)})</span>}
                      </p>
                    </div>
                  </div>

                  {/* Per-tier fee breakdown */}
                  {calcResult.feeBreakdown && calcResult.feeBreakdown.length > 0 && (
                    <div className="border-t border-red-200 pt-2 mb-2">
                      {calcResult.feeBreakdown.map((line, i) => (
                        <div key={i} className="flex justify-between text-sm py-0.5">
                          <span className="text-gray-600">{line.label}</span>
                          <span className="font-medium">{fmtMoney(line.amount)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm pt-1 border-t border-red-200 mt-1">
                        <span className="font-semibold text-red-800">Fee to retain (ex-VAT)</span>
                        <span className="font-bold text-red-700">{fmtMoney(calcResult.fee)}</span>
                      </div>
                      {calcResult.refund > 0 && (
                        <div className="flex justify-between text-sm pt-0.5">
                          <span className="font-semibold text-green-800">Refund due</span>
                          <span className="font-bold text-green-700">{fmtMoney(calcResult.refund)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {calcResult.minimumApplied && (
                    <p className="text-xs text-red-600 mt-1">Minimum fee of £30 (£25+VAT) applied</p>
                  )}

                  {/* Source / freshness so staff know what they're acting on */}
                  <p className="text-xs text-gray-500 mt-2">
                    Hire value sourced from HireHop billing
                    {moneySummary ? ' (live)' : ' (cached)'}.
                  </p>

                  {/* Copyable summary */}
                  {calcResult.summary && (
                    <div className="mt-3 bg-white/60 rounded p-2 border border-red-100">
                      <p className="text-xs text-gray-700 leading-relaxed">{calcResult.summary}</p>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(calcResult.summary);
                          const btn = document.activeElement as HTMLButtonElement;
                          if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
                        }}
                        className="mt-1 text-xs text-ooosh-600 hover:text-ooosh-700 font-medium hover:underline"
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* HH Invoice / VAT breakdown — applies to the retained fee, NOT the hire value */}
              {effectiveFee > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                  <p className="font-medium text-blue-800 mb-1">HireHop Invoice Required</p>
                  <div className="grid grid-cols-2 gap-2 text-blue-700">
                    <div>Net (ex-VAT): <strong>{fmtMoney(effectiveFee)}</strong></div>
                    <div>VAT (20%): <strong>{fmtMoney(effectiveFee * 0.2)}</strong></div>
                    <div className="col-span-2">Gross (inc VAT): <strong>{fmtMoney(effectiveFee * 1.2)}</strong></div>
                  </div>
                  <p className="text-xs text-blue-600 mt-2">
                    Create an invoice in HireHop for the retained cancellation fee so it can be reconciled.
                  </p>
                </div>
              )}

              {noHireValue && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                  No hire value available — calculator cannot run. Enter a manual fee below.
                </div>
              )}

              {/* Manual override */}
              <div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useManual}
                    onChange={e => setUseManual(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Override with manual fee
                </label>
                {useManual && (
                  <input
                    type="number"
                    step="0.01"
                    value={manualFee}
                    onChange={e => setManualFee(e.target.value)}
                    placeholder="Manual cancellation fee"
                    className="mt-2 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                )}
              </div>

              {/* Transport & Crew */}
              {transportCrew && (transportCrew.quotes.length > 0 || transportCrew.crew.length > 0) && (
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Transport & Crew Commitments</h4>
                  {transportCrew.quotes.map(q => (
                    <div key={q.id} className="flex justify-between text-sm py-1">
                      <span className="text-gray-600">{q.job_type} — {q.venue_name || 'Unknown'}</span>
                      <span className="font-medium">{fmtMoney(q.client_charge_total)}</span>
                    </div>
                  ))}
                  {transportCrew.crew.map(c => (
                    <div key={c.id} className="flex justify-between text-sm py-1">
                      <span className="text-gray-600">{c.first_name} {c.last_name} ({c.role})</span>
                      <span className="font-medium">{c.agreed_rate ? fmtMoney(c.agreed_rate) : '—'}</span>
                    </div>
                  ))}
                  {transportCrew.vehicles.length > 0 && (
                    <div className="text-sm text-gray-500 mt-1">
                      {transportCrew.vehicles.length} vehicle{transportCrew.vehicles.length !== 1 ? 's' : ''} assigned
                    </div>
                  )}
                  <div className="mt-3">
                    <label className="text-xs text-gray-500">Additional transport/crew charges to include</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={transportCharges || ''}
                      onChange={e => setTransportCharges(toNum(e.target.value))}
                      placeholder="0.00"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1"
                    />
                  </div>
                </div>
              )}

              {/* Insurance excess held */}
              {excessHeldRecords.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 text-sm">
                  <p className="font-medium text-amber-800 mb-1">Insurance excess held</p>
                  <p className="text-amber-700">
                    {fmtMoney(totalExcessHeld)} held across {excessHeldRecords.length} record{excessHeldRecords.length !== 1 ? 's' : ''} — will be flagged for refund.
                  </p>
                  <p className="text-xs text-amber-600 mt-1">
                    Refund processed separately on the Money tab.
                  </p>
                </div>
              )}

              {/* Reason */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cancellation reason</label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  {CANCELLATION_REASON_OPTIONS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Additional context..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {/* Open requirements on this job — default to cancel, tick to keep */}
              <CancelOpenRequirementsSection
                jobId={jobId}
                targetStatus="cancelled"
                keepIds={keepRequirementIds}
                onChange={setKeepRequirementIds}
              />

              {/* Client email opt-out + recipient preview. Crew emails fire
                  regardless — they're operational, not customer-comms. */}
              <div className="border border-gray-200 rounded-lg p-3 text-sm">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendClientEmail}
                    onChange={e => setSendClientEmail(e.target.checked)}
                    className="mt-0.5 rounded border-gray-300"
                  />
                  <span className="flex-1">
                    <span className="font-medium text-gray-700">Send cancellation email to client</span>
                    {sendClientEmail ? (
                      <span className="block text-xs text-gray-500 mt-0.5">
                        {contacts.length} recipient{contacts.length !== 1 ? 's' : ''}
                        {contacts.length === 0 && ' — info@ fallback will be used'}
                      </span>
                    ) : (
                      <span className="block text-xs text-amber-700 mt-0.5">
                        Skipped — handle the client comms out-of-band.
                      </span>
                    )}
                  </span>
                </label>
                {sendClientEmail && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowRecipients(s => !s)}
                      className="mt-2 text-xs text-gray-500 hover:text-gray-700"
                    >
                      {showRecipients ? 'Hide recipients' : 'Show recipients'}
                    </button>
                    {showRecipients && (
                      <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                        {contacts.length === 0 ? (
                          <li className="text-amber-700">No client contacts on file — email will be routed to info@oooshtours.co.uk with an amber banner.</li>
                        ) : (
                          contacts.map((c, i) => (
                            <li key={i}>
                              {c.name} &lt;{c.email}&gt;
                              {c.source && <span className="text-gray-400 ml-1">· {c.source}</span>}
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </>
                )}
                {transportCrew && transportCrew.crew.length > 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    Plus {transportCrew.crew.filter(c => c.email).length} crew email{transportCrew.crew.filter(c => c.email).length !== 1 ? 's' : ''} (always sent).
                  </p>
                )}
              </div>

              {/* Summary — shows the actual cash position based on what the
                  client has paid (from the Money summary), not the theoretical
                  refund the calculator assumes from full hire value. */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm space-y-2">
                <p className="font-medium text-gray-700">Cancellation Summary</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-gray-500">Fee retained (ex-VAT):</span>
                    <span className="ml-1 font-bold text-red-700">{fmtMoney(effectiveFee)}</span>
                    <div className="text-xs text-gray-500">inc-VAT {fmtMoney(feeIncVat)}</div>
                  </div>
                  <div>
                    <span className="text-gray-500">Paid by client:</span>
                    <span className="ml-1 font-bold text-gray-700">{haveDepositData ? fmtMoney(totalHireDepositsPaid) : '—'}</span>
                    {!haveDepositData && <div className="text-xs text-amber-600">Money summary unavailable</div>}
                  </div>
                </div>
                {haveDepositData && (
                  <div className="border-t border-gray-200 pt-2">
                    {allSquare && (
                      <div className="text-emerald-700 font-medium">
                        ✓ All square — deposit covers the cancellation fee. Nobody owes anybody anything.
                      </div>
                    )}
                    {!allSquare && actualRefund > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Refund to client:</span>
                        <span className="font-bold text-green-700">{fmtMoney(actualRefund)}</span>
                      </div>
                    )}
                    {!allSquare && outstandingBalance > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Client still owes:</span>
                        <span className="font-bold text-amber-700">{fmtMoney(outstandingBalance)}</span>
                      </div>
                    )}
                    {actualRefund > 0 && actualRefund < calculatedRefundExVat - 0.5 && (
                      <p className="text-xs text-gray-500 mt-1">
                        Capped at amount paid. T&C-calculated refund was {fmtMoney(calculatedRefundExVat)} (ex-VAT).
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Actions preview */}
              <div className="text-xs text-gray-500 space-y-1">
                <p className="font-medium text-gray-600">On confirmation, the system will:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Set HireHop status to Cancelled (9)</li>
                  <li>Mark all requirements as not needed</li>
                  {transportCrew && transportCrew.crew.length > 0 && (
                    <li>Notify {transportCrew.crew.length} crew member{transportCrew.crew.length !== 1 ? 's' : ''} by email</li>
                  )}
                  {transportCrew && transportCrew.vehicles.length > 0 && (
                    <li>Cancel {transportCrew.vehicles.length} vehicle assignment{transportCrew.vehicles.length !== 1 ? 's' : ''}</li>
                  )}
                  {excessHeldRecords.length > 0 && (
                    <li>Flag {fmtMoney(totalExcessHeld)} excess for refund processing</li>
                  )}
                  {actualRefund > 0 && (
                    <li>Create pending refund record on Money tab ({fmtMoney(actualRefund)})</li>
                  )}
                  {outstandingBalance > 0 && (
                    <li>Note {fmtMoney(outstandingBalance)} outstanding balance — invoice the client for this</li>
                  )}
                  <li>Log cancellation on activity timeline</li>
                </ul>
              </div>

              {/* Type-to-confirm guard for short-notice / large-fee cancellations */}
              {requiresTypeConfirm && (
                <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm">
                  <p className="font-medium text-red-800 mb-1">Confirm a high-impact cancellation</p>
                  <p className="text-xs text-red-700 mb-2">
                    Type <strong>{expectedConfirm}</strong> to enable the confirm button.
                  </p>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    placeholder={String(expectedConfirm)}
                    className="w-full border border-red-300 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
              )}

              {/* Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onCancel}
                  disabled={saving}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Go Back
                </button>
                {canAction ? (
                  <button
                    onClick={handleSubmit}
                    disabled={saving || (!calcResult && !useManual) || !typeConfirmOk}
                    className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                  >
                    {saving ? 'Processing...' : 'Confirm Cancellation'}
                  </button>
                ) : (
                  <button
                    disabled
                    className="flex-1 px-4 py-2 bg-amber-100 text-amber-800 rounded-lg text-sm font-medium cursor-not-allowed"
                  >
                    Refer to Manager
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
