/**
 * "Does for us: Boiler service · Gas safety (CP12)" — the premises checks an
 * organisation is the contractor on, or has done (PREMISES-COMPLIANCE-SPEC.md §16).
 * Shown on the organisation page only when there are some; the server leaves
 * out checks this login can't see.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { PremisesCheck, statusPill } from './premisesCopy';

export default function OrgPremisesLine({ orgId }: { orgId: string }) {
  const [checks, setChecks] = useState<PremisesCheck[]>([]);
  useEffect(() => {
    api.get<{ data: PremisesCheck[] }>(`/premises/by-organisation/${orgId}`)
      .then(r => setChecks(r.data ?? []))
      .catch(() => setChecks([]));
  }, [orgId]);
  if (checks.length === 0) return null;
  return (
    <p className="mt-1 text-sm text-gray-500">
      Premises checks they do:{' '}
      {checks.map((c, i) => {
        const pill = statusPill(c);
        return (
          <span key={c.id}>
            {i > 0 && ' · '}
            <Link to={`/operations/premises/checks/${c.id}`} className="text-ooosh-600 hover:text-ooosh-700" title={`${c.place_name} · ${pill.text}`}>
              {c.title}
            </Link>
          </span>
        );
      })}
    </p>
  );
}
