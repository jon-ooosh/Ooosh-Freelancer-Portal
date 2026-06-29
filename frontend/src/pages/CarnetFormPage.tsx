/**
 * CarnetFormPage — public client request form (token-authenticated, no Layout).
 * Mounted at /carnet-form/:token. Port of the Ooosh Jotform: gathers carnet
 * details + the names + GMR crossings, and captures the lead's signature to the
 * Letter of Authorisation. On submit the backend stores everything, seeds the
 * GMRs, generates the two-signature PDF and emails a copy to the client.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

const EU_COUNTRIES = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Estonia',
  'Finland', 'France', 'French overseas territories', 'Germany', 'Greece', 'Hungary', 'Ireland',
  'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal',
  'Romania', 'Slovakia', 'Slovenia', 'Spain',
];
const NON_EU_COUNTRIES = [
  'Albania', 'Algeria', 'Andorra', 'Belarus', 'Bosnia and Herzegovina', 'Channel Islands / Isle of Man',
  'Faroe Islands', 'Gibraltar', 'Iceland', 'Israel', 'Norway', 'Russian Federation', 'Serbia',
  'Switzerland (includes Liechtenstein)', 'Turkey', 'Ukraine', 'United Kingdom',
];
const CROSSINGS = ['Dover', 'Calais', 'Folkestone', 'Eurotunnel', 'Other'];

interface Ctx {
  valid: boolean;
  already_submitted: boolean;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  lead_name: string | null;
  lead_email: string | null;
  lead_role: string | null;
  default_start_date: string | null;
  authority_terms: string;
}

export default function CarnetFormPage() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // form state
  const [length, setLength] = useState('');
  const [startDate, setStartDate] = useState('');
  const [eu, setEu] = useState<string[]>([]);
  const [nonEu, setNonEu] = useState<string[]>([]);
  const [leadName, setLeadName] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [leadRole, setLeadRole] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [gmrNeeded, setGmrNeeded] = useState<'yes' | 'no' | ''>('');
  const [crossings, setCrossings] = useState<{ crossing_date: string; crossing_location: string; direction: string }[]>([
    { crossing_date: '', crossing_location: '', direction: 'out_of_eu' },
  ]);
  const [accepted, setAccepted] = useState(false);
  const [termsScrolled, setTermsScrolled] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/carnets/form/${token}`);
        const j = await res.json();
        if (!res.ok) { setError(j.error || 'This link is not valid.'); }
        else {
          setCtx(j.data);
          setLeadName(j.data.lead_name || '');
          setLeadEmail(j.data.lead_email || '');
          setLeadRole(j.data.lead_role || '');
          if (j.data.default_start_date) setStartDate(j.data.default_start_date);
        }
      } catch { setError('Could not load the form.'); }
      finally { setLoading(false); }
    })();
  }, [token]);

  function onTermsScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setTermsScrolled(true);
  }

  function toggle(list: string[], setList: (v: string[]) => void, v: string) {
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  // signature pad
  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx2 = canvasRef.current!.getContext('2d')!;
    const p = pos(e); ctx2.beginPath(); ctx2.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx2 = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx2.lineWidth = 2; ctx2.lineCap = 'round'; ctx2.strokeStyle = '#1e293b';
    ctx2.lineTo(p.x, p.y); ctx2.stroke(); hasInk.current = true;
  }
  function clearSig() {
    const c = canvasRef.current; if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    hasInk.current = false;
  }

  async function submit() {
    setError('');
    if (!length) return setError('Please choose a carnet length.');
    if (!startDate) return setError('Please provide a required start date.');
    if (!leadName.trim()) return setError('Please enter the lead name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(leadEmail.trim())) return setError('Please enter a valid lead email.');
    if (!leadRole.trim()) return setError('Please enter the lead role.');
    if (eu.length + nonEu.length === 0) return setError('Please select at least one country.');
    if (gmrNeeded === '') return setError('Please answer the GMR question.');
    if (gmrNeeded === 'yes' && !crossings.some((c) => c.crossing_date && c.crossing_location)) return setError('Please add at least one crossing (date + location).');
    if (!accepted) return setError('Please read and accept the terms.');
    if (!hasInk.current) return setError('Please sign in the box.');
    setSubmitting(true);
    try {
      const signature = canvasRef.current!.toDataURL('image/png');
      const res = await fetch(`/api/carnets/form/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carnet_length_months: Number(length), carnet_start_date: startDate,
          eu_countries: eu, non_eu_countries: nonEu,
          lead_name: leadName.trim(), lead_email: leadEmail.trim(), lead_role: leadRole.trim(),
          additional_names: extra.filter((n) => n.trim()).map((n) => {
            const parts = n.trim().split(/\s+/); return { first: parts[0], last: parts.slice(1).join(' ') };
          }),
          gmr_needed: gmrNeeded === 'yes',
          crossings: gmrNeeded === 'yes' ? crossings.filter((c) => c.crossing_date || c.crossing_location) : [],
          accepted, signature,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(j.error || 'Could not submit. Please try again.');
      else setDone(true);
    } catch { setError('Could not submit. Please try again.'); }
    finally { setSubmitting(false); }
  }

  if (loading) return <Shell><p className="text-slate-400">Loading…</p></Shell>;
  if (error && !ctx) return <Shell><p className="text-red-600">{error}</p></Shell>;
  if (ctx && !ctx.valid) return <Shell><p className="text-slate-600">This carnet is closed — the form is no longer available.</p></Shell>;
  if (done || (ctx && ctx.already_submitted)) return (
    <Shell>
      <h1 className="text-xl font-bold text-slate-800 mb-2">Thank you</h1>
      <p className="text-slate-600">Your carnet details and signed authority have been received. We've emailed you a copy. There's nothing more to do here.</p>
    </Shell>
  );

  const cell = 'flex items-center gap-2 text-sm text-slate-700';
  return (
    <Shell>
      <h1 className="text-2xl font-bold text-slate-800">Carnet request form</h1>
      {ctx && <p className="text-sm text-slate-500 mb-5">{ctx.job_name || 'Your hire'}{ctx.hh_job_number ? ` · job #${ctx.hh_job_number}` : ''}</p>}

      <Section title="Length of carnet required" required>
        <div className="flex gap-4">
          {['2', '6', '12'].map((m) => (
            <label key={m} className={cell}><input type="radio" name="len" checked={length === m} onChange={() => setLength(m)} /> {m} months</label>
          ))}
        </div>
      </Section>

      <Section title="Required start date" required>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
      </Section>

      <Section title="Countries you'll travel through" required hint="select at least one across EU and non-EU">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
          {EU_COUNTRIES.map((c) => <label key={c} className={cell}><input type="checkbox" checked={eu.includes(c)} onChange={() => toggle(eu, setEu, c)} /> {c}</label>)}
        </div>
      </Section>

      <Section title="Non-EU countries you'll travel through">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
          {NON_EU_COUNTRIES.map((c) => <label key={c} className={cell}><input type="checkbox" checked={nonEu.includes(c)} onChange={() => toggle(nonEu, setNonEu, c)} /> {c}</label>)}
        </div>
      </Section>

      <Section title="Lead person (signs the authority)" required>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input placeholder="Lead name" value={leadName} onChange={(e) => setLeadName(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
          <input placeholder="Lead email" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
          <input placeholder="Role (e.g. Tour Manager)" value={leadRole} onChange={(e) => setLeadRole(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-sm" />
        </div>
      </Section>

      <Section title="Additional names on the carnet">
        {extra.map((n, i) => (
          <div key={i} className="flex gap-2 mb-1">
            <input placeholder={`Additional name ${i + 1}`} value={n} onChange={(e) => setExtra(extra.map((x, j) => j === i ? e.target.value : x))} className="border border-slate-300 rounded px-2 py-1 text-sm flex-1" />
            <button onClick={() => setExtra(extra.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm px-2">✕</button>
          </div>
        ))}
        <button onClick={() => setExtra([...extra, ''])} className="text-sm text-purple-600 hover:text-purple-800">+ Add name</button>
      </Section>

      <Section title="Do you need us to arrange GMR(s) too? (UK border)" required>
        <div className="flex gap-4 mb-2">
          <label className={cell}><input type="radio" name="gmr" checked={gmrNeeded === 'yes'} onChange={() => setGmrNeeded('yes')} /> Yes</label>
          <label className={cell}><input type="radio" name="gmr" checked={gmrNeeded === 'no'} onChange={() => setGmrNeeded('no')} /> No</label>
        </div>
        {gmrNeeded === 'yes' && (
          <div className="space-y-2">
            {crossings.map((x, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <input type="date" value={x.crossing_date} onChange={(e) => setCrossings(crossings.map((c, j) => j === i ? { ...c, crossing_date: e.target.value } : c))} className="border border-slate-300 rounded px-2 py-1 text-sm" />
                <select value={x.crossing_location} onChange={(e) => setCrossings(crossings.map((c, j) => j === i ? { ...c, crossing_location: e.target.value } : c))} className="border border-slate-300 rounded px-2 py-1 text-sm">
                  <option value="">Crossing…</option>
                  {CROSSINGS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={x.direction} onChange={(e) => setCrossings(crossings.map((c, j) => j === i ? { ...c, direction: e.target.value } : c))} className="border border-slate-300 rounded px-2 py-1 text-sm">
                  <option value="out_of_eu">Leaving UK</option>
                  <option value="into_eu">Returning to UK</option>
                </select>
                {crossings.length > 1 && <button onClick={() => setCrossings(crossings.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm px-1">✕</button>}
              </div>
            ))}
            <button onClick={() => setCrossings([...crossings, { crossing_date: '', crossing_location: '', direction: 'out_of_eu' }])} className="text-sm text-purple-600 hover:text-purple-800">+ Add crossing</button>
          </div>
        )}
      </Section>

      {ctx && (
        <Section title="Terms & authority">
          <div onScroll={onTermsScroll} className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-3 max-h-40 overflow-y-auto whitespace-pre-line mb-1">{ctx.authority_terms}</div>
          {!termsScrolled && <p className="text-xs text-amber-600 mb-2">Please scroll to the end of the terms to continue.</p>}
          <label className={`${cell} ${!termsScrolled ? 'opacity-50' : ''}`}>
            <input type="checkbox" disabled={!termsScrolled} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            I have read and agree to the above, and I sign as the lead person named.
          </label>
        </Section>
      )}

      <Section title="Signature" required>
        <canvas ref={canvasRef} width={600} height={160} onPointerDown={start} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }}
          className="w-full border border-slate-300 rounded-lg bg-white touch-none" style={{ maxWidth: 600 }} />
        <button onClick={clearSig} className="text-xs text-slate-500 underline mt-1">Clear signature</button>
      </Section>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      <button onClick={submit} disabled={submitting} className="px-5 py-2.5 bg-purple-600 text-white rounded-lg font-medium disabled:opacity-50">
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-xl shadow p-6 sm:p-8">{children}</div>
    </div>
  );
}
function Section({ title, children, required, hint }: { title: string; children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-2">
        {title}{required && <span className="text-red-500"> *</span>}
        {hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}
      </h2>
      {children}
    </div>
  );
}
