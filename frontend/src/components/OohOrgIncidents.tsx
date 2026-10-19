import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

/**
 * Read-only OOH incident rollup for an organisation (as the job client).
 * Surfaces the "this client's drivers keep parking badly" pattern across a
 * client's hires. Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md. Enforcement
 * is per-driver — this is context, not a control.
 */

interface DriverIncident {
  driverId: string | null;
  driverName: string | null;
  blocked: boolean;
  incidentCount: number;
  lastIncidentOn: string | null;
}
interface OrgIncidents {
  totalIncidents: number;
  drivers: DriverIncident[];
}

export default function OohOrgIncidents({ orgId }: { orgId: string }) {
  const [data, setData] = useState<OrgIncidents | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<{ data: OrgIncidents }>(`/ooh-return/by-organisation/${orgId}`);
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load OOH incidents');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-red-600 py-6">{error}</div>;
  }
  if (!data || data.drivers.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-400 text-4xl mb-3">🌙</p>
        <p className="text-gray-600 font-medium">No out-of-hours incidents</p>
        <p className="text-sm text-gray-400 mt-1">This client's drivers have no flagged OOH returns.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Out-of-hours incidents</h3>
          <p className="text-xs text-gray-500 mt-0.5">Flagged returns across this client's drivers (read-only)</p>
        </div>
        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">
          {data.totalIncidents} total
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
              <th className="px-5 py-2 font-medium">Driver</th>
              <th className="px-5 py-2 font-medium">Incidents</th>
              <th className="px-5 py-2 font-medium">Last incident</th>
              <th className="px-5 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.drivers.map((d, i) => (
              <tr key={d.driverId || `unattributed-${i}`} className="border-b border-gray-50 last:border-0">
                <td className="px-5 py-2.5">
                  {d.driverId ? (
                    <Link to={`/drivers/${d.driverId}`} className="text-ooosh-600 hover:underline font-medium">
                      {d.driverName || 'Unnamed driver'}
                    </Link>
                  ) : (
                    <span className="text-gray-500 italic">Unattributed</span>
                  )}
                </td>
                <td className="px-5 py-2.5">{d.incidentCount}</td>
                <td className="px-5 py-2.5 text-gray-600">
                  {d.lastIncidentOn ? new Date(d.lastIncidentOn).toLocaleDateString('en-GB') : '—'}
                </td>
                <td className="px-5 py-2.5">
                  {d.blocked ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                      OOH blocked
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
