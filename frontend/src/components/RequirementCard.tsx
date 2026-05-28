/**
 * RequirementCard — reusable card component for the Prep Checklist.
 *
 * Renders a single job requirement with:
 * - Type-specific HH context (vehicle details, backline counts, etc.)
 * - Status dropdown (non-linear: any → any) for standard requirements
 * - Contextual status display for hire_forms (driver submissions) and excess (financial status)
 * - Multi-step progress bar
 * - Mismatch warnings
 * - "HH" badge for auto-derived requirements
 * - Action buttons (send hire form, van & driver toggle)
 */

import { useState, useEffect, useRef } from 'react';
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
  phase: 'pre_hire' | 'post_hire';
  type_label: string;
  type_icon: string;
  type_steps: string[] | null;
  sort_order: number;
  event_trigger: string | null;
  delivery_method: string | null;
}

export type VehicleSlotMode = 'self_drive' | 'van_and_driver';

export interface VehicleSlot {
  item_id: number;
  slot_index: number;
  item_name: string;
  mode: VehicleSlotMode;
}

export interface DerivedFlags {
  has_vehicle: boolean;
  vehicle_count: number;
  vehicle_types: string[];
  vehicle_slots?: VehicleSlot[];
  self_drive_count?: number;
  van_and_driver_count?: number;
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
  /** Optional person UUID when the contact came from a known person row.
   *  Used by the picker's "save as job contacts" promote checkbox. */
  person_id?: string;
}

interface HireFormDriver {
  driver_name: string | null;
  status: string;
  created_at: string;
  requires_referral: boolean;
  excess_status: string | null;
  excess_amount_required: number | null;
  excess_amount_taken: number | null;
}

interface ExcessInfo {
  totals: {
    total_excess_required: number;
    total_excess_collected: number;
    total_excess_outstanding: number;
    drivers_cleared: number;
    drivers_pending: number;
  };
  drivers: Array<{
    driver_name: string;
    excess_amount_required: number;
    excess_amount_taken: number;
    amount_held?: number;
    held_expires_at?: string | null;
    excess_status: string;
    requires_referral: boolean;
  }>;
}

export const PREP_STATUS_CONFIG: Record<string, { label: string; colour: string; bg: string; border: string }> = {
  not_started: { label: 'Not Started', colour: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' },
  in_progress: { label: 'In Progress', colour: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-200' },
  done:        { label: 'Done',        colour: 'text-green-700', bg: 'bg-green-100', border: 'border-green-200' },
  blocked:     { label: 'Blocked',     colour: 'text-red-700',   bg: 'bg-red-100',   border: 'border-red-200' },
  cancelled:   { label: 'Cancelled',   colour: 'text-gray-500',  bg: 'bg-gray-50',   border: 'border-gray-200' },
};

export const PREP_STATUS_ORDER: JobRequirement['status'][] = ['not_started', 'in_progress', 'done', 'blocked'];

// Type-specific status label overrides (same underlying statuses, friendlier names per context)
const TYPE_STATUS_LABELS: Record<string, Record<string, string>> = {
  backline: { not_started: 'Not Started', in_progress: 'Working On It', done: 'Done', blocked: 'Problem' },
  rehearsal: { not_started: 'Not Started', in_progress: 'In Progress', done: 'Done', blocked: 'Problem' },
  invoice: { not_started: 'Not Invoiced', in_progress: 'Generated', done: 'Sent', blocked: 'Problem' },
  payment_reconcile: { not_started: 'Outstanding', in_progress: 'Partial', done: 'Reconciled', blocked: 'Dispute' },
  excess_resolve: { not_started: 'Pending', in_progress: 'In Progress', done: 'Resolved', blocked: 'Dispute' },
  freelancer_followup: { not_started: 'Not Contacted', in_progress: 'Chased', done: 'Done', blocked: 'Overdue' },
  client_followup: { not_started: 'Not Contacted', in_progress: 'In Progress', done: 'Done', blocked: 'No Response' },
  reminder: { not_started: 'To Do', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked' },
  damage_review: { not_started: 'Open', in_progress: 'Awaiting Quote', done: 'Resolved', blocked: 'Stalled' },
};

const EXCESS_STATUS_LABELS: Record<string, { label: string; colour: string }> = {
  needed:                { label: 'Required',          colour: 'text-amber-600' },
  not_required:          { label: 'Covered',           colour: 'text-gray-500' },
  pending:               { label: 'Required',          colour: 'text-amber-600' },
  partially_paid:        { label: 'Partially Paid',    colour: 'text-amber-600' },
  taken:                 { label: 'Taken',             colour: 'text-green-600' },
  pre_auth:              { label: 'Pre-auth Taken',    colour: 'text-blue-600' },
  waived:                { label: 'Waived',            colour: 'text-gray-500' },
  fully_claimed:         { label: 'Fully Claimed',     colour: 'text-red-600' },
  partially_reimbursed:  { label: 'Partially Reimbursed', colour: 'text-amber-600' },
  reimbursed:            { label: 'Reimbursed',        colour: 'text-green-600' },
  rolled_over:           { label: 'On Account',        colour: 'text-blue-600' },
};

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
  hhJobNumber,
  isVanAndDriver,
  onStatusChange,
  onAdvanceStep,
  onRemove,
  onVanAndDriverToggle,
  onSlotModeChange,
  onReload,
}: {
  req: JobRequirement;
  derivedFlags?: DerivedFlags | null;
  seatAvailability?: SeatAvailability | null;
  isNested?: boolean;
  jobId: string;
  hhJobNumber?: number | null;
  isVanAndDriver?: boolean;
  onStatusChange: (reqId: string, status: JobRequirement['status']) => void;
  onAdvanceStep: (reqId: string) => void;
  onRemove: (reqId: string, reason?: string) => void;
  onVanAndDriverToggle?: () => void;
  onSlotModeChange?: (itemId: number, slotIndex: number, mode: VehicleSlotMode) => void;
  onReload?: () => void;
}) {
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [dropdownAbove, setDropdownAbove] = useState(false);
  const [showEmailPicker, setShowEmailPicker] = useState(false);
  const [emailContacts, setEmailContacts] = useState<EmailContact[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [customEmail, setCustomEmail] = useState('');
  const [customName, setCustomName] = useState('');
  const [customError, setCustomError] = useState('');
  // Round 6: opt-in promote-to-job-contacts on send. Default OFF — we want
  // staff to consciously promote, not silently mutate. Only renders when at
  // least one selected contact has a person_id AND isn't already in
  // job_contacts (i.e. source isn't job_contact / job_contact_primary).
  const [promoteToJobContacts, setPromoteToJobContacts] = useState(false);

  // Deletion confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const requiresDeleteReason = ['hire_forms', 'excess'].includes(req.requirement_type);

  // Hire form submissions + excess data (loaded for nested cards)
  const [hireFormDrivers, setHireFormDrivers] = useState<HireFormDriver[]>([]);
  const [excessInfo, setExcessInfo] = useState<ExcessInfo | null>(null);

  const isSuspendedByVD = req.notes?.includes('[Suspended: Van & Driver]') || false;
  const statusConfig = PREP_STATUS_CONFIG[req.status] || PREP_STATUS_CONFIG.not_started;
  const typeLabels = TYPE_STATUS_LABELS[req.requirement_type];
  const label = req.custom_label || req.type_label;

  // Load hire form and excess data for nested cards
  useEffect(() => {
    if (req.requirement_type === 'hire_forms' && hhJobNumber) {
      api.get<{ data: HireFormDriver[] }>(`/hire-forms/by-job/${hhJobNumber}`)
        .then(d => setHireFormDrivers(Array.isArray(d?.data) ? d.data : []))
        .catch(() => {});
    }
    if ((req.requirement_type === 'excess' || req.requirement_type === 'excess_resolve') && jobId) {
      // Try the excess-info endpoint — gracefully handle if it doesn't exist or returns unexpected shape
      api.get<{ data?: ExcessInfo }>(`/money/${jobId}/excess-info`)
        .then(d => {
          if (d?.data?.totals) setExcessInfo(d.data);
        })
        .catch(() => {});
    }
  }, [req.requirement_type, hhJobNumber, jobId]);

  // ── Hire Form Email ────────────────────────────────────────────────

  async function openEmailPicker() {
    setLoadingContacts(true);
    setShowEmailPicker(true);
    setCustomEmail('');
    setCustomName('');
    setCustomError('');
    setPromoteToJobContacts(false);
    try {
      const data = await api.get<{ contacts: EmailContact[] }>(`/hire-forms/email-contacts/${jobId}`);
      setEmailContacts(data.contacts);
      setSelectedEmails(new Set(data.contacts.map(c => c.email)));
    } catch (err) {
      console.error('Failed to load contacts:', err);
    } finally {
      setLoadingContacts(false);
    }
  }

  /** Promote any selected contacts that have a known person_id and aren't
   *  already in job_contacts. Fire-and-forget — failures don't block the send. */
  async function promoteSelectedToJobContacts() {
    const toPromote = emailContacts.filter(c =>
      selectedEmails.has(c.email) &&
      c.person_id &&
      c.source !== 'job_contact' &&
      c.source !== 'job_contact_primary'
    );
    if (toPromote.length === 0) return;
    await Promise.all(
      toPromote.map(c =>
        api.post(`/pipeline/${jobId}/contacts/add-person`, { person_id: c.person_id })
          .catch(err => console.warn(`Failed to promote ${c.email}:`, err))
      )
    );
  }

  function addCustomEmail() {
    const email = customEmail.trim().toLowerCase();
    if (!email) {
      setCustomError('Enter an email address');
      return;
    }
    // Minimal email shape check — backend will Zod-validate properly
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setCustomError('That doesn’t look like a valid email');
      return;
    }
    if (emailContacts.some(c => c.email.toLowerCase() === email)) {
      // Already in the list — just select it
      setSelectedEmails(prev => new Set(prev).add(email));
      setCustomEmail('');
      setCustomName('');
      setCustomError('');
      return;
    }
    const name = customName.trim() || email;
    setEmailContacts(prev => [...prev, { email, name, source: 'manual_entry' }]);
    setSelectedEmails(prev => new Set(prev).add(email));
    setCustomEmail('');
    setCustomName('');
    setCustomError('');
  }

  async function sendHireFormEmail(isChase: boolean) {
    if (selectedEmails.size === 0) return;
    setEmailSending(true);
    setEmailResult(null);
    try {
      const recipients = emailContacts
        .filter(c => selectedEmails.has(c.email))
        .map(c => ({ email: c.email, name: c.name }));
      // Promote first so future auto-emails route to job_contacts directly.
      // Best-effort: don't block the send on promote failure.
      if (promoteToJobContacts) {
        await promoteSelectedToJobContacts();
      }
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
    } catch {
      setEmailResult('Failed to send');
    } finally {
      setEmailSending(false);
    }
  }

  // Hide status dropdown for contextual cards (hire_forms, excess, vehicle with nested children)
  const isContextualStatus = (isNested && (req.requirement_type === 'hire_forms' || req.requirement_type === 'excess'))
    || req.requirement_type === 'vehicle';

  // Click outside to dismiss status dropdown
  const statusMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showStatusMenu) return;
    function handleClick(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showStatusMenu]);

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div
      className={`group bg-white rounded-xl border ${req.hh_mismatch && !isSuspendedByVD ? 'border-amber-300 bg-amber-50/30' : statusConfig.border} p-4 transition-all hover:shadow-sm ${isNested ? 'ml-8 border-l-4' : ''} ${isSuspendedByVD ? 'opacity-50' : ''}`}
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

            {/* ── Type-specific content ── */}

            {/* Vehicle */}
            {req.requirement_type === 'vehicle' && derivedFlags?.has_vehicle && (
              <div className="mt-1 text-xs text-gray-500 space-y-1">
                {/* Per-slot rows (preferred) with fallback to job-level toggle for pre-migration jobs */}
                {derivedFlags.vehicle_slots && derivedFlags.vehicle_slots.length > 0 ? (
                  <>
                    {(() => {
                      // Count slots per item_id so we can show slot numbers when there are multiple of the same type
                      const slotsByItem = new Map<number, number>();
                      for (const s of derivedFlags.vehicle_slots) {
                        slotsByItem.set(s.item_id, (slotsByItem.get(s.item_id) || 0) + 1);
                      }
                      return derivedFlags.vehicle_slots.map((slot) => {
                        const totalOfType = slotsByItem.get(slot.item_id) || 1;
                        const isSelfDrive = slot.mode === 'self_drive';
                        return (
                          <div key={`${slot.item_id}-${slot.slot_index}`} className="flex items-center gap-2 flex-wrap">
                            <span>
                              {slot.item_name}
                              {totalOfType > 1 && <span className="text-gray-400"> — Van {slot.slot_index + 1}</span>}
                            </span>
                            {onSlotModeChange ? (
                              <button
                                onClick={() => onSlotModeChange(slot.item_id, slot.slot_index, isSelfDrive ? 'van_and_driver' : 'self_drive')}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                  isSelfDrive
                                    ? 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                                    : 'bg-indigo-100 text-indigo-700 border-indigo-300 hover:bg-indigo-200'
                                }`}
                                title={isSelfDrive ? 'Currently Self-Drive — click to switch to Van & Driver' : 'Currently Van & Driver — click to switch to Self-Drive'}
                              >
                                {isSelfDrive ? '🔑 Self-Drive' : '👤 Van & Driver'}
                              </button>
                            ) : (
                              <span className="text-[10px] text-gray-400">{isSelfDrive ? 'Self-Drive' : 'Van & Driver'}</span>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </>
                ) : (
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
                )}
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

            {/* Suspended by Van & Driver banner */}
            {isSuspendedByVD && (req.requirement_type === 'hire_forms' || req.requirement_type === 'excess') && (
              <div className="mt-1 text-xs text-gray-400 italic">Not required — Van & Driver mode</div>
            )}

            {/* Hire Forms — show driver submissions + send button */}
            {req.requirement_type === 'hire_forms' && !isSuspendedByVD && (
              <div className="mt-1 space-y-1">
                {/* Summary counts */}
                {(() => {
                  const received = hireFormDrivers.filter(d =>
                    d.status === 'confirmed' || d.status === 'booked_out' || d.status === 'active'
                  ).length;
                  const referralCount = hireFormDrivers.filter(d => d.requires_referral).length;
                  // Parse all "sent" entries from the notes — each line was
                  // appended by /api/hire-forms/send-email as:
                  //   "Hire form email sent to a@x.com, b@y.com on DD/MM/YYYY"
                  // Show the last one in the badge; full history in the tooltip.
                  const sendRegex = /Hire form (email|reminder) sent to (.+?) on (\d{2}\/\d{2}\/\d{4})/g;
                  const sends: { kind: string; recipients: string; date: string }[] = [];
                  if (req.notes) {
                    let m: RegExpExecArray | null;
                    while ((m = sendRegex.exec(req.notes)) !== null) {
                      sends.push({ kind: m[1], recipients: m[2], date: m[3] });
                    }
                  }
                  const hasSentNote = sends.length > 0;
                  const lastSend = hasSentNote ? sends[sends.length - 1] : null;
                  const sendTooltip = sends.length
                    ? sends.map(s => `${s.date} (${s.kind}) → ${s.recipients}`).join('\n')
                    : '';

                  return (
                    <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                      {hasSentNote && lastSend && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium max-w-full"
                          title={sendTooltip}
                        >
                          <span className="shrink-0">✓ Sent {lastSend.date}</span>
                          <span className="truncate text-blue-600/80">to {lastSend.recipients}</span>
                          {sends.length > 1 && (
                            <span className="shrink-0 px-1 rounded bg-blue-200/70 text-blue-800">+{sends.length - 1}</span>
                          )}
                        </span>
                      )}
                      {received > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                          {received} received
                        </span>
                      )}
                      {referralCount > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                          {referralCount} referral{referralCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  );
                })()}

                {/* Individual driver list */}
                {hireFormDrivers.length > 0 ? (
                  <div className="space-y-0.5">
                    {hireFormDrivers.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          d.status === 'confirmed' || d.status === 'booked_out' || d.status === 'active' ? 'bg-green-500' :
                          d.status === 'soft' ? 'bg-amber-400' : 'bg-gray-300'
                        }`} />
                        <span className="text-gray-700">{d.driver_name || 'Unknown driver'}</span>
                        {d.requires_referral && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">Referral</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">No hire forms submitted yet</div>
                )}
                {/* Always available — staff legitimately need this when:
                    - 0 received: original email went to spam, wrong contact,
                      need to send to a different person, etc.
                    - ≥1 received: send to additional drivers (multi-driver
                      hire) or chase missing drivers.
                    The auto-email scheduler handles the standard 10-day-out
                    invite + 5-day chase, but it's not the only path —
                    staff need manual control too.
                    Tooltip clarifies what the button actually does, since
                    'send hire form' previously read as 'send the agreement
                    PDF' to staff who hadn't seen the underlying flow. */}
                <button
                  onClick={openEmailPicker}
                  title="Sends an email with a link for the driver to complete their DVLA check, licence + signature. The hire agreement PDF (with van + dates) is generated separately at book-out."
                  className="inline-flex items-center gap-1.5 mt-1 px-3 py-1 text-xs font-semibold text-white bg-ooosh-600 rounded-md shadow-sm hover:bg-ooosh-700 active:bg-ooosh-800 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {hireFormDrivers.length > 0 ? 'Send again / Chase' : 'Send hire form'}
                </button>
              </div>
            )}

            {/* Excess — show financial status */}
            {req.requirement_type === 'excess' && !isSuspendedByVD && (
              <div className="mt-1 text-xs">
                {excessInfo?.totals ? (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-700 font-medium">
                        £{(excessInfo.totals.total_excess_required ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })} required
                      </span>
                      {(excessInfo.totals.total_excess_collected ?? 0) > 0 && (
                        <span className="text-green-600">
                          £{(excessInfo.totals.total_excess_collected ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })} collected
                        </span>
                      )}
                      {(excessInfo.totals.total_excess_outstanding ?? 0) > 0 && (
                        <span className="text-amber-600">
                          £{(excessInfo.totals.total_excess_outstanding ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })} outstanding
                        </span>
                      )}
                    </div>
                    {(excessInfo.drivers || []).map((d, i) => {
                      // Top-N rule: drivers beyond the highest-risk N (where
                      // N = van count) have £0 required because the top
                      // driver(s) cover the excess for the whole hire. The
                      // raw status is usually 'pending' on those records, but
                      // showing "Pending £0/£0" reads as "outstanding" when
                      // really nothing is owed. Render a muted "Covered"
                      // pill instead — pure UI rule, no data change, no
                      // status loops.
                      const required = d.excess_amount_required ?? 0;
                      const taken = d.excess_amount_taken ?? 0;
                      const isCovered = required === 0 && taken === 0;
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs text-gray-500">
                          <span>{d.driver_name || 'Unknown'}:</span>
                          {isCovered ? (
                            <span
                              className="text-gray-400 italic"
                              title="Excess covered by another driver on this hire"
                            >
                              Covered
                            </span>
                          ) : (
                            <>
                              <span className={EXCESS_STATUS_LABELS[d.excess_status]?.colour || 'text-gray-500'}>
                                {EXCESS_STATUS_LABELS[d.excess_status]?.label || d.excess_status || 'Unknown'}
                              </span>
                              <span className="text-gray-400">
                                £{taken.toLocaleString('en-GB', { minimumFractionDigits: 2 })} / £{required.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                              </span>
                            </>
                          )}
                          {d.requires_referral && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">Referral</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-gray-400">Insurance excess required for self-drive hire</span>
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

            {/* Rehearsal */}
            {req.requirement_type === 'rehearsal' && derivedFlags?.has_rehearsal && (
              <div className="mt-1 text-xs text-gray-500">
                Rehearsal room detected
                {derivedFlags.prep_time_by_category.rehearsals > 0 && (
                  <span> — est. {formatPrepTime(derivedFlags.prep_time_by_category.rehearsals)} prep</span>
                )}
              </div>
            )}

            {/* Invoice — show "Mark as Sent" button when status is in_progress (generated) */}
            {req.requirement_type === 'invoice' && req.status === 'in_progress' && (
              <div className="mt-1.5">
                <button
                  onClick={() => onStatusChange(req.id, 'done')}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Mark as Sent to Client
                </button>
              </div>
            )}

            {/* Reminder — show due date, assigned user, event trigger, delivery, notes */}
            {req.requirement_type === 'reminder' && (
              <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                {req.due_date && (
                  <div className={`font-medium ${new Date(req.due_date) <= new Date() ? 'text-red-600' : 'text-blue-600'}`}>
                    Due: {new Date(req.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {new Date(req.due_date) <= new Date() && ' (overdue)'}
                  </div>
                )}
                {req.event_trigger && (
                  <div className="text-[10px] text-purple-600">
                    Triggers on: job {req.event_trigger}
                  </div>
                )}
                {req.delivery_method && req.delivery_method !== 'both' && (
                  <div className="text-[10px] text-gray-400">
                    Notify via: {req.delivery_method === 'notification' ? 'Bell only' : 'Email only'}
                  </div>
                )}
                {req.assigned_to_name && (
                  <div className="text-gray-400">Assigned to: {req.assigned_to_name}</div>
                )}
                {req.notes && <div>{req.notes}</div>}
              </div>
            )}

            {/* Damage — show notes + chase hint */}
            {req.requirement_type === 'damage_review' && (
              <div className="mt-1 text-xs text-gray-500">
                {req.notes && <div>{req.notes}</div>}
                {req.due_date && (
                  <div className="text-amber-600 font-medium mt-0.5">
                    Chase: {new Date(req.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                )}
              </div>
            )}

            {/* Excess resolution — explain the amber/blue light against live excess */}
            {req.requirement_type === 'excess_resolve' && excessInfo?.drivers && (() => {
              const NEEDS_ACTION = ['needed', 'pending', 'taken', 'partially_paid', 'partially_reimbursed'];
              const unresolved = excessInfo.drivers.filter(d => NEEDS_ACTION.includes(d.excess_status));
              const heldAmount = unresolved.reduce(
                (sum, d) => sum + Math.max(0, (d.excess_amount_taken || 0) + (d.amount_held || 0)), 0);
              const preAuths = excessInfo.drivers.filter(d => d.excess_status === 'pre_auth');
              const preAuthTotal = preAuths.reduce((sum, d) => sum + (d.amount_held || 0), 0);
              const earliestExpiry = preAuths
                .map(d => d.held_expires_at)
                .filter((x): x is string => !!x)
                .sort()[0];
              const daysToExpiry = earliestExpiry
                ? Math.ceil((new Date(earliestExpiry).getTime() - Date.now()) / 86400000)
                : null;
              if (unresolved.length === 0 && preAuths.length === 0) return null;
              return (
                <div className="mt-1 space-y-1">
                  {/* Amber contradiction — marked Resolved but money still in limbo */}
                  {req.status === 'done' && unresolved.length > 0 && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      ⚠ Marked resolved, but £{heldAmount.toLocaleString('en-GB', { minimumFractionDigits: 2 })} excess is still in limbo
                      ({unresolved.map(d => `${d.driver_name || 'Driver'}: ${d.excess_status.replace(/_/g, ' ')}`).join(', ')}).
                      Reimburse, claim, roll over or waive.
                    </div>
                  )}
                  {/* Amber to-do when not yet resolved (and not just a pre-auth pending) */}
                  {req.status !== 'done' && unresolved.length > 0 && (
                    <div className="text-xs text-amber-600">
                      £{heldAmount.toLocaleString('en-GB', { minimumFractionDigits: 2 })} excess still to resolve — reimburse, claim, roll over or waive.
                    </div>
                  )}
                  {/* Blue info — live pre-auth, decision pending */}
                  {preAuths.length > 0 && (
                    <div className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                      Pre-auth £{preAuthTotal.toLocaleString('en-GB', { minimumFractionDigits: 2 })} held
                      {daysToExpiry !== null && (daysToExpiry > 0
                        ? ` — auto-releases in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`
                        : ' — releasing imminently')}. Capture now if claiming for damage, otherwise no action needed.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Notes (for types without specific rendering) */}
            {!['vehicle', 'hire_forms', 'backline', 'excess', 'excess_resolve', 'invoice', 'damage_review', 'reminder'].includes(req.requirement_type) && req.notes && (
              <div className="mt-1 text-xs text-gray-400 truncate max-w-md">{req.notes.split('\n').filter(Boolean).pop()}</div>
            )}

            {/* Mismatch warning — suppressed for V&D-suspended rows, where the
                "removed from HireHop" mismatch is expected (the van was
                deliberately removed when the hire shifted to V&D / backline-only)
                and an amber warning misleads staff into thinking there's a problem. */}
            {req.hh_mismatch && req.hh_mismatch_detail && !isSuspendedByVD && (
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

          {/* Status dropdown — only for non-contextual cards */}
          {!isContextualStatus && (
            <div className="relative" ref={statusMenuRef}>
              <button
                onClick={() => {
                  if (!showStatusMenu && statusMenuRef.current) {
                    const rect = statusMenuRef.current.getBoundingClientRect();
                    setDropdownAbove(rect.bottom + 180 > window.innerHeight);
                  }
                  setShowStatusMenu(!showStatusMenu);
                }}
                className={`inline-flex px-3 py-1 rounded text-xs font-medium ${isSuspendedByVD ? 'bg-gray-100 text-gray-500' : `${statusConfig.bg} ${statusConfig.colour}`} cursor-pointer hover:opacity-80 transition-opacity`}
              >
                {isSuspendedByVD ? 'Not Required' : (typeLabels?.[req.status] || statusConfig.label)}
                <svg className="w-3 h-3 ml-1 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showStatusMenu && (
                <div className={`absolute right-0 w-36 bg-white rounded-lg shadow-lg border border-gray-200 z-10 py-1 ${dropdownAbove ? 'bottom-full mb-1' : 'mt-1'}`}>
                  {PREP_STATUS_ORDER.map((s) => {
                    const sc = PREP_STATUS_CONFIG[s];
                    return (
                      <button
                        key={s}
                        onClick={() => { onStatusChange(req.id, s); setShowStatusMenu(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2 ${req.status === s ? 'font-bold' : ''}`}
                      >
                        <span className={`w-2 h-2 rounded-full ${sc.bg.replace('100', '500')}`} />
                        {typeLabels?.[s] || sc.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Remove button */}
          <button
            onClick={() => setShowDeleteConfirm(true)}
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

      {/* ── Delete confirmation ── */}
      {showDeleteConfirm && (() => {
        // Hire-forms is the most-misclicked card type (the X sits next to
        // the email picker dismiss). We always lock down deletion of
        // hire_forms / excess HARD: type-to-confirm ("DELETE"), explicit
        // copy explaining drivers/assignments are NOT deleted by removing
        // this card (they remain in the system; hit Sync HH to bring the
        // card back). When drivers are loaded we list them too so it's
        // obvious what state the hire is in. The type-to-confirm fires
        // even with zero loaded drivers, since assignments may have
        // existed historically (and the misclick is the destructive path
        // either way).
        const isHireForms = req.requirement_type === 'hire_forms';
        const hasAttachedDrivers = isHireForms && hireFormDrivers.length > 0;
        const requiresTypeConfirm = isHireForms;
        const reasonOk = !requiresDeleteReason || deleteReason.trim().length > 0;
        const typedOk = !requiresTypeConfirm || deleteReason.trim().toUpperCase().endsWith('DELETE');
        const canRemove = reasonOk && typedOk;

        const submit = () => {
          if (!canRemove) return;
          // Strip the "DELETE" sentinel before sending the reason — it's
          // a UI guard, not part of the audit message.
          const reason = requiresTypeConfirm
            ? deleteReason.trim().replace(/\s*DELETE\s*$/i, '').trim() || undefined
            : (deleteReason.trim() || undefined);
          onRemove(req.id, reason);
          setShowDeleteConfirm(false);
          setDeleteReason('');
        };

        return (
          <div className="mt-3 pt-3 border-t border-red-200 bg-red-50 -mx-4 -mb-4 px-4 pb-4 rounded-b-xl">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span className="text-sm font-bold text-red-800">
                Remove {label}?
              </span>
            </div>

            {isHireForms && (
              <div className="mb-2 rounded-md bg-white border border-red-200 p-2 text-xs">
                {hasAttachedDrivers ? (
                  <>
                    <div className="font-semibold text-red-700 mb-1">
                      ⚠ This card has {hireFormDrivers.length} attached driver{hireFormDrivers.length !== 1 ? 's' : ''}:
                    </div>
                    <ul className="space-y-0.5 mb-2">
                      {hireFormDrivers.map((d, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="font-medium text-gray-800">{d.driver_name || 'Unknown driver'}</span>
                          <span className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-600">{d.status}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="font-semibold text-red-700 mb-1">
                    ⚠ This is the Driver Hire Forms card.
                  </div>
                )}
                <div className="text-gray-600 leading-snug">
                  Removing the card does <strong>not</strong> delete drivers or
                  cancel the hire — assignment records stay in the database. To bring
                  the card back, hit <strong>Sync HH</strong> at the top of the job.
                  If you meant to dismiss the email picker, click <strong>Close</strong> there
                  instead — not this X.
                </div>
              </div>
            )}

            {requiresDeleteReason && (
              <div className="mb-2">
                <input
                  type="text"
                  value={deleteReason}
                  onChange={e => setDeleteReason(e.target.value)}
                  placeholder={requiresTypeConfirm ? 'Reason — and type DELETE at the end to confirm' : 'Reason for removing (required)...'}
                  className="w-full px-2 py-1.5 text-xs border border-red-300 rounded focus:ring-red-300 focus:border-red-400"
                  autoFocus={!isHireForms}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canRemove) submit();
                    else if (e.key === 'Escape') { setShowDeleteConfirm(false); setDeleteReason(''); }
                  }}
                />
                {requiresTypeConfirm && deleteReason.trim() && !typedOk && (
                  <div className="text-[11px] text-red-600 mt-1">
                    Type <code className="px-1 bg-red-100 rounded">DELETE</code> at the end of the reason to enable the Remove button.
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={submit}
                disabled={!canRemove}
                className="px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Remove
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteReason(''); }}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                autoFocus={isHireForms}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Email contact picker ── */}
      {showEmailPicker && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-600">Send hire form to:</span>
            {/* Explicit text button — was previously a tiny X that looked
                identical to the requirement-card delete X (and was easy to
                misclick into the delete flow). */}
            <button
              onClick={() => setShowEmailPicker(false)}
              className="text-xs font-medium text-gray-500 hover:text-gray-800 px-2 py-0.5 rounded hover:bg-gray-100"
              title="Close — does not affect drivers"
            >
              Close
            </button>
          </div>
          {loadingContacts ? (
            <div className="text-xs text-gray-400 py-2">Loading contacts...</div>
          ) : (
            <>
              {emailContacts.length === 0 ? (
                <div className="text-xs text-gray-400 py-2">No contacts with email addresses found for this job. Add one below.</div>
              ) : (
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
              )}

              {/* Manual entry — type any email address */}
              <div className="mt-2 pt-2 border-t border-dashed border-gray-200">
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Or send to another address</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="email"
                    value={customEmail}
                    onChange={e => { setCustomEmail(e.target.value); setCustomError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomEmail(); } }}
                    placeholder="email@example.com"
                    className="flex-1 min-w-[180px] text-xs px-2 py-1 rounded border border-gray-200 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  <input
                    type="text"
                    value={customName}
                    onChange={e => setCustomName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomEmail(); } }}
                    placeholder="Name (optional)"
                    className="flex-1 min-w-[140px] text-xs px-2 py-1 rounded border border-gray-200 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  <button
                    type="button"
                    onClick={addCustomEmail}
                    className="px-2 py-1 text-xs font-medium text-ooosh-600 border border-ooosh-300 rounded hover:bg-ooosh-50"
                  >
                    + Add
                  </button>
                </div>
                {customError && (
                  <div className="text-[11px] text-red-500 mt-1">{customError}</div>
                )}
              </div>

              {/* Round 6 — promote-on-send. Only render when ≥1 selected
                  recipient has a person_id AND isn't already in job_contacts. */}
              {(() => {
                const promotable = emailContacts.filter(c =>
                  selectedEmails.has(c.email) &&
                  c.person_id &&
                  c.source !== 'job_contact' &&
                  c.source !== 'job_contact_primary'
                );
                if (promotable.length === 0) return null;
                return (
                  <label className="flex items-start gap-2 mt-3 px-2 py-1.5 rounded bg-blue-50 border border-blue-100 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={promoteToJobContacts}
                      onChange={e => setPromoteToJobContacts(e.target.checked)}
                      className="mt-0.5 rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                    />
                    <span className="text-[11px] text-blue-900 leading-snug">
                      Also save {promotable.length === 1 ? 'this contact' : `these ${promotable.length} contacts`} to the job, so future emails route here automatically.
                    </span>
                  </label>
                );
              })()}

              <div className="flex items-center gap-2 mt-3">
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
                  Chase
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
