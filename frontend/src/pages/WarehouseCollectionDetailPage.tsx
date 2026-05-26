/**
 * Warehouse Collection sign-off — kiosk page (no Layout wrapper).
 *
 * Displays equipment list, captures signature, optionally emails the
 * delivery note PDF. On submit:
 *   - Job flips to dispatched (OP) + status 5 (HireHop, via writeback)
 *   - PDF lands on the Files tab of the job, signature in R2
 *   - Activity Timeline gets a "Equipment collected at HH:MM by X" note
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { warehouseFetch, getWarehouseToken } from '../services/warehouseSession';

interface EquipmentItem {
  id: string;
  name: string;
  quantity: number;
}

interface CollectionContact {
  personId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
}

interface JobDetails {
  id: string;
  hhRef: string;
  jobName: string;
  clientName: string;
  clientEmail: string;
  contacts: CollectionContact[];
  hireStartDate: string;
  pipelineStatus: string;
  items: EquipmentItem[];
}

// Sentinel for the "Someone else" picker option
const MANUAL_CONTACT = 'manual';

export default function WarehouseCollectionDetailPage() {
  const navigate = useNavigate();
  const { jobId } = useParams<{ jobId: string }>();

  const [job, setJob] = useState<JobDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [collectedBy, setCollectedBy] = useState('');
  const [emails, setEmails] = useState<string[]>(['']);
  const [sendEmail, setSendEmail] = useState(true);
  const [selectedContactId, setSelectedContactId] = useState<string>(MANUAL_CONTACT);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  const fetchJob = useCallback(async () => {
    if (!getWarehouseToken()) {
      navigate('/warehouse', { replace: true });
      return;
    }
    if (!jobId) return;
    setIsLoading(true);
    setError('');
    try {
      const response = await warehouseFetch(`/api/warehouse/collections/${jobId}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to load job');
        return;
      }
      const data = await response.json();
      const j: JobDetails = data.job;
      setJob(j);
      // Default to the lead contact (job_contacts primary first, then org
      // graph). Falls back to free-text prefilled with client name + the
      // helper-resolved email when the job has no associated people.
      const lead = j.contacts && j.contacts.length > 0 ? j.contacts[0] : null;
      if (lead) {
        setSelectedContactId(lead.personId);
        setCollectedBy(lead.name || j.clientName || '');
        setEmails(lead.email ? [lead.email] : j.clientEmail ? [j.clientEmail] : ['']);
      } else {
        setSelectedContactId(MANUAL_CONTACT);
        setCollectedBy(j.clientName || '');
        setEmails(j.clientEmail ? [j.clientEmail] : ['']);
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'unauthorized' in err) {
        navigate('/warehouse', { replace: true });
        return;
      }
      console.error('Fetch job error:', err);
      setError('Failed to load job details');
    } finally {
      setIsLoading(false);
    }
  }, [jobId, navigate]);

  useEffect(() => { fetchJob(); }, [fetchJob]);

  // Canvas init — match the prior warehouse module's setup so drawing
  // feels identical on the existing tablet
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
  }, [job]);

  function getCoordinates(e: React.TouchEvent | React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      const touch = e.touches[0];
      if (!touch) return null;
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startDrawing(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault();
    const coords = getCoordinates(e);
    if (!coords) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    setIsDrawing(true);
    ctx.beginPath();
    ctx.moveTo(coords.x, coords.y);
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    if (!isDrawing) return;
    e.preventDefault();
    const coords = getCoordinates(e);
    if (!coords) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    setHasSignature(true);
  }

  function stopDrawing() { setIsDrawing(false); }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    setHasSignature(false);
  }

  function captureSignature(): string | null {
    const canvas = canvasRef.current;
    if (!canvas || !hasSignature) return null;
    return canvas.toDataURL('image/png');
  }

  function selectContact(c: CollectionContact) {
    setSelectedContactId(c.personId);
    setCollectedBy(c.name);
    setEmails(c.email ? [c.email] : ['']);
    setSendEmail(true);
  }

  function selectManual() {
    setSelectedContactId(MANUAL_CONTACT);
    setCollectedBy('');
    setEmails(['']);
  }

  function addEmail() { if (emails.length < 3) setEmails([...emails, '']); }
  function removeEmail(index: number) { if (emails.length > 1) setEmails(emails.filter((_, i) => i !== index)); }
  function updateEmail(index: number, value: string) {
    const next = [...emails];
    next[index] = value;
    setEmails(next);
  }

  async function handleSubmit() {
    if (!hasSignature) {
      setSubmitError('Please capture a signature.');
      return;
    }
    const signature = captureSignature();
    if (!signature) {
      setSubmitError('Failed to capture signature.');
      return;
    }
    if (!collectedBy.trim()) {
      setSubmitError('Please enter the name of the person collecting.');
      return;
    }

    const validEmails = sendEmail
      ? emails.map((e) => e.trim()).filter((e) => e && /\S+@\S+\.\S+/.test(e))
      : [];
    if (sendEmail && validEmails.length === 0) {
      setSubmitError('Please enter at least one valid email address (or untick send email).');
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');
    try {
      const response = await warehouseFetch(`/api/warehouse/collections/${jobId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          signatureBase64: signature,
          collectedBy: collectedBy.trim(),
          recipientEmails: validEmails,
          jobName: job?.jobName,
          hireStartDate: job?.hireStartDate,
          hhRef: job?.hhRef,
          items: job?.items?.map((it) => ({ name: it.name, quantity: it.quantity })) || [],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setSubmitError(data.error || 'Failed to complete collection');
        return;
      }
      navigate('/warehouse/collections?completed=true', { replace: true });
    } catch (err) {
      if (err && typeof err === 'object' && 'unauthorized' in err) {
        navigate('/warehouse', { replace: true });
        return;
      }
      console.error('Submit error:', err);
      setSubmitError('Failed to complete collection. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { return dateStr; }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading job details…</p>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-gray-100 p-4">
        <div className="max-w-2xl mx-auto bg-white rounded-xl p-6 text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Error Loading Job</h1>
          <p className="text-gray-600 mb-4">{error || 'Job not found'}</p>
          <button onClick={() => navigate('/warehouse/collections')} className="text-purple-600 underline">
            Back to collections
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 pb-8">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/warehouse/collections')}
            className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-gray-800 truncate">{job.jobName}</h1>
            <p className="text-sm text-gray-500">Collection sign-off</p>
          </div>
          <img src="/ooosh-logo-full.jpg" alt="Ooosh" className="h-9 w-auto" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Hire start date</p>
              <p className="font-medium text-gray-800">{formatDate(job.hireStartDate)}</p>
            </div>
            {job.hhRef && (
              <div>
                <p className="text-gray-500">HireHop ref</p>
                <p className="font-medium text-gray-800">{job.hhRef}</p>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-purple-50 border-b border-purple-100">
            <h2 className="font-semibold text-purple-800">📦 Equipment ({job.items.length} items)</h2>
          </div>
          <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
            {job.items.length === 0 ? (
              <p className="p-4 text-gray-500 text-center">No equipment items found</p>
            ) : (
              job.items.map((item, index) => (
                <div key={item.id || index} className="px-4 py-3 flex justify-between items-center">
                  <span className="text-gray-800">{item.name}</span>
                  <span className="text-gray-600 font-medium bg-gray-100 px-2 py-1 rounded">
                    ×{item.quantity}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {job.contacts.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <label className="block text-sm font-medium text-gray-700 mb-3">👤 Who's collecting?</label>
            <div className="space-y-2">
              {job.contacts.map((c) => {
                const selected = selectedContactId === c.personId;
                return (
                  <button
                    key={c.personId}
                    type="button"
                    onClick={() => selectContact(c)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                      selected
                        ? 'border-purple-500 bg-purple-50 ring-2 ring-purple-200'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">
                          {c.isPrimary && <span className="text-amber-500 mr-1" title="Lead contact">★</span>}
                          {c.name}
                          {c.role && <span className="text-gray-400 font-normal"> · {c.role}</span>}
                        </p>
                        {c.email && <p className="text-sm text-gray-500 truncate">{c.email}</p>}
                      </div>
                      {selected && <span className="text-purple-600 text-lg">✓</span>}
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={selectManual}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                  selectedContactId === MANUAL_CONTACT
                    ? 'border-purple-500 bg-purple-50 ring-2 ring-purple-200'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <p className="font-medium text-gray-800">✏️ Someone else</p>
                <p className="text-sm text-gray-500">Type the collector's name and email below</p>
              </button>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl p-4 shadow-sm">
          <label className="block text-sm font-medium text-gray-700 mb-2">👤 Collected by</label>
          <input
            type="text"
            value={collectedBy}
            onChange={(e) => setCollectedBy(e.target.value)}
            placeholder="Enter name of person collecting"
            className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            {job.contacts.length > 0
              ? 'Auto-filled from the contact above — overtype if needed'
              : `Edit if someone other than ${job.clientName || 'the contact'} is collecting`}
          </p>
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-gray-700">📧 Send delivery note</label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span className="text-sm text-gray-600">Send email</span>
            </label>
          </div>
          {sendEmail && (
            <div className="space-y-2">
              {emails.map((email, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => updateEmail(index, e.target.value)}
                    placeholder="Email address"
                    className="flex-1 px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  {emails.length > 1 && (
                    <button onClick={() => removeEmail(index)} className="p-3 text-red-500 hover:bg-red-50 rounded-lg">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {emails.length < 3 && (
                <button onClick={addEmail} className="text-sm text-purple-600 hover:text-purple-700">
                  + Add another email
                </button>
              )}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-gray-700">✍️ Signature</label>
            {hasSignature && (
              <button onClick={clearSignature} className="text-sm text-red-500 hover:text-red-600">Clear</button>
            )}
          </div>
          <div className="border-2 border-dashed border-gray-300 rounded-lg overflow-hidden bg-white">
            <canvas
              ref={canvasRef}
              className="w-full h-40 touch-none cursor-crosshair"
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
            />
          </div>
          <p className="mt-2 text-xs text-gray-400 text-center">
            Sign above to confirm collection of equipment
          </p>
        </div>

        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-red-700">{submitError}</p>
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={isSubmitting || !hasSignature}
          className="w-full bg-purple-600 text-white py-4 rounded-xl font-semibold text-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors shadow-lg"
        >
          {isSubmitting ? 'Processing…' : '✅ Complete Collection'}
        </button>
      </main>
    </div>
  );
}
