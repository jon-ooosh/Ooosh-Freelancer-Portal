/**
 * RequirementCard — reusable card component for the Prep Checklist.
 *
 * Renders a single job requirement with:
 * - Type-specific HH context (vehicle details, backline counts, etc.)
 * - Status dropdown (non-linear: any → any)
 * - Multi-step progress bar
 * - Mismatch warnings
 * - "HH" badge for auto-derived requirements
 * - Action buttons (send hire form, van & driver toggle)
 */

import { useState } from 'react';
import { api } from '../services/api';

// ── Types ──────────────────────────────────────────────────────────────

export interface JobRequirement {
  id: string;
  job_id: string;
  requirement_type: string;
  status: 'not_started' | 'in_progress' | 'done' | 'blocked';
  current_step: string | null;
  custom_label: string | null;
  notes: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  due_date: string | null;
  is_auto: boolean;
  source: string;
  hh_mismatch: boolean;
  hh_mismatch_detail: string | null;
  hh_item_snapshot: unknown[] | null;
  type_label: string;
  type_icon: string;
  type_steps: string[] | null;
  sort_order: number;
}

export interface DerivedFlags {
  has_vehicle: boolean;
  vehicle_count: number;
  vehicle_types: string[];
  seat_config: 'round_table' | 'forward_facing' | null;
  has_backline: boolean;
  backline_item_count: number;
  has_rehearsal: boolean;
  has_staging: boolean;
  has_pa: boolean;
  has_lighting: boolean;
  has_crew_items: boolean;
  crew_item_count: number;
  total_prep_time_mins: number;
  prep_time_by_category: { vehicles: number; backline: number; rehearsals: number; other: number };
}

export interface SeatAvailability {
  required: string;
  matchingVans: Array<{ reg: string; seat_layout: string | null }>;
  nonMatchingVans: Array<{ reg: string; seat_layout: string | null }>;
  unknownVans: Array<{ reg: string }>;
}

interface EmailContact {
  email: string;
  name: string;
  source: string;
}

export const PREP_STATUS_CONFIG: Record<string, { label: string; colour: string; bg: string; border: string }> = {
  not_started: { label: 'Not Started', colour: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' },
  in_progress: { label: 'In Progress', colour: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-200' },
  done:        { label: 'Done',        colour: 'text-green-700', bg: 'bg-green-100', border: 'border-green-200' },
  blocked:     { label: 'Blocked',     colour: 'text-red-700',   bg: 'bg-red-100',   border: 'border-red-200' },
};

export const PREP_STATUS_ORDER: JobRequirement['status'][] = ['not_started', 'in_progress', 'done', 'blocked'];

// ── Helper ─────────────────────────────────────────────────────────────

function formatPrepTime(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── Component ──────────────────────────────────────────────────────────

export default function RequirementCard({
  req,
  derivedFlags,
  seatAvailability,
  isNested,
  jobId,
  isVanAndDriver,
  onStatusChange,
  onAdvanceStep,
  onRemove,
  onVanAndDriverToggle,
  onReload,
}: {
  req: JobRequirement;
  derivedFlags?: DerivedFlags | null;
  seatAvailability?: SeatAvailability | null;
  isNested?: boolean;
  jobId: string;
  isVanAndDriver?: boolean;
  onStatusChange: (reqId: string, status: JobRequirement['status']) => void;
  onAdvanceStep: (reqId: string) => void;
  onRemove: (reqId: string) => void;
  onVanAndDriverToggle?: () => void;
  onReload?: () => void;
}) {
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showEmailPicker, setShowEmailPicker] = useState(false);
  const [emailContacts, setEmailContacts] = useState<EmailContact[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const statusConfig = PREP_STATUS_CONFIG[req.status] || PREP_STATUS_CONFIG.not_started;
  const label = req.custom_label || req.type_label;

  // ── Hire Form Email ────────────────────────────────────────────────

  async function openEmailPicker() {
    setLoadingContacts(true);
    setShowEmailPicker(true);
    try {
      const data = await api.get<{ contacts: EmailContact[] }>(`/hire-forms/email-contacts/${jobId}`);
      setEmailContacts(data.contacts);
      // Pre-select all contacts
      setSelectedEmails(new Set(data.contacts.map(c => c.email)));
    } catch (err) {
      console.error('Failed to load contacts:', err);
    } finally {
      setLoadingContacts(false);
    }
  }

  async function sendHireFormEmail(isChase: boolean) {
    if (selectedEmails.size === 0) return;
    setEmailSending(true);
    setEmailResult(null);
    try {
      const recipients = emailContacts
        .filter(c => selectedEmails.has(c.email))
        .map(c => ({ email: c.email, name: c.name }));
      const data = await api.post<{ sent: number; failed: number }>('/hire-forms/send-email', {
        jobId,
        recipients,
        isChase,
      });
      setEmailResult(`Sent to ${data.sent} contact${data.sent !== 1 ? 's' : ''}${data.failed > 0 ? ` (${data.failed} failed)` : ''}`);
      setTimeout(() => {
        setShowEmailPicker(false);
        setEmailResult(null);
        onReload?.();
      }, 2000);
    } catch (err) {
      setEmailResult('Failed to send');
    } finally {
      setEmailSending(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div
      className={`group bg-white rounded-xl border ${req.hh_mismatch ? 'border-amber-300 bg-amber-50/30' : statusConfig.border} p-4 transition-all hover:shadow-sm ${isNested ? 'ml-8 border-l-4' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="text-lg flex-shrink-0">{isNested ? '↳' : ''} {req.type_icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-medium ${req.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                {label}
              </span>
              {req.is_auto && req.source === 'hirehop_sync' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 border border-blue-200 font-medium">HH</span>
              )}
              {req.assigned_to_name && (
                <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{req.assigned_to_name}</span>
              )}
              {req.due_date && (
                <span className="text-xs text-gray-400">Due: {new Date(req.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              )}
            </div>

            {/* ── Type-specific HH context ── */}

            {/* Vehicle */}
            {req.requirement_type === 'vehicle' && derivedFlags?.has_vehicle && (
              <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{derivedFlags.vehicle_count} vehicle{derivedFlags.vehicle_count !== 1 ? 's' : ''}: {derivedFlags.vehicle_types.join(', ')}</span>
                  {onVanAndDriverToggle && (
                    <button
                      onClick={onVanAndDriverToggle}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                        isVanAndDriver
                          ? 'bg-indigo-100 text-indigo-700 border-indigo-300 hover:bg-indigo-200'
                          : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                      }`}
                      title={isVanAndDriver ? 'Currently Van & Driver — click to switch to Self-Drive' : 'Currently Self-Drive — click to switch to Van & Driver'}
                    >
                      {isVanAndDriver ? '👤 Van & Driver' : '🔑 Self-Drive'}
                    </button>
                  )}
                </div>
                {derivedFlags.seat_config && (
                  <div className={derivedFlags.seat_config === 'forward_facing' ? 'text-amber-600' : 'text-green-600'}>
                    {derivedFlags.seat_config === 'forward_facing' ? '⬆️ Forward-facing seats' : '🔄 Round a table'}
                    {seatAvailability?.matchingVans && seatAvailability.matchingVans.length > 0 && (
                      <span className="text-green-600 ml-1">— {seatAvailability.matchingVans.map(v => v.reg).join(', ')} already set</span>
                    )}
                    {seatAvailability?.nonMatchingVans && seatAvailability.nonMatchingVans.length > 0 && (
                      <span className="text-gray-400 ml-1">— {seatAvailability.nonMatchingVans.map(v => v.reg).join(', ')} need turning</span>
                    )}
                  </div>
                )}
                {derivedFlags.prep_time_by_category.vehicles > 0 && (
                  <div>Est. prep: {formatPrepTime(derivedFlags.prep_time_by_category.vehicles)}</div>
                )}
              </div>
            )}

            {/* Hire Forms — send button */}
            {req.requirement_type === 'hire_forms' && (
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={openEmailPicker}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-ooosh-600 bg-ooosh-50 border border-ooosh-200 rounded hover:bg-ooosh-100 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Send hire form
                </button>
                {req.status === 'in_progress' && req.notes?.includes('Hire form email sent') && (
                  <span className="text-[10px] text-green-600">Sent</span>
                )}
              </div>
            )}

            {/* Backline */}
            {req.requirement_type === 'backline' && derivedFlags?.has_backline && (
              <div className="mt-1 text-xs text-gray-500">
                {derivedFlags.backline_item_count} item{derivedFlags.backline_item_count !== 1 ? 's' : ''} detected
                {derivedFlags.prep_time_by_category.backline > 0 && (
                  <span> — est. {formatPrepTime(derivedFlags.prep_time_by_category.backline)} prep/de-prep</span>
                )}
              </div>
            )}

            {/* Excess — show link to Money tab */}
            {req.requirement_type === 'excess' && (
              <div className="mt-1 text-xs text-gray-500">
                {req.notes ? req.notes.split('\n').filter(Boolean).pop() : 'Insurance excess required for self-drive hire'}
              </div>
            )}

            {/* Notes (for types without specific rendering) */}
            {!['vehicle', 'hire_forms', 'backline', 'excess'].includes(req.requirement_type) && req.notes && (
              <div className="mt-1 text-xs text-gray-400 truncate max-w-md">{req.notes.split('\n').filter(Boolean).pop()}</div>
            )}

            {/* Mismatch warning */}
            {req.hh_mismatch && req.hh_mismatch_detail && (
              <div className="mt-1 text-xs text-amber-600 font-medium">
                ⚠ {req.hh_mismatch_detail}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Step progress */}
          {req.type_steps && req.current_step && (
            <div className="flex items-center gap-1 mr-2">
              <span className="text-xs text-gray-500">{req.current_step}</span>
              {req.type_steps.indexOf(req.current_step) < req.type_steps.length - 1 && (
                <button
                  onClick={() => onAdvanceStep(req.id)}
                  className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium ml-1"
                >
                  Next &rarr;
                </button>
              )}
            </div>
          )}

          {/* Status dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowStatusMenu(!showStatusMenu)}
              className={`inline-flex px-3 py-1 rounded text-xs font-medium ${statusConfig.bg} ${statusConfig.colour} cursor-pointer hover:opacity-80 transition-opacity`}
            >
              {statusConfig.label}
              <svg className="w-3 h-3 ml-1 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showStatusMenu && (
              <div className="absolute right-0 mt-1 w-36 bg-white rounded-lg shadow-lg border border-gray-200 z-10 py-1">
                {PREP_STATUS_ORDER.map((s) => {
                  const sc = PREP_STATUS_CONFIG[s];
                  return (
                    <button
                      key={s}
                      onClick={() => { onStatusChange(req.id, s); setShowStatusMenu(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2 ${req.status === s ? 'font-bold' : ''}`}
                    >
                      <span className={`w-2 h-2 rounded-full ${sc.bg.replace('100', '500')}`} />
                      {sc.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Remove button */}
          <button
            onClick={() => onRemove(req.id)}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all ml-1"
            title="Remove requirement"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Multi-step progress bar */}
      {req.type_steps && (
        <div className="mt-3 flex gap-1">
          {req.type_steps.map((step: string, i: number) => {
            const currentIdx = req.current_step ? req.type_steps!.indexOf(req.current_step) : -1;
            const isComplete = i <= currentIdx;
            return (
              <div
                key={step}
                className={`flex-1 h-1.5 rounded-full ${isComplete ? 'bg-green-400' : 'bg-gray-200'} transition-colors`}
                title={step}
              />
            );
          })}
        </div>
      )}

      {/* ── Email contact picker modal ── */}
      {showEmailPicker && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-600">Send hire form to:</span>
            <button onClick={() => setShowEmailPicker(false)} className="text-gray-400 hover:text-gray-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {loadingContacts ? (
            <div className="text-xs text-gray-400 py-2">Loading contacts...</div>
          ) : emailContacts.length === 0 ? (
            <div className="text-xs text-gray-400 py-2">No contacts with email addresses found for this job.</div>
          ) : (
            <>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {emailContacts.map(c => (
                  <label key={c.email} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedEmails.has(c.email)}
                      onChange={e => {
                        const next = new Set(selectedEmails);
                        if (e.target.checked) next.add(c.email);
                        else next.delete(c.email);
                        setSelectedEmails(next);
                      }}
                      className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                    />
                    <span className="text-xs text-gray-700">{c.name}</span>
                    <span className="text-[10px] text-gray-400">{c.email}</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-500 ml-auto">{c.source.replace('_', ' ')}</span>
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => sendHireFormEmail(false)}
                  disabled={emailSending || selectedEmails.size === 0}
                  className="px-3 py-1 text-xs font-medium bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                >
                  {emailSending ? 'Sending...' : `Send (${selectedEmails.size})`}
                </button>
                <button
                  onClick={() => sendHireFormEmail(true)}
                  disabled={emailSending || selectedEmails.size === 0}
                  className="px-3 py-1 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50"
                >
                  Send reminder
                </button>
                {emailResult && (
                  <span className={`text-xs ${emailResult.includes('Failed') ? 'text-red-500' : 'text-green-600'}`}>
                    {emailResult}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
