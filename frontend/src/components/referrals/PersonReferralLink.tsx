/**
 * A person's personal referral link (docs/BUSINESS-FIGURES-SPEC.md §8d): shown with Copy
 * once it exists (Jon's review email makes one automatically), or "Make a referral link".
 * Links belong to people, never bands. Backend: routes/referrals.ts.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';

interface Summary { link: { code: string; url: string; urlText: string; scans: number } | null; referred: number; thanked: number }

export default function PersonReferralLink({ personId }: { personId: string }) {
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<{ data: Summary }>(`/referrals/person/${personId}`).then((r) => { if (live) setS(r.data); }).catch(() => {});
    return () => { live = false; };
  }, [personId]);

  if (!s) return null;

  const make = async () => {
    setBusy(true);
    try { setS((await api.post<{ data: Summary }>(`/referrals/person/${personId}/link`, {})).data); } catch { /* stays as it was */ }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!s.link) return;
    try { await navigator.clipboard.writeText(s.link.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the link is on screen */ }
  };

  return (
    <div className="mt-3 text-xs text-gray-500 flex flex-wrap items-center gap-2">
      <span>🤝 Referral link:</span>
      {s.link ? (
        <>
          <span className="font-mono text-gray-700">{s.link.urlText}</span>
          <button type="button" onClick={copy} className="text-ooosh-700 hover:underline">{copied ? 'Copied' : 'Copy'}</button>
          <span className="text-gray-400">
            · {s.link.scans} {s.link.scans === 1 ? 'visit' : 'visits'} · {s.referred} referred{s.thanked ? ` · ${s.thanked} thanked` : ''}
          </span>
        </>
      ) : (
        <button type="button" onClick={make} disabled={busy} className="text-ooosh-700 hover:underline disabled:opacity-50">
          Make a referral link
        </button>
      )}
    </div>
  );
}
