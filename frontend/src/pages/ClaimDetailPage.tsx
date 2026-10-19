/**
 * One possible-insurance-claim case (docs/INCIDENT-CLAIMS-SPEC.md, Phase 1).
 *
 * The case file around one incident: the Problems it covers, the broker-form
 * answers (staff-entered in Phase 1 — the client form is Phase 2), files,
 * the owner + next-check date that keeps long cases moving (§9.2), and — for
 * managers — the policyholder signature, the broker PDF and the send.
 *
 * Keyed by id (.claude/rules/frontend.md › Detail pages).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { useAuthedFileUrl } from '../hooks/useAuthedFileUrl';
import { openAuthedFile, openR2Key } from '../lib/openAuthedFile';
import { compressImageWithThumb } from '../modules/vehicles/lib/image-utils';
import { SignatureCapture, SignatureCaptureHandle } from '../modules/vehicles/components/book-out/SignatureCapture';
import { MentionComposer } from '../components/messaging/MentionComposer';
import { useAttachments } from '../components/messaging/Attachments';
import {
  CLAIM_SECTIONS, CLIENT_CHECKLIST, ClaimSectionDef, isFieldShown, sectionMissing, type DamageMark, type OutlineType,
} from '@claimform';
import { DamageOutlineEditor } from '../components/claims/VanOutline';
import { GpsTraceCard } from '../components/claims/GpsTraceCard';
import { LinkifiedText } from '../components/LinkifiedText';
import { FieldsGrid, ListEditor } from '../components/claims/FormFields';
import {
  ClaimStage, ClaimStagePill, NextCheckCell, OUTCOME_LABEL, fmtClaimDate, ukDatePlus,
} from '../components/claims/format';

type Row = Record<string, unknown>;
type FormData = Record<string, unknown>;

interface ClaimEvent {
  id: string;
  event_type: string;
  event_date: string | null;
  body: string | null;
  metadata: Row | null;
  created_at: string;
  created_by_name: string | null;
}
interface ClaimFile {
  id: string;
  r2_key: string;
  thumb_r2_key: string | null;
  filename: string;
  file_type: string;
  content_type: string | null;
  caption: string | null;
  taken_at: string | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
  share_with_insurer: boolean;
}
interface LinkedProblem { id: string; summary: string; category: string; status: string; created_at: string }
interface CaseDriver { driver_id: string; full_name: string; assignment_id: string; vehicle_id: string; has_hire_form: boolean }
interface Claim {
  id: string;
  stage: ClaimStage;
  stage_label: string;
  outcome: string | null;
  origin_issue_id: string | null;
  job_id: string | null;
  job_name: string | null;
  client_name: string | null;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  driver_id: string | null;
  driver_name: string | null;
  hh_job_number: number | null;
  incident_at: string | null;
  notified_on: string | null;
  notified_via: string | null;
  form_data: FormData;
  broker_ref: string | null;
  insurer_ref: string | null;
  broker_sent_at: string | null;
  broker_pdf_key: string | null;
  third_party_claim: boolean;
  third_party_claim_notes: string | null;
  liability_dispute: boolean;
  liability_dispute_notes: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  next_check_on: string | null;
  policyholder_signed_at: string | null;
  policyholder_signed_name: string | null;
  policyholder_user_name: string | null;
  watchers: string[];
  value_estimate: { value_ex_vat: number; rounded_to: number; start_date: string } | null;
  hire_form_declarations: { accidents: boolean; convictions: boolean; disability: boolean; licence_points: number | null; additional_details: string | null } | null;
  problems: LinkedProblem[];
  events: ClaimEvent[];
  files: ClaimFile[];
  drivers: CaseDriver[];
  links: ClaimLink[];
  outline: OutlineType;
  damage_marks: DamageMark[];
  sketch_key: string | null;
  driver_signed_at: string | null;
  driver_signed_name: string | null;
  sections_done: Record<string, string> | null;
  submitted_at: string | null;
  chase_level: number;
  chase_sent_for: string | null;
  chase_paused_at: string | null;
  chase_paused_reason: string | null;
}
interface StaffUser { id: string; name: string | null; email: string }
interface ClaimLink {
  id: string;
  recipient_name: string | null;
  recipient_email: string | null;
  role: string;
  status: string;
  filled_as: string | null;
  filled_by_name: string | null;
  sent_at: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  created_at: string;
}

const FILE_TYPE_LABEL: Record<string, string> = {
  photo: 'Photo',
  police_report: 'Police report',
  broker_correspondence: 'Broker / insurer letter',
  repair_quote: 'Repair quote',
  tts360_notice: 'TTS360 notice',
  other: 'Other',
};

// How the incident first reached us (migration 260).
const NOTIFIED_VIA_LABEL: Record<string, string> = {
  client: 'Client (called / emailed us)',
  tts360: 'TTS360 (24-hour line)',
  third_party: 'Third party / their insurer',
  check_in: 'Found at check-in',
  other: 'Other',
};
// File types an insurer would expect — pre-ticked "share" on upload (mirrors the backend).
const SHARED_BY_DEFAULT = new Set(['photo', 'police_report', 'repair_quote']);

const errMsg = (e: unknown, fallback: string) =>
  ((e as { body?: { error?: string } })?.body?.error) || fallback;

export default function ClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <ClaimDetailContent key={id} />;
}

function ClaimDetailContent() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(user?.role);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [flash, setFlash] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<{ data: Claim }>(`/claims/${id}`);
      setClaim(r.data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ data: StaffUser[] }>('/claims/meta/users').then((r) => setUsers(r.data)).catch(() => undefined);
  }, []);

  const patch = async (body: Row, okMsg?: string) => {
    try {
      await api.patch(`/claims/${id}`, body);
      if (okMsg) setFlash(okMsg);
      await load();
    } catch (e) {
      setFlash(errMsg(e, 'Save failed'));
    }
  };

  if (loading) return <div className="p-6 text-slate-400">Loading…</div>;
  if (notFound || !claim) {
    return (
      <div className="p-6 text-slate-500">
        Claim not found. <Link to="/vehicles/claims" className="text-ooosh-600 hover:underline">All claims</Link>
      </div>
    );
  }

  const watching = !!user && claim.watchers.includes(user.id);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-800">
              {claim.vehicle_reg || 'No van'}{claim.hh_job_number ? ` · #${claim.hh_job_number}` : ''}
            </h1>
            <ClaimStagePill stage={claim.stage} outcome={claim.outcome} />
            {claim.third_party_claim && <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Third-party claim</span>}
            {claim.liability_dispute && <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">Liability dispute</span>}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {claim.job_name ? <>{claim.job_id ? <Link to={`/jobs/${claim.job_id}`} className="hover:underline">{claim.job_name}</Link> : claim.job_name}{' · '}</> : null}
            Incident {claim.incident_at ? fmtClaimDate(claim.incident_at) : 'date not yet known'}
            {' · '}we heard {fmtClaimDate(claim.notified_on)}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => { await api.post(`/claims/${id}/${watching ? 'unwatch' : 'watch'}`, {}); load(); }}
          className="px-3 py-1.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50"
        >
          {watching ? '👁 Watching' : 'Watch'}
        </button>
      </div>

      {flash && (
        <div className="mb-3 text-sm px-3 py-2 rounded bg-slate-100 text-slate-700 flex justify-between">
          <span>{flash}</span>
          <button type="button" onClick={() => setFlash('')} className="text-slate-400">✕</button>
        </div>
      )}

      <StageBar claim={claim} isManager={isManager} onDone={(m) => { setFlash(m); load(); }} onSend={() => setSending(true)} />
      {sending && (
        <SendFormPanel
          claim={claim}
          onClose={() => setSending(false)}
          onSent={(m) => { setSending(false); setFlash(m); load(); }}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 space-y-4">
          <DetailsCard claim={claim} patch={patch} />
          <ClientLinksCard
            claim={claim}
            onChange={(m) => { if (m) setFlash(m); load(); }}
            onSend={() => { setSending(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          />
          <FormCard claim={claim} onSaved={(m) => { setFlash(m); load(); }} />
          <DamageCard claim={claim} onChange={load} />
          <GpsTraceCard
            claimId={claim.id}
            hasVan={!!claim.vehicle_reg}
            saved={claim.files.filter((f) => f.file_type === 'gps_trace').map((f) => ({ id: f.id, caption: f.caption, filename: f.filename }))}
            onChange={(m) => { setFlash(m); load(); }}
          />
          <FilesCard claim={claim} isManager={isManager} onChange={load} />
          <TimelineCard claim={claim} onChange={load} />
        </div>
        <div className="space-y-4">
          <NextCheckCard claim={claim} users={users} patch={patch} />
          <ComplicationsCard claim={claim} patch={patch} />
          <ProblemsCard claim={claim} onChange={load} />
          <DocumentsCard claim={claim} />
          {isManager && <BrokerCard claim={claim} onDone={(m) => { setFlash(m); load(); }} />}
        </div>
      </div>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function StageBar({ claim, isManager, onDone, onSend }: {
  claim: Claim; isManager: boolean; onDone: (msg: string) => void; onSend: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const move = async (stage: string, extra: Row = {}) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/claims/${claim.id}/stage`, { stage, ...extra });
      setClosing(false);
      onDone('Stage updated.');
    } catch (e) {
      setError(errMsg(e, 'Could not change stage'));
    } finally {
      setBusy(false);
    }
  };

  const btn = 'px-3 py-1.5 text-xs rounded border disabled:opacity-50';
  const help: Record<ClaimStage, string> = {
    open: 'Start here: send the incident form to the driver and/or the client. Taken it all by phone instead? Fill in the form below and mark it complete.',
    form_out: 'The client has the form. They get a reminder each morning (up to 4) until they send it; you get a bell and an email when they do.',
    submitted: 'Waiting for a manager to review the answers.',
    reviewed: 'Reviewed. The broker has NOT been told — send it when (and if) you decide to, or close it.',
    with_broker: 'With the broker. Record their reference and keep the next-check date moving.',
    closed: `Closed${claim.outcome ? ` — ${OUTCOME_LABEL[claim.outcome] || claim.outcome}` : ''}.`,
  };

  return (
    <div className="bg-white rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-600 mr-auto">{help[claim.stage]}</span>
        {claim.stage === 'open' && (
          <>
            <button type="button" disabled={busy} className={`${btn} bg-ooosh-600 text-white border-ooosh-600 !text-sm !px-4 !py-2`} onClick={onSend}>
              📧 Send form to driver / client
            </button>
            <button type="button" disabled={busy} className={btn} onClick={() => move('submitted')} title="Everything was taken by phone and entered below">
              Taken by phone — ready for review
            </button>
          </>
        )}
        {claim.stage === 'form_out' && (
          <>
            <button type="button" disabled={busy} className={btn} onClick={onSend}>+ Send to someone else</button>
            <button type="button" disabled={busy} className={btn} onClick={() => move('submitted')}
              title="Mark it complete yourself (e.g. the rest came by phone)">
              Mark complete — ready for review
            </button>
          </>
        )}
        {claim.stage === 'submitted' && isManager && (
          <>
            <button type="button" disabled={busy} className={btn} onClick={() => move('open')}>Back to open</button>
            <button type="button" disabled={busy} className={`${btn} bg-ooosh-600 text-white border-ooosh-600`} onClick={() => move('reviewed')}>Mark reviewed</button>
          </>
        )}
        {claim.stage === 'reviewed' && isManager && (
          <button type="button" disabled={busy} className={btn} onClick={() => move('with_broker')} title="Already sent another way (e.g. emailed by hand)">
            Mark as sent by hand
          </button>
        )}
        {claim.stage !== 'closed' && isManager && (
          <button type="button" disabled={busy} className={btn} onClick={() => setClosing((v) => !v)}>Close case…</button>
        )}
        {claim.stage === 'closed' && isManager && (
          <button type="button" disabled={busy} className={btn} onClick={() => move('reviewed')}>Re-open</button>
        )}
        {!isManager && ['submitted', 'reviewed', 'with_broker'].includes(claim.stage) && (
          <span className="text-xs text-slate-400">Next steps are a manager's.</span>
        )}
      </div>
      {closing && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            Outcome
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="block mt-1 border rounded px-2 py-1 text-sm">
              <option value="">— pick —</option>
              {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="flex-1 min-w-[12rem] border rounded px-2 py-1 text-sm" />
          <button type="button" disabled={busy || !outcome} className={`${btn} bg-slate-800 text-white`} onClick={() => move('closed', { outcome, note: note || undefined })}>
            Close
          </button>
        </div>
      )}
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
      {(claim.stage === 'form_out' || (claim.stage === 'open' && claim.links.length > 0)) && <FormProgress claim={claim} />}
      {claim.stage === 'form_out' && <ChaseControls claim={claim} onDone={onDone} />}
    </div>
  );
}

const CHASE_MAX = 4;

/** Reminder status + pause / restart (spec §9.1). Pause needs a reason. */
function ChaseControls({ claim, onDone }: { claim: Claim; onDone: (msg: string) => void }) {
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const call = async (path: string, body: Row, msg: string) => {
    setBusy(true); setError('');
    try { await api.post(`/claims/${claim.id}/chase/${path}`, body); setPausing(false); setReason(''); onDone(msg); }
    catch (e) { setError(errMsg(e, 'Failed')); }
    finally { setBusy(false); }
  };
  const sent = Math.min(claim.chase_level, CHASE_MAX);
  const last = claim.chase_sent_for ? ` · last run ${fmtClaimDate(claim.chase_sent_for)}` : '';
  let status: React.ReactNode;
  if (claim.chase_paused_at) {
    status = <span className="text-amber-700">Reminders paused — {claim.chase_paused_reason}. The next-check date applies meanwhile.</span>;
  } else if (claim.chase_level > CHASE_MAX) {
    status = <span className="text-red-700 font-medium">{CHASE_MAX} reminders sent and still no form — reminders have stopped. Worth a phone call.</span>;
  } else {
    status = <span className="text-slate-600">Reminders: {sent} of {CHASE_MAX} sent{last}. One goes each morning at 09:21 (not within 20 hours of the client doing something).</span>;
  }
  const btn = 'px-2 py-1 text-xs rounded border bg-white disabled:opacity-50';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {status}
      {!claim.chase_paused_at && claim.chase_level <= CHASE_MAX && (
        <button type="button" className={btn} disabled={busy} onClick={() => setPausing((v) => !v)}>Pause reminders…</button>
      )}
      {(claim.chase_paused_at || claim.chase_level > 0) && (
        <button type="button" className={btn} disabled={busy}
          onClick={() => call('restart', {}, 'Reminders restarted — the next one is reminder 1.')}>
          Restart from reminder 1
        </button>
      )}
      {pausing && (
        <span className="basis-full flex flex-wrap gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (e.g. driver in hospital, speaking by phone)"
            className="flex-1 min-w-[16rem] border rounded px-2 py-1 text-sm" />
          <button type="button" className="px-2 py-1 text-xs rounded border bg-slate-800 text-white disabled:opacity-50" disabled={busy || reason.trim().length < 2}
            onClick={() => call('pause', { reason: reason.trim() }, 'Reminders paused.')}>
            Pause
          </button>
        </span>
      )}
      {error && <span className="basis-full text-red-600">{error}</span>}
    </div>
  );
}

/** Which EVENT types are the client working through their link. */
const CLIENT_ACTIVITY = new Set([
  'link_opened', 'who_filling', 'section_saved', 'damage_marked', 'sketch_saved', 'driver_verified', 'driver_signed', 'handed_off', 'sent_to_driver',
]);

/** "5 of 8 done" + where each part stands + the client's latest activity. */
function FormProgress({ claim }: { claim: Claim }) {
  const done = claim.sections_done || {};
  const form = claim.form_data || {};
  const items = CLIENT_CHECKLIST.map((it) => {
    if (it.key === 'driver') return { ...it, state: claim.driver_signed_at ? 'done' : 'todo' };
    if (it.key === 'who') return { ...it, state: done.who ? 'done' : 'todo' };
    const def = CLAIM_SECTIONS.find((x) => x.key === it.key)!;
    const complete = !!done[it.key] && sectionMissing(def, form).length === 0;
    const v = form[it.key];
    const started = (Array.isArray(v) ? v.length > 0 : !!v && Object.keys(v as object).length > 0) || typeof form[`${it.key}_involved`] === 'boolean';
    return { ...it, state: complete ? 'done' : started ? 'started' : 'todo' };
  });
  const n = items.filter((i) => i.state === 'done').length;
  const last = claim.events.find((e) => !e.created_by_name && CLIENT_ACTIVITY.has(e.event_type));
  return (
    <div className="mt-3 pt-3 border-t flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="font-medium text-slate-700">Client form: {n} of {items.length} done</span>
      {items.map((i) => (
        <span key={i.key} className={i.state === 'done' ? 'text-green-700' : i.state === 'started' ? 'text-amber-700' : 'text-slate-400'}
          title={i.state === 'started' ? 'Started, not finished' : undefined}>
          {i.state === 'done' ? '✓' : i.state === 'started' ? '…' : '○'} {i.title}
        </span>
      ))}
      <span className="basis-full text-slate-500">
        {last ? `Last activity ${new Date(last.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}: ${(last.body || '').replace(/\.?$/, '.')}` : 'Not opened yet.'}
        {' '}Parts the client saves show in the form below as they go — ticked once they are complete.
      </span>
    </div>
  );
}

function InlineText({ value, onSave, placeholder }: { value: string | null; onSave: (v: string | null) => void; placeholder?: string }) {
  const [v, setV] = useState(value || '');
  useEffect(() => { setV(value || ''); }, [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((v.trim() || null) !== (value || null)) onSave(v.trim() || null); }}
      placeholder={placeholder}
      className="w-full border border-slate-200 rounded px-2 py-1 text-sm focus:border-ooosh-400"
    />
  );
}

function DetailsCard({ claim, patch }: { claim: Claim; patch: (b: Row, m?: string) => Promise<void> }) {
  const f = (label: string, node: React.ReactNode) => (
    <div>
      <dt className="text-xs text-slate-500 mb-0.5">{label}</dt>
      <dd className="text-sm text-slate-800">{node}</dd>
    </div>
  );
  return (
    <Card title="Case details">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {f('Van', claim.vehicle_id
          ? <Link className="text-ooosh-700 hover:underline" to={`/vehicles/fleet/${claim.vehicle_id}`}>{claim.vehicle_reg}</Link>
          : <span className="text-slate-400">not set</span>)}
        {f('Make / model', [claim.vehicle_make, claim.vehicle_model].filter(Boolean).join(' ') || '—')}
        {f('Driver at the time', (
          <select
            value={claim.driver_id || ''}
            onChange={(e) => patch({ driver_id: e.target.value || null }, 'Driver updated.')}
            className="w-full border border-slate-200 rounded px-2 py-1 text-sm"
          >
            <option value="">— not identified yet —</option>
            {claim.driver_id && !claim.drivers.some((d) => d.driver_id === claim.driver_id) && (
              <option value={claim.driver_id}>{claim.driver_name || 'Current driver'}</option>
            )}
            {claim.drivers.map((d) => <option key={d.driver_id} value={d.driver_id}>{d.full_name}</option>)}
          </select>
        ))}
        {f('Driver declaration', claim.driver_signed_at
          ? <span className="text-green-700">✍️ Signed by {claim.driver_signed_name} on {fmtClaimDate(claim.driver_signed_at)}</span>
          : <span className="text-slate-400">not signed yet</span>)}
        {f('We were notified on', (
          <input
            type="date"
            value={claim.notified_on || ''}
            onChange={(e) => e.target.value && patch({ notified_on: e.target.value })}
            className="border border-slate-200 rounded px-2 py-1 text-sm"
          />
        ))}
        {f('How we heard', (
          <select
            value={claim.notified_via || ''}
            onChange={(e) => patch({ notified_via: e.target.value || null }, 'Saved.')}
            className="w-full border border-slate-200 rounded px-2 py-1 text-sm"
          >
            <option value="">— not set —</option>
            {claim.notified_via && !NOTIFIED_VIA_LABEL[claim.notified_via] && <option value={claim.notified_via}>{claim.notified_via}</option>}
            {Object.entries(NOTIFIED_VIA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        ))}
        {f('Boswell ref (broker)', <InlineText value={claim.broker_ref} onSave={(v) => patch({ broker_ref: v }, 'Boswell ref saved.')} placeholder="—" />)}
        {f('Markerstudy ref (insurer)', <InlineText value={claim.insurer_ref} onSave={(v) => patch({ insurer_ref: v }, 'Markerstudy ref saved.')} placeholder="—" />)}
        {f('Docs sent to Boswells', (
          <input
            type="date"
            value={claim.broker_sent_at ? claim.broker_sent_at.slice(0, 10) : ''}
            onChange={(e) => patch({ broker_sent_on: e.target.value || null })}
            className="border border-slate-200 rounded px-2 py-1 text-sm"
          />
        ))}
        {f('Estimated van value (ex-VAT)', claim.value_estimate
          ? <>£{claim.value_estimate.value_ex_vat.toLocaleString('en-GB')} <span className="text-xs text-slate-400">(to nearest £{claim.value_estimate.rounded_to})</span></>
          : <span className="text-slate-400">no purchase price / first-registration date on the van</span>)}
      </dl>
    </Card>
  );
}

// ── The form (staff-entered in Phase 1) ─────────────────────────────────────

function FormCard({ claim, onSaved }: { claim: Claim; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState<FormData>(() => JSON.parse(JSON.stringify(claim.form_data || {})));
  // Top-level keys staff have edited since the last save. Only these are sent,
  // so a client saving other parts through their link at the same time keeps them.
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const dirty = changed.size > 0;
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const touch = (key: string) => setChanged((c) => (c.has(key) ? c : new Set(c).add(key)));

  // The page reloads the case after any save (ours or a card's) — take the
  // server's copy of every part staff aren't in the middle of editing.
  useEffect(() => {
    setForm((prev) => {
      const next: FormData = JSON.parse(JSON.stringify(claim.form_data || {}));
      changed.forEach((k) => { if (k in prev) next[k] = prev[k]; });
      return next;
    });
  }, [claim.form_data]); // eslint-disable-line react-hooks/exhaustive-deps

  const sectionRow = (key: string): Row => {
    const v = form[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
  };
  const listRows = (key: string): Row[] => (Array.isArray(form[key]) ? (form[key] as Row[]) : []);
  const setSectionField = (section: string, key: string, v: unknown) => {
    setForm((f) => ({ ...f, [section]: { ...(f[section] && typeof f[section] === 'object' ? (f[section] as Row) : {}), [key]: v } }));
    touch(section);
  };
  const setList = (section: string, rows: Row[]) => { setForm((f) => ({ ...f, [section]: rows })); touch(section); };
  const setTop = (key: string, v: unknown) => { setForm((f) => ({ ...f, [key]: v })); touch(key); };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const patch: FormData = {};
      changed.forEach((k) => { patch[k] = form[k] ?? null; });
      await api.patch(`/claims/${claim.id}`, { form_data: patch });
      setChanged(new Set());
      onSaved('Form saved.');
    } catch (e) {
      setError(errMsg(e, 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const decl = claim.hire_form_declarations;
  const hireHint = (v: boolean | undefined) => (v === undefined ? undefined : `hire form: ${v ? 'Yes' : 'No'}`);
  const driverHints: Record<string, string> = {};
  if (decl) {
    driverHints.decl_accidents = hireHint(decl.accidents)!;
    driverHints.decl_convictions = `${hireHint(decl.convictions)}${decl.licence_points ? ` (${decl.licence_points} pts on licence)` : ''}`;
    driverHints.decl_disability = hireHint(decl.disability)!;
  }

  const summary = (s: ClaimSectionDef): string => {
    let text: string;
    if (s.list) {
      const n = listRows(s.key).length;
      text = n ? `${n} ${s.list.itemLabel.toLowerCase()}${n === 1 ? '' : 's'}` : s.gate && form[`${s.key}_involved`] === false ? 'none' : '—';
    } else {
      const row = sectionRow(s.key);
      const filled = s.fields.filter((f) => isFieldShown(f, row) && row[f.key] != null && row[f.key] !== '').length;
      text = filled ? `${filled} answered` : '—';
    }
    // What the client form would still ask for (staff sections have no required fields).
    const needed = s.who === 'staff' ? 0 : sectionMissing(s, form).length;
    return needed && text !== '—' ? `${text} · ${needed} still needed` : text;
  };

  return (
    <Card
      title="Claim form"
      right={
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          <button type="button" onClick={save} disabled={!dirty || saving} className="px-3 py-1.5 text-xs rounded bg-ooosh-600 text-white disabled:opacity-40">
            {saving ? 'Saving…' : 'Save form'}
          </button>
        </div>
      }
    >
      <p className="text-xs text-slate-500 mb-3">
        The broker's questions — filled in by the client through their link, or by staff from a phone call; either can edit.
        Insured details come from Settings › Claims, and the driver's name, date of birth, address and licence from their hire form — only the broker PDF puts them together.
      </p>
      {claim.stage === 'form_out' && (
        <div className="text-xs mb-3 px-3 py-2 rounded bg-blue-50 text-blue-800 border border-blue-200">
          The client has this form and can see and change the parts they fill in. Saving here only changes the parts you edited.
        </div>
      )}
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}
      <div className="divide-y border rounded">
        {CLAIM_SECTIONS.map((s) => (
          <div key={s.key}>
            <button
              type="button"
              onClick={() => setOpen(open === s.key ? null : s.key)}
              className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
            >
              <span className="text-sm font-medium text-slate-700">
                {s.title}
                {s.who === 'staff' && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">Ooosh only</span>}
              </span>
              <span className="text-xs text-slate-400">{summary(s)} {open === s.key ? '▲' : '▼'}</span>
            </button>
            {open === s.key && (
              <div className="px-3 pb-4 pt-1">
                {s.hint && <p className="text-xs text-slate-500 mb-2">{s.hint}</p>}
                {s.key === 'driver' && !claim.driver_id && (
                  <p className="text-xs text-amber-700 mb-2">Pick the driver in Case details first — their hire-form answers then show here as hints.</p>
                )}
                {s.list ? (
                  <ListEditor
                    section={s}
                    rows={listRows(s.key)}
                    gate={s.gate ? form[`${s.key}_involved`] : undefined}
                    onGate={(v) => setTop(`${s.key}_involved`, v)}
                    onChange={(rows) => setList(s.key, rows)}
                  />
                ) : (
                  <FieldsGrid
                    fields={s.fields}
                    row={sectionRow(s.key)}
                    onChange={(k, v) => setSectionField(s.key, k, v)}
                    hints={s.key === 'driver' ? driverHints : undefined}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Client links (Phase 2) ───────────────────────────────────────────────

const LINK_STATUS: Record<string, string> = {
  sent: 'Sent', opened: 'Opened', handed_off: 'Passed on', submitted: 'Submitted', revoked: 'Switched off',
};

interface Recipients {
  drivers: Array<{ driver_id: string; name: string; email: string | null }>;
  contacts: Array<{ person_id: string; name: string; email: string; role: string | null; org: string | null; is_primary: boolean }>;
}

/** Pick who gets the form — opened from the top bar or the Client form card. */
function SendFormPanel({ claim, onClose, onSent }: { claim: Claim; onClose: () => void; onSent: (msg: string) => void }) {
  const [rec, setRec] = useState<Recipients | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [extraName, setExtraName] = useState('');
  const [extraEmail, setExtraEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get<{ data: Recipients }>(`/claims/${claim.id}/recipients`)
      .then((r) => {
        if (!alive) return;
        setRec(r.data);
        // Pre-tick every driver on the van with an email, and the lead contact (spec §3 step 4) —
        // but not people who already have a link.
        const already = new Set(claim.links.filter((l) => l.status !== 'revoked').map((l) => (l.recipient_email || '').toLowerCase()));
        const t = new Set<string>();
        r.data.drivers.filter((d) => d.email && !already.has(d.email.toLowerCase())).forEach((d) => t.add(`d:${d.driver_id}`));
        const lead = r.data.contacts.find((c) => c.is_primary) || r.data.contacts[0];
        if (lead && !already.has(lead.email.toLowerCase())) t.add(`p:${lead.person_id}`);
        setTicked(t);
      })
      .catch(() => { if (alive) setError('Could not load who to send it to'); });
    return () => { alive = false; };
  }, [claim.id, claim.links]);

  const toggle = (k: string) => setTicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const extraOk = !extraEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extraEmail.trim());
  const send = async () => {
    const recipients: Row[] = [];
    ticked.forEach((k) => {
      if (k.startsWith('d:')) recipients.push({ driver_id: k.slice(2) });
      if (k.startsWith('p:')) recipients.push({ person_id: k.slice(2) });
    });
    if (extraEmail.trim()) {
      if (!extraOk) { setError("That email address doesn't look right"); return; }
      recipients.push({ name: extraName.trim() || undefined, email: extraEmail.trim() });
    }
    if (!recipients.length) { setError('Tick someone, or type a name and email under "Someone else"'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post<{ data: { results: Array<{ name: string; sent: boolean; error?: string }> } }>(`/claims/${claim.id}/links`, { recipients });
      const failed = r.data.results.filter((x) => !x.sent);
      onSent(failed.length
        ? `Sent to ${r.data.results.length - failed.length}; not sent: ${failed.map((f) => `${f.name} (${f.error || 'failed'})`).join(', ')}`
        : `Form sent to ${r.data.results.map((x) => x.name).join(', ')}.`);
    } catch (e) { setError(errMsg(e, 'Send failed')); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-lg border-2 border-ooosh-300 p-4 mt-3 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Send the incident form</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Each person gets their own link, can pass it on, and it saves as they go. Only driver NAMES are shown on it —
          the driver confirms who they are with a code emailed to the address on their hire form.
        </p>
      </div>
      {!rec ? <div className="text-xs text-slate-400">{error || 'Loading…'}</div> : (
        <>
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Drivers on this van</div>
            {rec.drivers.length === 0 && <div className="text-xs text-slate-400">No drivers found on this van and hire — use "Someone else" below.</div>}
            {rec.drivers.map((d) => (
              <label key={d.driver_id} className="flex items-center gap-2 text-sm py-0.5">
                <input type="checkbox" disabled={!d.email} checked={ticked.has(`d:${d.driver_id}`)} onChange={() => toggle(`d:${d.driver_id}`)} />
                {d.name} <span className="text-xs text-slate-400">{d.email || 'no email on file'}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Job contacts</div>
            {rec.contacts.length === 0 && <div className="text-xs text-slate-400">No contacts with an email on this job.</div>}
            {rec.contacts.map((c) => (
              <label key={c.person_id} className="flex items-center gap-2 text-sm py-0.5">
                <input type="checkbox" checked={ticked.has(`p:${c.person_id}`)} onChange={() => toggle(`p:${c.person_id}`)} />
                {c.name} <span className="text-xs text-slate-400">{[c.role, c.org, c.email].filter(Boolean).join(' · ')}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Someone else</div>
            <div className="flex flex-wrap gap-2">
              <input value={extraName} onChange={(e) => setExtraName(e.target.value)} placeholder="Name" className="border rounded px-2 py-1.5 text-sm w-48" />
              <input type="email" value={extraEmail} onChange={(e) => setExtraEmail(e.target.value)} placeholder="Email address"
                className={`border rounded px-2 py-1.5 text-sm flex-1 min-w-[14rem] ${extraOk ? '' : 'border-red-400'}`} />
            </div>
          </div>
        </>
      )}
      {error && rec && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border">Cancel</button>
        <button type="button" onClick={send} disabled={busy || !rec} className="px-4 py-1.5 text-sm rounded bg-ooosh-600 text-white disabled:opacity-50">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ClientLinksCard({ claim, onChange, onSend }: { claim: Claim; onChange: (msg?: string) => void; onSend: () => void }) {
  const [error, setError] = useState('');
  const canSend = claim.stage === 'open' || claim.stage === 'form_out';

  const act = async (l: ClaimLink, what: 'resend' | 'revoke') => {
    if (what === 'revoke' && !confirm(`Switch off ${l.recipient_name || l.recipient_email}'s link? They won't be able to open the form.`)) return;
    try { await api.post(`/claims/${claim.id}/links/${l.id}/${what}`, {}); onChange(what === 'resend' ? 'Link re-sent.' : 'Link switched off.'); } catch (e) { setError(errMsg(e, 'Failed')); }
  };

  return (
    <Card
      title="Client form"
      right={canSend ? <button type="button" onClick={onSend} className="px-3 py-1.5 text-xs rounded bg-ooosh-600 text-white">{claim.links.length ? '+ Send to someone else' : 'Send form'}</button> : undefined}
    >
      {claim.links.length === 0 && (
        <p className="text-xs text-slate-500">
          Nobody has the form yet — use <strong>Send form</strong> (also at the top of the page) to email it to the driver, the client, or anyone else.
        </p>
      )}
      {claim.links.length > 0 && (
        <ul className="divide-y text-sm mb-2">
          {claim.links.map((l) => (
            <li key={l.id} className="py-2 flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-800">{l.recipient_name || l.recipient_email}</span>
              <span className="text-xs text-slate-400">{l.role === 'driver' ? 'driver' : l.role === 'forwarded' ? 'passed on to them' : 'contact'}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${l.status === 'submitted' ? 'bg-green-100 text-green-700' : l.status === 'revoked' ? 'bg-slate-100 text-slate-500' : l.status === 'opened' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>
                {LINK_STATUS[l.status] || l.status}
              </span>
              {l.filled_by_name && <span className="text-xs text-slate-500">filled in by {l.filled_by_name}{l.filled_as === 'driver' ? ' (driver)' : ''}</span>}
              <span className="text-[11px] text-slate-400">
                {l.sent_at ? `sent ${fmtClaimDate(l.sent_at)}` : 'not sent'}{l.last_opened_at ? ` · last opened ${new Date(l.last_opened_at).toLocaleString('en-GB')}` : ''}
              </span>
              {canSend && l.status !== 'revoked' && (
                <span className="ml-auto flex gap-2">
                  <button type="button" onClick={() => act(l, 'resend')} className="text-xs text-ooosh-700 hover:underline">Resend</button>
                  <button type="button" onClick={() => act(l, 'revoke')} className="text-xs text-slate-400 hover:text-red-600">Switch off</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </Card>
  );
}

// ── Damage outline + sketch ────────────────────────────────────────────────

function SketchImage({ keyName }: { keyName: string }) {
  const { ref, url, failed } = useAuthedFileUrl(keyName);
  return url
    ? <img ref={ref} src={url} alt="Sketch" className="w-full border rounded cursor-pointer" onClick={() => openR2Key(keyName, 'sketch.png').catch(() => undefined)} />
    : <div ref={ref} className="h-40 border rounded bg-slate-50 flex items-center justify-center text-xs text-slate-400">{failed ? "Couldn't load the sketch" : 'Loading sketch…'}</div>;
}

function DamageCard({ claim, onChange }: { claim: Claim; onChange: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uploadSketch = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      try {
        const { blob } = await compressImageWithThumb(file, 2000, 0.85, 0);
        fd.append('file', blob, 'sketch.jpg');
      } catch { fd.append('file', file, file.name); }
      await api.upload(`/claims/${claim.id}/sketch`, fd);
      onChange();
    } catch (err) { setError(errMsg(err, 'Upload failed')); } finally { setBusy(false); }
  };
  return (
    <Card title="Damage marks & sketch">
      <p className="text-xs text-slate-500 mb-2">
        Crosses for damage, arrows for the point of impact — what the client marked, or mark it yourself. Printed in the broker PDF.
        The drawing is the {claim.outline.replace('_', ' ')} outline; change the van&apos;s outline on its vehicle page if it&apos;s wrong.
      </p>
      <DamageOutlineEditor
        type={claim.outline}
        initial={claim.damage_marks || []}
        onSave={async (marks, png) => { await api.put(`/claims/${claim.id}/damage`, { marks, png_base64: png }); onChange(); }}
      />
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-slate-600">Sketch of the scene</span>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="text-xs text-ooosh-700 hover:underline">
            {busy ? 'Uploading…' : claim.sketch_key ? 'Replace with a photo / image' : 'Add a photo of a sketch'}
          </button>
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={uploadSketch} />
        </div>
        {claim.sketch_key ? <SketchImage keyName={claim.sketch_key} /> : <div className="text-xs text-slate-400 italic">No sketch yet — the client draws one on the form.</div>}
      </div>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </Card>
  );
}

// ── Files ──────────────────────────────────────────────────────────────────

function FileThumb({ f }: { f: ClaimFile }) {
  const isImage = (f.content_type || '').startsWith('image/');
  const { ref, url } = useAuthedFileUrl(f.thumb_r2_key || f.r2_key, { enabled: isImage });
  return (
    <button
      type="button"
      onClick={() => openR2Key(f.r2_key, f.filename).catch(() => undefined)}
      className="w-20 h-16 shrink-0 rounded border bg-slate-100 overflow-hidden flex items-center justify-center text-xl"
      title="Open"
    >
      {isImage && url ? <img ref={ref} src={url} alt="" className="w-full h-full object-cover" /> : <span ref={ref}>{isImage ? '🖼' : '📄'}</span>}
    </button>
  );
}

function FilesCard({ claim, isManager, onChange }: { claim: Claim; isManager: boolean; onChange: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadType, setUploadType] = useState('photo');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);   // capture BEFORE the reset
    e.target.value = '';
    if (!files.length) return;
    setError('');
    let done = 0;
    for (const file of files) {
      setBusy(`Uploading ${done + 1} of ${files.length}…`);
      const fd = new FormData();
      let body: Blob = file;
      let name = file.name;
      if (file.type.startsWith('image/')) {
        // Compress + a small thumbnail for the broker PDF, in one decode.
        // A format the browser can't decode (some HEIC) goes up as-is.
        try {
          const { blob, pdfBase64 } = await compressImageWithThumb(file, 2048, 0.85, 400, 0.7);
          body = blob;
          name = name.replace(/\.[^.]+$/, '') + '.jpg';
          if (pdfBase64) fd.append('thumb', await (await fetch(pdfBase64)).blob(), 'thumb.jpg');
        } catch { /* upload the original */ }
      }
      fd.append('file', body, name);
      const type = file.type.startsWith('image/') ? 'photo' : uploadType === 'photo' ? 'other' : uploadType;
      fd.append('file_type', type);
      fd.append('share_with_insurer', SHARED_BY_DEFAULT.has(type) ? 'true' : 'false');
      try {
        await api.upload(`/claims/${claim.id}/files`, fd);
        done++;
      } catch (err) {
        setError(errMsg(err, `Upload failed for ${file.name}`));
      }
    }
    setBusy('');
    onChange();
  };

  const edit = async (f: ClaimFile, body: Row) => {
    try { await api.patch(`/claims/${claim.id}/files/${f.id}`, body); onChange(); } catch (e) { setError(errMsg(e, 'Save failed')); }
  };
  const remove = async (f: ClaimFile) => {
    if (!confirm(`Remove ${f.filename} from the case?`)) return;
    try { await api.delete(`/claims/${claim.id}/files/${f.id}`); onChange(); } catch (e) { setError(errMsg(e, 'Delete failed')); }
  };

  return (
    <Card
      title={`Files (${claim.files.length})`}
      right={
        <div className="flex items-center gap-2">
          <select value={uploadType} onChange={(e) => setUploadType(e.target.value)} className="border rounded px-2 py-1 text-xs" title="Type for non-photo files">
            {Object.entries(FILE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={!!busy} className="px-3 py-1.5 text-xs rounded bg-ooosh-600 text-white disabled:opacity-50">
            {busy || '+ Add files'}
          </button>
          <input ref={inputRef} type="file" multiple accept="image/*,application/pdf,.doc,.docx,.eml,.msg" className="hidden" onChange={onFiles} />
        </div>
      }
    >
      <p className="text-xs text-slate-500 mb-2">
        Photos, police reports, TTS360 notices, broker letters, repair quotes. Only files ticked <em>Share with insurers</em> go
        to the broker: photos as thumbnails in the PDF, documents attached to the email. Photos, police reports and repair
        quotes start ticked; everything else starts private.
      </p>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}
      {claim.files.length === 0 ? (
        <div className="text-xs text-slate-400 italic">No files yet.</div>
      ) : (
        <div className="space-y-2">
          {claim.files.map((f) => (
            <div key={f.id} className="flex items-start gap-3 border rounded p-2">
              <FileThumb f={f} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="text-sm text-slate-800 truncate">{f.filename}</div>
                <div className="flex flex-wrap items-center gap-2">
                  {f.file_type === 'gps_trace' ? (
                    // Saved by the GPS card — not a type staff pick, so no select.
                    <span className="border rounded px-1.5 py-0.5 text-xs bg-slate-50 text-slate-600">GPS trace</span>
                  ) : (
                    <select value={f.file_type} onChange={(e) => edit(f, { file_type: e.target.value })} className="border rounded px-1.5 py-0.5 text-xs">
                      {Object.entries(FILE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  )}
                  <label className="flex items-center gap-1 text-xs text-slate-700" title="Shared files go to the broker: photos in the PDF, documents attached to the email">
                    <input type="checkbox" checked={f.share_with_insurer} onChange={(e) => edit(f, { share_with_insurer: e.target.checked })} />
                    Share with insurers
                  </label>
                  <span className="text-[11px] text-slate-400">{fmtClaimDate(f.uploaded_at)}{f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ''}</span>
                </div>
                <InlineText value={f.caption} onSave={(v) => edit(f, { caption: v })} placeholder="Caption (shows in the broker PDF)" />
              </div>
              {isManager && (
                <button type="button" onClick={() => remove(f)} className="text-xs text-red-600 hover:underline shrink-0">Remove</button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Timeline: updates, milestones, events ───────────────────────────────────

const EVENT_ICON: Record<string, string> = {
  created: '🆕', comment: '💬', stage_change: '➡️', milestone: '📍', next_check: '📅',
  problem_linked: '🔗', problem_unlinked: '✂️', file_added: '📎', file_removed: '🗑', ref_recorded: '🔖',
  complication: '⚠️', owner_change: '👤', driver_set: '🧑', form_saved: '📝', broker_sent: '📤',
  broker_send_failed: '❌', policyholder_signed: '✍️', notified_via: '📞', file_sharing: '🔓',
  form_sent: '📧', link_opened: '👀', link_revoked: '🚫', who_filling: '🙋', handed_off: '↪️', sent_to_driver: '📧',
  section_saved: '✅', driver_verified: '🔐', driver_signed: '✍️', damage_marked: '❌', sketch_saved: '✏️',
  chase_sent: '⏰', chase_escalated: '🚩', chase_paused: '⏸', chase_restarted: '🔁', gps_saved: '📍', sms_sent: '📱',
};

function TimelineCard({ claim, onChange }: { claim: Claim; onChange: () => void }) {
  const [note, setNote] = useState('');
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  // The shared composer needs an attachments hook; case files go through the
  // Files card instead (kept under the private claims/ prefix), so anything
  // pasted here is refused at submit rather than silently dropped.
  const attach = useAttachments();
  const [next, setNext] = useState<string>(claim.next_check_on && claim.next_check_on > ukDatePlus(0) ? claim.next_check_on : ukDatePlus(14));
  const [mKind, setMKind] = useState('processed');
  const [mDate, setMDate] = useState(ukDatePlus(0));
  const [mNote, setMNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsDate = claim.stage !== 'closed' && claim.stage !== 'form_out';

  const logUpdate = async () => {
    if (!note.trim()) return;
    if (attach.pending.length > 0) {
      setError('Add files in the Files card above - they stay private to the case there. Remove the attachment here to post.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/claims/${claim.id}/updates`, {
        note: note.trim(),
        mentioned_user_ids: mentionedIds,
        ...(needsDate ? { next_check_on: next || null } : {}),
      });
      setNote('');
      setMentionedIds([]);
      onChange();
    } catch (e) {
      setError(errMsg(e, 'Could not log the update'));
    } finally {
      setBusy(false);
    }
  };
  const addMilestone = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/claims/${claim.id}/milestones`, { kind: mKind, date: mDate, note: mNote.trim() || undefined });
      setMNote('');
      onChange();
    } catch (e) {
      setError(errMsg(e, 'Could not add the milestone'));
    } finally {
      setBusy(false);
    }
  };

  const milestones = claim.events.filter((e) => e.event_type === 'milestone');

  return (
    <Card title="Updates & timeline">
      <div className="space-y-2 mb-4">
        <MentionComposer
          value={note}
          onChange={setNote}
          mentionedIds={mentionedIds}
          onMentionedIdsChange={setMentionedIds}
          attach={attach}
          rows={2}
          placeholder="Log an update — a call, an email from the broker, what's next… (type @ to mention someone)"
        />
        <div className="flex flex-wrap items-center gap-2">
          {needsDate && (
            <>
              <span className="text-xs text-slate-600">When should we next check on this?</span>
              <input type="date" value={next} onChange={(e) => setNext(e.target.value)} className="border rounded px-2 py-1 text-xs" />
              {[7, 14, 30].map((d) => (
                <button key={d} type="button" onClick={() => setNext(ukDatePlus(d))} className="px-2 py-0.5 text-xs rounded border">+{d}d</button>
              ))}
            </>
          )}
          <button type="button" onClick={logUpdate} disabled={busy || !note.trim()} className="ml-auto px-3 py-1.5 text-xs rounded bg-ooosh-600 text-white disabled:opacity-40">Log update</button>
        </div>
      </div>

      <div className="border rounded p-3 mb-4 bg-slate-50/50">
        <div className="text-xs font-semibold text-slate-600 mb-2">Milestones</div>
        <ul className="text-sm space-y-1 mb-2">
          <li>📍 {fmtClaimDate(claim.notified_on)} — we were notified</li>
          {claim.broker_sent_at && <li>📍 {fmtClaimDate(claim.broker_sent_at)} — docs sent to Boswells</li>}
          {milestones.filter((m) => (m.metadata?.kind as string) !== 'broker_sent' && (m.metadata?.kind as string) !== 'notified').map((m) => (
            <li key={m.id}>📍 {fmtClaimDate(m.event_date)} — {m.body}</li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select value={mKind} onChange={(e) => setMKind(e.target.value)} className="border rounded px-2 py-1 text-xs">
            <option value="processed">Claim processed / approved</option>
            <option value="repair_booked">Repair booked</option>
            <option value="other">Other</option>
          </select>
          <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          <input value={mNote} onChange={(e) => setMNote(e.target.value)} placeholder="Note" className="flex-1 min-w-[8rem] border rounded px-2 py-1 text-xs" />
          <button type="button" onClick={addMilestone} disabled={busy || !mDate} className="px-3 py-1 text-xs rounded border">Add</button>
        </div>
      </div>

      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}
      <ul className="space-y-2">
        {claim.events.map((e) => (
          <li key={e.id} className="text-sm flex gap-2">
            <span className="w-5 shrink-0">{EVENT_ICON[e.event_type] || '•'}</span>
            <div className="min-w-0">
              <div className="text-slate-800 whitespace-pre-wrap break-words">
                {e.body ? <LinkifiedText text={e.body} /> : e.event_type.replace(/_/g, ' ')}
                {e.event_date && e.event_type === 'milestone' ? <span className="text-slate-500"> ({fmtClaimDate(e.event_date)})</span> : null}
              </div>
              <div className="text-[11px] text-slate-400">
                {new Date(e.created_at).toLocaleString('en-GB')}{e.created_by_name ? ` · ${e.created_by_name}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Right column ─────────────────────────────────────────────────────────

function NextCheckCard({ claim, users, patch }: { claim: Claim; users: StaffUser[]; patch: (b: Row, m?: string) => Promise<void> }) {
  if (claim.stage === 'closed') return null;
  return (
    <Card title="Keeping it moving">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs text-slate-600">Owner</span>
          <select
            value={claim.owner_user_id || ''}
            onChange={(e) => patch({ owner_user_id: e.target.value || null }, 'Owner updated.')}
            className="mt-1 w-full border rounded px-2 py-1 text-sm"
          >
            <option value="">— nobody —</option>
            {claim.owner_user_id && !users.some((u) => u.id === claim.owner_user_id) && (
              <option value={claim.owner_user_id}>{claim.owner_name || 'Current owner'}</option>
            )}
            {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
        </label>
        <div>
          <span className="text-xs text-slate-600">Next check</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={claim.next_check_on || ''}
              onChange={(e) => patch({ next_check_on: e.target.value || null }, 'Next check date set.')}
              className="border rounded px-2 py-1 text-sm"
            />
            {[7, 14, 30].map((d) => (
              <button key={d} type="button" onClick={() => patch({ next_check_on: ukDatePlus(d) }, 'Next check date set.')} className="px-2 py-0.5 text-xs rounded border">+{d}d</button>
            ))}
          </div>
          <div className="text-xs mt-1"><NextCheckCell row={claim} /></div>
          <p className="text-[11px] text-slate-400 mt-1">The owner gets a bell on this date. Overdue or blank shows on the dashboard.</p>
        </div>
      </div>
    </Card>
  );
}

function ComplicationsCard({ claim, patch }: { claim: Claim; patch: (b: Row, m?: string) => Promise<void> }) {
  const item = (flag: 'third_party_claim' | 'liability_dispute', label: string, help: string) => {
    const on = claim[flag];
    const notesKey = `${flag}_notes` as 'third_party_claim_notes' | 'liability_dispute_notes';
    return (
      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={on} onChange={(e) => patch({ [flag]: e.target.checked })} className="mt-1" />
          <span>
            {label}
            <span className="block text-[11px] text-slate-400">{help}</span>
          </span>
        </label>
        {on && <InlineText value={claim[notesKey]} onSave={(v) => patch({ [notesKey]: v })} placeholder="Notes" />}
      </div>
    );
  };
  return (
    <Card title="Complications">
      <div className="space-y-3">
        {item('third_party_claim', 'Third-party claim against our policy', 'Someone else is claiming — our driver may be at fault.')}
        {item('liability_dispute', 'Dispute over who pays for repairs', 'Usually with the hirer, over the excess.')}
      </div>
    </Card>
  );
}

function ProblemsCard({ claim, onChange }: { claim: Claim; onChange: () => void }) {
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ id: string; summary: string; category: string; hh_job_number: number | null }>>([]);
  const [error, setError] = useState('');

  const openPicker = async () => {
    setPicking(true);
    try {
      const r = await api.get<{ data: typeof candidates }>(`/claims/${claim.id}/linkable-problems`);
      setCandidates(r.data);
    } catch { setCandidates([]); }
  };
  const link = async (issueId: string) => {
    try { await api.post(`/claims/${claim.id}/problems`, { issue_id: issueId }); setPicking(false); onChange(); } catch (e) { setError(errMsg(e, 'Could not link')); }
  };
  const unlink = async (issueId: string) => {
    if (!confirm('Take this Problem off the claim? (The Problem itself stays.)')) return;
    try { await api.delete(`/claims/${claim.id}/problems/${issueId}`); onChange(); } catch (e) { setError(errMsg(e, 'Could not unlink')); }
  };

  return (
    <Card title={`Problems (${claim.problems.length})`} right={<button type="button" onClick={openPicker} className="text-xs text-ooosh-600 hover:underline">+ Link</button>}>
      <p className="text-[11px] text-slate-400 mb-2">The damage and its repair (quotes, TTS360) stay on each Problem.</p>
      <ul className="space-y-1.5">
        {claim.problems.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-2 text-sm">
            <Link to={`/operations/problems/${p.id}`} className="text-slate-800 hover:underline min-w-0">
              {p.summary}
              <span className="block text-[11px] text-slate-400">{p.category} · {p.status.replace(/_/g, ' ')}</span>
            </Link>
            {p.id !== claim.origin_issue_id && (
              <button type="button" onClick={() => unlink(p.id)} className="text-[11px] text-slate-400 hover:text-red-600 shrink-0">remove</button>
            )}
          </li>
        ))}
      </ul>
      {picking && (
        <div className="mt-3 border-t pt-2">
          {candidates.length === 0 ? (
            <div className="text-xs text-slate-400">No other Problems on this van or hire to link.</div>
          ) : (
            <ul className="space-y-1">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => link(c.id)} className="text-left text-xs text-ooosh-700 hover:underline">
                    + {c.summary} <span className="text-slate-400">({c.category}{c.hh_job_number ? ` · #${c.hh_job_number}` : ''})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setPicking(false)} className="mt-2 text-xs text-slate-500">Close</button>
        </div>
      )}
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </Card>
  );
}

function DocumentsCard({ claim }: { claim: Claim }) {
  const [error, setError] = useState('');
  // Until the driver is identified, show everyone on the van (spec §13).
  const shown = claim.driver_id ? claim.drivers.filter((d) => d.driver_id === claim.driver_id) : claim.drivers;
  return (
    <Card title="Linked documents">
      <ul className="space-y-2 text-sm">
        {claim.vehicle_id && claim.hh_job_number && (
          <li>
            <Link to={`/vehicles/fleet/${claim.vehicle_id}/hire/${claim.hh_job_number}`} className="text-ooosh-700 hover:underline">
              Book-out & check-in record (condition reports, photos)
            </Link>
          </li>
        )}
        {shown.map((d) => (
          <li key={d.driver_id} className="space-y-0.5">
            <div className="font-medium text-slate-700">{d.full_name}</div>
            <div className="flex flex-wrap gap-3 text-xs">
              <Link to={`/drivers/${d.driver_id}`} className="text-ooosh-700 hover:underline">Driver record & documents</Link>
              {d.has_hire_form ? (
                <button
                  type="button"
                  onClick={() => openAuthedFile(`/hire-forms/${d.assignment_id}/download`, 'hire-agreement.pdf').catch(() => setError('Could not open the hire form'))}
                  className="text-ooosh-700 hover:underline"
                >
                  Signed hire form
                </button>
              ) : <span className="text-slate-400">no hire form PDF</span>}
            </div>
          </li>
        ))}
        {!shown.length && !claim.vehicle_id && <li className="text-xs text-slate-400">Nothing linked yet — set the van and driver.</li>}
      </ul>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </Card>
  );
}

function BrokerCard({ claim, onDone }: { claim: Claim; onDone: (m: string) => void }) {
  const sigRef = useRef<SignatureCaptureHandle>(null);
  const [signing, setSigning] = useState(false);
  const [printName, setPrintName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const preview = () => openAuthedFile(`/claims/${claim.id}/pdf`, 'motor-claim.pdf').catch(() => setError('Could not build the PDF'));

  const sign = async () => {
    const blob = await sigRef.current?.getBlob();
    if (!blob || printName.trim().length < 2) { setError('Sign and print your name'); return; }
    setBusy(true);
    setError('');
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      await api.post(`/claims/${claim.id}/sign`, { signature_png_base64: b64, print_name: printName.trim() });
      setSigning(false);
      onDone('Signed as policyholder.');
    } catch (e) {
      setError(errMsg(e, 'Could not save the signature'));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!confirm('Email the claim PDF to the broker now? This is the point the broker hears about it.')) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/claims/${claim.id}/send-to-broker`, { note: note.trim() || undefined });
      onDone('Sent to the broker.');
    } catch (e) {
      setError(errMsg(e, 'Send failed — nothing was marked as sent'));
    } finally {
      setBusy(false);
    }
  };

  const canSend = ['submitted', 'reviewed'].includes(claim.stage) || (claim.stage === 'with_broker');

  return (
    <Card title="Broker (managers)">
      <div className="space-y-3 text-sm">
        <button type="button" onClick={preview} className="w-full px-3 py-1.5 text-xs rounded border">Preview broker PDF</button>

        <div>
          <div className="text-xs text-slate-600 mb-1">Policyholder signature</div>
          {claim.policyholder_signed_at ? (
            <div className="text-xs text-green-700">
              ✍️ Signed by {claim.policyholder_signed_name}{claim.policyholder_user_name ? ` (${claim.policyholder_user_name})` : ''} on {fmtClaimDate(claim.policyholder_signed_at)}
              <button type="button" onClick={() => setSigning(true)} className="ml-2 text-slate-500 underline">re-sign</button>
            </div>
          ) : !signing && (
            <button type="button" onClick={() => setSigning(true)} className="px-3 py-1.5 text-xs rounded border">Sign for Ooosh</button>
          )}
          {signing && (
            <div className="space-y-2 mt-2">
              <SignatureCapture ref={sigRef} label="Signature of policyholder" />
              <input value={printName} onChange={(e) => setPrintName(e.target.value)} placeholder="Print name" className="w-full border rounded px-2 py-1 text-sm" />
              <div className="flex gap-2">
                <button type="button" onClick={() => setSigning(false)} className="px-3 py-1 text-xs rounded border">Cancel</button>
                <button type="button" onClick={sign} disabled={busy} className="px-3 py-1 text-xs rounded bg-ooosh-600 text-white disabled:opacity-50">Save signature</button>
              </div>
            </div>
          )}
        </div>

        {canSend && (
          <div className="border-t pt-3 space-y-2">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note to the broker (optional)" className="w-full border rounded px-2 py-1 text-sm" />
            <button
              type="button"
              onClick={send}
              disabled={busy || !claim.policyholder_signed_at}
              className="w-full px-3 py-2 text-sm rounded bg-slate-800 text-white disabled:opacity-40"
              title={claim.policyholder_signed_at ? '' : 'Sign as policyholder first'}
            >
              {claim.stage === 'with_broker' ? 'Send an updated PDF to the broker' : 'Send to broker'}
            </button>
            <p className="text-[11px] text-slate-400">Nothing goes to the broker until this is pressed.</p>
          </div>
        )}
        {claim.broker_pdf_key && (
          <button type="button" onClick={() => openR2Key(claim.broker_pdf_key!, 'sent-claim.pdf').catch(() => setError('Could not open'))} className="text-xs text-ooosh-700 hover:underline">
            Open the PDF last sent
          </button>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </Card>
  );
}
