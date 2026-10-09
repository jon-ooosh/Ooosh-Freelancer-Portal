/**
 * The buyer-facing sections of a van sale page (docs/VEHICLE-SALES-SPEC.md §6.3).
 *
 * Mirrors the payload built by backend/src/services/vehicle-sale-links.ts
 * `shapeForBuyer()` — the ONLY place that decides what a buyer may see. These
 * components just render whatever arrives; an absent section was switched off
 * for this link and is never sent.
 *
 * Built as standalone pieces so the future "vehicle info pack" (selective
 * sharing of vehicle data with clients) can reuse them.
 */


// ── Payload (keep in step with BuyerPayload in the backend) ────────────────

export interface BuyerMotDefect { type: string | null; text: string | null; dangerous: boolean }
export interface BuyerMotTest {
  completedDate: string | null; result: string; expiryDate: string | null;
  odometer: number | null; odometerUnit: 'MI' | 'KM' | null; testNumber: string | null;
  defects: BuyerMotDefect[];
}

export interface BuyerPayload {
  state: 'available';
  reg: string;
  title: string;
  vehicle: {
    make: string | null; model: string | null; colour: string | null; seats: number | null;
    fuelType: string | null; gearbox: string | null; year: number | null; mileage: number | null;
    bodyType: string | null;
  };
  v5: {
    vin: string | null; dateFirstReg: string | null; bodyType: string | null; typeDesignation: string | null;
    category: string | null; maxMassKg: number | null; engineCc: number | null;
  };
  keyDates: { motDue: string | null; taxDue: string | null; lastServiceDate: string | null; ulezCompliant: boolean | null };
  description: string | null;
  photos: Array<{ url: string; label: string | null }>;
  price?: { amount: number; vatBasis: 'plus' | 'inc' };
  serviceHistory?: Array<{ date: string; mileage: number | null; type: string; description: string; garage: string | null }>;
  motHistory?: { fetchedAt: string | null; hasOutstandingRecall: string | null; tests: BuyerMotTest[] } | null;
  mileageHistory?: Array<{ month: string; mileage: number }>;
  damageHistory?: Array<{ date: string; summary: string; status: 'Repaired' | 'Closed' | 'Outstanding' }>;
  contact: string | null;
}

export type BuyerResult = BuyerPayload | { state: 'unavailable' };

// ── Formatting (range-checked: a bad value renders '—', never throws) ──────

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtMonth(m: string): string {
  const date = new Date(m + '-01T00:00:00');
  if (Number.isNaN(date.getTime())) return m;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

const miles = (n: number | null | undefined) => (n != null ? `${n.toLocaleString('en-GB')} mi` : '—');
const titleCase = (s: string | null) =>
  s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '—';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-gray-100 py-1.5 text-sm">
          <dt className="text-gray-500">{k}</dt>
          <dd className="text-right text-gray-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Sections ───────────────────────────────────────────────────────────────

export function BuyerHeadline({ p }: { p: BuyerPayload }) {
  const bits = [p.vehicle.year, p.vehicle.gearbox, p.vehicle.fuelType && titleCase(p.vehicle.fuelType),
    p.vehicle.seats ? `${p.vehicle.seats} seats` : null, p.vehicle.mileage != null ? miles(p.vehicle.mileage) : null]
    .filter(Boolean);
  return (
    <div>
      <p className="font-mono text-sm font-bold tracking-wider text-gray-500">{p.reg}</p>
      <h1 className="text-2xl font-bold text-ooosh-navy">{titleCase(p.title)}</h1>
      <p className="mt-1 text-sm text-gray-600">{bits.join(' · ')}</p>
      {p.price && (
        <p className="mt-2 text-2xl font-bold text-gray-900">
          {p.price.amount.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })}
          <span className="ml-1.5 text-sm font-normal text-gray-500">{p.price.vatBasis === 'plus' ? '+VAT' : 'inc. VAT'}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Each photo is a plain link to the full-size image in a new tab (jon, Oct
 * 2026). It was an in-page lightbox, which on a phone could not be zoomed and
 * let a swipe scroll the page underneath instead of the picture. The browser's
 * own image view does pinch-zoom and scrolling properly, and the photos are on
 * the public bucket so a bare link needs no auth.
 */
export function BuyerPhotos({ photos }: { photos: BuyerPayload['photos'] }) {
  if (photos.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {photos.map((ph, i) => (
        <a key={ph.url} href={ph.url} target="_blank" rel="noopener noreferrer"
          title={`${ph.label ?? 'Vehicle photo'} — opens full size in a new tab`}
          className={`block overflow-hidden rounded-lg bg-gray-100 ${i === 0 ? 'col-span-2 sm:col-span-3' : ''}`}>
          <img src={ph.url} alt={ph.label ?? 'Vehicle photo'} loading={i < 3 ? 'eager' : 'lazy'}
            className={`w-full object-cover ${i === 0 ? 'aspect-[16/9]' : 'aspect-[4/3]'}`} />
        </a>
      ))}
    </div>
  );
}

export function BuyerDescription({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Card title="About this vehicle">
      <p className="whitespace-pre-line text-sm text-gray-800">{text}</p>
    </Card>
  );
}

export function BuyerFacts({ p }: { p: BuyerPayload }) {
  return (
    <Card title="Vehicle details">
      <Rows rows={[
        ['Make', titleCase(p.vehicle.make)],
        ['Model', titleCase(p.vehicle.model)],
        ['Colour', titleCase(p.vehicle.colour)],
        ['Seats', p.vehicle.seats != null ? String(p.vehicle.seats) : '—'],
        ['Fuel', titleCase(p.vehicle.fuelType)],
        ['Gearbox', p.vehicle.gearbox ?? '—'],
        ['Mileage', miles(p.vehicle.mileage)],
        ['First registered', fmtDate(p.v5.dateFirstReg)],
        ['Body type', titleCase(p.v5.bodyType)],
        ['Engine', p.v5.engineCc != null ? `${p.v5.engineCc.toLocaleString('en-GB')} cc` : '—'],
        ['Max. weight', p.v5.maxMassKg != null ? `${p.v5.maxMassKg.toLocaleString('en-GB')} kg` : '—'],
        ['Category', p.v5.category ?? '—'],
        ['VIN', p.v5.vin ?? '—'],
        ['MOT until', fmtDate(p.keyDates.motDue)],
        ['Taxed until', fmtDate(p.keyDates.taxDue)],
        ['Last service', fmtDate(p.keyDates.lastServiceDate)],
        ['ULEZ', p.keyDates.ulezCompliant == null ? '—' : p.keyDates.ulezCompliant ? 'Compliant' : 'Not compliant'],
      ]} />
    </Card>
  );
}

export function BuyerServiceHistory({ rows }: { rows: BuyerPayload['serviceHistory'] }) {
  if (!rows) return null;
  return (
    <Card title="Service history">
      {rows.length === 0 ? <p className="text-sm text-gray-500">No service records to show.</p> : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <li key={i} className="py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-gray-900">{r.description || r.type}</span>
                <span className="text-xs text-gray-500">{fmtDate(r.date)}</span>
              </div>
              <div className="text-xs text-gray-500">
                {[r.type, r.mileage != null ? miles(r.mileage) : null, r.garage].filter(Boolean).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const DEFECT_STYLE: Record<string, string> = {
  DANGEROUS: 'bg-red-100 text-red-800', MAJOR: 'bg-red-50 text-red-700', FAIL: 'bg-red-50 text-red-700',
  MINOR: 'bg-amber-50 text-amber-700', ADVISORY: 'bg-gray-100 text-gray-600',
};

export function BuyerMotHistory({ mot }: { mot: BuyerPayload['motHistory'] | undefined }) {
  if (mot === undefined) return null;
  return (
    <Card title="MOT history (DVSA)">
      {!mot || mot.tests.length === 0 ? (
        <p className="text-sm text-gray-500">No MOT tests on record yet.</p>
      ) : (
        <>
          {mot.hasOutstandingRecall === 'Yes' && (
            <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">DVSA reports an outstanding manufacturer recall.</p>
          )}
          <ul className="space-y-3">
            {mot.tests.map((t, i) => {
              const passed = t.result === 'PASSED';
              return (
                <li key={t.testNumber ?? i} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                      {passed ? 'PASS' : 'FAIL'}
                    </span>
                    <span className="font-medium text-gray-900">{fmtDate(t.completedDate)}</span>
                    <span className="text-xs text-gray-500">
                      {t.odometer != null ? `${t.odometer.toLocaleString('en-GB')} ${t.odometerUnit === 'KM' ? 'km' : 'mi'}` : ''}
                    </span>
                  </div>
                  {t.defects.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {t.defects.map((d, j) => {
                        const type = d.dangerous ? 'DANGEROUS' : (d.type ?? '');
                        return (
                          <li key={j} className="flex items-start gap-2 text-xs">
                            <span className={`shrink-0 rounded px-1 ${DEFECT_STYLE[type] ?? 'bg-gray-100 text-gray-600'}`}>
                              {type ? type.charAt(0) + type.slice(1).toLowerCase() : 'Note'}
                            </span>
                            <span className="text-gray-700">{d.text ?? ''}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

export function BuyerMileageHistory({ rows }: { rows: BuyerPayload['mileageHistory'] }) {
  if (!rows) return null;
  return (
    <Card title="Mileage history">
      {rows.length === 0 ? <p className="text-sm text-gray-500">No readings to show.</p> : (
        <Rows rows={[...rows].reverse().map((r) => [fmtMonth(r.month), miles(r.mileage)])} />
      )}
    </Card>
  );
}

export function BuyerDamageHistory({ rows }: { rows: BuyerPayload['damageHistory'] }) {
  if (!rows) return null;
  return (
    <Card title="Damage & repair history">
      {rows.length === 0 ? <p className="text-sm text-gray-500">Nothing recorded.</p> : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div>
                <div className="text-gray-900">{r.summary}</div>
                <div className="text-xs text-gray-500">{fmtDate(r.date)}</div>
              </div>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                r.status === 'Outstanding' ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-800'
              }`}>{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function BuyerContact({ contact }: { contact: string | null }) {
  if (!contact) return null;
  return (
    <section className="rounded-xl bg-ooosh-navy p-4 text-white">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">Interested?</h2>
      <p className="mt-1 whitespace-pre-line text-sm">{contact}</p>
    </section>
  );
}

/** The whole page body, in order. The info pack can pick sections instead. */
export function BuyerSaleBody({ p }: { p: BuyerPayload }) {
  return (
    <div className="space-y-4">
      <BuyerHeadline p={p} />
      <BuyerPhotos photos={p.photos} />
      <BuyerDescription text={p.description} />
      <BuyerFacts p={p} />
      <BuyerServiceHistory rows={p.serviceHistory} />
      <BuyerMotHistory mot={p.motHistory} />
      <BuyerMileageHistory rows={p.mileageHistory} />
      <BuyerDamageHistory rows={p.damageHistory} />
      <BuyerContact contact={p.contact} />
    </div>
  );
}
