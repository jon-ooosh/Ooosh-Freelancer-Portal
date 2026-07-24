/**
 * FreelancerApplyPage — public freelancer sign-up form (token-authenticated, no
 * Layout). Mounted at /freelancer-apply/:token. Staff invite a specific person;
 * this form ENRICHES that same person and fires an "all good?" alert to info@.
 * The token IS the gate — usable only while the application is invited/more_info.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

const SKILLS = [
  'Driving', 'Backline Tech', 'Sound / FOH', 'Monitor Engineer', 'Lighting',
  'Stage Hand', 'Tour Manager', 'Studio Sitter', 'Warehouse', 'Rigger', 'Video', 'Merch', 'Other',
];
const LOOKING_FOR = [
  { v: 'local', label: 'Local day work (UK)' },
  { v: 'uk', label: 'UK tours' },
  { v: 'uk_eu', label: 'UK & EU tours' },
  { v: 'any', label: "Whatever's going" },
];
const DRIVING_CONFIDENCE = ['Up to 3.5t', '7m LWB / splitter', 'Carrying passengers', 'Carrying equipment'];
const INS_QUESTIONS: { key: string; q: string }[] = [
  { key: 'convictions', q: 'Any motoring convictions or fixed penalties in the last 5 years?' },
  { key: 'accidents', q: 'Any accidents or claims (fault or non-fault) in the last 3 years?' },
  { key: 'medical', q: 'Any medical conditions the DVLA should be aware of that could affect driving?' },
  { key: 'refused', q: 'Ever been refused motor insurance or had a policy cancelled?' },
];

interface Prefill {
  first_name: string; last_name: string; preferred_name: string; email: string;
  phone: string; mobile: string; date_of_birth: string; home_address: string;
  emergency_contact_name: string; emergency_contact_phone: string; skills: string[];
  licence_number: string; licence_issued_by: string; licence_expiry: string;
  licence_passed_date: string; passport_expiry: string; day_rate_note: string;
}
interface DocRef { r2_key: string; label: string; filename: string; content_type?: string; }
interface RefEntry { name: string; company: string; email: string; phone: string; role: string; consent: boolean; }

export default function FreelancerApplyPage() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [terms, setTerms] = useState('');
  const [tcsVersion, setTcsVersion] = useState('');

  // core
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [dob, setDob] = useState('');
  const [homeAddress, setHomeAddress] = useState('');
  const [emName, setEmName] = useState('');
  const [emPhone, setEmPhone] = useState('');
  // work
  const [utr, setUtr] = useState('');
  const [eligible, setEligible] = useState(false);
  const [lookingFor, setLookingFor] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  // driving
  const [drivingConfidence, setDrivingConfidence] = useState<string[]>([]);
  const [licenceNumber, setLicenceNumber] = useState('');
  const [licenceIssuedBy, setLicenceIssuedBy] = useState('');
  const [licenceExpiry, setLicenceExpiry] = useState('');
  const [licencePassed, setLicencePassed] = useState('');
  const [licenceAddress, setLicenceAddress] = useState('');
  const [insurance, setInsurance] = useState<Record<string, string>>({});
  const [insuranceDetail, setInsuranceDetail] = useState('');
  // passport / extra
  const [passportValid, setPassportValid] = useState('');
  const [passportExpiry, setPassportExpiry] = useState('');
  const [pliExpiry, setPliExpiry] = useState('');
  const [dayRate, setDayRate] = useState('');
  const [anythingElse, setAnythingElse] = useState('');
  // documents + refs
  const [docs, setDocs] = useState<DocRef[]>([]);
  const [refs, setRefs] = useState<RefEntry[]>([]);
  // consent
  const [accepted, setAccepted] = useState(false);
  const [termsScrolled, setTermsScrolled] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  const isDriving = skills.some((s) => /driv/i.test(s));

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/freelancers/apply/${token}`);
        const j = await res.json();
        if (!res.ok) { setError(j.error || 'This link is not valid.'); }
        else {
          setTerms(j.data.terms || '');
          setTcsVersion(j.data.tcs_version || '');
          const p: Prefill = j.data.prefill || {};
          setFirstName(p.first_name || ''); setLastName(p.last_name || '');
          setPreferredName(p.preferred_name || ''); setEmail(p.email || '');
          setPhone(p.phone || ''); setMobile(p.mobile || ''); setDob(p.date_of_birth || '');
          setHomeAddress(p.home_address || '');
          setEmName(p.emergency_contact_name || ''); setEmPhone(p.emergency_contact_phone || '');
          setSkills(Array.isArray(p.skills) ? p.skills : []);
          setLicenceNumber(p.licence_number || ''); setLicenceIssuedBy(p.licence_issued_by || '');
          setLicenceExpiry(p.licence_expiry || ''); setLicencePassed(p.licence_passed_date || '');
          setPassportExpiry(p.passport_expiry || ''); setDayRate(p.day_rate_note || '');
        }
      } catch { setError('Could not load the form.'); }
      finally { setLoading(false); }
    })();
  }, [token]);

  function toggle(list: string[], setList: (v: string[]) => void, v: string) {
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  function onTermsScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setTermsScrolled(true);
  }

  // signature pad
  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!; const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!; const p = pos(e);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1e293b'; ctx.lineTo(p.x, p.y); ctx.stroke();
    hasInk.current = true;
  }
  function clearSig() {
    const c = canvasRef.current; if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    hasInk.current = false;
  }

  async function submit() {
    setError('');
    if (!firstName.trim() || !lastName.trim()) return setError('Please enter your first and last name.');
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Please enter a valid email.');
    if (skills.length === 0) return setError('Please select at least one skill.');
    if (!accepted) return setError('Please read and accept the terms.');
    if (!hasInk.current) return setError('Please sign in the box.');
    setSubmitting(true);
    try {
      const signature = canvasRef.current!.toDataURL('image/png');
      const res = await fetch(`/api/freelancers/apply/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName.trim(), last_name: lastName.trim(),
          preferred_name: preferredName.trim() || null,
          email: email.trim() || null, phone: phone.trim() || null, mobile: mobile.trim() || null,
          date_of_birth: dob || null, home_address: homeAddress.trim() || null,
          emergency_contact_name: emName.trim() || null, emergency_contact_phone: emPhone.trim() || null,
          utr: utr.trim() || null, eligible_to_work: eligible, looking_for: lookingFor || null,
          skills,
          driving_confidence: isDriving ? drivingConfidence : null,
          licence_number: isDriving ? licenceNumber.trim() || null : null,
          licence_issued_by: isDriving ? licenceIssuedBy.trim() || null : null,
          licence_expiry: isDriving ? licenceExpiry || null : null,
          licence_passed_date: isDriving ? licencePassed || null : null,
          licence_address: isDriving ? licenceAddress.trim() || null : null,
          insurance_answers: isDriving ? { ...insurance, detail: insuranceDetail.trim() || null } : {},
          passport_valid_18mo: passportValid || null, passport_expiry: passportExpiry || null,
          pli_expiry: pliExpiry || null,
          expected_day_rate: dayRate.trim() || null, anything_else: anythingElse.trim() || null,
          documents: docs,
          references: refs.filter((r) => r.name.trim() || r.company.trim()),
          accepted, tcs_version: tcsVersion, signature,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(j.error || 'Could not submit. Please try again.');
      else setDone(true);
    } catch { setError('Could not submit. Please try again.'); }
    finally { setSubmitting(false); }
  }

  if (loading) return <Shell><p className="text-slate-400">Loading…</p></Shell>;
  if (error && !terms && !done) return <Shell><p className="text-red-600">{error}</p></Shell>;
  if (done) return (
    <Shell>
      <h1 className="text-xl font-bold text-slate-800 mb-2">Thank you</h1>
      <p className="text-slate-600">Your details have been received. We'll review them and get back to you to confirm whether you've been accepted, if we need anything more, or otherwise. There's nothing more to do here.</p>
    </Shell>
  );

  const inp = 'border border-slate-300 rounded px-2 py-1.5 text-sm w-full';
  const cell = 'flex items-center gap-2 text-sm text-slate-700';
  return (
    <Shell>
      <h1 className="text-2xl font-bold text-slate-800">Freelancer sign-up</h1>
      <p className="text-sm text-slate-500 mb-5">Please fill this in as fully as you can. Fields marked * are required.</p>

      <Section title="About you" required>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input placeholder="First name *" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inp} />
          <input placeholder="Last name *" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inp} />
          <input placeholder="Preferred name (if any)" value={preferredName} onChange={(e) => setPreferredName(e.target.value)} className={inp} />
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={inp} />
          <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={inp} />
          <input placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} className={inp} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
          <label className="text-xs text-slate-500">Date of birth<input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={inp} /></label>
          <input placeholder="Home address" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} className={`${inp} mt-4`} />
        </div>
      </Section>

      <Section title="Emergency contact">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input placeholder="Contact name" value={emName} onChange={(e) => setEmName(e.target.value)} className={inp} />
          <input placeholder="Contact phone" value={emPhone} onChange={(e) => setEmPhone(e.target.value)} className={inp} />
        </div>
      </Section>

      <Section title="Working with us">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          <input placeholder="UTR number (if you have one)" value={utr} onChange={(e) => setUtr(e.target.value)} className={inp} />
          <label className={cell}><input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} /> I'm eligible to work in the UK</label>
        </div>
        <p className="text-xs font-medium text-slate-600 mb-1">What are you looking for?</p>
        <div className="flex flex-wrap gap-3">
          {LOOKING_FOR.map((o) => (
            <label key={o.v} className={cell}><input type="radio" name="looking" checked={lookingFor === o.v} onChange={() => setLookingFor(o.v)} /> {o.label}</label>
          ))}
        </div>
      </Section>

      <Section title="Your skills" required hint="tick all that apply">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
          {SKILLS.map((s) => <label key={s} className={cell}><input type="checkbox" checked={skills.includes(s)} onChange={() => toggle(skills, setSkills, s)} /> {s}</label>)}
        </div>
      </Section>

      {isDriving && (
        <div className="border-l-2 border-purple-200 pl-4 mb-5">
          <Section title="Driving details">
            <p className="text-xs font-medium text-slate-600 mb-1">Confident driving / carrying:</p>
            <div className="flex flex-wrap gap-3 mb-3">
              {DRIVING_CONFIDENCE.map((c) => <label key={c} className={cell}><input type="checkbox" checked={drivingConfidence.includes(c)} onChange={() => toggle(drivingConfidence, setDrivingConfidence, c)} /> {c}</label>)}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input placeholder="Licence number" value={licenceNumber} onChange={(e) => setLicenceNumber(e.target.value)} className={inp} />
              <input placeholder="Issued by (e.g. DVLA)" value={licenceIssuedBy} onChange={(e) => setLicenceIssuedBy(e.target.value)} className={inp} />
              <label className="text-xs text-slate-500">Licence expiry<input type="date" value={licenceExpiry} onChange={(e) => setLicenceExpiry(e.target.value)} className={inp} /></label>
              <label className="text-xs text-slate-500">Date passed<input type="date" value={licencePassed} onChange={(e) => setLicencePassed(e.target.value)} className={inp} /></label>
            </div>
            <input placeholder="Licence address (if different from home address)" value={licenceAddress} onChange={(e) => setLicenceAddress(e.target.value)} className={`${inp} mt-2`} />
          </Section>

          <Section title="Licence & DVLA documents">
            <DocUpload token={token!} label="Licence Front" docs={docs} setDocs={setDocs} setError={setError} />
            <DocUpload token={token!} label="Licence Back" docs={docs} setDocs={setDocs} setError={setError} />
            <DocUpload token={token!} label="DVLA Summary" docs={docs} setDocs={setDocs} setError={setError} />
          </Section>

          <Section title="Insurance questionnaire">
            {INS_QUESTIONS.map((q) => (
              <div key={q.key} className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm text-slate-700">{q.q}</span>
                <div className="flex gap-3 shrink-0">
                  <label className={cell}><input type="radio" name={q.key} checked={insurance[q.key] === 'yes'} onChange={() => setInsurance({ ...insurance, [q.key]: 'yes' })} /> Yes</label>
                  <label className={cell}><input type="radio" name={q.key} checked={insurance[q.key] === 'no'} onChange={() => setInsurance({ ...insurance, [q.key]: 'no' })} /> No</label>
                </div>
              </div>
            ))}
            <textarea placeholder="If you answered Yes to any of the above, please give details" value={insuranceDetail} onChange={(e) => setInsuranceDetail(e.target.value)} className={`${inp} mt-2`} rows={2} />
          </Section>
        </div>
      )}

      <Section title="Passport (needed for EU tour work)">
        <div className="flex flex-wrap gap-3 mb-2">
          <span className="text-sm text-slate-700">Passport valid for 18+ months?</span>
          <label className={cell}><input type="radio" name="pp" checked={passportValid === 'yes'} onChange={() => setPassportValid('yes')} /> Yes</label>
          <label className={cell}><input type="radio" name="pp" checked={passportValid === 'no'} onChange={() => setPassportValid('no')} /> No</label>
          <label className={cell}><input type="radio" name="pp" checked={passportValid === 'na'} onChange={() => setPassportValid('na')} /> N/A</label>
        </div>
        <label className="text-xs text-slate-500 block mb-2">Passport expiry<input type="date" value={passportExpiry} onChange={(e) => setPassportExpiry(e.target.value)} className={inp} style={{ maxWidth: 200 }} /></label>
        <DocUpload token={token!} label="Passport" docs={docs} setDocs={setDocs} setError={setError} />
      </Section>

      <Section title="Anything else + extra documents">
        <input placeholder="Expected day rate (optional)" value={dayRate} onChange={(e) => setDayRate(e.target.value)} className={`${inp} mb-2`} />
        <textarea placeholder="Anything else we should know?" value={anythingElse} onChange={(e) => setAnythingElse(e.target.value)} className={inp} rows={2} />
        <div className="mt-2">
          <DocUpload token={token!} label="Public Liability Insurance" docs={docs} setDocs={setDocs} setError={setError} />
          <label className="text-xs text-slate-500 block mb-2">PLI expiry (if uploaded)<input type="date" value={pliExpiry} onChange={(e) => setPliExpiry(e.target.value)} className={inp} style={{ maxWidth: 200 }} /></label>
          <DocUpload token={token!} label="CV" docs={docs} setDocs={setDocs} setError={setError} />
        </div>
      </Section>

      <Section title="References">
        {refs.map((r, i) => (
          <div key={i} className="border border-slate-200 rounded p-2 mb-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input placeholder="Name" value={r.name} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} className={inp} />
              <input placeholder="Company" value={r.company} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, company: e.target.value } : x))} className={inp} />
              <input placeholder="Email" value={r.email} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} className={inp} />
              <input placeholder="Phone" value={r.phone} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))} className={inp} />
              <input placeholder="How do they know you? (role)" value={r.role} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, role: e.target.value } : x))} className={`${inp} sm:col-span-2`} />
            </div>
            <div className="flex items-center justify-between mt-1">
              <label className={cell}><input type="checkbox" checked={r.consent} onChange={(e) => setRefs(refs.map((x, j) => j === i ? { ...x, consent: e.target.checked } : x))} /> They're happy to be contacted</label>
              <button onClick={() => setRefs(refs.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm">Remove</button>
            </div>
          </div>
        ))}
        <button onClick={() => setRefs([...refs, { name: '', company: '', email: '', phone: '', role: '', consent: false }])} className="text-sm text-purple-600 hover:text-purple-800">+ Add reference</button>
      </Section>

      <Section title="Privacy & terms" required>
        <div onScroll={onTermsScroll} className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-3 max-h-48 overflow-y-auto whitespace-pre-line mb-1">{terms}</div>
        {!termsScrolled && <p className="text-xs text-amber-600 mb-2">Please scroll to the end of the terms to continue.</p>}
        <label className={`${cell} ${!termsScrolled ? 'opacity-50' : ''}`}>
          <input type="checkbox" disabled={!termsScrolled} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          I have read and agree to the above, and the information I've given is true and complete.
        </label>
      </Section>

      <Section title="Signature" required>
        <canvas ref={canvasRef} width={600} height={160} onPointerDown={start} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }}
          className="w-full border border-slate-300 rounded-lg bg-white touch-none" style={{ maxWidth: 600 }} />
        <button onClick={clearSig} className="text-xs text-slate-500 underline mt-1">Clear signature</button>
      </Section>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      <button onClick={submit} disabled={submitting} className="px-5 py-2.5 bg-purple-600 text-white rounded-lg font-medium disabled:opacity-50">
        {submitting ? 'Submitting…' : 'Submit application'}
      </button>
    </Shell>
  );
}

function DocUpload({ token, label, docs, setDocs, setError }: {
  token: string; label: string; docs: DocRef[]; setDocs: (v: DocRef[]) => void; setError: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const existing = docs.find((d) => d.label === label);
  const inputId = `doc-${label.replace(/\s+/g, '-')}`;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', label);
      const res = await fetch(`/api/freelancers/apply/${token}/upload`, { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(j.error || 'Upload failed.');
      else setDocs([...docs.filter((d) => d.label !== label), j.data]);
    } catch { setError('Upload failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex items-center gap-3 mb-1.5">
      <span className="text-sm text-slate-700 w-44 shrink-0">{label}</span>
      {existing ? (
        <span className="text-xs text-green-700 flex items-center gap-2">✓ {existing.filename}
          <button onClick={() => setDocs(docs.filter((d) => d.label !== label))} className="text-slate-400 hover:text-red-500 underline">remove</button>
        </span>
      ) : (
        <label htmlFor={inputId} className="text-xs text-purple-600 hover:text-purple-800 cursor-pointer underline">
          {busy ? 'Uploading…' : 'Upload'}
          <input id={inputId} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={onPick} disabled={busy} />
        </label>
      )}
    </div>
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
