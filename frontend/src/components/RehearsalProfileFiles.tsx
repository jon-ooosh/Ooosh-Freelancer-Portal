/**
 * RehearsalProfileFiles — read-only surfacing of the band's rehearsal-profile
 * files (mix files, stage plots) on the Job Detail Files tab. Once a job has a
 * band anchor, the band's profile files "rise up" here so staff don't re-attach
 * a stage plot on every booking. Surfaced, not copied — the files stay owned by
 * organisation_rehearsal_profile. Self-hides when there are none.
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface ProfileFile { r2_key: string; filename: string }
interface Resp {
  anchorOrg: { id: string; name: string | null } | null;
  profile: { files: ProfileFile[] } | null;
}

export default function RehearsalProfileFiles({ jobId }: { jobId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ data: Resp }>(`/rehearsals/job/${jobId}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { /* hide */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [jobId]);

  const files = data?.profile?.files ?? [];
  if (!loaded || files.length === 0) return null;

  const open = async (f: ProfileFile) => {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(f.r2_key)}`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      alert('Failed to open file');
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-2">
        From {data?.anchorOrg?.name ? (
          <Link to={`/organisations/${data.anchorOrg.id}?tab=rehearsal`} className="text-ooosh-600 hover:underline">
            {data.anchorOrg.name}
          </Link>
        ) : 'the band'}'s rehearsal profile
      </h3>
      <p className="text-xs text-gray-400 mb-2">Shared across every booking. Managed on the band's Rehearsals tab.</p>
      <div className="space-y-1.5">
        {files.map((f) => (
          <button key={f.r2_key} onClick={() => open(f)} className="block text-sm text-ooosh-600 hover:underline truncate">
            🎚 {f.filename}
          </button>
        ))}
      </div>
    </div>
  );
}
