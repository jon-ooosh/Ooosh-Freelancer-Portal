/**
 * JobContactsCard — per-hire contact selection on Job Detail
 *
 * Mirrors the cascade UX from the New Enquiry modal but inline on the Job
 * Detail header card. Lets staff tick which of the client/linked-org people
 * are on THIS hire (writes to job_contacts, migration 086) and mark a
 * primary. The primary becomes the `to` for all client-facing emails
 * routed via getJobEmailRecipients / resolveClientEmailTarget.
 *
 * Round 6 (May 2026): rounds 1-5 built the data layer + routing graduation,
 * but only the New Enquiry form could write to job_contacts. This component
 * closes the loop — staff can now tick contacts on HH-synced jobs, edit the
 * primary after the fact, etc.
 *
 * Round 7 (Jun 2026) — three additions:
 *   - Default primary on first open: org-level primary contact wins, else
 *     a sole candidate is auto-ticked + auto-primaried. Stops staff having
 *     to click "the only option" on every HH-synced single-contact job.
 *     Fires ONCE per (job with no job_contacts rows yet) — once we've
 *     stamped a row, the auto-select is done.
 *   - Emailless-primary guard: clicking a chip with no email to promote
 *     to primary is blocked at the UI (a chip with no email can still be
 *     ticked as a CC, but can't be the star). Backend would now fall
 *     through to info@ if every ticked contact lacked an email — see the
 *     Issue 1 fix in services/money-emails.ts.
 *   - Email routing picker: collapsible "Customise" section with 5
 *     buckets (Bookings & payments, Send invoice, Hire forms, Insurance
 *     excess, Delivery / on-the-day). Each row is a multi-select chip
 *     picker of ticked contacts; default = "primary" (no override).
 *     Persists to jobs.email_routing JSONB (migration 102) via
 *     PUT /api/pipeline/:jobId/email-routing.
 *
 * Click semantics on the contact chips:
 *   - Unticked chip → tick it. First tick auto-becomes primary IF it has
 *     an email (otherwise ticked-but-not-primary).
 *   - Ticked non-primary chip → promote to primary IF it has an email.
 *   - × on a ticked chip → untick (clears primary if it was primary).
 *   - "+ Add" → search-first picker. Existing person → link to client org
 *     + tick. New person → create + link + tick.
 *
 * Saves auto-trigger on any change (debounced 400ms). No save button.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';

export interface JobContactsCardProps {
  jobId: string;
  /** Called after any save so parent can refresh banners / has_client_email */
  onChanged?: () => void;
}

interface TickedContact {
  person_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

interface CandidateContact {
  person_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  source_org_id: string | null;
  source_org_name: string | null;
  is_org_primary: boolean;
}

interface SearchResult {
  id: string;
  name: string;
  subtitle: string | null;
  type: string;
}

// Email buckets — must match backend services/email-routing.ts. If a new
// bucket lands, add it here too.
const EMAIL_BUCKETS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: 'bookings_payments', label: 'Bookings & payments', description: 'Booking confirmations, payment receipts, last-minute alerts.' },
  { id: 'send_invoice', label: 'Send invoice', description: 'Invoices and statements (often a different person — accountant / finance).' },
  { id: 'hire_forms', label: 'Hire forms & driver', description: 'Hire form send/chase emails to drivers.' },
  { id: 'excess', label: 'Insurance excess', description: 'Excess payment confirmations, pre-auth holds, reimbursements, claims.' },
  { id: 'delivery_on_day', label: 'Delivery / on-the-day', description: 'Delivery notes, collection confirmations, check-in summaries.' },
];

/** Stable wrapper around the global search that scopes to people only.
 *  The shared /search endpoint mixes entity types — we filter client-side. */
async function searchPeople(q: string): Promise<SearchResult[]> {
  const data = await api.get<{ results: SearchResult[] }>(
    `/search?q=${encodeURIComponent(q)}&limit=20`
  );
  return (data.results || []).filter(r => r.type === 'person').slice(0, 8);
}

export default function JobContactsCard({ jobId, onChanged }: JobContactsCardProps) {
  const [ticked, setTicked] = useState<TickedContact[]>([]);
  const [candidates, setCandidates] = useState<CandidateContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Routing overrides — sparse map { bucket: [person_id, ...] }
  const [routing, setRouting] = useState<Record<string, string[]>>({});
  const [routingExpanded, setRoutingExpanded] = useState(false);

  // Add-contact UX state
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [emailField, setEmailField] = useState('');
  const [phoneField, setPhoneField] = useState('');
  const [roleField, setRoleField] = useState('General Contact');
  const [adding, setAdding] = useState(false);

  // Track local mutations to debounce-save without re-fetching every keystroke
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routingSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [contactsData, routingData] = await Promise.all([
        api.get<{ ticked: TickedContact[]; candidates: CandidateContact[] }>(
          `/pipeline/${jobId}/contacts`
        ),
        api.get<{ routing: Record<string, string[]> }>(
          `/pipeline/${jobId}/email-routing`
        ).catch(() => ({ routing: {} })),
      ]);
      setTicked(contactsData.ticked);
      setCandidates(contactsData.candidates);
      setRouting(routingData.routing || {});

      // Default-primary auto-select. Only when this job has zero
      // job_contacts rows AND a clear default candidate exists. Auto-saves
      // immediately so the user sees the chip already starred — matches
      // the "I have to tick the only option" pain point.
      //
      // Rules (mirror the New Enquiry form):
      //   1. Org-level primary contact (is_org_primary=true) → that one.
      //   2. Sole candidate → that one.
      //   3. Otherwise: leave unticked.
      //
      // Only candidates WITH an email qualify for auto-primary — staff
      // shouldn't open a job and find an unreachable primary auto-set.
      if (contactsData.ticked.length === 0 && contactsData.candidates.length > 0) {
        const reachable = contactsData.candidates.filter(c => c.email && c.email.trim());
        let defaultCandidate: CandidateContact | null = null;
        const orgPrimaries = reachable.filter(c => c.is_org_primary);
        if (orgPrimaries.length === 1) {
          defaultCandidate = orgPrimaries[0];
        } else if (reachable.length === 1) {
          defaultCandidate = reachable[0];
        }
        if (defaultCandidate) {
          const next: TickedContact[] = [{
            person_id: defaultCandidate.person_id,
            name: defaultCandidate.name,
            email: defaultCandidate.email,
            phone: defaultCandidate.phone,
            is_primary: true,
          }];
          setTicked(next);
          // Persist immediately (skip debounce — staff sees the result of
          // their default-select on first paint, not 400ms later).
          try {
            await api.put(`/pipeline/${jobId}/contacts`, {
              person_ids: [defaultCandidate.person_id],
              primary_person_id: defaultCandidate.person_id,
            });
            onChanged?.();
          } catch {
            // Non-fatal — staff can pick manually if the auto-select fails.
          }
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [jobId, onChanged]);

  useEffect(() => {
    load();
  }, [load]);

  /** Persist current ticked list (idempotent replace). Debounced. */
  function scheduleSave(next: TickedContact[]) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const personIds = next.map(t => t.person_id);
        const primary = next.find(t => t.is_primary);
        await api.put(`/pipeline/${jobId}/contacts`, {
          person_ids: personIds,
          primary_person_id: primary?.person_id || null,
        });
        onChanged?.();
      } catch (err: any) {
        setError(err.message || 'Save failed');
        // Re-load to revert local state to whatever the server has
        load();
      }
    }, 400);
  }

  /** Persist routing overrides. Debounced. Drops empty buckets server-side. */
  function scheduleRoutingSave(next: Record<string, string[]>) {
    if (routingSaveTimer.current) clearTimeout(routingSaveTimer.current);
    routingSaveTimer.current = setTimeout(async () => {
      try {
        await api.put(`/pipeline/${jobId}/email-routing`, { routing: next });
      } catch (err: any) {
        setError(err.message || 'Routing save failed');
      }
    }, 400);
  }

  function isTicked(personId: string): boolean {
    return ticked.some(t => t.person_id === personId);
  }

  function handleChipClick(candidate: CandidateContact) {
    const currentlyTicked = isTicked(candidate.person_id);
    const hasEmail = !!(candidate.email && candidate.email.trim());

    if (!currentlyTicked) {
      // Tick it. If nothing else is ticked, becomes primary automatically —
      // but only if it has an email (so the auto-primary doesn't land on an
      // unreachable contact).
      const becomesPrimary = ticked.length === 0 && hasEmail;
      const next: TickedContact[] = [
        ...ticked.map(t => ({ ...t, is_primary: becomesPrimary ? false : t.is_primary })),
        {
          person_id: candidate.person_id,
          name: candidate.name,
          email: candidate.email,
          phone: candidate.phone,
          is_primary: becomesPrimary,
        },
      ];
      setTicked(next);
      scheduleSave(next);
      return;
    }

    // Already ticked: promote to primary (if not already, and reachable)
    const isPrimary = ticked.find(t => t.person_id === candidate.person_id)?.is_primary;
    if (isPrimary) return;
    if (!hasEmail) {
      setError('This contact has no email — can\'t set as primary. Add an email or pick another contact.');
      return;
    }
    const next = ticked.map(t => ({
      ...t,
      is_primary: t.person_id === candidate.person_id,
    }));
    setTicked(next);
    scheduleSave(next);
  }

  function handleChipRemove(personId: string) {
    const wasPrimary = ticked.find(t => t.person_id === personId)?.is_primary;
    let next = ticked.filter(t => t.person_id !== personId);
    // If we removed the primary, promote the first remaining REACHABLE
    // contact (don't leave an emailless contact as the new primary).
    if (wasPrimary && next.length > 0) {
      const firstReachableIdx = next.findIndex(t => t.email && t.email.trim());
      next = next.map((t, i) => ({ ...t, is_primary: i === firstReachableIdx }));
    }
    setTicked(next);
    scheduleSave(next);

    // Drop the removed person from any routing buckets so we don't leave
    // stale UUIDs in the JSONB. Backend would silently skip them anyway,
    // but keeping the UI state honest avoids confusion.
    const nextRouting: Record<string, string[]> = {};
    let routingChanged = false;
    for (const [bucket, ids] of Object.entries(routing)) {
      const filtered = ids.filter(id => id !== personId);
      if (filtered.length !== ids.length) routingChanged = true;
      if (filtered.length > 0) nextRouting[bucket] = filtered;
    }
    if (routingChanged) {
      setRouting(nextRouting);
      scheduleRoutingSave(nextRouting);
    }
  }

  function toggleRoutingMember(bucket: string, personId: string) {
    const current = routing[bucket] || [];
    const next = current.includes(personId)
      ? current.filter(id => id !== personId)
      : [...current, personId];
    const nextRouting = { ...routing };
    if (next.length > 0) nextRouting[bucket] = next;
    else delete nextRouting[bucket];
    setRouting(nextRouting);
    scheduleRoutingSave(nextRouting);
  }

  // Person search — debounced
  useEffect(() => {
    if (!showAddPicker || !search.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchPeople(search)
        .then(results => { if (!cancelled) setSearchResults(results); })
        .catch(() => { if (!cancelled) setSearchResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, showAddPicker]);

  async function addExistingPerson(personId: string) {
    setAdding(true);
    setError('');
    try {
      await api.post(`/pipeline/${jobId}/contacts/add-person`, {
        person_id: personId,
        set_as_primary: ticked.length === 0,
      });
      setShowAddPicker(false);
      setSearch('');
      setSearchResults([]);
      setShowCreateForm(false);
      await load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message || 'Failed to add contact');
    } finally {
      setAdding(false);
    }
  }

  async function createAndAddPerson() {
    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name required');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await api.post(`/pipeline/${jobId}/contacts/add-person`, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: emailField.trim() || undefined,
        phone: phoneField.trim() || undefined,
        role: roleField,
        set_as_primary: ticked.length === 0,
      });
      setShowAddPicker(false);
      setSearch('');
      setSearchResults([]);
      setShowCreateForm(false);
      setFirstName('');
      setLastName('');
      setEmailField('');
      setPhoneField('');
      setRoleField('General Contact');
      await load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message || 'Failed to create contact');
    } finally {
      setAdding(false);
    }
  }

  // Candidates not yet ticked, for the "available" hint
  const untickedCandidates = candidates.filter(c => !isTicked(c.person_id));

  // Ticked people that aren't in candidates (e.g. ad-hoc / cross-org). Render
  // anyway so staff can see + remove them.
  const tickedNotInCandidates = ticked.filter(t => !candidates.some(c => c.person_id === t.person_id));

  // Primary name for the routing-summary line
  const primary = ticked.find(t => t.is_primary);
  const overrideCount = Object.values(routing).filter(v => Array.isArray(v) && v.length > 0).length;

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider pt-1">
          Contacts:
        </span>

        {loading && <span className="text-xs text-gray-400 italic pt-1">Loading…</span>}

        {!loading && candidates.length === 0 && ticked.length === 0 && (
          <span className="text-xs text-gray-400 italic pt-1">
            No people linked to client or related orgs — add one below or via the organisation page.
          </span>
        )}

        {/* Ticked from candidates */}
        {candidates.map(candidate => {
          const tickedRow = ticked.find(t => t.person_id === candidate.person_id);
          const isTickedHere = !!tickedRow;
          const isPrimary = !!tickedRow?.is_primary;
          const hasEmail = !!(candidate.email && candidate.email.trim());
          const isTickedNoPrimary = isTickedHere && !isPrimary && !hasEmail;
          return (
            <span
              key={candidate.person_id}
              className={`inline-flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-pointer transition-colors ${
                isPrimary
                  ? 'bg-blue-100 border-blue-400 text-blue-900'
                  : isTickedHere
                    ? 'bg-blue-50 border-blue-200 text-blue-800'
                    : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
              }`}
              onClick={() => handleChipClick(candidate)}
              title={
                isPrimary
                  ? 'Primary contact — emails will land here'
                  : isTickedNoPrimary
                    ? 'No email — can\'t be set as primary. Ticked as CC only.'
                    : isTickedHere
                      ? 'Click again to make primary'
                      : hasEmail ? 'Click to add to this hire' : 'Click to add as CC (no email — can\'t be primary)'
              }
            >
              {isPrimary && <span title="Primary contact">★</span>}
              <span className={isPrimary ? 'font-bold' : 'font-medium'}>{candidate.name}</span>
              {candidate.role && <span className="opacity-60">({candidate.role})</span>}
              {!candidate.email && (
                <span className="opacity-50 italic text-[10px]" title="No email on file">⚠ no email</span>
              )}
              {isTickedHere && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleChipRemove(candidate.person_id); }}
                  className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
                  title="Remove from this hire"
                >
                  &times;
                </button>
              )}
            </span>
          );
        })}

        {/* Ticked but not in candidates (e.g. attached ad-hoc / cross-org) */}
        {tickedNotInCandidates.map(t => {
          const hasEmail = !!(t.email && t.email.trim());
          return (
            <span
              key={t.person_id}
              className={`inline-flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-pointer transition-colors ${
                t.is_primary
                  ? 'bg-blue-100 border-blue-400 text-blue-900'
                  : 'bg-blue-50 border-blue-200 text-blue-800'
              }`}
              onClick={() => {
                // Promote to primary
                if (t.is_primary) return;
                if (!hasEmail) {
                  setError('This contact has no email — can\'t set as primary.');
                  return;
                }
                const next = ticked.map(tt => ({ ...tt, is_primary: tt.person_id === t.person_id }));
                setTicked(next);
                scheduleSave(next);
              }}
              title={t.is_primary ? 'Primary contact' : (hasEmail ? 'Click to make primary' : 'No email — can\'t be primary')}
            >
              {t.is_primary && <span>★</span>}
              <span className={t.is_primary ? 'font-bold' : 'font-medium'}>{t.name}</span>
              {!hasEmail && (
                <span className="opacity-50 italic text-[10px]" title="No email on file">⚠ no email</span>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleChipRemove(t.person_id); }}
                className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
              >
                &times;
              </button>
            </span>
          );
        })}

        {!showAddPicker ? (
          <button
            type="button"
            onClick={() => { setShowAddPicker(true); setSearch(''); setShowCreateForm(false); setError(''); }}
            className="inline-flex items-center px-2 py-1 text-xs text-gray-500 hover:text-ooosh-600 hover:bg-gray-50 rounded border border-dashed border-gray-300 transition-colors"
          >
            + Add
          </button>
        ) : null}
      </div>

      {/* Hint when staff have nothing ticked but candidates exist */}
      {!loading && ticked.length === 0 && untickedCandidates.length > 0 && (
        <p className="text-xs text-amber-600 mt-1.5 italic">
          ⚠ No primary contact picked — client emails will fall through to org-level routing.
          Click a chip above to tick.
        </p>
      )}

      {/* Email routing — collapsible. Hidden if no contacts ticked (nothing to route to). */}
      {!loading && ticked.length > 0 && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setRoutingExpanded(v => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
          >
            <span className="font-medium">Email routing:</span>
            {overrideCount === 0 ? (
              <span>All emails &rarr; <strong className="text-gray-700">{primary?.name || 'primary contact'}</strong></span>
            ) : (
              <span>{overrideCount} override{overrideCount === 1 ? '' : 's'}</span>
            )}
            <span className="opacity-50">{routingExpanded ? '▴ Collapse' : '▾ Customise'}</span>
          </button>

          {routingExpanded && (
            <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1.5">
              <p className="text-[11px] text-gray-500 mb-1">
                Default is the primary contact. Tick names below to override per category — leave empty to use the default.
              </p>
              {EMAIL_BUCKETS.map(bucket => {
                const overrides = routing[bucket.id] || [];
                return (
                  <div key={bucket.id} className="flex items-start gap-2 py-1">
                    <div className="flex-shrink-0 w-40">
                      <div className="text-xs font-medium text-gray-700">{bucket.label}</div>
                      <div className="text-[10px] text-gray-400 leading-tight">{bucket.description}</div>
                    </div>
                    <div className="flex-1 flex flex-wrap gap-1 items-center">
                      {ticked.filter(t => t.email && t.email.trim()).length === 0 ? (
                        <span className="text-[11px] text-gray-400 italic">No reachable contacts ticked</span>
                      ) : (
                        ticked
                          .filter(t => t.email && t.email.trim())
                          .map(t => {
                            const selected = overrides.includes(t.person_id);
                            return (
                              <button
                                key={t.person_id}
                                type="button"
                                onClick={() => toggleRoutingMember(bucket.id, t.person_id)}
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded transition-colors ${
                                  selected
                                    ? 'bg-blue-100 border-blue-400 text-blue-900'
                                    : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                                }`}
                                title={selected ? 'Click to remove from this category' : 'Click to add to this category'}
                              >
                                {selected ? '✓ ' : ''}{t.name}
                              </button>
                            );
                          })
                      )}
                      {overrides.length === 0 && (
                        <span className="text-[10px] text-gray-400 italic ml-1">(default → primary)</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add-contact picker */}
      {showAddPicker && (
        <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-blue-800 font-medium">
              {showCreateForm ? 'Create new contact' : 'Find or create a contact'}
            </p>
            <button
              type="button"
              onClick={() => {
                setShowAddPicker(false);
                setSearch('');
                setSearchResults([]);
                setShowCreateForm(false);
                setError('');
              }}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>

          {!showCreateForm && (
            <>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-ooosh-500 focus:border-ooosh-500"
                autoFocus
              />
              {searching && <p className="text-xs text-gray-400 italic">Searching…</p>}
              {searchResults.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                  {searchResults.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => addExistingPerson(r.id)}
                      disabled={adding}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-xs flex items-center gap-2 border-b border-gray-50 last:border-b-0 disabled:opacity-50"
                    >
                      <span className="font-medium">{r.name}</span>
                      {r.subtitle && <span className="text-gray-400">{r.subtitle}</span>}
                    </button>
                  ))}
                </div>
              )}
              {search.trim() && !searching && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 italic">No matches.</p>
              )}
              <button
                type="button"
                onClick={() => { setShowCreateForm(true); setError(''); }}
                className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
              >
                + Create new contact instead
              </button>
            </>
          )}

          {showCreateForm && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name *"
                  className="border border-gray-300 rounded px-2 py-1 text-xs"
                  autoFocus
                />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last name *"
                  className="border border-gray-300 rounded px-2 py-1 text-xs"
                />
              </div>
              <input
                type="email"
                value={emailField}
                onChange={(e) => setEmailField(e.target.value)}
                placeholder="Email (recommended)"
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <input
                type="tel"
                value={phoneField}
                onChange={(e) => setPhoneField(e.target.value)}
                placeholder="Phone"
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <select
                value={roleField}
                onChange={(e) => setRoleField(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
              >
                <option value="General Contact">General Contact</option>
                <option value="Tour Manager">Tour Manager</option>
                <option value="Manager">Manager</option>
                <option value="Production Manager">Production Manager</option>
                <option value="Engineer">Engineer</option>
                <option value="Accountant">Accountant</option>
                <option value="Promoter">Promoter</option>
                <option value="Crew">Crew</option>
                <option value="Band Member">Band Member</option>
                <option value="Driver">Driver</option>
                <option value="Agent">Agent</option>
                <option value="Site Contact">Site Contact</option>
                <option value="Owner">Owner</option>
                <option value="Other">Other</option>
              </select>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={createAndAddPerson}
                  disabled={adding}
                  className="px-3 py-1 text-xs bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                >
                  {adding ? 'Adding…' : 'Create + add to hire'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Back to search
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 mt-1.5">{error}</p>
      )}
    </div>
  );
}
