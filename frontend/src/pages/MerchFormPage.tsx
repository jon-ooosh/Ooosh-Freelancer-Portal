/**
 * Public inbound merch-delivery form (no login). Replaces the JotForm.
 * Client tells us what they're sending; on submit the backend creates the
 * held_item, generates labels, and emails them back. Pre-filled with the HH
 * job number via ?job= so the record auto-links.
 *
 * Mounted outside the Layout shell (public route). Uses plain fetch.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const inputCls = 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base';
const PURPLE = '#7B5EA7';

export default function MerchFormPage() {
  const [params] = useSearchParams();
  const jobFromUrl = params.get('job') || '';
  const [ctx, setCtx] = useState<{ client_name: string | null } | null>(null);
  const [f, setF] = useState({
    band_name: '', hh_job_number: jobFromUrl, box_count: '', expected_date: '',
    import_charge_flag: '', contact_email: '', contact_phone: '', notes: '', agree: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!jobFromUrl) return;
    fetch(`/api/holding/public/job/${jobFromUrl}`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (j?.data) { setCtx(j.data); if (j.data.client_name) setF((cur) => ({ ...cur, band_name: cur.band_name || j.data.client_name })); }
    }).catch(() => {});
  }, [jobFromUrl]);

  async function submit() {
    setErr('');
    if (!f.band_name.trim()) { setErr('Please enter the band / artist name.'); return; }
    if (!f.box_count || Number(f.box_count) < 1) { setErr('How many boxes are you sending?'); return; }
    if (!f.contact_email.trim()) { setErr('We need an email to send your labels to.'); return; }
    if (!f.agree) { setErr('Please accept the terms to continue.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/holding/public/merch-form', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          band_name: f.band_name.trim(),
          hh_job_number: f.hh_job_number ? Number(f.hh_job_number) : null,
          box_count: Number(f.box_count),
          expected_date: f.expected_date || null,
          import_charge_flag: f.import_charge_flag || null,
          contact_email: f.contact_email.trim(),
          contact_phone: f.contact_phone || null,
          notes: f.notes || null,
        }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Submission failed'); }
      setDone(true);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Submission failed'); } finally { setSubmitting(false); }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">Thanks!</h1>
          <p className="text-slate-600">We've emailed your printable labels to <strong>{f.contact_email}</strong>. Please attach one to each box — we can't accept items without a label.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow p-6">
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Merch / equipment delivery</h1>
        <p className="text-sm text-slate-500 mb-5">
          Sending items to Ooosh ahead of your hire{ctx?.client_name ? ` (${ctx.client_name})` : ''}? Tell us what's coming and we'll email you labels to print.
        </p>

        <div className="space-y-4">
          <div><label className="block text-sm text-slate-500 mb-1">Band / artist name *</label>
            <input className={inputCls} value={f.band_name} onChange={(e) => setF({ ...f, band_name: e.target.value })} /></div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm text-slate-500 mb-1">Job / contract #</label>
              <input className={inputCls} type="number" inputMode="numeric" value={f.hh_job_number} onChange={(e) => setF({ ...f, hh_job_number: e.target.value })} placeholder="0000" /></div>
            <div><label className="block text-sm text-slate-500 mb-1">Total boxes *</label>
              <input className={inputCls} type="number" inputMode="numeric" value={f.box_count} onChange={(e) => setF({ ...f, box_count: e.target.value })} /></div>
          </div>

          <div><label className="block text-sm text-slate-500 mb-1">Estimated delivery date</label>
            <input className={inputCls} type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></div>

          <div><label className="block text-sm text-slate-500 mb-1">Will a customs / import charge be payable?</label>
            <select className={inputCls} value={f.import_charge_flag} onChange={(e) => setF({ ...f, import_charge_flag: e.target.value })}>
              <option value="">—</option><option value="no">No</option><option value="yes">Yes</option><option value="unknown">Don't know</option>
            </select></div>

          <div><label className="block text-sm text-slate-500 mb-1">Contact email *</label>
            <input className={inputCls} type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />
            <p className="text-xs text-slate-400 mt-1">We'll send your labels and arrival updates here.</p></div>

          <div><label className="block text-sm text-slate-500 mb-1">Contact phone</label>
            <input className={inputCls} type="tel" value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} /></div>

          <div><label className="block text-sm text-slate-500 mb-1">Anything we should know?</label>
            <textarea className={inputCls} rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>

          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input type="checkbox" className="w-5 h-5 mt-0.5" checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} />
            <span>I understand items must arrive no more than 5 days before the hire, each box must carry a printed label, and Ooosh accepts deliveries as a goodwill service without liability for loss or damage.</span>
          </label>

          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button onClick={submit} disabled={submitting} style={{ backgroundColor: PURPLE }}
            className="w-full text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50">{submitting ? 'Submitting…' : 'Submit & get my labels'}</button>
        </div>
      </div>
    </div>
  );
}
