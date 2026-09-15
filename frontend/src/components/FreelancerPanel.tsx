import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import FreelancerHistorySection from './FreelancerHistorySection';

// ---------------------------------------------------------------------------
// FreelancerPanel — the single home for everything freelancer on a Person.
//
// Consolidates what used to be split across the generic Edit slide-panel and
// the Details tab: freelancer-specific data, approval status, renewal/review
// dates, required documents, and the assignment history/upcoming view. Only
// rendered from PersonDetailPage's "Freelancer" tab, which is itself only shown
// when the person is a freelancer in any state (pending / approved / removed).
// ---------------------------------------------------------------------------

interface FileAttachment {
  name: string;
  label?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
}

export interface FreelancerPerson {
  id: string;
  first_name: string;
  last_name: string;
  is_approved: boolean;
  freelancer_status: string | null;
  freelancer_joined_date: string | null;
  freelancer_next_review_date: string | null;
  skills: string[];
  is_insured_on_vehicles: boolean;
  has_tshirt: boolean;
  onboarding: Record<string, unknown> | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  licence_details: string | null;
  freelancer_references: string | null;
  portal_notifications_paused_until: string | null;
  files: FileAttachment[];
}

interface FreelancerPanelProps {
  person: FreelancerPerson;
  onChanged: () => void;
  onFilesChanged: (files: FileAttachment[]) => void;
  onActivityCreated: () => void;
  onInvite: () => void;
}

const PRESET_SKILLS = [
  'Sound Engineer', 'Lighting Engineer', 'Stage Manager', 'Backline Tech',
  'Monitor Engineer', 'FOH Engineer', 'Rigger', 'Tour Manager',
  'Production Manager', 'Driver', 'Truck Driver', 'Van Driver', 'Stage Hand',
  'Carpenter', 'Electrician', 'Video Tech', 'LED Tech', 'Follow Spot Operator',
  'Pyro Tech', 'SFX Tech', 'Wardrobe', 'Runner', 'Caterer', 'Security',
  'First Aider', 'Site Manager', 'Event Manager', 'Studio Sitter',
];

// Status descriptions — pairs with the pill so staff know what the state means
// and what the next action is.
const STATUS_DESCRIPTION: Record<string, string> = {
  approved: 'Cleared for assignment to jobs.',
  invited: 'Sign-up link sent — waiting for them to complete their application.',
  applied: 'Application submitted — review their details and documents, then approve or decline.',
  more_info: 'More information requested — waiting on the freelancer.',
  declined: 'Not cleared for hire.',
  pending: 'Not yet approved for assignment to jobs.',
};

interface InviteAudit {
  id: string;
  status: string;
  invited_at: string | null;
  submitted_at: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
}

interface FullApplication {
  id: string;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  decision_notes: string | null;
  submission: Record<string, unknown> | null;
  insurance_answers: Record<string, unknown> | null;
  references: Array<Record<string, unknown>> | null;
  invited_by_name: string | null;
  reviewed_by_name: string | null;
}

const REVIEWABLE = ['applied', 'more_info'];

export default function FreelancerPanel({ person, onChanged, onFilesChanged, onActivityCreated, onInvite }: FreelancerPanelProps) {
  const [editing, setEditing] = useState(false);
  const [invite, setInvite] = useState<InviteAudit | null>(null);
  const [application, setApplication] = useState<FullApplication | null>(null);

  const currentUser = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(currentUser?.role);

  // Who sent the sign-up invite, and when. Re-fetched when the person or their
  // freelancer status changes (e.g. after a re-invite opens a fresh application).
  useEffect(() => {
    let cancelled = false;
    api.get<{ data: InviteAudit | null }>(`/freelancers/by-person/${person.id}`)
      .then((r) => { if (!cancelled) setInvite(r.data); })
      .catch(() => { if (!cancelled) setInvite(null); });
    return () => { cancelled = true; };
  }, [person.id, person.freelancer_status]);

  // Full application (submission / insurance / references) for the review panel —
  // only fetched when there's a reviewable application to act on.
  const loadApplication = useCallback(() => {
    if (!invite?.id || !REVIEWABLE.includes(person.freelancer_status || '')) {
      setApplication(null);
      return;
    }
    let cancelled = false;
    api.get<{ data: FullApplication }>(`/freelancers/applications/${invite.id}`)
      .then((r) => { if (!cancelled) setApplication(r.data); })
      .catch(() => { if (!cancelled) setApplication(null); });
    return () => { cancelled = true; };
  }, [invite?.id, person.freelancer_status]);

  useEffect(() => { loadApplication(); }, [loadApplication]);

  const pill = freelancerStatusPill(person.freelancer_status, person.is_approved);
  const descriptionKey = person.is_approved ? 'approved' : (person.freelancer_status || 'pending');
  const description = STATUS_DESCRIPTION[descriptionKey] || STATUS_DESCRIPTION.pending;

  const reviewInfo = reviewDateInfo(person.freelancer_next_review_date);

  const pausedUntil = person.portal_notifications_paused_until ? new Date(person.portal_notifications_paused_until) : null;
  const portalPaused = pausedUntil && pausedUntil > new Date();
  const pausedLabel = portalPaused
    ? ((pausedUntil!.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000) > 5
        ? 'Portal notifications paused indefinitely'
        : `Portal notifications paused until ${pausedUntil!.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`)
    : null;

  return (
    <div className="space-y-6">
      {/* Status + approval */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${pill.cls}`}>{pill.label}</span>
              {reviewInfo && (
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${reviewInfo.cls}`}>{reviewInfo.label}</span>
              )}
              {portalPaused && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
                  <span aria-hidden="true">🔕</span>
                  <span>{pausedLabel}</span>
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-gray-500">{description}</p>
            {invite?.invited_at && (
              <p className="mt-1 text-xs text-gray-400">
                Invited{invite.invited_by_name ? ` by ${invite.invited_by_name}` : ''} on {fmtDateTime(invite.invited_at)}
                {invite.submitted_at ? ` · applied ${fmtDate(invite.submitted_at)}` : ''}
              </p>
            )}
          </div>
          {!person.is_approved && (
            <button
              onClick={onInvite}
              className="px-3 py-1.5 text-sm border border-purple-300 text-purple-700 rounded hover:bg-purple-50 transition-colors whitespace-nowrap"
            >
              {person.freelancer_status ? 'Re-send sign-up' : 'Invite to freelance'}
            </button>
          )}
        </div>
      </div>

      {/* Application review (only while there's a submitted / info-requested form) */}
      {REVIEWABLE.includes(person.freelancer_status || '') && application && (
        <ReviewPanel
          application={application}
          isManager={isManager}
          onDecided={() => { onChanged(); }}
        />
      )}

      {/* Onboarding checklist (once approved) */}
      {person.is_approved && (
        <OnboardingChecklist person={person} onChanged={onChanged} />
      )}

      {/* Freelancer details (read / edit) */}
      {editing ? (
        <FreelancerDetailsForm
          person={person}
          onCancel={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Freelancer Details</h3>
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              Edit details
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailField label="Joined Date" value={fmtDate(person.freelancer_joined_date)} />
            <DetailField label="Next Review Date" value={fmtDate(person.freelancer_next_review_date)} />
            <DetailField label="Skills" value={person.skills?.length ? person.skills.join(', ') : null} />
            <DetailField label="Licence" value={person.licence_details} />
            <DetailField label="Insured on Vehicles" value={person.is_insured_on_vehicles ? 'Yes' : 'No'} />
            <DetailField label="Approved" value={person.is_approved ? 'Yes' : 'No'} />
            <DetailField label="Has T-Shirt" value={person.has_tshirt ? 'Yes' : 'No'} />
            <DetailField label="Emergency Contact" value={person.emergency_contact_name} />
            <DetailField label="Emergency Phone" value={person.emergency_contact_phone} />
            {person.freelancer_references && (
              <div className="md:col-span-2">
                <DetailField label="References" value={person.freelancer_references} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Required documents */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <FreelancerDocuments
          personId={person.id}
          files={person.files || []}
          onFilesChanged={onFilesChanged}
          onActivityCreated={onActivityCreated}
        />
      </div>

      {/* Assignment history + upcoming */}
      <FreelancerHistorySection entityId={person.id} />
    </div>
  );
}

// ---- Application review panel --------------------------------------------

function ReviewPanel({ application, isManager, onDecided }: {
  application: FullApplication;
  isManager: boolean;
  onDecided: () => void;
}) {
  const [mode, setMode] = useState<null | 'decline' | 'request-info'>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const sub = application.submission || {};
  const lookingFor = Array.isArray(sub.looking_for) ? (sub.looking_for as string[]) : (sub.looking_for ? [String(sub.looking_for)] : []);
  const insurance = application.insurance_answers || {};
  const insuranceEntries = Object.entries(insurance).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const refs = Array.isArray(application.references) ? application.references : [];

  async function act(action: 'approve' | 'decline' | 'request-info', requireNotes: boolean) {
    if (requireNotes && !notes.trim()) { setError('Please add a note explaining what you need / why.'); return; }
    setBusy(action);
    setError('');
    try {
      await api.post(`/freelancers/applications/${application.id}/${action}`, { notes: notes.trim() || undefined });
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setBusy(null);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-amber-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Review application</h3>
        {application.submitted_at && (
          <span className="text-xs text-gray-400">Submitted {fmtDate(application.submitted_at)}</span>
        )}
      </div>

      {application.status === 'more_info' && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          More info was requested{application.decision_notes ? `: "${application.decision_notes}"` : ''} — waiting on the freelancer. You can still approve or decline now.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <ReviewField label="Looking for" value={lookingFor.length ? lookingFor.map(prettyLookingFor).join(', ') : null} />
        <ReviewField label="Eligible to work in UK" value={sub.eligible_to_work === true ? 'Confirmed' : (sub.eligible_to_work === false ? 'Not confirmed' : null)} />
        <ReviewField label="UTR" value={typeof sub.utr === 'string' ? sub.utr : null} />
        <ReviewField label="Expected day rate" value={typeof sub.expected_day_rate === 'string' ? sub.expected_day_rate : null} />
        {typeof sub.other_skill_detail === 'string' && sub.other_skill_detail && (
          <div className="md:col-span-2"><ReviewField label="Other skills" value={sub.other_skill_detail} /></div>
        )}
        {typeof sub.anything_else === 'string' && sub.anything_else && (
          <div className="md:col-span-2"><ReviewField label="Anything else" value={sub.anything_else} /></div>
        )}
      </div>

      {insuranceEntries.length > 0 && (
        <div className="mt-4 pt-4 border-t">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Insurance questionnaire</p>
          <ul className="space-y-1 text-sm text-gray-700">
            {insuranceEntries.map(([k, v]) => (
              <li key={k} className="flex gap-2">
                <span className="text-gray-500">{prettyKey(k)}:</span>
                <span className="font-medium">{String(v)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {refs.length > 0 && (
        <div className="mt-4 pt-4 border-t">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">References</p>
          <ul className="space-y-2 text-sm text-gray-700">
            {refs.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{String(r.name || '—')}</span>
                {r.company ? ` · ${String(r.company)}` : ''}{r.role ? ` (${String(r.role)})` : ''}
                {Boolean(r.email || r.phone) && (
                  <span className="text-gray-500"> — {[r.email, r.phone].filter(Boolean).map(String).join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        Full submitted details, documents and signature are in the Details / Documents sections below and the person's record.
      </p>

      {error && <div className="mt-3 bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

      {/* Decision */}
      <div className="mt-4 pt-4 border-t">
        {!isManager ? (
          <p className="text-sm text-gray-500">A manager needs to approve or decline this application.</p>
        ) : mode ? (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
              {mode === 'decline' ? 'Reason (shown to the freelancer if you email them)' : 'What do you need from them?'}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              autoFocus
              placeholder={mode === 'decline' ? 'Optional note…' : 'e.g. Please re-upload a clearer photo of your licence back.'}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y"
            />
            <div className="flex gap-2">
              <button
                onClick={() => act(mode === 'decline' ? 'decline' : 'request-info', mode === 'request-info')}
                disabled={!!busy}
                className={`px-4 py-1.5 text-sm rounded font-medium text-white disabled:opacity-50 ${mode === 'decline' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}`}
              >
                {busy ? 'Sending…' : mode === 'decline' ? 'Confirm decline + email' : 'Send request + email'}
              </button>
              <button onClick={() => { setMode(null); setNotes(''); setError(''); }} className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => act('approve', false)}
              disabled={!!busy}
              className="px-4 py-1.5 text-sm bg-green-600 text-white rounded font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {busy === 'approve' ? 'Approving…' : '✓ Approve'}
            </button>
            <button onClick={() => setMode('request-info')} className="px-4 py-1.5 text-sm border border-amber-300 text-amber-700 rounded hover:bg-amber-50">Request more info</button>
            <button onClick={() => setMode('decline')} className="px-4 py-1.5 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50">Decline</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-0.5 text-gray-900">{value || '—'}</dd>
    </div>
  );
}

function prettyLookingFor(v: string): string {
  const map: Record<string, string> = { local: 'Local work', uk: 'UK tours', uk_eu: 'UK & EU tours', any: "Whatever's going" };
  return map[v] || v;
}

function prettyKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Onboarding checklist -------------------------------------------------

function OnboardingChecklist({ person, onChanged }: { person: FreelancerPerson; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const onboarding = (person.onboarding || {}) as Record<string, unknown>;
  const jsonbDone = (key: string) => {
    const v = onboarding[key];
    return !!v && (v === true || (typeof v === 'object' && (v as { done?: boolean }).done === true));
  };

  async function toggle(key: string, value: boolean) {
    setBusy(key);
    setError('');
    try {
      await api.patch(`/freelancers/${person.id}/onboarding`, { [key]: value });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  }

  const items: { key: string; label: string; done: boolean; toggleKey?: string; note?: string }[] = [
    { key: 'approved', label: 'Reviewed & approved', done: true },
    { key: 'insured', label: 'Added to vehicle insurance', done: person.is_insured_on_vehicles, toggleKey: 'is_insured_on_vehicles' },
    { key: 'tshirt', label: 'T-shirt given', done: person.has_tshirt, toggleKey: 'has_tshirt' },
    { key: 'portal', label: 'Portal access sent', done: jsonbDone('portal_invite_sent'), toggleKey: 'portal_invite_sent', note: 'Send them the portal sign-up link' },
    { key: 'resources', label: 'Training / how-to docs shared', done: jsonbDone('resources_shared'), toggleKey: 'resources_shared' },
    { key: 'payments', label: 'Payments policy available', done: true, note: 'Covered by the T&Cs signed at application' },
  ];

  const completeCount = items.filter((i) => i.done).length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Onboarding checklist</h3>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${completeCount === items.length ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
          {completeCount}/{items.length} done
        </span>
      </div>
      {error && <div className="bg-red-50 text-red-700 px-3 py-1.5 rounded text-xs mb-2">{error}</div>}
      <ul className="space-y-2">
        {items.map((item) => {
          const toggleable = !!item.toggleKey && item.key !== 'approved' && item.key !== 'payments';
          return (
            <li key={item.key} className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={item.done}
                disabled={!toggleable || busy === item.toggleKey}
                onChange={(e) => item.toggleKey && toggle(item.toggleKey, e.target.checked)}
                className="mt-0.5 rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500 disabled:opacity-60"
              />
              <div className="min-w-0">
                <span className={`text-sm ${item.done ? 'text-gray-900' : 'text-gray-700'}`}>{item.label}</span>
                {item.note && <p className="text-xs text-gray-400">{item.note}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- Editable freelancer details form ------------------------------------

function FreelancerDetailsForm({ person, onCancel, onSaved }: {
  person: FreelancerPerson;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    freelancer_joined_date: person.freelancer_joined_date?.split('T')[0] || '',
    freelancer_next_review_date: person.freelancer_next_review_date?.split('T')[0] || '',
    skills: person.skills || [],
    licence_details: person.licence_details || '',
    is_insured_on_vehicles: person.is_insured_on_vehicles,
    is_approved: person.is_approved,
    has_tshirt: person.has_tshirt,
    emergency_contact_name: person.emergency_contact_name || '',
    emergency_contact_phone: person.emergency_contact_phone || '',
    freelancer_references: person.freelancer_references || '',
  });
  const [skillInput, setSkillInput] = useState('');
  const [showCustomSkill, setShowCustomSkill] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function addSkill() {
    const skill = skillInput.trim();
    if (skill && !form.skills.includes(skill)) set('skills', [...form.skills, skill]);
    setSkillInput('');
    setShowCustomSkill(false);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await api.put(`/people/${person.id}`, {
        freelancer_joined_date: form.freelancer_joined_date || null,
        freelancer_next_review_date: form.freelancer_next_review_date || null,
        skills: form.skills,
        licence_details: form.licence_details || null,
        is_insured_on_vehicles: form.is_insured_on_vehicles,
        is_approved: form.is_approved,
        has_tshirt: form.has_tshirt,
        emergency_contact_name: form.emergency_contact_name || null,
        emergency_contact_phone: form.emergency_contact_phone || null,
        freelancer_references: form.freelancer_references || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">Edit Freelancer Details</h3>
      {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

      {/* Skills */}
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Skills</label>
        <div className="flex flex-wrap gap-1 mb-2">
          {form.skills.map(skill => (
            <span key={skill} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-ooosh-100 text-ooosh-700">
              {skill}
              <button type="button" onClick={() => set('skills', form.skills.filter(s => s !== skill))} className="text-ooosh-400 hover:text-ooosh-600">&times;</button>
            </span>
          ))}
        </div>
        <select
          value=""
          onChange={e => {
            const val = e.target.value;
            if (val === '__custom__') { setShowCustomSkill(true); setSkillInput(''); }
            else if (val && !form.skills.includes(val)) set('skills', [...form.skills, val]);
            e.target.value = '';
          }}
          className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          <option value="">Select a skill...</option>
          {PRESET_SKILLS.filter(s => !form.skills.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
          <option value="__custom__">+ Add custom skill</option>
        </select>
        {showCustomSkill && (
          <div className="flex gap-2 mt-2">
            <input
              value={skillInput}
              onChange={e => setSkillInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkill(); } }}
              placeholder="Type custom skill..."
              autoFocus
              className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
            <button type="button" onClick={addSkill} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Add</button>
          </div>
        )}
      </div>

      {/* Dates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Joined Date" type="date" value={form.freelancer_joined_date} onChange={v => set('freelancer_joined_date', v)} />
        <FormField label="Next Review Date" type="date" value={form.freelancer_next_review_date} onChange={v => set('freelancer_next_review_date', v)} />
      </div>

      <FormField label="Licence Details" value={form.licence_details} onChange={v => set('licence_details', v)} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Emergency Contact Name" value={form.emergency_contact_name} onChange={v => set('emergency_contact_name', v)} />
        <FormField label="Emergency Contact Phone" value={form.emergency_contact_phone} onChange={v => set('emergency_contact_phone', v)} />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">References</label>
        <textarea
          value={form.freelancer_references}
          onChange={e => set('freelancer_references', e.target.value)}
          rows={2}
          placeholder="Reference details..."
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <Checkbox label="Insured on vehicles" checked={form.is_insured_on_vehicles} onChange={v => set('is_insured_on_vehicles', v)} />
        <Checkbox label="Approved freelancer" checked={form.is_approved} onChange={v => set('is_approved', v)} />
        <Checkbox label="Has T-shirt" checked={form.has_tshirt} onChange={v => set('has_tshirt', v)} />
      </div>

      <div className="flex gap-3 pt-2 border-t">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Details'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </div>
  );
}

// ---- Required documents ---------------------------------------------------

const REQUIRED_DOCS = [
  { label: 'DVLA Check', description: 'DVLA licence check result' },
  { label: 'Licence Front', description: 'Front of driving licence' },
  { label: 'Licence Back', description: 'Back of driving licence' },
  { label: 'Passport', description: 'Passport photo page' },
];

function FreelancerDocuments({ personId, files, onFilesChanged, onActivityCreated }: {
  personId: string;
  files: FileAttachment[];
  onFilesChanged: (files: FileAttachment[]) => void;
  onActivityCreated: () => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingLabel, setUploadingLabel] = useState('');

  function getDocFile(docLabel: string): FileAttachment | undefined {
    return files.find(f => f.label?.toLowerCase() === docLabel.toLowerCase());
  }

  function handleUploadClick(docLabel: string) {
    setUploadingLabel(docLabel);
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadingLabel) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    setUploading(uploadingLabel);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('entity_type', 'people');
      formData.append('entity_id', personId);
      formData.append('label', uploadingLabel);

      const result = await api.upload<FileAttachment>('/files/upload', formData);
      onFilesChanged([...files, result]);
      onActivityCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
      setUploadingLabel('');
    }
  }

  async function handleReplace(docLabel: string, existingFile: FileAttachment) {
    try {
      await api.deleteWithBody('/files/delete', {
        key: existingFile.url,
        entity_type: 'people',
        entity_id: personId,
      });
      onFilesChanged(files.filter(f => f.url !== existingFile.url));
      onActivityCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      return;
    }
    handleUploadClick(docLabel);
  }

  async function handleDownload(file: FileAttachment) {
    try {
      const { blob, contentType } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
      const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      setError('Download failed');
    }
  }

  const presentCount = REQUIRED_DOCS.filter(d => getDocFile(d.label)).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Required Documents</h3>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          presentCount === REQUIRED_DOCS.length ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
        }`}>
          {presentCount}/{REQUIRED_DOCS.length} uploaded
        </span>
      </div>

      {error && <div className="bg-red-50 text-red-700 px-3 py-1.5 rounded text-xs mb-2">{error}</div>}

      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelected}
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {REQUIRED_DOCS.map((doc) => {
          const file = getDocFile(doc.label);
          const isUploading = uploading === doc.label;
          return (
            <div
              key={doc.label}
              className={`flex items-center gap-3 p-3 rounded-lg border ${file ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}
            >
              {file ? (
                <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              )}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${file ? 'text-green-800' : 'text-amber-800'}`}>{doc.label}</p>
                {file ? (
                  <p className="text-xs text-green-600 truncate">Uploaded {fmtDate(file.uploaded_at)}</p>
                ) : (
                  <p className="text-xs text-amber-600">Missing</p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {file ? (
                  <>
                    <button type="button" onClick={() => handleDownload(file)} className="p-1 text-green-600 hover:text-green-800 rounded hover:bg-green-100" title="View / Download">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                    <button type="button" onClick={() => handleReplace(doc.label, file)} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100" title="Replace">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUploadClick(doc.label)}
                    disabled={isUploading}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded hover:bg-amber-200 disabled:opacity-50"
                  >
                    {isUploading ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    )}
                    Upload
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Helpers --------------------------------------------------------------

// Finer freelancer status pill (invited / applied / more_info / approved / declined).
// Exported so PersonDetailPage's header can share the same mapping.
export function freelancerStatusPill(status: string | null, isApproved: boolean): { label: string; cls: string } {
  if (isApproved || status === 'approved') return { label: 'Approved Freelancer', cls: 'bg-green-100 text-green-700' };
  switch (status) {
    case 'invited': return { label: 'Invited', cls: 'bg-slate-100 text-slate-600' };
    case 'applied': return { label: 'Applied — needs review', cls: 'bg-amber-100 text-amber-700' };
    case 'more_info': return { label: 'Info requested', cls: 'bg-amber-100 text-amber-700' };
    case 'declined': return { label: 'Declined', cls: 'bg-red-100 text-red-700' };
    default: return { label: 'Pending Approval', cls: 'bg-amber-100 text-amber-700' };
  }
}

// Review-date pip — overdue / due soon / OK. Null when no review date set.
function reviewDateInfo(reviewDate: string | null): { label: string; cls: string } | null {
  if (!reviewDate) return null;
  const due = new Date(reviewDate);
  if (isNaN(due.getTime())) return null;
  const days = Math.round((due.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return { label: `Review overdue (${fmtDate(reviewDate)})`, cls: 'bg-red-100 text-red-700' };
  if (days <= 30) return { label: `Review due ${fmtDate(reviewDate)}`, cls: 'bg-amber-100 text-amber-700' };
  return { label: `Review ${fmtDate(reviewDate)}`, cls: 'bg-green-100 text-green-700' };
}

function fmtDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value || '—'}</dd>
    </div>
  );
}

function FormField({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
      />
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500" />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}
