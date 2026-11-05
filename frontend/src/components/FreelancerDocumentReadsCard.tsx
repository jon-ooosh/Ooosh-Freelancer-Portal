import { useEffect, useState } from 'react';
import { api } from '../services/api';

// ---------------------------------------------------------------------------
// "Documents to read" on a freelancer's Freelancer tab: every Staff Document
// that asks freelancers to confirm they've read it, and when this person did
// (backend services/freelancer-document-reads.ts). A read belongs to a version,
// so a new version shows as "Not yet" again. Hidden when no document asks.
// ---------------------------------------------------------------------------

interface DocRead { id: string; title: string; version: number; readAt: string | null }

export default function FreelancerDocumentReadsCard({ personId }: { personId: string }) {
  const [docs, setDocs] = useState<DocRead[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ data: DocRead[] }>(`/staff-documents/freelancer-reads/person/${personId}`)
      .then((r) => { if (!cancelled) setDocs(r.data); })
      .catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [personId]);

  if (!docs || docs.length === 0) return null;
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const unread = docs.filter((d) => !d.readAt).length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold text-gray-900">Documents to read</h3>
        <span className={`text-xs ${unread ? 'text-amber-700' : 'text-green-700'}`}>
          {unread ? `${unread} not read yet` : 'All read'}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Asked of every freelancer in the portal (Staff Documents). A tick means they tapped
        &ldquo;I&apos;ve read and understood this&rdquo; for the current version.
      </p>
      <ul className="divide-y divide-gray-100">
        {docs.map((d) => (
          <li key={d.id} className="py-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="text-gray-800">{d.title} <span className="text-xs text-gray-400">v{d.version}</span></span>
            {d.readAt
              ? <span className="text-xs text-green-700 whitespace-nowrap">✓ Read {when(d.readAt)}</span>
              : <span className="text-xs text-amber-700 whitespace-nowrap">Not yet</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
