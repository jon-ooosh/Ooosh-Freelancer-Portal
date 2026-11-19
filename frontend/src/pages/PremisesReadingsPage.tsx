/**
 * Enter meter readings — the phone screen a meter's To Do opens
 * (docs/PREMISES-COMPLIANCE-SPEC.md §14).
 *
 * Every meter the person can see, one box each: type the number, take a photo
 * of the dial, save them all in one go. Each reading is checked against the
 * meter's history as it's typed (GET …/reading-check) — lower than last time,
 * or over three times a usual week, is a WARNING; nothing is refused. Each saved
 * reading ticks that meter's To Do.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { ukToday } from '../lib/ukDate';
import { uploadRecordFiles } from '../components/premises/RecordModal';
import { Meter, ReadingAssessment, fmtDate, fmtNumber, readingWarning, statusPill } from '../components/premises/premisesCopy';

interface Entry { value: string; replaced: boolean; photos: File[]; state: 'idle' | 'saving' | 'saved' | 'error'; message?: string }
const blank: Entry = { value: '', replaced: false, photos: [], state: 'idle' };

function MeterCard({ meter, entry, onChange }: { meter: Meter; entry: Entry; onChange: (e: Entry) => void }) {
  const [assessment, setAssessment] = useState<ReadingAssessment | null>(null);
  const value = entry.value.trim() === '' ? null : Number(entry.value);
  const valueOk = value !== null && Number.isFinite(value);

  useEffect(() => {
    if (!valueOk) { setAssessment(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ data: ReadingAssessment }>(
        `/premises/checks/${meter.id}/reading-check?value=${value}&done_on=${ukToday()}&replaced=${entry.replaced ? 1 : 0}`)
        .then(res => { if (live) setAssessment(res.data); })
        .catch(() => { if (live) setAssessment(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [meter.id, value, valueOk, entry.replaced]);

  const pill = statusPill(meter);
  const warning = readingWarning(assessment, meter.unit);
  const done = entry.state === 'saved';
  return (
    <div className={`bg-white border rounded-lg p-4 space-y-2 ${done ? 'border-green-300' : 'border-gray-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/operations/premises/checks/${meter.id}`} className="font-semibold text-gray-900 hover:underline">{meter.title}</Link>
          <div className="text-xs text-gray-500">{meter.place_name}{meter.meter_serial ? ` · ${meter.meter_serial}` : ''}</div>
        </div>
        {!done && <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${pill.cls}`}>{pill.text}</span>}
        {done && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">Saved</span>}
      </div>
      <div className="text-xs text-gray-600">
        {meter.last_reading
          ? <>Last: <b className="tabular-nums">{fmtNumber(meter.last_reading.value, 3)}{meter.unit ? ` ${meter.unit}` : ''}</b> on {fmtDate(meter.last_reading.done_on)}</>
          : 'No reading yet — this one starts it off.'}
      </div>
      {!done && (
        <>
          <input inputMode="decimal" value={entry.value} aria-label={`Reading for ${meter.title}`}
            onChange={e => onChange({ ...entry, value: e.target.value.replace(/[^0-9.]/g, ''), state: 'idle', message: undefined })}
            placeholder={meter.unit ? `Reading in ${meter.unit}` : 'Reading'}
            className="w-full px-3 py-2.5 border-2 border-ooosh-300 focus:border-ooosh-600 rounded-lg text-xl tabular-nums tracking-wide" />
          {assessment?.previous && !assessment.flag && assessment.used !== null && (
            <p className="text-xs text-gray-500">+{fmtNumber(assessment.used)}{meter.unit ? ` ${meter.unit}` : ''} since {fmtDate(assessment.previous.done_on)}</p>
          )}
          {warning && <p className="text-xs rounded bg-amber-50 text-amber-800 px-2 py-1.5">{warning}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-ooosh-600 cursor-pointer hover:underline">
              {entry.photos.length ? `📷 ${entry.photos.length} photo${entry.photos.length > 1 ? 's' : ''}` : '+ Photo of the dial'}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                onChange({ ...entry, photos: [...entry.photos, ...picked] });
              }} />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={entry.replaced} onChange={e => onChange({ ...entry, replaced: e.target.checked })} />
              Meter replaced
            </label>
          </div>
          {entry.state === 'error' && <p className="text-xs text-red-700">{entry.message}</p>}
        </>
      )}
      {done && entry.message && <p className="text-xs text-amber-700">{entry.message}</p>}
    </div>
  );
}

export default function PremisesReadingsPage() {
  const [meters, setMeters] = useState<Meter[] | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<{ data: Meter[] }>('/premises/meters');
    setMeters(res.data);
  }, []);
  useEffect(() => { load().catch(err => setError(err instanceof Error ? err.message : 'Could not load the meters')); }, [load]);

  const entryFor = (id: string) => entries[id] ?? blank;
  const toSave = (meters ?? []).filter(m => {
    const e = entryFor(m.id);
    return e.state !== 'saved' && e.value.trim() !== '' && Number.isFinite(Number(e.value));
  });

  async function saveAll() {
    setSaving(true); setError(null);
    for (const m of toSave) {
      const e = entryFor(m.id);
      setEntries(prev => ({ ...prev, [m.id]: { ...e, state: 'saving' } }));
      try {
        const res = await api.post<{ data: { id: string } }>(`/premises/checks/${m.id}/records`, {
          done_on: ukToday(), reading_value: Number(e.value), meter_replaced: e.replaced,
        });
        const failed = e.photos.length ? await uploadRecordFiles(res.data.id, e.photos) : [];
        setEntries(prev => ({ ...prev, [m.id]: {
          ...e, state: 'saved',
          message: failed.length ? 'Saved — the photo didn’t upload; add it on the meter’s page.' : undefined,
        } }));
      } catch (err) {
        setEntries(prev => ({ ...prev, [m.id]: { ...e, state: 'error', message: err instanceof Error ? err.message : 'Not saved' } }));
      }
    }
    setSaving(false);
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-6 pb-28">
      <div className="text-xs text-gray-500 mb-1"><Link to="/operations/premises" className="hover:underline">Premises &amp; compliance</Link></div>
      <h1 className="text-2xl font-bold text-gray-900">Enter meter readings</h1>
      <p className="text-sm text-gray-500 mb-4">Type each number as it shows on the meter, and snap the dial if you can. Today's date is used.</p>
      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
      {meters === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : meters.length === 0 ? (
        <p className="text-sm text-gray-600">No meters set up yet — add one on Premises &amp; compliance as a "Meter reading" check.</p>
      ) : (
        <div className="space-y-3">
          {meters.map(m => (
            <MeterCard key={m.id} meter={m} entry={entryFor(m.id)} onChange={e => setEntries(prev => ({ ...prev, [m.id]: e }))} />
          ))}
        </div>
      )}
      {meters && meters.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 bg-white/95 border-t border-gray-200 px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
          <div className="max-w-xl mx-auto">
            <button type="button" onClick={() => void saveAll()} disabled={saving || toSave.length === 0}
              className="w-full py-3 rounded-lg bg-ooosh-600 text-white font-semibold disabled:opacity-40">
              {saving ? 'Saving…' : toSave.length > 1 ? `Save ${toSave.length} readings` : toSave.length === 1 ? 'Save reading' : 'Type a reading to save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
