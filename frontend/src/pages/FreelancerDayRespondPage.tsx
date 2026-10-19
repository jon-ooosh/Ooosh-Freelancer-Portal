/**
 * Public accept / decline page for a yard-day offer (spec §9.4).
 *
 * Token-authenticated, no login, no Layout shell — they arrive from an email,
 * on a phone, probably with one hand. Mirrors OohReturnParkingPage.
 *
 * WHY THIS PAGE EXISTS AT ALL, rather than the email's buttons just doing it:
 * mail scanners follow every link in a message before a human sees it, so a
 * one-click accept URL would accept on their behalf. The email carries the
 * INTENT (?r=accept) and this page carries the confirmation.
 *
 * A DEAD LINK MUST SAY WHY. Somebody is standing in a corridor with their phone
 * out; "this didn't work" leaves them not knowing whether they are expected at
 * the yard tomorrow. Every unusable state below names what happened and ends by
 * telling them to ring us.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

type Reason = 'unknown' | 'passed' | 'answered' | 'cancelled' | 'completed';

interface OfferView {
  usable: boolean;
  reason: Reason | null;
  personName: string | null;
  booking: {
    bookingDate: string;
    bookingDateLabel: string;
    duration: string;
    rate: string;
    notes: string | null;
    status: string;
  } | null;
}

/** What a dead link says. Each one answers "so am I expected or not?". */
function deadLinkMessage(reason: Reason | null, status?: string): { title: string; body: string } {
  switch (reason) {
    case 'answered':
      return {
        title: status === 'accepted' ? 'You already said yes to this one' : 'You already replied to this one',
        body: status === 'accepted'
          ? 'We have you down for it, so there is nothing else to do. If something has changed and you can no longer make it — or you tapped the wrong button — please get in touch rather than leaving it.'
          : 'Your answer is recorded and no one is expecting you. If you have changed your mind and could do it after all, or you tapped the wrong button, get in touch — it may still be going.',
      };
    case 'passed':
      return {
        title: 'That day has been and gone',
        body: 'This link was for a day that has already passed, so there is nothing left to answer. If you think that is wrong, or you did work that day and it is not showing, please get in touch.',
      };
    case 'cancelled':
      return {
        title: 'That day was cancelled',
        body: 'The day is no longer going ahead and nobody is expecting you. Sorry for the back and forth. We will be in touch about other days.',
      };
    case 'completed':
      return {
        title: 'That day is already done',
        body: 'This one is marked as worked and closed off. If your invoice is outstanding, or something does not look right, please get in touch.',
      };
    default:
      return {
        title: 'We do not recognise that link',
        body: 'It may have been mistyped, or cut in half by an email app. Try opening it again from the original message — and if it still will not work, get in touch and we will sort it out.',
      };
  }
}

export default function FreelancerDayRespondPage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  // Which button they pressed in the email. It ONLY highlights the matching
  // button here — it never answers on its own, because mail scanners follow
  // every link in a message before a human sees it. Highlighting is what makes
  // the tap on this page read as confirming rather than being asked twice.
  const intent = params.get('r') === 'accept' ? 'accepted'
    : params.get('r') === 'decline' ? 'declined' : null;

  const [view, setView] = useState<OfferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  // WHICH button is in flight, so only that one reads "Sending…" and a
  // double-tap cannot fire the request twice.
  const [saving, setSaving] = useState<'accepted' | 'declined' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/freelancer-days/respond/${token}`);
        const data = await res.json();
        if (live) setView(data as OfferView);
      } catch {
        if (live) setView({ usable: false, reason: 'unknown', personName: null, booking: null });
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [token]);

  async function submit(choice: 'accepted' | 'declined') {
    if (saving) return;
    setSaving(choice);
    setError('');
    try {
      const res = await fetch(`/api/freelancer-days/respond/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: choice, note: note.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A 409 means it stopped being answerable between loading and pressing
        // — cancelled while they were reading it, most likely. Re-render as the
        // dead link it now is rather than showing a raw error.
        if (res.status === 409 || res.status === 404) {
          setView(data as OfferView);
          return;
        }
        setError(data?.error || 'That did not save. Please try again, or ring us.');
        return;
      }
      setDone(choice);
    } catch {
      setError('That did not save — you may have lost signal. Try again, or ring us.');
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return <Shell><p className="text-sm text-gray-500">Loading…</p></Shell>;
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          {done === 'accepted' ? 'Brilliant — thank you' : 'Thanks for letting us know'}
        </h1>
        <p className="text-sm text-gray-600 leading-relaxed">
          {done === 'accepted'
            ? `We have you down for ${view?.booking?.bookingDateLabel ?? 'that day'}. If anything changes, let us know rather than leaving it — we would always rather hear early.`
            : 'No problem at all, and thanks for answering rather than leaving us guessing. We will keep you in mind for other days.'}
        </p>
      </Shell>
    );
  }

  if (!view?.usable || !view.booking) {
    const msg = deadLinkMessage(view?.reason ?? null, view?.booking?.status);
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">{msg.title}</h1>
        <p className="text-sm text-gray-600 leading-relaxed mb-4">{msg.body}</p>
        <p className="text-sm text-gray-500">Ooosh Tours</p>
      </Shell>
    );
  }

  const b = view.booking;
  return (
    <Shell>
      <h1 className="text-xl font-semibold text-gray-900 mb-1">
        {view.personName ? `Hi ${view.personName} —` : ''} can you do this day?
      </h1>
      <p className="text-sm text-gray-600 mb-4">A day at the yard with us. Saying no is completely fine.</p>

      <dl className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-5 space-y-3">
        <Row label="Day" value={b.bookingDateLabel} />
        <Row label="Hours" value={b.duration} />
        <Row label="Rate" value={b.rate} />
        {b.notes && <Row label="What we need a hand with" value={b.notes} />}
      </dl>

      {/* Above the buttons on purpose: the buttons ARE the send, so anything
          typed after pressing one would be lost. §9.4 decision 3 — a decline is
          a response, not something to excuse — so this stays optional and is
          labelled as such. */}
      <label className="block mb-4">
        <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
          Anything to add? (optional)
        </span>
        <input
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={500}
          placeholder="e.g. I could do it but not until 11"
          className="w-full px-3 py-2 rounded border border-gray-300 text-sm"
        />
      </label>

      {error && (
        <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</p>
      )}

      {/* One tap answers — no confirm step. The two labels say exactly what
          each does, and a second screen asking you to agree with yourself is
          the kind of thing people stop reading. A mis-tap is recoverable: the
          link still works, says which way it went, and tells them to get in
          touch. */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => void submit('accepted')}
          className={`px-4 py-4 rounded-lg text-sm font-semibold bg-green-700 text-white disabled:opacity-40 ${
            intent === 'accepted' ? 'ring-4 ring-green-200' : ''}`}
        >
          {saving === 'accepted' ? 'Sending…' : 'Yes, I can do it'}
        </button>
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => void submit('declined')}
          className={`px-4 py-4 rounded-lg text-sm font-semibold bg-white border-2 border-gray-300 text-gray-700 disabled:opacity-40 ${
            intent === 'declined' ? 'ring-4 ring-gray-200' : ''}`}
        >
          {saving === 'declined' ? 'Sending…' : 'Sorry, I cannot'}
        </button>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 mt-0.5">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100 py-8 px-4">
      <div className="mx-auto w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        {children}
      </div>
    </div>
  );
}
