/**
 * CardReaderPayment — the "Card reader" method on the Money tab's Record Payment form
 * (docs/STRIPE-TERMINAL-SPEC.md, Phase 1).
 *
 * Pick a reader, send the amount to it, wait for the tap. The backend records the
 * payment itself when Stripe says the card was approved (services/stripe-terminal.ts)
 * — this component only starts it and shows what happened, so closing the browser
 * mid-payment loses nothing. Try again re-sends the SAME payment (never a second one).
 *
 * In test mode the reader is Stripe's simulator, so two buttons stand in for the card.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import RecipientPicker, { type PickedRecipient } from './RecipientPicker';

export interface CardReaderAccess { enabled: boolean; mode: 'test' | 'live'; configured?: boolean }

interface Reader { id: string; label: string; status: string; device_type: string | null }

export interface Session {
  id: string;
  status: 'pending' | 'failed' | 'recording' | 'succeeded' | 'record_failed' | 'cancelled';
  amount: string;
  reader_label: string | null;
  failure_code: string | null;
  failure_message: string | null;
  hh_push_error: string | null;
  livemode: boolean;
  /** This payment moved the job to Booked — its email is the booking confirmation. */
  confirmed_booking?: boolean;
  /** "Send receipt?" (migration 292). null on payments from before it. */
  receipt_status?: 'pending' | 'sending' | 'sent' | 'auto_sent' | 'skipped' | 'failed' | null;
  receipt_sent_to?: string | null;
  /** Something to read before closing (e.g. a pre-auth that expires before the hire ends). */
  warning?: string | null;
  /** A till sale: the sale created once the card was approved. */
  shop_sale_id?: string | null;
  capture_before?: string | null;
}

const LAST_READER_KEY = 'card-reader-last-id';

function readLastReader(): string {
  try { return localStorage.getItem(LAST_READER_KEY) || ''; } catch { return ''; }
}
function writeLastReader(id: string): void {
  try { localStorage.setItem(LAST_READER_KEY, id); } catch { /* private window — fine */ }
}

interface Props {
  jobId: string;
  access: CardReaderAccess;
  amount: number;
  /** deposit / balance from Record Payment; excess / excess_preauth from the excess Manage modal. */
  paymentType: 'deposit' | 'balance' | 'excess' | 'excess_preauth' | 'shop';
  /** Starts the payment instead of POST /terminal/jobs/:jobId/pay — the shop till
   *  sends its basket to /terminal/shop/pay. */
  startPayment?: (readerId: string) => Promise<{ data: Session }>;
  /** The excess record, for excess / excess_preauth. */
  excessId?: string;
  notes: string;
  /** Returns an error to show instead of sending, or null when the form is good. */
  validate: () => string | null;
  /** The payment was recorded (or the card taken). Only a flag for the parent — it
   *  refreshes on close, because refreshing mid-flow unmounts the open form. */
  onRecorded: (session: Session) => void;
  /** A payment is on the reader (or just failed): the parent locks amount + method. */
  onActiveChange: (active: boolean) => void;
  /** Close the form. */
  onClose: () => void;
}

export default function CardReaderPayment({ jobId, access, amount, paymentType, excessId, startPayment, notes, validate, onRecorded, onActiveChange, onClose }: Props) {
  const isPreauth = paymentType === 'excess_preauth';
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [readerId, setReaderId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const tick = useRef(0);
  const recordedRef = useRef(false);
  // "Send receipt?" — who to pre-tick (undefined while asking), and who is ticked now.
  const [receiptDefaults, setReceiptDefaults] = useState<string[] | null | undefined>(undefined);
  const [receiptTo, setReceiptTo] = useState<PickedRecipient[]>([]);

  const isTest = access.mode === 'test';

  useEffect(() => {
    let alive = true;
    api.get<{ data: { mode: string; readers: Reader[] } }>('/terminal/readers')
      .then((r) => {
        if (!alive) return;
        const list = r.data.readers;
        setReaders(list);
        const last = readLastReader();
        const pick = list.find((x) => x.id === last) || list.find((x) => x.status === 'online') || list[0];
        setReaderId(pick?.id || '');
      })
      .catch((e: Error) => { if (alive) setLoadError(e.message || 'Could not load the readers'); });
    return () => { alive = false; };
  }, []);

  // Poll while the payment is open. Every 5th poll (~10s) asks Stripe directly, in
  // case a webhook is slow or missing; the rest read OP only.
  const open = session && ['pending', 'failed', 'recording'].includes(session.status);
  useEffect(() => {
    if (!session || !open) return;
    const t = setInterval(async () => {
      tick.current += 1;
      const check = tick.current % 5 === 0 ? '?check=1' : '';
      try {
        const r = await api.get<{ data: Session }>(`/terminal/sessions/${session.id}${check}`);
        setSession(r.data);
      } catch { /* keep polling — a blip is not a failure */ }
    }, 2000);
    return () => clearInterval(t);
  }, [session?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Waiting for "Send receipt?" counts as active too, so the form can't be closed by
  // accident before it's answered (the 15-minute sweep is the backstop, not the plan).
  const receiptPending = session?.status === 'succeeded' && session.receipt_status === 'pending';
  const active = !!open || receiptPending;
  useEffect(() => { onActiveChange(active); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!receiptPending || !session || receiptDefaults !== undefined) return;
    api.get<{ data: { default_emails: string[] } }>(`/terminal/sessions/${session.id}/receipt`)
      .then((r) => setReceiptDefaults(r.data.default_emails))
      .catch(() => setReceiptDefaults(null));
  }, [receiptPending, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the receipt is answered there's nothing left to see — close, unless HireHop
  // refused the deposit (staff need to read that).
  const receiptDone = session?.status === 'succeeded' && session.receipt_status !== 'pending';
  useEffect(() => {
    if (receiptDone && session && !session.hh_push_error && !session.warning && session.receipt_status !== null && session.receipt_status !== undefined) onClose();
  }, [receiptDone]); // eslint-disable-line react-hooks/exhaustive-deps

  function answerReceipt(skip: boolean) {
    if (!session) return;
    if (!skip && receiptTo.length === 0) { setError('Tick or add at least one email, or choose No receipt.'); return; }
    void act(() => api.post<{ data: Session }>(`/terminal/sessions/${session.id}/receipt`,
      skip ? { skip: true } : { recipients: receiptTo }));
  }

  useEffect(() => {
    if (!recordedRef.current && session && (session.status === 'succeeded' || session.status === 'record_failed')) {
      recordedRef.current = true;
      onRecorded(session);
    }
  }, [session?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<{ data: Session }>) {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      setSession(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    if (!readerId) { setError('Pick a reader'); return; }
    writeLastReader(readerId);
    if (startPayment) { void act(() => startPayment(readerId)); return; }
    void act(() => api.post<{ data: Session }>(`/terminal/jobs/${jobId}/pay`, {
      amount, payment_type: paymentType, reader_id: readerId, notes: notes || undefined,
      ...(excessId ? { excess_id: excessId } : {}),
    }));
  }

  // ── Before sending: reader picker + Send ──
  if (!session) {
    return (
      <div className="space-y-3">
        {isTest && (
          <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-800">
            <strong>Test mode.</strong> This uses Stripe's simulated reader, not the real S700. No card is charged,
            but OP records the payment for real (HireHop deposit marked TEST MODE) - use a test job.
          </div>
        )}
        {access.configured === false && (
          <p className="text-xs text-red-600">The Stripe key for {isTest ? 'test' : 'live'} mode is not set on the server.</p>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Reader</label>
          {loadError ? (
            <p className="text-xs text-red-600">{loadError}</p>
          ) : !readers ? (
            <p className="text-xs text-gray-500">Loading readers...</p>
          ) : readers.length === 0 ? (
            <p className="text-xs text-red-600">No readers are registered in Stripe.</p>
          ) : readers.length === 1 ? (
            <p className="text-sm text-gray-700">
              {readers[0]!.label} <span className={readers[0]!.status === 'online' ? 'text-green-600' : 'text-red-600'}>({readers[0]!.status})</span>
            </p>
          ) : (
            <select value={readerId} onChange={(e) => setReaderId(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2">
              {readers.map((r) => <option key={r.id} value={r.id}>{r.label} ({r.status})</option>)}
            </select>
          )}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-2 pt-2">
          <button onClick={send} disabled={busy || !readerId}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
            {busy ? 'Sending...' : `${isPreauth ? 'Pre-auth' : 'Send'} £${amount > 0 ? amount.toFixed(2) : '0.00'} ${isPreauth ? 'on' : 'to'} reader`}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── After sending: the payment's state ──
  const amt = `£${Number(session.amount).toFixed(2)}`;
  return (
    <div className="space-y-3">
      {session.status === 'pending' && (
        <div className="px-3 py-3 text-sm bg-blue-50 border border-blue-200 rounded-md text-blue-900">
          <div className="font-semibold">Waiting for card...</div>
          <div className="text-xs mt-1">{amt} is showing on {session.reader_label || 'the reader'}. Ask the client to tap, insert or swipe.</div>
        </div>
      )}
      {session.status === 'recording' && (
        <div className="px-3 py-3 text-sm bg-blue-50 border border-blue-200 rounded-md text-blue-900">
          <div className="font-semibold">Card approved - recording...</div>
        </div>
      )}
      {session.status === 'failed' && (
        <div className="px-3 py-3 text-sm bg-red-50 border border-red-200 rounded-md text-red-800">
          <div className="font-semibold">Not taken</div>
          <div className="text-xs mt-1">{session.failure_message || 'The card was declined.'}{session.failure_code ? ` (${session.failure_code})` : ''}</div>
        </div>
      )}
      {session.status === 'succeeded' && (
        <div className="px-3 py-3 text-sm bg-green-50 border border-green-200 rounded-md text-green-800">
          <div className="font-semibold">
            {isPreauth ? `Pre-auth of ${amt} recorded` : `Paid - ${amt} recorded`}{session.livemode ? '' : ' (TEST MODE)'}
          </div>
          <div className="text-xs mt-1">
            {isPreauth
              ? `Nothing is taken until you capture it from the excess record.${session.capture_before ? ` Expires ${new Date(session.capture_before).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}.` : ''}`
              : paymentType === 'shop' ? 'Sale recorded.' : 'Recorded in OP and pushed to HireHop.'}
            {session.receipt_status === 'sent' || session.receipt_status === 'auto_sent'
              ? ` Receipt sent to ${session.receipt_sent_to || 'the client'}.` : ''}
            {session.receipt_status === 'skipped' ? ' No receipt sent.' : ''}
          </div>
        </div>
      )}
      {session.status === 'succeeded' && session.warning && (
        <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-300 rounded-md text-amber-900">
          <div className="font-semibold mb-1">Check this</div>
          <div>{session.warning}</div>
        </div>
      )}
      {receiptPending && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-800">
            {session.confirmed_booking ? 'Send the booking confirmation to:' : 'Send receipt?'}
          </div>
          {session.confirmed_booking && (
            <p className="text-xs text-gray-500">This payment confirmed the booking, so the client gets the confirmation email.</p>
          )}
          <RecipientPicker jobId={jobId} preselect={receiptDefaults} onChange={setReceiptTo} disabled={busy} />
          <div className="flex gap-2 pt-1">
            <button disabled={busy || receiptTo.length === 0} onClick={() => answerReceipt(false)}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
              {busy ? 'Sending...' : session.confirmed_booking ? 'Send confirmation' : 'Send receipt'}
            </button>
            {!session.confirmed_booking && (
              <button disabled={busy} onClick={() => answerReceipt(true)}
                className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md disabled:opacity-50">
                No receipt
              </button>
            )}
          </div>
        </div>
      )}
      {session.status === 'succeeded' && session.hh_push_error && (
        <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-800">
          <div className="font-semibold mb-1">Saved in OP - HireHop push failed</div>
          <div>{session.hh_push_error}</div>
        </div>
      )}
      {session.status === 'record_failed' && (
        <div className="px-3 py-3 text-sm bg-red-50 border border-red-200 rounded-md text-red-800">
          <div className="font-semibold">{isPreauth ? 'Pre-auth authorised, but OP could not record it' : 'Card taken, but OP could not record it'}</div>
          <div className="text-xs mt-1">
            {session.failure_message} - info@ has been emailed the details.
            {isPreauth ? ' The amount is held on the card: record it with Record Pre-Auth, or cancel it in Stripe.' : ' Record it by hand (Stripe GBP).'}
          </div>
        </div>
      )}
      {session.status === 'cancelled' && (
        <div className="px-3 py-3 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-700">
          <div className="font-semibold">Cancelled - nothing was taken</div>
        </div>
      )}

      {isTest && session.status === 'pending' && (
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => act(() => api.post(`/terminal/sessions/${session.id}/simulate`, { outcome: 'approve' }))}
            className="flex-1 px-3 py-1.5 text-xs font-medium text-green-700 border border-green-300 rounded-md hover:bg-green-50 disabled:opacity-50">
            Simulate approved card
          </button>
          <button disabled={busy} onClick={() => act(() => api.post(`/terminal/sessions/${session.id}/simulate`, { outcome: 'decline' }))}
            className="flex-1 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300 rounded-md hover:bg-red-50 disabled:opacity-50">
            Simulate declined card
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2 pt-2">
        {session.status === 'failed' && (
          <button disabled={busy} onClick={() => act(() => api.post(`/terminal/sessions/${session.id}/retry`, {}))}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
            Try again
          </button>
        )}
        {(session.status === 'pending' || session.status === 'failed') && (
          <>
            <button disabled={busy} onClick={() => act(() => api.get(`/terminal/sessions/${session.id}?check=1`))}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md disabled:opacity-50">
              Check status
            </button>
            <button disabled={busy} onClick={() => act(() => api.post(`/terminal/sessions/${session.id}/cancel`, {}))}
              className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md disabled:opacity-50">
              Cancel payment
            </button>
          </>
        )}
        {!active && (
          <button onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md">
            Done
          </button>
        )}
      </div>
    </div>
  );
}
