/**
 * CarnetDetailPage — Operations > Carnets > one carnet on its own page.
 *
 * Route: /operations/carnets/:id. Fetches the carnet for the header, renders the
 * rich CarnetSection cockpit. The Operations list + the Job-View "Manage carnet
 * in Operations →" link both navigate here.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import CarnetSection from '../components/CarnetSection';

interface CarnetHead {
  id: string;
  job_id: string;
  mode: string;
  status: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
}

export default function CarnetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [head, setHead] = useState<CarnetHead | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<{ data: CarnetHead }>(`/carnets/${id}`);
      setHead(res.data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-6 text-gray-400">Loading…</div>;
  if (notFound || !head) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Link to="/operations/carnets" className="text-sm text-purple-600 hover:text-purple-800">← Back to carnets</Link>
        <p className="mt-4 text-gray-500">Carnet not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link to="/operations/carnets" className="text-sm text-purple-600 hover:text-purple-800">← Back to carnets</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">
            Carnet — {head.hh_job_number ? `#${head.hh_job_number}` : 'job'}{head.client_name ? ` · ${head.client_name}` : ''}
          </h1>
          {head.job_name && <p className="text-sm text-gray-500">{head.job_name}</p>}
        </div>
        <button
          onClick={() => navigate(`/jobs/${head.job_id}`)}
          className="text-sm text-purple-600 hover:text-purple-800 whitespace-nowrap"
        >View job →</button>
      </div>

      <CarnetSection jobId={head.job_id} onChanged={load} />
    </div>
  );
}
