/**
 * Public van sale page — /van/:token (docs/VEHICLE-SALES-SPEC.md §6).
 *
 * No login: the token is the credential. What this buyer sees was decided
 * server-side by the link's switches (services/vehicle-sale-links.ts); this
 * page only renders it. A revoked link, a closed sale and a bad token all show
 * the same "no longer available" (Q6). `?preview=1` is staff checking the
 * page — passed through so the view isn't counted.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { BuyerSaleBody, type BuyerResult } from '../components/vehicle-sale/BuyerSections';

export default function VehicleForSalePage() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const preview = searchParams.get('preview') === '1';
  const [data, setData] = useState<BuyerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: BuyerResult }>(
          `/vehicle-sales/public/${encodeURIComponent(token ?? '')}${preview ? '?preview=1' : ''}`,
        );
        if (!cancelled) setData(res.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load this page');
      }
    })();
    return () => { cancelled = true; };
  }, [token, preview]);

  useEffect(() => {
    if (data?.state === 'available') document.title = `${data.reg} for sale — Ooosh Tours`;
  }, [data]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <img src="/ooosh-logo-full.jpg" alt="Ooosh Tours" className="h-9" />
          {preview && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              Staff preview — not counted as a view
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-5">
        {error && <p className="py-16 text-center text-gray-500">{error}</p>}
        {!error && !data && <p className="py-16 text-center text-gray-400">Loading…</p>}
        {data?.state === 'unavailable' && (
          <p className="py-16 text-center text-gray-600">This vehicle is no longer available.</p>
        )}
        {data?.state === 'available' && <BuyerSaleBody p={data} />}
      </main>
    </div>
  );
}
