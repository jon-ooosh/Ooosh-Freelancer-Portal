import { useRef, useState } from 'react';
import { api } from '../../services/api';
import { DocumentThumb } from './DocumentThumb';

/**
 * One block of evidence: the image(s), the date staff set, the expiry OP
 * derived, and the actions — together.
 *
 * Replaces the old split where "Document Validity" was one card and "Documents"
 * a separate card 400px below with nothing tying an image to its date. That
 * layout is why staff kept forgetting to update dates when they uploaded a
 * replacement by hand: the two halves of the same fact were never on screen at
 * the same time.
 *
 * A group can hold several files under one window — the licence is front, back
 * and selfie sharing a single 90-day check, which is also why the date prompt
 * asks once per group rather than once per file.
 */

export interface EvidenceFile {
  url: string;
  name?: string;
  label?: string;
  tag?: string;
  uploaded_at?: string;
}

export interface EvidenceSlot {
  /** Which file in this group — 'Licence Front', 'Selfie', … */
  label: string;
  /** Accepted label/tag spellings. Matched on a normalised token. */
  match: string[];
  hint?: string;
}

export interface EvidenceGroupSpec {
  key: string;
  title: string;
  slots: EvidenceSlot[];
  /** The FROM date column staff edit, e.g. 'dvla_check_date'. */
  fromField?: string;
  fromLabel?: string;
  /** A free-text field that travels with the document, e.g. 'poa1_provider'. */
  textField?: string;
  textLabel?: string;
  /** The document's own expiry, where it has one. */
  docExpiryField?: string;
  docExpiryLabel?: string;
  /** OP-derived expiry, display only. */
  until?: string | null;
  /** Explanation shown when there is no derived window. */
  emptyHint?: string;
}

/**
 * Normalised match — lowercase, strip non-alphanumerics, compare tag then label.
 *
 * Upload paths spell the same document several ways ('licence_front' /
 * 'license_front' / 'Licence Front'), which is how the driver snapshot PDF
 * silently dropped licence and POA images for months. Matching on a token
 * rather than an exact string means a new variant doesn't break the group.
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function filesForSlot(files: EvidenceFile[], slot: EvidenceSlot): EvidenceFile[] {
  const wanted = new Set(slot.match.map(norm));
  return files.filter(f => {
    const tag = f.tag ? norm(f.tag) : '';
    const label = f.label ? norm(f.label) : '';
    return (tag && wanted.has(tag)) || (label && wanted.has(label));
  });
}

function latest(files: EvidenceFile[]): EvidenceFile | null {
  if (files.length === 0) return null;
  return files.reduce((a, b) =>
    new Date(a.uploaded_at || 0) > new Date(b.uploaded_at || 0) ? a : b);
}

function ExpiryPill({ until }: { until: string | null | undefined }) {
  if (!until) return <span className="text-xs text-gray-400">No expiry set</span>;
  const exp = new Date(until);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((exp.getTime() - today.getTime()) / 86400000);
  const tone = days < 0
    ? 'bg-red-100 text-red-700'
    : days <= 30 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${tone}`}>
      {days < 0 ? 'Expired ' : 'Valid to '}
      {exp.toLocaleDateString('en-GB')}
      {days >= 0 && days <= 30 && ` (${days}d)`}
    </span>
  );
}

export function EvidenceGroup({
  spec, files, driverId, dates, canEdit, onFilesChanged, onDateChanged,
}: {
  spec: EvidenceGroupSpec;
  files: EvidenceFile[];
  driverId: string;
  /** Current values for every editable field on the spec (dates AND text). */
  dates: Record<string, string | null>;
  canEdit: boolean;
  onFilesChanged: (files: EvidenceFile[]) => void;
  /** Persists one field — dates and the provider text go through the same PATCH. */
  onDateChanged: (field: string, value: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingSlot, setPendingSlot] = useState<EvidenceSlot | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  // After an upload we ask for the date, because that is the step staff forget.
  const [askDate, setAskDate] = useState<{ value: string; alsoAskBack: boolean } | null>(null);
  const [savingDate, setSavingDate] = useState(false);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const slot = pendingSlot;
    if (!file || !slot) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('entity_type', 'drivers');
      form.append('entity_id', driverId);
      form.append('label', slot.label);
      form.append('tag', norm(slot.label));
      const result = await api.upload<EvidenceFile>('/files/upload', form);
      onFilesChanged([...files, result]);

      // Soft-force the date. Deliberately AMBER, not a hard gate — the file is
      // already saved, and refusing to store a document because someone can't
      // read the date off it would be the same mistake as the book-out gate.
      //
      // Skipped when the user can't save dates (that's manager-tier, while
      // uploading is not) — they'd have no way to answer the prompt. The
      // amber "no date set" marker and the What-needs-doing line stay, so the
      // gap is still visible for a manager to clear.
      if (spec.fromField && canEdit) {
        setAskDate({
          value: dates[spec.fromField] || '',
          // Uploading a licence front prompts for the back; they share one window.
          alsoAskBack: /front/i.test(slot.label)
            && spec.slots.some(sl => /back/i.test(sl.label))
            && filesForSlot(files, spec.slots.find(sl => /back/i.test(sl.label))!).length === 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setPendingSlot(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function saveDate() {
    if (!spec.fromField || !askDate) return;
    setSavingDate(true);
    try {
      await onDateChanged(spec.fromField, askDate.value);
      setAskDate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the date');
    } finally {
      setSavingDate(false);
    }
  }

  async function handleOpen(file: EvidenceFile) {
    try {
      const { blob, contentType } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
      const url = URL.createObjectURL(new Blob([blob], { type: contentType }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('Could not open that file');
    }
  }

  const fromValue = spec.fromField ? dates[spec.fromField] : null;
  const missingDate = !!spec.fromField && !fromValue;

  // Date inputs are held locally and committed on blur. `type="date"` fires
  // onChange on partial edits in some browsers, so saving per keystroke would
  // PUT half-typed values (and re-derive the expiry from each one).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const shown = (field: string) => draft[field] ?? dates[field] ?? '';
  async function commit(field: string) {
    const value = draft[field];
    if (value === undefined || value === (dates[field] ?? '')) return;
    try {
      await onDateChanged(field, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the date');
    } finally {
      setDraft(d => { const next = { ...d }; delete next[field]; return next; });
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5" id={`evidence-${spec.key}`}>
      <input
        ref={inputRef} type="file" onChange={handleUpload} className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
      />

      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <h3 className="text-sm font-semibold text-gray-700">{spec.title}</h3>
        <div className="text-right">
          <ExpiryPill until={spec.until} />
          {!spec.until && spec.emptyHint && (
            <p className="text-[11px] text-amber-600 mt-0.5 max-w-[18rem]">{spec.emptyHint}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <div className="flex flex-wrap gap-4">
        {spec.slots.map((slot) => {
          const slotFiles = filesForSlot(files, slot);
          const newest = latest(slotFiles);
          return (
            <div key={slot.label} className="flex flex-col items-center gap-1.5 w-20">
              {newest ? (
                <DocumentThumb fileKey={newest.url} filename={newest.name} onOpen={() => handleOpen(newest)} />
              ) : (
                <div className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center text-[10px] text-gray-400 text-center px-1">
                  Not uploaded
                </div>
              )}
              {/* The caption only earns its space when it tells slots apart
                  (Front / Back / Selfie). Under a lone thumbnail it just
                  repeated the card title. */}
              {spec.slots.length > 1 && (
                <span className="text-[11px] text-gray-600 text-center leading-tight">{slot.label}</span>
              )}
              {canEdit && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => { setPendingSlot(slot); inputRef.current?.click(); }}
                  className="text-[11px] text-ooosh-600 hover:text-ooosh-700 disabled:opacity-50"
                >
                  {newest ? 'Replace' : 'Upload'}
                </button>
              )}
              {slotFiles.length > 1 && (
                <span className="text-[10px] text-gray-400">+{slotFiles.length - 1} older</span>
              )}
            </div>
          );
        })}
      </div>

      {spec.fromField && (
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="block text-[11px] text-gray-500 mb-0.5">{spec.fromLabel}</span>
            <input
              type="date"
              disabled={!canEdit}
              value={shown(spec.fromField)}
              onChange={(e) => setDraft(d => ({ ...d, [spec.fromField!]: e.target.value }))}
              onBlur={() => commit(spec.fromField!)}
              className={`rounded border px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 ${
                missingDate ? 'border-amber-400 bg-amber-50' : 'border-gray-300'
              }`}
            />
          </label>
          {spec.textField && (
            <label className="block">
              <span className="block text-[11px] text-gray-500 mb-0.5">{spec.textLabel}</span>
              <input
                type="text"
                disabled={!canEdit}
                value={shown(spec.textField)}
                placeholder="e.g. Barclays"
                onChange={(e) => setDraft(d => ({ ...d, [spec.textField!]: e.target.value }))}
                onBlur={() => commit(spec.textField!)}
                className="w-36 rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </label>
          )}
          {spec.docExpiryField && (
            <label className="block">
              <span className="block text-[11px] text-gray-500 mb-0.5">{spec.docExpiryLabel}</span>
              <input
                type="date"
                disabled={!canEdit}
                value={shown(spec.docExpiryField)}
                onChange={(e) => setDraft(d => ({ ...d, [spec.docExpiryField!]: e.target.value }))}
                onBlur={() => commit(spec.docExpiryField!)}
                className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </label>
          )}
          {missingDate && (
            <p className="text-[11px] text-amber-700 pb-1">
              No date set &mdash; expiry can&rsquo;t be worked out until there is one.
            </p>
          )}
        </div>
      )}
      </div>

      {askDate && spec.fromField && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900 mb-2">
            Uploaded. What&rsquo;s the <strong>{spec.fromLabel?.toLowerCase()}</strong>? Ooosh works the
            expiry out from it.
            {askDate.alsoAskBack && <> Don&rsquo;t forget the back of the licence too.</>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={askDate.value}
              onChange={(e) => setAskDate({ ...askDate, value: e.target.value })}
              className="rounded border border-amber-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
            <button
              type="button"
              disabled={!askDate.value || savingDate}
              onClick={saveDate}
              className="px-3 py-1.5 bg-ooosh-600 text-white rounded-lg text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50"
            >
              {savingDate ? 'Saving…' : 'Save date'}
            </button>
            <button
              type="button"
              onClick={() => setAskDate(null)}
              className="text-sm text-gray-600 hover:text-gray-800"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  );
}
