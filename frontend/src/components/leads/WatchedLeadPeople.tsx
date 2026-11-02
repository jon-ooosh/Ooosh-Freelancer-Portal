/**
 * On a watched band's lead: the people we dealt with at the band (its own
 * people and the contacts on its jobs), and when we were last in touch. After
 * a year or more the tour manager has often changed (TOUR-FINDER-SPEC §21.2
 * item 8) — this shows whether the contacts are fresh before anyone emails.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { fmtDateYear } from './leadTypes';

interface BandPerson {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  last_contact_at: string | null;
  last_job: { job_id: string; hh_job_number: number | null; start: string | null } | null;
}

/** Over a year since we heard from them — flag it. */
const STALE_DAYS = 365;

export default function WatchedLeadPeople({ leadId }: { leadId: string }) {
  const [people, setPeople] = useState<BandPerson[] | null>(null);

  useEffect(() => {
    let live = true;
    api.get<{ data: BandPerson[] }>(`/band-watches/lead/${leadId}/people`)
      .then((res) => { if (live) setPeople(res.data ?? []); })
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [leadId]);

  if (!people) return null;
  if (people.length === 0) {
    return <p className="mb-2 text-gray-500">No people on file for this band yet — use Research again or add a contact.</p>;
  }

  const lastSeen = (p: BandPerson): string | null => {
    const a = p.last_contact_at;
    const b = p.last_job?.start ?? null;
    if (!a) return b;
    if (!b) return a;
    return Date.parse(a) > Date.parse(b) ? a : b;
  };

  return (
    <div className="mb-2">
      <div className="text-gray-400 mb-1">People we’ve dealt with at this band:</div>
      <ul className="space-y-0.5">
        {people.map((p) => {
          const seen = lastSeen(p);
          const t = seen ? new Date(seen).getTime() : NaN;
          const stale = Number.isNaN(t) || Date.now() - t > STALE_DAYS * 86_400_000;
          return (
            <li key={p.id}>
              <Link to={`/people/${p.id}`} className="text-blue-600 hover:underline">{p.name ?? p.email ?? 'Unnamed'}</Link>
              <span className="text-gray-400">
                {p.role ? ` · ${p.role}` : ''}{p.email ? ` · ${p.email}` : ''}
                {p.last_contact_at ? ` · last in touch ${fmtDateYear(p.last_contact_at)}` : ''}
                {p.last_job ? ` · on job ${p.last_job.hh_job_number ? `#${p.last_job.hh_job_number}` : ''}${p.last_job.start ? ` (${fmtDateYear(p.last_job.start)})` : ''}` : ''}
              </span>
              {stale && <span className="ml-1 text-amber-700">· may have moved on — worth checking</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
