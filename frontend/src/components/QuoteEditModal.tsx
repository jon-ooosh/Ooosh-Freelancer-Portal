import { useEffect, useState } from 'react';
import { api } from '../services/api';
import DatePicker from './DatePicker';
import { TimeInput } from './TimeInput';
import { VenuePicker } from './VenuePicker';

// Minimal shape — union of editable fields used by JobDetailPage and TransportOpsPage.
// Reference-only fields (out_date, return_date, hh_pushed_at) drive amber warnings
// and the "already pushed to HH" banner. They're optional so either page can pass
// what it has.
export interface QuoteForEdit {
  id: string;
  job_type: 'delivery' | 'collection' | 'crewed';
  calculation_mode?: string | null;
  venue_id?: string | null;
  venue_name?: string | null;
  linked_venue_name?: string | null;
  job_date: string | Date | null;
  job_finish_date: string | Date | null;
  is_multi_day?: boolean | null;
  num_days?: number | null;
  arrival_time?: string | null;
  what_is_it?: string | null;
  work_type?: string | null;
  work_description?: string | null;
  crew_count?: number | null;
  internal_notes?: string | null;
  freelancer_notes?: string | null;
  client_charge_rounded?: number | null;
  freelancer_fee_rounded?: number | null;
  // Reference / derived
  is_local?: boolean | null;
  out_date?: string | Date | null;
  return_date?: string | Date | null;
  hh_pushed_at?: string | null;
}

function parseDateField(d: string | Date | null | undefined): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d).includes('T') ? String(d).split('T')[0] : String(d);
}

export function QuoteEditModal({
  quote,
  onClose,
  onSaved,
}: {
  quote: QuoteForEdit;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const isLocal = !!quote.is_local || quote.calculation_mode === 'fixed';
  const wasPushedToHh = !!quote.hh_pushed_at;

  const [form, setForm] = useState({
    job_type: quote.job_type,
    venue_id: quote.venue_id || null,
    venue_name: quote.linked_venue_name || quote.venue_name || '',
    job_date: parseDateField(quote.job_date),
    job_finish_date: parseDateField(quote.job_finish_date),
    is_multi_day: !!quote.is_multi_day,
    num_days: quote.num_days || 1,
    arrival_time: quote.arrival_time || '',
    what_is_it: quote.what_is_it || '',
    work_type: quote.work_type || '',
    work_description: quote.work_description || '',
    crew_count: quote.crew_count || 1,
    internal_notes: quote.internal_notes || '',
    freelancer_notes: quote.freelancer_notes || '',
    client_charge_rounded: Number(quote.client_charge_rounded ?? 0),
    freelancer_fee_rounded: Number(quote.freelancer_fee_rounded ?? 0),
  });
  const [saving, setSaving] = useState(false);

  // Expense charge-mode editing (three-state) — fetched from the quote so both
  // the Job Detail and Transport Ops entry points behave identically. Stored
  // engine shape: { type, description, amount, includedInCharge, chargeMode }.
  type ChargeMode = 'na' | 'included' | 'not_included' | 'recharge';
  type ExpenseLine = { type: string; description?: string; amount?: number; includedInCharge?: boolean; chargeMode?: ChargeMode };
  const [expenses, setExpenses] = useState<ExpenseLine[] | null>(null);
  // Only send expenses to the PUT when the user actually touched them.
  // Sending them unconditionally forces the backend recalc on EVERY save,
  // which (a) used to clobber manual fee edits, and (b) reprices the quote
  // from *current* calculator settings even when only a note was edited.
  const [expensesDirty, setExpensesDirty] = useState(false);
  useEffect(() => {
    if (isLocal) return; // local D&C quotes have no calculator expenses
    let cancelled = false;
    api.get<{ expenses?: ExpenseLine[] | string }>(`/quotes/${quote.id}`)
      .then((res) => {
        if (cancelled) return;
        const raw = res.expenses;
        const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
        setExpenses(arr);
      })
      .catch(() => { /* leave null — section just won't render */ });
    return () => { cancelled = true; };
  }, [quote.id, isLocal]);

  const expMode = (e: ExpenseLine): ChargeMode =>
    e.chargeMode ?? (e.includedInCharge === false ? 'not_included' : 'included');
  const setExpMode = (i: number, m: ChargeMode) => {
    setExpensesDirty(true);
    setExpenses((prev) => prev ? prev.map((e, idx) => idx === i ? { ...e, chargeMode: m, includedInCharge: m === 'included' } : e) : prev);
  };
  const setAllExpMode = (m: ChargeMode) => {
    setExpensesDirty(true);
    setExpenses((prev) => prev ? prev.map((e) => ({ ...e, chargeMode: m, includedInCharge: m === 'included' })) : prev);
  };
  const setExpAmount = (i: number, v: number) => {
    setExpensesDirty(true);
    setExpenses((prev) => prev ? prev.map((e, idx) => idx === i ? { ...e, amount: v } : e) : prev);
  };
  const setExpType = (i: number, t: string) => {
    setExpensesDirty(true);
    setExpenses((prev) => prev ? prev.map((e, idx) => idx === i ? { ...e, type: t } : e) : prev);
  };
  const addExpense = () => {
    setExpensesDirty(true);
    setExpenses((prev) => [...(prev || []), { type: '', description: '', amount: 0, chargeMode: 'included', includedInCharge: true }]);
  };
  const removeExpense = (i: number) => {
    setExpensesDirty(true);
    setExpenses((prev) => prev ? prev.filter((_, idx) => idx !== i) : prev);
  };
  // Known expense types show a fixed label; anything else gets a type picker so a
  // newly-added line (e.g. a hotel we're now providing) gets the right portal wording.
  const EXP_TYPE_LABELS: Record<string, string> = {
    fuel: 'Fuel', parking: 'Parking', tolls: 'Tolls', transport_out: 'Travel (out)',
    transport_back: 'Travel (back)', hotel: 'Hotel', pd: 'Per Diem',
  };

  const hhStart = parseDateField(quote.out_date ?? null);
  const hhEnd = parseDateField(quote.return_date ?? null);
  const startMismatch = !!(hhStart && form.job_date && form.job_date !== hhStart);
  const endMismatch = !!(form.is_multi_day && hhEnd && form.job_finish_date && form.job_finish_date !== hhEnd);

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`/quotes/${quote.id}`, {
        job_type: form.job_type,
        venue_id: form.venue_id,
        venue_name: form.venue_name,
        job_date: form.job_date || null,
        job_finish_date: form.job_finish_date || null,
        is_multi_day: form.is_multi_day,
        num_days: form.num_days,
        arrival_time: form.arrival_time || null,
        what_is_it: form.what_is_it || null,
        work_type: form.work_type || null,
        work_description: form.work_description || null,
        crew_count: form.crew_count > 1 ? form.crew_count : 1,
        internal_notes: form.internal_notes || null,
        freelancer_notes: form.freelancer_notes || null,
        client_charge_rounded: form.client_charge_rounded,
        freelancer_fee_rounded: form.freelancer_fee_rounded,
        // Only send when the user actually edited them (triggers the backend
        // recalc + re-flags the job). Untouched expenses stay off the payload
        // so a fee/notes-only save never reprices the quote.
        ...(expenses && expensesDirty ? { expenses } : {}),
      });
      await onSaved();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const titleLabel =
    form.job_type === 'delivery' ? 'Delivery' : form.job_type === 'collection' ? 'Collection' : 'Crewed Job';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Edit {isLocal ? 'Local ' : ''}{titleLabel}
        </h3>

        {wasPushedToHh && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong>Heads up:</strong> this quote has already been pushed to HireHop.
            Edits here will NOT update the HireHop line item — adjust it manually in HireHop if the price or details have changed.
          </div>
        )}

        <div className="space-y-4">
          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              value={form.job_type}
              onChange={(e) => setForm((p) => ({ ...p, job_type: e.target.value as QuoteForEdit['job_type'] }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="delivery">Delivery</option>
              <option value="collection">Collection</option>
              <option value="crewed">Crewed</option>
            </select>
          </div>

          {/* Venue */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Venue</label>
            <VenuePicker
              value={{ venueId: form.venue_id, venueName: form.venue_name }}
              onChange={({ venueId, venueName }) =>
                setForm((p) => ({ ...p, venue_id: venueId, venue_name: venueName }))
              }
            />
          </div>

          {/* Date & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {form.is_multi_day ? 'Start Date' : 'Date'}
              </label>
              <DatePicker
                value={form.job_date}
                onChange={(val) => setForm((p) => ({ ...p, job_date: val }))}
                className={startMismatch ? '[&>button]:border-amber-400 [&>button]:bg-amber-50' : ''}
              />
              {startMismatch && (
                <p className="text-xs text-amber-600 mt-1">HH start: {hhStart}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Time</label>
              <TimeInput
                value={form.arrival_time}
                onChange={(v) => setForm((p) => ({ ...p, arrival_time: v }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              {!form.arrival_time && (
                <p className="text-xs text-gray-400 italic mt-1">Leave blank for "Time TBC"</p>
              )}
            </div>
          </div>

          {/* Multi-day toggle + finish date */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_multi_day}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    is_multi_day: e.target.checked,
                    num_days: e.target.checked ? Math.max(p.num_days, 2) : 1,
                  }))
                }
                className="w-4 h-4 text-ooosh-600 rounded"
              />
              Multi-day
            </label>
            {form.is_multi_day && (
              <>
                <div>
                  <DatePicker
                    value={form.job_finish_date}
                    onChange={(val) => {
                      const days =
                        form.job_date && val
                          ? Math.max(
                              1,
                              Math.ceil(
                                (new Date(val + 'T00:00:00').getTime() -
                                  new Date(form.job_date + 'T00:00:00').getTime()) /
                                  86400000
                              ) + 1
                            )
                          : form.num_days;
                      setForm((p) => ({ ...p, job_finish_date: val, num_days: days }));
                    }}
                    min={form.job_date || undefined}
                    className={endMismatch ? '[&>button]:border-amber-400 [&>button]:bg-amber-50' : ''}
                  />
                </div>
                <span className="text-xs text-purple-600 font-medium">{form.num_days} days</span>
              </>
            )}
          </div>
          {endMismatch && (
            <p className="text-xs text-amber-600 -mt-2">HH return: {hhEnd}</p>
          )}

          {/* Crewed-specific fields */}
          {form.job_type === 'crewed' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Work Type</label>
                <select
                  value={form.work_type}
                  onChange={(e) => setForm((p) => ({ ...p, work_type: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  <option value="backline_tech">Backline Tech</option>
                  <option value="general_assist">General Assist</option>
                  <option value="engineer_foh">Engineer - FOH</option>
                  <option value="engineer_mons">Engineer - mons</option>
                  <option value="driving_only">Driving Only</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Crew Needed</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={form.crew_count}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, crew_count: Math.max(1, parseInt(e.target.value) || 1) }))
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              {form.work_type && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Work Description</label>
                  <textarea
                    value={form.work_description}
                    onChange={(e) => setForm((p) => ({ ...p, work_description: e.target.value }))}
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              )}
            </div>
          )}

          {/* What is it (D&C only) */}
          {form.job_type !== 'crewed' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What is it</label>
              <select
                value={form.what_is_it}
                onChange={(e) => setForm((p) => ({ ...p, what_is_it: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">—</option>
                <option value="vehicle">Vehicle</option>
                <option value="equipment">Equipment</option>
                <option value="people">People</option>
              </select>
            </div>
          )}

          {/* Fees — editable for all quotes (override calculator values or set local fees) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client Charge</label>
              <input
                type="number"
                min={0}
                step={5}
                value={form.client_charge_rounded}
                onChange={(e) =>
                  setForm((p) => ({ ...p, client_charge_rounded: parseFloat(e.target.value) || 0 }))
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Fee</label>
              <input
                type="number"
                min={0}
                step={5}
                value={form.freelancer_fee_rounded}
                onChange={(e) =>
                  setForm((p) => ({ ...p, freelancer_fee_rounded: parseFloat(e.target.value) || 0 }))
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Expenses — three-state charge mode (same control as the calculator).
              Changing states recalculates the client total + re-flags the job on save. */}
          {expenses && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expenses — who pays?</label>
              <p className="text-xs text-gray-500 mb-2">
                <span className="text-amber-700 font-medium">Recharge</span> = billed to the client at actual + markup post-hire. Tap a heading to set all. Add a line if the scope changes (e.g. a hotel).
              </p>
              <div className="border rounded-lg divide-y text-sm">
                <div className="px-2 py-2 bg-gray-50 flex items-center gap-1">
                  <div className="flex-1 font-medium text-gray-700">Item</div>
                  <div className="w-14 text-center font-medium text-gray-700 text-xs">£</div>
                  {([['na', 'N/A'], ['included', 'In quote'], ['not_included', 'Client'], ['recharge', 'Recharge']] as [ChargeMode, string][]).map(([m, label]) => (
                    <button key={m} type="button" onClick={() => setAllExpMode(m)} title={`Set all to "${label}"`}
                      className={`w-12 text-center text-xs font-medium hover:underline ${m === 'recharge' ? 'text-amber-700' : 'text-gray-600'}`}>{label}</button>
                  ))}
                  <div className="w-5" />
                </div>
                <div className="px-2">
                  {expenses.map((e, i) => {
                    const m = expMode(e);
                    const known = EXP_TYPE_LABELS[e.type];
                    return (
                      <div key={i} className="flex items-center gap-1 py-1.5 border-b border-gray-100 last:border-0">
                        <div className="flex-1 min-w-0">
                          {known ? (
                            <span className={`truncate ${m === 'recharge' ? 'text-amber-700' : m === 'included' ? 'text-gray-800' : 'text-gray-400'}`}>{known}</span>
                          ) : (
                            <select value={e.type} onChange={(ev) => setExpType(i, ev.target.value)}
                              className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs">
                              <option value="">Type…</option>
                              <option value="hotel">Hotel</option>
                              <option value="fuel">Fuel</option>
                              <option value="parking">Parking</option>
                              <option value="tolls">Tolls</option>
                              <option value="transport_out">Travel (out)</option>
                              <option value="transport_back">Travel (back)</option>
                              <option value="pd">Per Diem</option>
                              <option value="other">Other</option>
                            </select>
                          )}
                        </div>
                        <input type="number" min="0" value={e.amount || ''} onChange={(ev) => setExpAmount(i, parseFloat(ev.target.value) || 0)}
                          className="w-14 border border-gray-200 rounded px-1 py-0.5 text-xs text-right" />
                        {(['na', 'included', 'not_included', 'recharge'] as const).map((opt) => (
                          <div key={opt} className="w-12 flex justify-center">
                            <input type="radio" name={`exp-${i}`} checked={m === opt} onChange={() => setExpMode(i, opt)}
                              className={`w-4 h-4 ${opt === 'recharge' ? 'accent-amber-600' : 'accent-ooosh-600'}`} />
                          </div>
                        ))}
                        <button type="button" onClick={() => removeExpense(i)} title="Remove" className="w-5 text-red-400 hover:text-red-600">×</button>
                      </div>
                    );
                  })}
                </div>
                <div className="px-2 py-1.5">
                  <button type="button" onClick={addExpense} className="text-xs text-ooosh-600 hover:text-ooosh-800">+ Add expense</button>
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
            <textarea
              value={form.internal_notes}
              onChange={(e) => setForm((p) => ({ ...p, internal_notes: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Notes</label>
            <textarea
              value={form.freelancer_notes}
              onChange={(e) => setForm((p) => ({ ...p, freelancer_notes: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {!isLocal && !wasPushedToHh && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
              Fee overrides will replace the calculator values. To fully recalculate, use the transport calculator from the Job Detail page.
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-ooosh-600 text-white rounded-lg text-sm hover:bg-ooosh-700 font-medium disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default QuoteEditModal;
