/**
 * ShopWeekClose — the weekly close on the till's "This week" tab
 * (SHOP-SALES-SPEC.md §20). Admin only: approving commits the week to Xero.
 *
 * Two steps on purpose. "Check it's ready" reads HireHop and shows what the
 * close WOULD do — or what's stopping it — without writing anything. Only then
 * does the Close button appear. A close that stops part-way (a penny out at
 * the draft, a Xero refusal) says why, and the same button carries on from
 * where it got to.
 */
import { useState } from 'react';
import { api } from '../../services/api';

type CloseState = 'drafted' | 'approved' | 'allocated' | 'completed';

interface CloseLogEntry { at: string; step: string; ok: boolean; detail: string }

interface ClosePreview {
  closeState: CloseState | null;
  hhInvoiceNumber: string | null;
  ready: boolean;
  blockers: string[];
  expectedGross: number;
  payments: Array<{ depositId: number; bankId: number | null; available: number }>;
  paymentsHeld: number;
  empty: boolean;
  invoiceDate: string;
  log: CloseLogEntry[];
}

interface CloseResult { done: boolean; message: string; preview: ClosePreview }

// HireHop bank ids (backend services/hh-deposit.ts HH_BANK_IDS) — display only.
const BANKS: Record<number, string> = {
  165: 'Amex', 168: 'Till (cash)', 169: 'Worldpay', 170: 'Lloyds',
  173: 'PayPal', 265: 'Wise (BACS)', 267: 'Stripe',
};

const STATE_LABEL: Record<CloseState, string> = {
  drafted: 'the draft invoice',
  approved: 'approving the invoice',
  allocated: 'allocating the payments',
  completed: 'closing',
};

const money = (n: number) => `£${n.toFixed(2)}`;

const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

interface Props {
  periodId: string;
  closeState: CloseState | null;
  invoiceNumber: string | null;
  closedAt: string | null;
  onChanged: () => void;
}

export default function ShopWeekClose({ periodId, closeState, invoiceNumber, closedAt, onChanged }: Props) {
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'close' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (closeState === 'completed') {
    return (
      <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
        <strong>Week closed.</strong>{' '}
        {invoiceNumber ? `Invoice ${invoiceNumber}, paid in full.` : 'Nothing was sold, so no invoice.'}{' '}
        The job is Completed{closedAt ? ` — ${fmtWhen(closedAt)}` : ''}.
      </div>
    );
  }

  const check = async () => {
    setBusy('check');
    setError(null);
    setResult(null);
    try {
      const r = await api.get<{ data: ClosePreview }>(`/shop/week/${periodId}/close`);
      setPreview(r.data);
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not check the week.');
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    const what = preview?.empty
      ? 'Nothing was sold, so this just sets the HireHop job to Completed. Carry on?'
      : `This raises the invoice (dated ${preview ? fmtDay(preview.invoiceDate) : 'Sunday'}), approves it into Xero, `
        + 'allocates every payment to it and sets the job to Completed. It can\'t be undone from here. Carry on?';
    if (!window.confirm(what)) return;
    setBusy('close');
    setError(null);
    try {
      const r = await api.post<{ data: CloseResult }>(`/shop/week/${periodId}/close`, {});
      setResult(r.data);
      setPreview(r.data.preview);
      onChanged();
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'The close failed.');
    } finally {
      setBusy(null);
    }
  };

  const state = preview?.closeState ?? closeState;
  const log = preview?.log ?? [];

  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-700">Close this week</h3>
        <span className="text-[11px] text-gray-400">admin only</span>
      </div>

      {state && state !== 'completed' && (
        <p className="mb-2 text-sm text-amber-800">
          Started, but stopped at {STATE_LABEL[state]}. Close carries on from there.
        </p>
      )}
      {!state && !preview && (
        <p className="mb-2 text-xs text-gray-500">
          Invoice the week&rsquo;s shop job, allocate every payment to it and set it to Completed.
          Check first — nothing is changed until you press Close.
        </p>
      )}

      {preview && !state && preview.blockers.length > 0 && (
        <div className="mb-2">
          <p className="text-sm font-medium text-red-800">Can&rsquo;t close yet:</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-red-800">
            {preview.blockers.map(b => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      {preview && preview.ready && !state && (
        preview.empty ? (
          <p className="mb-2 text-sm text-gray-700">Nothing was sold (everything cancelled or refunded) — no invoice needed.</p>
        ) : (
          <dl className="mb-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            <dt className="text-gray-600">Invoice, dated {fmtDay(preview.invoiceDate)}</dt>
            <dd className="text-right font-medium tabular-nums">{money(preview.expectedGross)}</dd>
            {preview.payments.map(p => (
              <div key={p.depositId} className="contents">
                <dt className="text-gray-500">Payment {p.depositId} · {p.bankId != null ? BANKS[p.bankId] ?? `bank ${p.bankId}` : '?'}</dt>
                <dd className="text-right tabular-nums text-gray-500">{money(p.available)}</dd>
              </div>
            ))}
            <dt className="text-gray-600">Payments held</dt>
            <dd className="text-right font-medium tabular-nums">{money(preview.paymentsHeld)}</dd>
          </dl>
        )
      )}

      {result && (
        <p className={`mb-2 text-sm ${result.done ? 'text-green-800' : 'text-red-800'}`}>{result.message}</p>
      )}
      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={check}
          disabled={busy != null}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy === 'check' ? 'Checking HireHop…' : preview ? 'Check again' : 'Check it’s ready'}
        </button>
        {preview?.ready && (
          <button
            onClick={close}
            disabled={busy != null}
            className="rounded bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-800 disabled:opacity-50"
          >
            {busy === 'close' ? 'Closing…' : state ? 'Carry on closing' : 'Close week'}
          </button>
        )}
      </div>

      {log.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-gray-500">What happened ({log.length})</summary>
          <ul className="mt-1 space-y-1 text-[11px]">
            {log.map((e, i) => (
              <li key={i} className={e.ok ? 'text-gray-600' : 'text-red-700'}>
                <span className="text-gray-400">{fmtWhen(e.at)}</span> · {e.step}: {e.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
