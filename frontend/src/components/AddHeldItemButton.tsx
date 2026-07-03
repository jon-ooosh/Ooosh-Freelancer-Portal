/**
 * "+ Add item" — logs a held item (temp storage / delivery / lost property)
 * straight from a job's Overview "Held for Clients" card, without leaving the
 * page. Reuses the same shared HeldItemForm as the /holding "Log Item" modal
 * and the mobile /quick sheet, so behaviour (notify-at-create, photos, owner
 * linking) stays in lockstep.
 *
 * The job is pre-filled: HH number + client org seed the form so staff don't
 * re-enter what we already know. Defaults to Temp Storage (kinds[0]) — the
 * "band left kit with us" case — but the toggle still offers Delivery and Lost
 * property.
 */
import { useState } from 'react';
import { api } from '../services/api';
import { HeldItemForm } from './holding/HeldItemForm';
import type { HeldItemLocation } from '../../../shared/types';

export default function AddHeldItemButton({
  hhJobNumber,
  clientOrgId,
  clientOrgName,
  onSaved,
}: {
  hhJobNumber?: number | null;
  clientOrgId?: string | null;
  clientOrgName?: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);

  function openModal() {
    setOpen(true);
    // Lazy-load the location picklist the first time it's needed.
    if (locations.length === 0) {
      api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {});
    }
  }

  return (
    <>
      <button onClick={openModal} className="text-xs text-[#7B5EA7] font-medium hover:underline">＋ Add item</button>

      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h3 className="font-semibold text-slate-800">Log held item</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <HeldItemForm
                variant="desktop"
                kinds={['temp_storage', 'incoming', 'lost_property']}
                locations={locations}
                initial={{
                  hh_job_number: hhJobNumber ? String(hhJobNumber) : '',
                  owner_organisation_id: clientOrgId ?? null,
                  org_name: clientOrgName || '',
                }}
                onDone={() => { setOpen(false); onSaved(); }}
                onCancel={() => setOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
