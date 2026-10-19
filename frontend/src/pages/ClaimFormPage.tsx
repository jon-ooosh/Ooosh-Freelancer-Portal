/**
 * PUBLIC — the possible-claim client form (docs/INCIDENT-CLAIMS-SPEC.md Phase 2).
 *
 * Reached from the emailed link /claim/:token; no login, no Layout. Phone-first.
 * A checklist of sections, each saved to the server on its own — close the tab,
 * come back on the same link, carry on. Plain fetch (the public-page pattern:
 * the staff api client would bounce a 401 to the login page).
 *
 * Privacy (D6/D7): the page only ever gets driver NAMES. Claiming to be the
 * driver needs the code emailed to that driver's address; the session it
 * returns lives in sessionStorage for this tab only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CLAIM_SECTIONS, CLIENT_CHECKLIST, CLAIM_PRIVACY_NOTICE, BROKER_DECLARATION,
  sectionMissing, sectionFormatErrors,
  type ClaimSectionDef, type DamageMark, type OutlineType,
} from '@claimform';
import { FieldsGrid, ListEditor } from '../components/claims/FormFields';
import { DamageOutlineEditor } from '../components/claims/VanOutline';
import { SketchPad, SketchPadHandle } from '../components/claims/SketchPad';
import { SignatureCapture, SignatureCaptureHandle } from '../modules/vehicles/components/book-out/SignatureCapture';
import { prepareImage } from '../lib/imageNormalise';

type Row = Record<string, unknown>;

interface FormState {
  closed: boolean;
  vehicle: { reg: string; make_model: string; outline: OutlineType };
  hh_job_number: number | null;
  job_name: string | null;
  recipient_name: string | null;
  filled_as: 'driver' | 'witness' | null;
  filled_by_name: string | null;
  form: Record<string, unknown>;
  sections_done: Record<string, string>;
  damage_marks: DamageMark[];
  has_sketch: boolean;
  driver_signed: boolean;
  driver_signed_name: string | null;
  drivers: Array<{ id: string; name: string; has_email: boolean }>;
  files: Array<{ id: string; filename: string; file_type: string; caption: string | null; content_type: string | null }>;
}

const API = '/api/claim-form';
const sessionKey = (token: string) => `claim-driver-session:${token}`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error || 'Something went wrong'), { body });
  return body as T;
}
const post = <T,>(url: string, data: unknown, headers: Record<string, string> = {}) =>
  call<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
const errText = (e: unknown) => {
  const body = (e as { body?: { problems?: string[]; missing?: string[] } }).body;
  const list = body?.problems || body?.missing;
  const msg = e instanceof Error ? e.message : 'Something went wrong';
  return list?.length ? `${msg}: ${list.join('; ')}` : msg;
};

/** A checklist item's state: done (client saved it complete), started, or not yet. */
function itemState(key: string, data: FormState): { done: boolean; started: boolean; missing: string[] } {
  if (key === 'driver') return { done: data.driver_signed, started: data.driver_signed, missing: [] };
  if (key === 'who') return { done: !!data.sections_done?.who, started: !!data.filled_as, missing: [] };
  const def = CLAIM_SECTIONS.find((s) => s.key === key);
  const missing = def ? sectionMissing(def, data.form) : [];
  const v = data.form[key];
  const started = (Array.isArray(v) ? v.length > 0 : !!v && Object.keys(v as object).length > 0)
    || typeof data.form[`${key}_involved`] === 'boolean';
  return { done: !!data.sections_done?.[key] && missing.length === 0, started, missing };
}

export default function ClaimFormPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [data, setData] = useState<FormState | null>(null);
  const [notFound, setNotFound] = useState('');
  const [view, setView] = useState<string>('home');
  const [submitted, setSubmitted] = useState(false);
  const [forwarded, setForwarded] = useState('');
  const [session, setSession] = useState<string | null>(() => {
    try { return sessionStorage.getItem(sessionKey(token)); } catch { return null; }
  });

  const load = useCallback(async () => {
    try {
      const r = await call<{ data: FormState }>(`${API}/${token}`);
      setData(r.data);
    } catch (e) {
      setNotFound(errText(e));
    }
  }, [token]);

  useEffect(() => {
    load();
    // "Opened" is a POST from the page — never a side effect of the GET.
    fetch(`${API}/${token}/opened`, { method: 'POST' }).catch(() => undefined);
  }, [load, token]);

  const saveSession = (s: string | null) => {
    setSession(s);
    try { if (s) sessionStorage.setItem(sessionKey(token), s); else sessionStorage.removeItem(sessionKey(token)); } catch { /* private mode */ }
  };

  const go = (v: string) => { setView(v); window.scrollTo({ top: 0 }); };

  if (notFound) return <Shell><p className="text-slate-600">{notFound}</p></Shell>;
  if (!data) return <Shell><p className="text-slate-400">Loading…</p></Shell>;
  if (forwarded) {
    return (
      <Shell data={data}>
        <h2 className="text-lg font-semibold text-slate-800 mb-2">Passed on — thank you</h2>
        <p className="text-slate-600">We&apos;ve emailed {forwarded} their own link to this form. You can close this page.</p>
      </Shell>
    );
  }
  if (submitted || data.closed) {
    return (
      <Shell data={data}>
        <h2 className="text-lg font-semibold text-slate-800 mb-2">Thank you — we&apos;ve got it</h2>
        <p className="text-slate-600">Your incident form has been sent to the Ooosh team. We&apos;ll be in touch if we need anything else.</p>
        <p className="text-slate-600 mt-3">If you receive any letters or calls about the incident, please send them to us rather than replying, and don&apos;t admit liability to anyone.</p>
      </Shell>
    );
  }

  const states = Object.fromEntries(CLIENT_CHECKLIST.map((s) => [s.key, itemState(s.key, data)]));
  const doneCount = CLIENT_CHECKLIST.filter((s) => states[s.key].done).length;
  const allDone = doneCount === CLIENT_CHECKLIST.length;

  if (view === 'home') {
    return (
      <Shell data={data}>
        <p className="text-slate-700 mb-1">
          {data.recipient_name ? `Hi ${data.recipient_name.split(/\s+/)[0]}. ` : ''}Please tell us what happened with our van. Do it in any order —
          each part saves when you press <strong>Save</strong>, and this same link brings you back.
        </p>
        <p className="text-sm text-slate-500 mb-4">
          {doneCount} of {CLIENT_CHECKLIST.length} done · parts marked <span className="text-red-600">*</span> are needed
        </p>
        <ul className="divide-y border rounded-xl bg-white">
          {CLIENT_CHECKLIST.map((s) => {
            const st = states[s.key];
            return (
              <li key={s.key}>
                <button type="button" onClick={() => go(s.key)} className="w-full flex items-center justify-between px-4 py-4 text-left">
                  <span className="flex items-center gap-3">
                    <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm ${
                      st.done ? 'bg-green-600 text-white' : st.started ? 'border-2 border-amber-500 text-amber-600' : 'border-2 border-slate-300 text-slate-400'}`}>
                      {st.done ? '✓' : st.started ? '…' : ''}
                    </span>
                    <span>
                      <span className="block text-base text-slate-800">{s.title}</span>
                      {!st.done && st.started && (
                        <span className="block text-xs text-amber-700">
                          {st.missing.length ? `Still needed: ${st.missing.slice(0, 3).join(', ')}${st.missing.length > 3 ? '…' : ''}` : 'Started — open it and press Save'}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-slate-400">›</span>
                </button>
              </li>
            );
          })}
        </ul>
        <SubmitBlock token={token} ready={allDone} onDone={() => setSubmitted(true)} />
        <p className="text-xs text-slate-400 mt-8">{CLAIM_PRIVACY_NOTICE}</p>
      </Shell>
    );
  }

  const back = () => { load(); go('home'); };

  if (view === 'who') {
    return (
      <Shell data={data} onBack={() => go('home')}>
        <WhoSection token={token} data={data} session={session} onSession={saveSession} onForwarded={setForwarded} onDone={back} />
      </Shell>
    );
  }
  if (view === 'driver') {
    return (
      <Shell data={data} onBack={() => go('home')}>
        <DriverSection token={token} data={data} session={session} onSession={saveSession} onDone={back} />
      </Shell>
    );
  }
  const def = CLAIM_SECTIONS.find((s) => s.key === view && s.who === 'client');
  if (!def) return <Shell data={data} onBack={() => go('home')}><p className="text-slate-500">That part of the form wasn&apos;t found.</p></Shell>;
  return (
    <Shell data={data} onBack={() => go('home')}>
      <ClientSection token={token} def={def} data={data} onSaved={back} onReload={load} />
    </Shell>
  );
}

function Shell({ data, onBack, children }: { data?: FormState; onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-[#7B5EA7] text-white px-4 py-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-xs uppercase tracking-wide opacity-80">Ooosh! Tours · Incident report</div>
          {data && (
            <div className="text-lg font-semibold">
              {data.vehicle.reg}{data.vehicle.make_model ? <span className="font-normal opacity-90"> · {data.vehicle.make_model}</span> : null}
            </div>
          )}
          {data?.job_name && <div className="text-sm opacity-90">{data.job_name}{data.hh_job_number ? ` (#${data.hh_job_number})` : ''}</div>}
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-5">
        {onBack && <button type="button" onClick={onBack} className="text-sm text-[#7B5EA7] mb-4">‹ Back to the checklist</button>}
        {children}
      </main>
    </div>
  );
}

const bigBtn = 'w-full px-4 py-3.5 rounded-xl text-base font-semibold';
const primary = `${bigBtn} bg-[#7B5EA7] text-white disabled:opacity-40`;
const secondary = `${bigBtn} border-2 border-slate-300 bg-white text-slate-700`;

function SubmitBlock({ token, ready, onDone }: { token: string; ready: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const submit = async () => {
    setBusy(true); setError(''); setMissing([]);
    try {
      await post(`${API}/${token}/submit`, {});
      onDone();
    } catch (e) {
      setError(errText(e));
      setMissing(((e as { body?: { missing?: string[] } }).body?.missing) || []);
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-6">
      <button type="button" onClick={submit} disabled={busy || !ready} className={primary}>{busy ? 'Sending…' : 'Send to Ooosh'}</button>
      {!ready && <p className="text-sm text-slate-500 mt-2 text-center">Finish every part above (including the driver&apos;s signature) to send.</p>}
      {error && <p className="text-sm text-red-600 mt-2">{error}{missing.length ? `: ${missing.join(', ')}` : ''}</p>}
    </div>
  );
}

// ── Who's filling this in ──────────────────────────────────────────────────

function WhoSection({ token, data, session, onSession, onForwarded, onDone }: {
  token: string; data: FormState; session: string | null;
  onSession: (s: string | null) => void; onForwarded: (who: string) => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<'driver' | 'witness' | 'forward' | null>(data.filled_as);
  const [name, setName] = useState(data.filled_by_name || data.recipient_name || '');
  const [fwdEmail, setFwdEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const saveWho = async (as: 'driver' | 'witness', who: string) => {
    setBusy(true); setError('');
    try { await post(`${API}/${token}/who`, { as, name: who }); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const forward = async () => {
    setBusy(true); setError('');
    try { await post(`${API}/${token}/forward`, { name, email: fwdEmail }); onForwarded(name); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">Who&apos;s filling this in?</h2>
      <div className="space-y-2">
        {([
          ['driver', 'I was driving'],
          ['witness', "I wasn't driving, but I know what happened"],
          ['forward', 'Someone else should do this'],
        ] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`${bigBtn} text-left border-2 ${mode === k ? 'border-[#7B5EA7] bg-purple-50 text-slate-800' : 'border-slate-200 bg-white text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'driver' && (
        <DriverCodeFlow
          token={token}
          drivers={data.drivers}
          session={session}
          onVerified={async (s, driverName) => { onSession(s); await saveWho('driver', driverName); }}
        />
      )}
      {mode === 'witness' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base" />
          </label>
          <p className="text-sm text-slate-500">You can fill in everything except the driver&apos;s declaration — we&apos;ll ask the driver for that part.</p>
          <button type="button" disabled={busy || name.trim().length < 2} onClick={() => saveWho('witness', name.trim())} className={primary}>Save</button>
        </div>
      )}
      {mode === 'forward' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">We&apos;ll email them their own link. Anything already filled in stays.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base" />
          <input type="email" value={fwdEmail} onChange={(e) => setFwdEmail(e.target.value)} placeholder="Their email" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base" />
          <button type="button" disabled={busy} onClick={forward} className={primary}>{busy ? 'Sending…' : 'Send it to them'}</button>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-slate-400 pt-4">{CLAIM_PRIVACY_NOTICE}</p>
    </div>
  );
}

/** Pick your name → code emailed to the address on your hire form → enter it. */
function DriverCodeFlow({ token, drivers, session, onVerified }: {
  token: string;
  drivers: FormState['drivers'];
  session: string | null;
  onVerified: (session: string, driverName: string) => Promise<void> | void;
}) {
  const [driverId, setDriverId] = useState(drivers.length === 1 ? drivers[0].id : '');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (session) return <p className="text-sm text-green-700">✓ You&apos;ve confirmed you were driving.</p>;
  if (!drivers.length) {
    return <p className="text-sm text-slate-600">We can&apos;t find the drivers for this van — please call Ooosh and we&apos;ll sort it out with you.</p>;
  }
  const send = async () => {
    setBusy(true); setError('');
    try {
      const r = await post<{ data: { masked_email: string } }>(`${API}/${token}/driver/code`, { driver_id: driverId });
      setSentTo(r.data.masked_email);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError('');
    try {
      const r = await post<{ data: { session: string } }>(`${API}/${token}/driver/verify`, { driver_id: driverId, code });
      await onVerified(r.data.session, drivers.find((d) => d.id === driverId)?.name || '');
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Which driver are you?</span>
        <select value={driverId} onChange={(e) => { setDriverId(e.target.value); setSentTo(''); }} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base bg-white">
          <option value="">— pick your name —</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {!sentTo ? (
        <>
          <p className="text-sm text-slate-500">We&apos;ll email a 6-digit code to the address on your hire form, to check it&apos;s you.</p>
          <button type="button" disabled={busy || !driverId} onClick={send} className={primary}>{busy ? 'Sending…' : 'Email me a code'}</button>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">We&apos;ve emailed a code to <strong>{sentTo}</strong>. It lasts 10 minutes.</p>
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" className="w-full border border-slate-300 rounded-lg px-3 py-3 text-2xl tracking-[0.5em] text-center" />
          <button type="button" disabled={busy || code.length !== 6} onClick={verify} className={primary}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" disabled={busy} onClick={send} className="text-sm text-[#7B5EA7] underline">Send a new code</button>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ── A client section (incl. damage outline + photos, and the sketch) ─────────

function ClientSection({ token, def, data, onSaved, onReload }: {
  token: string; def: ClaimSectionDef; data: FormState; onSaved: () => void; onReload: () => Promise<void>;
}) {
  const initial = data.form[def.key];
  const [row, setRow] = useState<Row>(() => (initial && typeof initial === 'object' && !Array.isArray(initial) ? { ...(initial as Row) } : {}));
  const [rows, setRows] = useState<Row[]>(() => (Array.isArray(initial) ? (initial as Row[]).map((r) => ({ ...r })) : []));
  const [gate, setGate] = useState<unknown>(data.form[`${def.key}_involved`]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sketchRef = useRef<SketchPadHandle>(null);
  const [sketchDirty, setSketchDirty] = useState(false);
  const [stillNeeded, setStillNeeded] = useState<string[]>([]);

  const save = async () => {
    const value = def.list ? rows : row;
    const bad = sectionFormatErrors(def, value);
    if (bad.length) { setError(`Please check: ${bad.join('; ')}`); return; }
    setBusy(true); setError(''); setStillNeeded([]);
    try {
      if (def.key === 'account' && sketchDirty && sketchRef.current && !sketchRef.current.isEmpty()) {
        const blob = await sketchRef.current.toBlob();
        if (blob) {
          const fd = new FormData();
          fd.append('file', blob, 'sketch.png');
          await call(`${API}/${token}/sketch`, { method: 'POST', body: fd });
        }
      }
      const r = await post<{ data: { missing?: string[] } }>(`${API}/${token}/section/${def.key}`, def.list ? { data: rows, gate } : { data: row });
      setSketchDirty(false);
      // Saved either way — but only back to the checklist once it's complete.
      if (r.data.missing?.length) {
        setStillNeeded(r.data.missing);
        await onReload();
      } else {
        onSaved();
      }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold text-slate-800">{def.title}</h2>
      {def.hint && <p className="text-sm text-slate-500">{def.hint}</p>}

      {def.key === 'damage' && (
        <div className="space-y-5">
          <div>
            <h3 className="text-base font-semibold text-slate-700 mb-1">Mark the damage on the van</h3>
            <p className="text-sm text-slate-500 mb-2">A cross for damage, an arrow for where it was hit. Roughly is fine — the photos show the detail. Turning your phone sideways makes the drawing bigger.</p>
            <DamageOutlineEditor
              type={data.vehicle.outline}
              initial={data.damage_marks}
              large
              onSave={async (marks, png) => {
                await post(`${API}/${token}/damage`, { marks, png_base64: png });
                await onReload();
              }}
            />
          </div>
          <PhotoUploader token={token} files={data.files} onChange={onReload} />
        </div>
      )}

      {def.list ? (
        <ListEditor section={def} rows={rows} gate={gate} onGate={setGate} onChange={setRows} large />
      ) : (
        <FieldsGrid fields={def.fields} row={row} onChange={(k, v) => setRow((r) => ({ ...r, [k]: v }))} large />
      )}

      {def.key === 'account' && (
        <div>
          <h3 className="text-base font-semibold text-slate-700 mb-1">Sketch of what happened</h3>
          <p className="text-sm text-slate-500 mb-2">
            Draw the roads, which way each vehicle was going (arrows), where they hit (a cross), and any road markings or signs.
            Or photograph a sketch on paper and add it under <em>Damage to our van</em> photos.
          </p>
          {data.has_sketch && !sketchDirty && (
            <div className="mb-2">
              <p className="text-xs text-slate-500 mb-1">Your saved sketch (draw below to replace it):</p>
              <img src={`${API}/${token}/sketch?t=${Date.now()}`} alt="Saved sketch" className="w-full border rounded-lg" />
            </div>
          )}
          <SketchPad ref={sketchRef} onChange={() => setSketchDirty(true)} />
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {stillNeeded.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Saved — but to finish this part we still need:</p>
          <ul className="list-disc ml-5 mt-1">{stillNeeded.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="mt-1">Fill those in and press Save again, or come back to it later.</p>
        </div>
      )}
      <button type="button" disabled={busy} onClick={save} className={primary}>{busy ? 'Saving…' : 'Save'}</button>
      {stillNeeded.length > 0 && <button type="button" onClick={onSaved} className={secondary}>Back to the checklist</button>}
    </div>
  );
}

function PhotoUploader({ token, files, onChange }: { token: string; files: FormState['files']; onChange: () => Promise<void> }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);   // capture BEFORE the reset
    e.target.value = '';
    if (!list.length) return;
    setError('');
    let i = 0;
    for (const file of list) {
      i++;
      setProgress(`Uploading ${i} of ${list.length}…`);
      try {
        const fd = new FormData();
        if (file.type === 'application/pdf') {
          fd.append('file', file, file.name);
          fd.append('file_type', 'police_report');
        } else {
          const img = await prepareImage(file);
          fd.append('file', img.blob, img.filename);
          if (img.thumb) fd.append('thumb', img.thumb, 'thumb.jpg');
          if (img.takenAt) fd.append('taken_at', img.takenAt);
        }
        await call(`${API}/${token}/files`, { method: 'POST', body: fd });
      } catch (err) {
        setError(`${file.name}: ${errText(err)}`);
      }
    }
    setProgress('');
    await onChange();
  };
  const remove = async (id: string) => {
    if (!confirm('Remove this file?')) return;
    try { await call(`${API}/${token}/files/${id}`, { method: 'DELETE' }); await onChange(); } catch (e) { setError(errText(e)); }
  };

  return (
    <div>
      <h3 className="text-base font-semibold text-slate-700 mb-1">Photos</h3>
      <p className="text-sm text-slate-500 mb-2">Of the damage, the scene, the other vehicle and its number plate — as many as you like. PDFs (a police report, say) are fine too.</p>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button type="button" onClick={() => cameraRef.current?.click()} disabled={!!progress} className={secondary}>📷 Take a photo</button>
        <button type="button" onClick={() => pickRef.current?.click()} disabled={!!progress} className={secondary}>🖼 Choose files</button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
      <input ref={pickRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onFiles} />
      {progress && <p className="text-sm text-slate-600 mb-2">{progress}</p>}
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {files.map((f) => (
            <div key={f.id} className="relative border rounded-lg overflow-hidden bg-white">
              {(f.content_type || '').startsWith('image/')
                ? <img src={`${API}/${token}/files/${f.id}/thumb`} alt={f.filename} className="w-full h-24 object-cover" />
                : <div className="h-24 flex items-center justify-center text-3xl">📄</div>}
              <button type="button" onClick={() => remove(f.id)} className="absolute top-1 right-1 bg-white/90 rounded-full w-7 h-7 text-sm text-red-600">✕</button>
              <div className="text-[11px] text-slate-500 px-1 truncate">{f.filename}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── The driver's part ──────────────────────────────────────────────────────

function DriverSection({ token, data, session, onSession, onDone }: {
  token: string; data: FormState; session: string | null; onSession: (s: string | null) => void; onDone: () => void;
}) {
  const [details, setDetails] = useState<{ name: string; hire_form: { accidents: boolean; convictions: boolean; disability: boolean } | null; answers: Row; signed: boolean } | null>(null);
  const [row, setRow] = useState<Row>({});
  const [printName, setPrintName] = useState('');
  const sigRef = useRef<SignatureCaptureHandle>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentToDriver, setSentToDriver] = useState('');
  const [iAmDriver, setIAmDriver] = useState(data.filled_as === 'driver');

  useEffect(() => {
    if (!session) return;
    post<{ data: NonNullable<typeof details> }>(`${API}/${token}/driver/details`, {}, { 'x-claim-driver-session': session })
      .then((r) => {
        setDetails(r.data);
        setPrintName(r.data.name);
        const a = { ...(r.data.answers || {}) };
        // Pre-fill the three declarations from the hire form (spec §7.3) — the driver confirms or changes them.
        if (r.data.hire_form) {
          if (a.decl_accidents === undefined) a.decl_accidents = r.data.hire_form.accidents;
          if (a.decl_convictions === undefined) a.decl_convictions = r.data.hire_form.convictions;
          if (a.decl_disability === undefined) a.decl_disability = r.data.hire_form.disability;
        }
        setRow(a);
      })
      .catch(() => onSession(null));   // expired session → ask for a new code
  }, [session, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const def = CLAIM_SECTIONS.find((s) => s.key === 'driver')!;

  if (data.driver_signed && !session) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-semibold text-slate-800">Driver declaration</h2>
        <p className="text-green-700">✓ Signed by {data.driver_signed_name}.</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-slate-800">Driver declaration</h2>
        <p className="text-slate-600">This part has to be completed and signed by the person who was driving.</p>
        {iAmDriver ? (
          <DriverCodeFlow token={token} drivers={data.drivers} session={session} onVerified={(s) => onSession(s)} />
        ) : sentToDriver ? (
          <p className="text-green-700">✓ We&apos;ve emailed {sentToDriver} a link to do their part.</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">Send it to the driver — we&apos;ll email them using the address on their hire form:</p>
            <div className="space-y-2">
              {data.drivers.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={busy || !d.has_email}
                  onClick={async () => {
                    setBusy(true); setError('');
                    try {
                      const r = await post<{ data: { name: string } }>(`${API}/${token}/send-to-driver`, { driver_id: d.id });
                      setSentToDriver(r.data.name);
                    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
                  }}
                  className={secondary}
                >
                  Send to {d.name}{d.has_email ? '' : ' (no email on file)'}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setIAmDriver(true)} className="text-sm text-[#7B5EA7] underline">Actually, I was the driver</button>
          </>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  if (!details) return <p className="text-slate-400">Loading…</p>;

  const hints: Record<string, string> = {};
  if (details.hire_form) {
    hints.decl_accidents = `your hire form said: ${details.hire_form.accidents ? 'Yes' : 'No'}`;
    hints.decl_convictions = `from your hire form and licence check: ${details.hire_form.convictions ? 'Yes' : 'No'}`;
    hints.decl_disability = `your hire form said: ${details.hire_form.disability ? 'Yes' : 'No'}`;
  }

  const save = async () => {
    const missing = sectionMissing(def, { driver: row });
    if (missing.length) { setError(`Please answer: ${missing.join('; ')}`); return; }
    const blob = await sigRef.current?.getBlob();
    if (!blob) { setError('Please sign in the box.'); return; }
    if (printName.trim().length < 2) { setError('Please print your name.'); return; }
    setBusy(true); setError('');
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      await post(`${API}/${token}/driver/save`, { data: row, signature_png_base64: b64, print_name: printName.trim() }, { 'x-claim-driver-session': session });
      onDone();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold text-slate-800">Driver declaration — {details.name}</h2>
      <p className="text-sm text-slate-500">
        Your name, date of birth, address and licence details come from your hire form — you don&apos;t need to enter them again.
        The three questions below are pre-filled from your hire form: please check they&apos;re still right.
        Question (a) is about <em>previous</em> accidents, not this one.
      </p>
      <FieldsGrid fields={def.fields} row={row} onChange={(k, v) => setRow((r) => ({ ...r, [k]: v }))} hints={hints} large />
      <div className="border rounded-xl bg-white p-3 text-sm text-slate-600">{BROKER_DECLARATION}</div>
      <SignatureCapture ref={sigRef} label="Signature of driver" />
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Print name</span>
        <input value={printName} onChange={(e) => setPrintName(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base" />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="button" disabled={busy} onClick={save} className={primary}>{busy ? 'Saving…' : 'Sign and save'}</button>
    </div>
  );
}
