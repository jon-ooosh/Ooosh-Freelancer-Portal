import { useEffect, useState } from 'react';
import { api } from '../services/api';

interface Candidate {
  person_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  role: string | null;
  is_org_primary: boolean;
  source_org_id: string | null;
  source_org_name: string | null;
}

interface Ticked {
  person_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  label: string | null;
}

interface Row extends Candidate {
  ticked: boolean;
  label: string;
}

/**
 * "Who does the driver call?" — pick contacts for one transport leg from the
 * people already on the job's organisations.
 *
 * Before this the site contact was re-typed into Freelancer Notes every time,
 * despite the job already knowing every person at every org on it. Ticked
 * contacts reach the freelancer portal as a `contacts` list on the leg.
 *
 * ── The phone problem, and why it's handled here ─────────────────────────
 * Only ~17% of `people` rows carry any number. A picker full of contacts with
 * an email and no mobile is useless to a driver at a loading bay, and staff
 * would go straight back to typing into the notes — so a candidate with no
 * number gets an inline "add number" that writes to the PERSON record
 * (`PUT /api/people/:id`), not to this leg. Captured once, true everywhere
 * after that. That's the whole point of referencing the person rather than
 * snapshotting their details onto the quote.
 *
 * Saving is immediate (its own PUT), not folded into the parent modal's save.
 * The contact list is a relationship, not a field of the quote, and a person
 * whose number you just fixed should stay fixed even if you then cancel out
 * of the quote edit.
 */
export function QuoteContactsPicker({ quoteId }: { quoteId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Inline phone capture, keyed by person_id so only one row opens at a time.
  const [phoneFor, setPhoneFor] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneSaving, setPhoneSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get<{ data: { ticked: Ticked[]; candidates: Candidate[] } }>(
          `/quotes/${quoteId}/contacts`
        );
        if (!alive) return;
        const tickedById = new Map(res.data.ticked.map((t) => [t.person_id, t]));

        // One list, not two. Candidates carry the tick state; anyone ticked who
        // is NO LONGER a candidate (they left the org, or the job's orgs
        // changed) is appended so they can still be seen and removed rather
        // than silently disappearing while staying on the leg.
        const merged: Row[] = res.data.candidates.map((c) => ({
          ...c,
          ticked: tickedById.has(c.person_id),
          label: tickedById.get(c.person_id)?.label || '',
        }));
        const candidateIds = new Set(res.data.candidates.map((c) => c.person_id));
        for (const t of res.data.ticked) {
          if (candidateIds.has(t.person_id)) continue;
          merged.push({
            person_id: t.person_id,
            name: t.name,
            email: t.email,
            phone: t.phone,
            mobile: t.mobile,
            role: null,
            is_org_primary: false,
            source_org_id: null,
            source_org_name: 'No longer on an org for this job',
            ticked: true,
            label: t.label || '',
          });
        }
        setRows(merged);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load contacts');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [quoteId]);

  async function persist(next: Row[]) {
    setRows(next);
    setSaving(true);
    setError(null);
    try {
      await api.put(`/quotes/${quoteId}/contacts`, {
        contacts: next
          .filter((r) => r.ticked)
          .map((r) => ({ person_id: r.person_id, label: r.label.trim() || null })),
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save contacts');
    } finally {
      setSaving(false);
    }
  }

  async function saveNumber(personId: string) {
    const number = phoneDraft.trim();
    if (!number) return;
    setPhoneSaving(true);
    setError(null);
    try {
      // Writes to the PERSON, so the number is right on every future job too.
      // `mobile` rather than `phone`: a number added in this context is the
      // one to ring on the day.
      await api.put(`/people/${personId}`, { mobile: number });
      setRows((prev) => prev.map((r) => (r.person_id === personId ? { ...r, mobile: number } : r)));
      setPhoneFor(null);
      setPhoneDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the number');
    } finally {
      setPhoneSaving(false);
    }
  }

  if (loading) return <p className="text-xs text-gray-400">Loading contacts…</p>;

  if (rows.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        No contacts found on this job's organisations. Add people to the client or linked orgs
        (Job Detail → Contacts) and they'll appear here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
        {rows.map((r) => {
          const number = r.mobile || r.phone;
          return (
            <div key={r.person_id} className="px-2.5 py-2">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={r.ticked}
                  onChange={(e) => {
                    const next = rows.map((x) =>
                      x.person_id === r.person_id ? { ...x, ticked: e.target.checked } : x
                    );
                    persist(next);
                  }}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{r.name || 'Unnamed'}</span>
                    {r.role && <span className="text-xs text-gray-500">{r.role}</span>}
                    {r.is_org_primary && (
                      <span className="text-xs text-ooosh-600">primary</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {r.source_org_name}
                  </div>
                  <div className="text-xs mt-0.5">
                    {number ? (
                      <span className="text-gray-700">{number}</span>
                    ) : phoneFor === r.person_id ? (
                      <span className="flex items-center gap-1.5 mt-1">
                        <input
                          type="tel"
                          value={phoneDraft}
                          autoFocus
                          onChange={(e) => setPhoneDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveNumber(r.person_id); }}
                          placeholder="Mobile number"
                          className="border border-gray-300 rounded px-2 py-1 text-xs w-40"
                        />
                        <button
                          type="button"
                          onClick={() => saveNumber(r.person_id)}
                          disabled={phoneSaving}
                          className="text-xs text-ooosh-600 font-medium disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setPhoneFor(null); setPhoneDraft(''); }}
                          className="text-xs text-gray-400"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setPhoneFor(r.person_id); setPhoneDraft(''); }}
                        className="text-amber-600 hover:text-amber-700"
                      >
                        ⚠ No number — add one
                      </button>
                    )}
                    {r.email && <span className="text-gray-400 ml-2">{r.email}</span>}
                  </div>
                  {r.ticked && (
                    <input
                      type="text"
                      value={r.label}
                      onChange={(e) => {
                        setRows((prev) =>
                          prev.map((x) =>
                            x.person_id === r.person_id ? { ...x, label: e.target.value } : x
                          )
                        );
                      }}
                      onBlur={() => persist(rows)}
                      placeholder="Role on this leg (e.g. Site contact, TM)"
                      className="mt-1.5 w-full border border-gray-200 rounded px-2 py-1 text-xs"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!error && saving && <p className="text-xs text-gray-400">Saving…</p>}
      {!error && !saving && savedAt !== null && (
        <p className="text-xs text-green-600">✓ Contacts saved</p>
      )}
      <p className="text-xs text-gray-500">
        Ticked contacts show on the freelancer's job in the portal, with whatever number is on
        their record at the time — so a number corrected later reaches them automatically.
      </p>
    </div>
  );
}
