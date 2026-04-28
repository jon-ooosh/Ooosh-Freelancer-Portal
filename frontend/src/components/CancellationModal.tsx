import { useState, useEffect } from 'react';
import { CANCELLATION_REASON_OPTIONS } from '../../../shared/types';
import { api } from '../services/api';
import CancelOpenRequirementsSection from './CancelOpenRequirementsSection';

interface TransportCrewData {
  quotes: Array<{ id: string; job_type: string; venue_name: string; total_cost: number; ops_status: string }>;
  crew: Array<{ id: string; first_name: string; last_name: string; email: string; role: string; agreed_rate: number }>;
  vehicles: Array<{ id: string; registration: string; vehicle_name: string; status: string }>;
  excess: Array<{ id: string; excess_amount_required: number; excess_status: string }>;
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
  hireValue: number | null;
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
    keep_requirement_ids?: string[];
  }) => void;
  onCancel: () => void;
  saving: boolean;
}

export default function CancellationModal({
  jobId, jobName, jobNumber, hireValue, hireStartDate, totalHireDays,
  userRole, onConfirm, onCancel, saving,
}: Props) {
  const [reason, setReason] = useState<string>(CANCELLATION_REASON_OPTIONS[0]);
  const [notes, setNotes] = useState('');
  const [transportCharges, setTransportCharges] = useState(0);
  const [calcResult, setCalcResult] = useState<CancellationCalcResult | null>(null);
  const [transportCrew, setTransportCrew] = useState<TransportCrewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualFee, setManualFee] = useState<string>('');
  const [useManual, setUseManual] = useState(false);
  const [keepRequirementIds, setKeepRequirementIds] = useState<Set<string>>(new Set());

  const canAction = userRole === 'admin' || userRole === 'manager';

  // Fetch transport/crew data and run calculator (independent — one failing doesn't block the other)
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);

      // Fetch transport & crew (non-blocking)
      api.get<TransportCrewData>(`/cancellations/${jobId}/transport-crew`)
        .then(setTransportCrew)
        .catch(err => console.warn('Failed to load transport/crew:', err));

      // Run calculator
      const cost = typeof hireValue === 'string' ? parseFloat(hireValue) : hireValue;
      if (cost && cost > 0 && hireStartDate) {
        try {
          const calcRes = await api.post<CancellationCalcResult>(`/cancellations/${jobId}/calculate`, {
            totalHireCost: cost,
            hireStartDate,
            transportCharges: 0,
            totalHireDays: totalHireDays && totalHireDays > 0 ? totalHireDays : undefined,
          });
          setCalcResult(calcRes);
        } catch (err) {
          console.error('Calculator failed:', err);
        }
      }

      setLoading(false);
    };
    fetchData();
  }, [jobId, hireValue, hireStartDate, totalHireDays]);

  // Recalculate when transport charges change
  useEffect(() => {
    const cost = typeof hireValue === 'string' ? parseFloat(hireValue) : hireValue;
    if (!cost || cost <= 0 || !hireStartDate || transportCharges === 0) return;
    api.post<CancellationCalcResult>(`/cancellations/${jobId}/calculate`, {
      totalHireCost: cost,
      hireStartDate,
      transportCharges,
      totalHireDays: totalHireDays && totalHireDays > 0 ? totalHireDays : undefined,
    }).then(setCalcResult).catch(() => {});
  }, [transportCharges, jobId, hireValue, hireStartDate, totalHireDays]);

  const hireCost = typeof hireValue === 'string' ? parseFloat(hireValue) : (hireValue || 0);
  const effectiveFee = useManual && manualFee ? parseFloat(manualFee) : (calcResult?.fee ?? 0);
  const effectiveRefund = calcResult ? calcResult.refund : (useManual && manualFee ? Math.max(0, hireCost - parseFloat(manualFee)) : 0);

  const handleSubmit = () => {
    onConfirm({
      cancellation_reason: reason,
      cancellation_notes: notes,
      cancellation_fee: effectiveFee,
      cancellation_refund: effectiveRefund,
      cancellation_tier: calcResult?.tier || 'manual',
      cancellation_notice_days: calcResult?.noticeDays || 0,
      transport_charges: transportCharges,
      breakdown: calcResult?.breakdown || `Manual fee: £${effectiveFee.toFixed(2)}`,
      keep_requirement_ids: keepRequirementIds.size > 0 ? Array.from(keepRequirementIds) : undefined,
    });
  };

  const tierLabel: Record<string, string> = {
    '>7_days': 'More than 7 days notice (10%)',
    '2_to_7_days': '2-7 days notice (25%)',
    '<2_days': 'Less than 2 days notice (100% capped)',
  };

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
                      <span className="text-gray-500">Hire value</span>
                      <p className="font-semibold">£{hireCost.toFixed(2)}</p>
                    </div>
                  </div>

                  {/* Per-tier fee breakdown */}
                  {calcResult.feeBreakdown && calcResult.feeBreakdown.length > 0 && (
                    <div className="border-t border-red-200 pt-2 mb-2">
                      {calcResult.feeBreakdown.map((line, i) => (
                        <div key={i} className="flex justify-between text-sm py-0.5">
                          <span className="text-gray-600">{line.label}</span>
                          <span className="font-medium">£{line.amount.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm pt-1 border-t border-red-200 mt-1">
                        <span className="font-semibold text-red-800">Fee to retain</span>
                        <span className="font-bold text-red-700">£{calcResult.fee.toFixed(2)}</span>
                      </div>
                      {calcResult.refund > 0 && (
                        <div className="flex justify-between text-sm pt-0.5">
                          <span className="font-semibold text-green-800">Refund due</span>
                          <span className="font-bold text-green-700">£{calcResult.refund.toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {calcResult.minimumApplied && (
                    <p className="text-xs text-red-600 mt-1">Minimum fee of £30 (£25+VAT) applied</p>
                  )}

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

              {/* HH Invoice / VAT breakdown */}
              {effectiveFee > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                  <p className="font-medium text-blue-800 mb-1">HireHop Invoice Required</p>
                  <div className="grid grid-cols-2 gap-2 text-blue-700">
                    <div>Net (ex-VAT): <strong>£{effectiveFee.toFixed(2)}</strong></div>
                    <div>VAT (20%): <strong>£{(effectiveFee * 0.2).toFixed(2)}</strong></div>
                    <div className="col-span-2">Gross (inc VAT): <strong>£{(effectiveFee * 1.2).toFixed(2)}</strong></div>
                  </div>
                  <p className="text-xs text-blue-600 mt-2">
                    Create an invoice in HireHop for the retained cancellation fee so it can be reconciled.
                  </p>
                </div>
              )}

              {!hireValue && (
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
                      <span className="font-medium">£{(q.total_cost || 0).toFixed(2)}</span>
                    </div>
                  ))}
                  {transportCrew.crew.map(c => (
                    <div key={c.id} className="flex justify-between text-sm py-1">
                      <span className="text-gray-600">{c.first_name} {c.last_name} ({c.role})</span>
                      <span className="font-medium">{c.agreed_rate ? `£${c.agreed_rate.toFixed(2)}` : '—'}</span>
                    </div>
                  ))}
                  {transportCrew.vehicles.length > 0 && (
                    <div className="text-sm text-gray-500 mt-1">
                      {transportCrew.vehicles.length} vehicle{transportCrew.vehicles.length !== 1 ? 's' : ''} assigned
                    </div>
                  )}
                  {transportCrew.excess.length > 0 && (
                    <div className="text-sm text-amber-600 mt-1">
                      {transportCrew.excess.length} excess record{transportCrew.excess.length !== 1 ? 's' : ''} — will be flagged for refund
                    </div>
                  )}
                  <div className="mt-3">
                    <label className="text-xs text-gray-500">Additional transport/crew charges to include</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={transportCharges || ''}
                      onChange={e => setTransportCharges(parseFloat(e.target.value) || 0)}
                      placeholder="0.00"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1"
                    />
                  </div>
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

              {/* Summary */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
                <p className="font-medium text-gray-700 mb-1">Cancellation Summary</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-gray-500">Fee retained:</span>
                    <span className="ml-1 font-bold text-red-700">£{effectiveFee.toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Refund due:</span>
                    <span className="ml-1 font-bold text-green-700">£{effectiveRefund.toFixed(2)}</span>
                  </div>
                </div>
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
                  {transportCrew && transportCrew.excess.length > 0 && (
                    <li>Flag excess for refund processing</li>
                  )}
                  <li>Create pending refund record on Money tab</li>
                  <li>Log cancellation on activity timeline</li>
                </ul>
              </div>

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
                    disabled={saving || (!calcResult && !useManual)}
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
