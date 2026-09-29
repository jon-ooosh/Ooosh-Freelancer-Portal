/**
 * The possible-claim form's field controls, shared by the staff case page and
 * the public client form (docs/INCIDENT-CLAIMS-SPEC.md). Rendered from the one
 * field catalogue (`@claimform`). `large` gives phone-sized touch targets.
 */
import { ClaimFieldDef, ClaimSectionDef, isFieldShown } from '@claimform';

type Row = Record<string, unknown>;

export function FieldInput({ def, value, onChange, large }: { def: ClaimFieldDef; value: unknown; onChange: (v: unknown) => void; large?: boolean }) {
  const base = large
    ? 'w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base focus:border-ooosh-400'
    : 'w-full border border-slate-200 rounded px-2 py-1 text-sm focus:border-ooosh-400';
  const pill = large ? 'px-5 py-2.5 text-sm rounded-lg border' : 'px-3 py-1 text-xs rounded border';
  const chip = large ? 'px-3 py-2 text-sm rounded-full border' : 'px-2 py-0.5 text-xs rounded-full border';
  switch (def.kind) {
    case 'textarea':
      return <textarea rows={3} value={(value as string) || ''} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'date':
      return <input type="date" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'money':
      return <input type="number" min={0} step="1" value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={base} />;
    case 'yesno':
      return (
        <div className="flex gap-1">
          {([['Yes', true], ['No', false]] as const).map(([label, v]) => (
            <button
              key={label}
              type="button"
              onClick={() => onChange(value === v ? null : v)}
              className={`${pill} ${value === v ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-slate-600 border-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
      );
    case 'choice': {
      const opts = def.options || [];
      const current = (value as string) || '';
      return (
        <select value={current} onChange={(e) => onChange(e.target.value || null)} className={base}>
          <option value="">—</option>
          {current && !opts.includes(current) && <option value={current}>{current}</option>}
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    case 'multi': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1">
          {(def.options || []).map((o) => {
            const on = arr.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])}
                className={`${chip} ${on ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-slate-600 border-slate-300'}`}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return <input value={(value as string) || ''} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

export function FieldsGrid({ fields, row, onChange, hints, large }: {
  fields: readonly ClaimFieldDef[];
  row: Row;
  onChange: (key: string, v: unknown) => void;
  hints?: Record<string, string>;
  large?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.filter((f) => isFieldShown(f, row)).map((f) => (
        <label key={f.key} className={`block ${f.kind === 'textarea' || f.kind === 'multi' ? 'sm:col-span-2' : ''}`}>
          <span className={large ? 'text-sm font-medium text-slate-700' : 'text-xs text-slate-600'}>{f.label}</span>
          {hints?.[f.key] && <span className="ml-2 text-[11px] text-indigo-600">{hints[f.key]}</span>}
          <div className="mt-1"><FieldInput def={f} value={row[f.key]} onChange={(v) => onChange(f.key, v)} large={large} /></div>
        </label>
      ))}
    </div>
  );
}

export function ListEditor({ section, rows, gate, onGate, onChange, large }: {
  section: ClaimSectionDef;
  rows: Row[];
  gate: unknown;
  onGate: (v: unknown) => void;
  onChange: (rows: Row[]) => void;
  large?: boolean;
}) {
  const showRows = !section.gate || gate === true || rows.length > 0;
  return (
    <div className="space-y-3">
      {section.gate && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-600">{section.gate.label}</span>
          <FieldInput def={{ key: 'gate', label: '', kind: 'yesno' }} value={gate} onChange={onGate} large={large} />
        </div>
      )}
      {showRows && rows.map((r, i) => (
        <div key={i} className="border rounded p-3 bg-slate-50/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-600">{section.list!.itemLabel} {i + 1}</span>
            <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">Remove</button>
          </div>
          <FieldsGrid
            fields={section.fields}
            row={r}
            onChange={(k, v) => onChange(rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)))}
            large={large}
          />
        </div>
      ))}
      {showRows && (
        <button type="button" onClick={() => onChange([...rows, {}])} className={`${large ? 'px-4 py-2.5 text-sm rounded-lg' : 'px-3 py-1.5 text-xs rounded'} border border-dashed border-slate-400 text-slate-600 hover:bg-slate-50`}>
          + {section.list!.addLabel}
        </button>
      )}
    </div>
  );
}

