/**
 * RehearsalProfileFiles — read-only surfacing of the band's rehearsal-profile
 * files (mix files, stage plots, layout photos) on the Job Detail Files tab.
 * Once a job has a band anchor, the band's profile files "rise up" here so
 * staff don't re-attach a stage plot on every booking. Surfaced, not copied —
 * the files stay owned by organisation_rehearsal_profile and are managed on the
 * band's Rehearsals tab. Self-hides when there are none.
 *
 * Props-driven: JobDetailPage fetches the band profile once (so the count can
 * feed the Files tab badge) and passes the files + anchor down here.
 */
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface ProfileFile { r2_key: string; filename: string; label?: string | null; comment?: string | null }

export default function RehearsalProfileFiles({
  anchorOrg,
  files,
}: {
  anchorOrg: { id: string; name: string | null } | null;
  files: ProfileFile[];
}) {
  if (!files.length) return null;

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
        From {anchorOrg?.name ? (
          <Link to={`/organisations/${anchorOrg.id}?tab=rehearsal`} className="text-ooosh-600 hover:underline">
            {anchorOrg.name}
          </Link>
        ) : 'the band'}'s rehearsal profile
      </h3>
      <p className="text-xs text-gray-400 mb-2">Shared across every booking. Managed on the band's Rehearsals tab.</p>
      <div className="space-y-2">
        {files.map((f) => (
          <div key={f.r2_key} className="text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => open(f)} className="text-ooosh-600 hover:underline truncate">
                🎚 {f.filename}
              </button>
              {f.label && (
                <span className="inline-block rounded bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5">{f.label}</span>
              )}
            </div>
            {f.comment && <p className="text-xs text-gray-500 mt-0.5">{f.comment}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
