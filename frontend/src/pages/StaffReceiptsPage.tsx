import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * My Receipts — every staff card-holder (any role) can attach receipts to their
 * own company-card (COT) costs that are missing one. This is where the receipt
 * chaser email lands, so general assistants have a place they can actually go.
 * Uses the already-open /api/costs endpoints (list is `mine`-scoped, PATCH
 * attaches the receipt).
 */
interface Cost {
  id: string;
  supplier_name: string | null;
  description: string | null;
  amount_gross: string | number | null;
  cost_date: string | null;
}

async function uploadReceipt(costId: string, file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('attachment_only', 'true');
  const res = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
  await api.patch(`/costs/${costId}`, { receipt_r2_key: res.r2_key, receipt_filename: res.filename });
}

function money(v: string | number | null): string {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return `£${(n || 0).toFixed(2)}`;
}

export default function StaffReceiptsPage() {
  const [costs, setCosts] = useState<Cost[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<{ data: Cost[] }>('/costs?missing_receipt=1&mine=1');
      setCosts(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onUpload = async (cost: Cost, file: File | undefined) => {
    if (!file) return;
    setBusyId(cost.id);
    setError(null);
    try { await uploadReceipt(cost.id, file); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusyId(null); }
  };

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">My Receipts</h1>
      <p className="text-gray-500 mb-6">Company-card purchases of yours that still need a receipt. Attach one so it can be reconciled.</p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 text-red-700 text-sm">{error}</div>}

      {costs.length === 0 ? (
        <div className="p-4 rounded-lg bg-green-50 text-green-700 text-sm">All caught up — no receipts outstanding. ✓</div>
      ) : (
        <div className="space-y-2">
          {costs.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-lg p-4">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{c.supplier_name || c.description || 'Company-card purchase'}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {money(c.amount_gross)}{c.cost_date && <> · {new Date(c.cost_date).toLocaleDateString('en-GB')}</>}
                </div>
              </div>
              <label className="shrink-0 px-4 py-2 rounded-md bg-purple-700 text-white text-sm font-medium hover:bg-purple-800 cursor-pointer">
                {busyId === c.id ? 'Uploading…' : 'Upload receipt'}
                <input type="file" className="hidden" accept="image/*,.pdf" capture="environment"
                  disabled={busyId === c.id}
                  onChange={(e) => onUpload(c, e.target.files?.[0])} />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
