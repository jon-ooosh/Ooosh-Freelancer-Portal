import { useEffect, useState } from 'react';
import { api } from '../services/api';
import EndorsementsPanel, { type EndorsementBrand } from '../components/EndorsementsPanel';

/**
 * Operations › Backline – Endorsements. Every artist endorsement in one place,
 * plus the editable brand list. A reference, not a calculator — see
 * docs/DISCOUNTS-SPEC.md phase 1 and services/endorsements.ts.
 */
export default function EndorsementsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Backline – Endorsements</h1>
        <p className="mt-1 text-sm text-gray-500">
          Who is endorsed by which brand, the deal, and when a rep or A&amp;R last confirmed it.
          Anyone can record or confirm one. Over 12 months since the last check is flagged red.
        </p>
      </div>
      <EndorsementsPanel showFilters />
      <BrandsCard />
    </div>
  );
}

function BrandsCard() {
  const [brands, setBrands] = useState<EndorsementBrand[]>([]);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDeal, setNewDeal] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get<{ data: EndorsementBrand[] }>('/endorsements/brands?include_inactive=true')
    .then((r) => setBrands(r.data || [])).catch(() => setBrands([]));
  useEffect(() => { if (open) load(); }, [open]);

  async function save(b: EndorsementBrand, fields: Partial<EndorsementBrand>) {
    setError('');
    try {
      await api.put(`/endorsements/brands/${b.id}`, fields);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError('');
    try {
      await api.post('/endorsements/brands', { name: newName.trim(), standard_deal: newDeal.trim() || null });
      setNewName('');
      setNewDeal('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add');
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-semibold text-gray-700">Brands and their standard deals</span>
        <span className="text-gray-400 text-sm">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3">
          {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}
          <p className="text-xs text-gray-500">The standard deal shows wherever an endorsement doesn’t have its own. Free text — nothing is calculated from it.</p>
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {brands.map((b) => (
                <tr key={b.id} className={b.is_active ? '' : 'opacity-50'}>
                  <td className="py-2 pr-4 font-medium text-gray-900 whitespace-nowrap">{b.name}</td>
                  <td className="py-2 pr-4 w-full">
                    <input
                      defaultValue={b.standard_deal || ''}
                      onBlur={(e) => { if (e.target.value !== (b.standard_deal || '')) save(b, { standard_deal: e.target.value || null }); }}
                      placeholder="Standard deal…"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none"
                    />
                  </td>
                  <td className="py-2 whitespace-nowrap text-right">
                    <button onClick={() => save(b, { is_active: !b.is_active })} className="text-xs text-gray-600 hover:underline">
                      {b.is_active ? 'Hide from pickers' : 'Show again'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={add} className="flex flex-wrap gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New brand" className="rounded border border-gray-300 px-3 py-1.5 text-sm" />
            <input value={newDeal} onChange={(e) => setNewDeal(e.target.value)} placeholder="Standard deal (optional)" className="flex-1 min-w-[12rem] rounded border border-gray-300 px-3 py-1.5 text-sm" />
            <button type="submit" className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Add brand</button>
          </form>
        </div>
      )}
    </div>
  );
}
