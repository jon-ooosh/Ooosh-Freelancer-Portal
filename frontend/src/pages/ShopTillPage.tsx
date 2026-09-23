/**
 * ShopTillPage — Money > Shop Till
 *
 * The counter. Search sale stock, build a basket, take payment — or record
 * stock we've used ourselves. See `docs/SHOP-SALES-SPEC.md`.
 *
 * Two things shape the whole design:
 *
 * 1. Search and pricing hit Postgres, never HireHop. Someone is standing at the
 *    counter waiting; the till cannot sit behind a rate-limit storm.
 * 2. A sale is ONE atomic record. The old process — a week-long shared HireHop
 *    job that several people poke at — is why the shop never reconciles.
 *
 * NOTE: this saves to OP only. Nothing reaches HireHop yet (spec steps 5–6).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface StockItem {
  hhStockId: number;
  title: string;
  altTitle: string | null;
  partNumber: string | null;
  categoryPath: string | null;
  priceExVat: number | null;
  vatRateIndex: number | null;
  maxDiscount: number | null;
  quantity: number;
  refreshedAt: string;
}

interface BasketLine {
  stock: StockItem;
  qty: number;
  /** Ex-VAT, after any discount. Starts at list. */
  unitPriceCharged: number;
}

interface Totals {
  net: number;
  vat: number;
  gross: number;
  discount: number;
  discountPct: number;
}

/** Tender keys map to HireHop bank accounts via getHHBankId() on the backend. */
const TENDERS: { key: string; label: string; needsJob?: boolean }[] = [
  { key: 'worldpay', label: 'Card (Worldpay)' },
  { key: 'amex', label: 'Card (AmEx)' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'stripe_gbp', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'wise_bacs', label: 'Bank transfer' },
  { key: 'invoice_later', label: 'Invoice later', needsJob: true },
];

const money = (n: number) => `£${n.toFixed(2)}`;

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';       // never toISOString an unchecked date
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function ShopTillPage() {
  const { user } = useAuthStore();

  const [mode, setMode] = useState<'sale' | 'consumption'>('sale');
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<StockItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [tender, setTender] = useState('till_cash');
  const [notes, setNotes] = useState('');
  const [maxDiscountPct, setMaxDiscountPct] = useState(0);
  const [cacheAge, setCacheAge] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Record<string, number | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ gross: number; id: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ data: { maxDiscountPct: number } }>('/shop/discount-cap')
      .then(r => setMaxDiscountPct(r.data.maxDiscountPct))
      .catch(() => setMaxDiscountPct(0));
    api.get<{ data: { refreshedAt: string | null } }>('/shop/stock/status')
      .then(r => setCacheAge(r.data.refreshedAt))
      .catch(() => setCacheAge(null));
  }, []);

  // Debounced search. Postgres-backed, so this is cheap enough to fire per keystroke.
  useEffect(() => {
    if (term.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.get<{ data: StockItem[] }>(`/shop/stock/search?q=${encodeURIComponent(term)}&limit=25`)
        .then(r => { if (!cancelled) setResults(r.data); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term]);

  // Live availability for what's in the basket — the shelf count alone can't
  // tell you three of those are reserved for a job on Thursday.
  const basketIds = basket.map(l => l.stock.hhStockId).join(',');
  useEffect(() => {
    if (!basket.length) { setAvailability({}); return; }
    let cancelled = false;
    api.post<{ data: Record<string, { available: number | null }> }>(
      '/shop/stock/availability',
      { stockIds: basket.map(l => l.stock.hhStockId) },
    )
      .then(r => {
        if (cancelled) return;
        const flat: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(r.data)) flat[k] = v.available;
        setAvailability(flat);
      })
      .catch(() => { /* advisory only — never block a sale on it */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketIds]);

  const addItem = useCallback((item: StockItem) => {
    setBasket(prev => {
      const existing = prev.find(l => l.stock.hhStockId === item.hhStockId);
      if (existing) {
        return prev.map(l => l.stock.hhStockId === item.hhStockId ? { ...l, qty: l.qty + 1 } : l);
      }
      return [...prev, { stock: item, qty: 1, unitPriceCharged: item.priceExVat ?? 0 }];
    });
    setTerm('');
    setResults([]);
    setSaved(null);
    searchRef.current?.focus();
  }, []);

  const setQty = (id: number, qty: number) =>
    setBasket(prev => qty <= 0
      ? prev.filter(l => l.stock.hhStockId !== id)
      : prev.map(l => l.stock.hhStockId === id ? { ...l, qty } : l));

  const setPrice = (id: number, price: number) =>
    setBasket(prev => prev.map(l => l.stock.hhStockId === id ? { ...l, unitPriceCharged: price } : l));

  // Mirrors the backend arithmetic: VAT is rounded PER LINE, because a basket
  // can mix rates and total-then-tax would be wrong the moment a zero-rated
  // item is in it.
  const totals: Totals = (() => {
    let net = 0, vat = 0, listTotal = 0;
    for (const l of basket) {
      const lineNet = Math.round(l.unitPriceCharged * l.qty * 100) / 100;
      const pct = l.stock.vatRateIndex === 1 ? 0 : 20;
      net += lineNet;
      vat += Math.round(lineNet * (pct / 100) * 100) / 100;
      listTotal += (l.stock.priceExVat ?? 0) * l.qty;
    }
    net = Math.round(net * 100) / 100;
    vat = Math.round(vat * 100) / 100;
    const discount = Math.round((listTotal - net) * 100) / 100;
    return {
      net, vat,
      gross: Math.round((net + vat) * 100) / 100,
      discount,
      discountPct: listTotal > 0 ? (discount / listTotal) * 100 : 0,
    };
  })();

  const overDiscountCap = totals.discount > 0 && totals.discountPct > maxDiscountPct + 0.001;

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const body = {
        kind: mode,
        lines: basket.map(l => ({
          hhStockId: l.stock.hhStockId,
          qty: l.qty,
          unitPriceCharged: l.unitPriceCharged,
        })),
        tender: mode === 'sale' ? tender : null,
        notes: notes.trim() || null,
      };
      const r = await api.post<{ data: { id: string; totals: Totals } }>('/shop/sales', body);
      setSaved({ gross: r.data.totals.gross, id: r.data.id });
      setBasket([]);
      setNotes('');
      searchRef.current?.focus();
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not record that.');
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = basket.length > 0 && !saving && !overDiscountCap
    && (mode === 'consumption' ? notes.trim().length > 0 : true);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Shop Till</h1>
        <span className="text-xs text-gray-500">Stock as of {ago(cacheAge)}</span>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        Records to OP only for now — nothing reaches HireHop until the push step ships.
      </p>

      {/* Sale vs internal use. Deliberately different-looking: consumption is a
          stock event with no money, not a 100%-discounted sale. */}
      <div className="flex gap-2 mb-4">
        {(['sale', 'consumption'] as const).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); setSaved(null); setError(null); }}
            className={`px-4 py-2 rounded text-sm font-medium ${
              mode === m ? 'bg-ooosh-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {m === 'sale' ? 'Sale' : 'Used for Ooosh'}
          </button>
        ))}
      </div>

      {saved && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
          Recorded{saved.gross > 0 ? ` — ${money(saved.gross)}` : ''}. Next one?
        </div>
      )}
      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          ref={searchRef}
          autoFocus
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="Search or scan — name, part number…"
          className="w-full rounded border border-gray-300 px-4 py-3 text-base focus:border-ooosh-500 focus:outline-none"
        />
        {searching && <p className="mt-1 text-xs text-gray-400">Searching…</p>}
        {results.length > 0 && (
          <ul className="mt-2 max-h-72 overflow-y-auto rounded border border-gray-200 divide-y">
            {results.map(item => (
              <li key={item.hhStockId}>
                <button
                  onClick={() => addItem(item)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ooosh-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900">{item.title}</span>
                    <span className="block truncate text-xs text-gray-500">
                      {item.categoryPath}{item.partNumber ? ` · ${item.partNumber}` : ''} · {item.quantity} on shelf
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-gray-900">
                    {money((item.priceExVat ?? 0) * (item.vatRateIndex === 1 ? 1 : 1.2))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Basket */}
      {basket.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-400">
          Nothing in the basket yet.
        </p>
      ) : (
        <div className="rounded border border-gray-200 divide-y">
          {basket.map(l => {
            const list = l.stock.priceExVat ?? 0;
            const avail = availability[String(l.stock.hhStockId)];
            const reserved = avail != null && avail < l.stock.quantity;
            const short = avail != null && avail < l.qty;
            return (
              <div key={l.stock.hhStockId} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">{l.stock.title}</p>
                  <p className="text-xs text-gray-500">
                    {l.stock.quantity} on shelf
                    {reserved && (
                      <span className={short ? 'text-red-600 font-medium' : 'text-amber-600'}>
                        {' '}· only {avail} free ({l.stock.quantity - (avail ?? 0)} reserved for jobs)
                      </span>
                    )}
                    {l.stock.vatRateIndex === 1 && <span className="text-gray-400"> · zero-rated</span>}
                  </p>
                </div>

                <input
                  type="number" min={0} step={1} value={l.qty}
                  onChange={e => setQty(l.stock.hhStockId, Number(e.target.value))}
                  className="w-16 rounded border border-gray-300 px-2 py-1.5 text-center text-sm"
                  aria-label="Quantity"
                />

                {mode === 'sale' && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">£</span>
                    <input
                      type="number" min={0} step="0.01" value={l.unitPriceCharged}
                      onChange={e => setPrice(l.stock.hhStockId, Number(e.target.value))}
                      className={`w-20 rounded border px-2 py-1.5 text-right text-sm ${
                        l.unitPriceCharged < list ? 'border-amber-400 bg-amber-50' : 'border-gray-300'
                      }`}
                      aria-label="Unit price excluding VAT"
                    />
                    {l.unitPriceCharged < list && (
                      <span className="text-xs text-amber-700 whitespace-nowrap">was {money(list)}</span>
                    )}
                  </div>
                )}

                <button
                  onClick={() => setQty(l.stock.hhStockId, 0)}
                  className="text-xs text-gray-400 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Totals + tender */}
      {basket.length > 0 && (
        <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-4">
          {mode === 'sale' && (
            <>
              <div className="mb-3 space-y-1 text-sm">
                <div className="flex justify-between text-gray-600">
                  <span>Net</span><span>{money(totals.net)}</span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>VAT</span><span>{money(totals.vat)}</span>
                </div>
                {totals.discount > 0 && (
                  <div className={`flex justify-between ${overDiscountCap ? 'text-red-700 font-medium' : 'text-amber-700'}`}>
                    <span>Discount ({totals.discountPct.toFixed(1)}%)</span>
                    <span>−{money(totals.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1 text-lg font-bold text-gray-900">
                  <span>Total</span><span>{money(totals.gross)}</span>
                </div>
              </div>

              {overDiscountCap && (
                <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                  That is a {totals.discountPct.toFixed(1)}% discount and your limit is {maxDiscountPct}%
                  {user?.role ? ` (${user.role.replace(/_/g, ' ')})` : ''}. Ask a manager to apply it.
                </p>
              )}

              <label className="mb-1 block text-xs font-medium text-gray-700">Payment</label>
              <select
                value={tender}
                onChange={e => setTender(e.target.value)}
                className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                {TENDERS.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              {tender === 'invoice_later' && (
                <p className="mb-3 text-xs text-amber-700">
                  Invoice-later needs a job to put it on — a walk-in has to pay now. Job picker lands with the push step.
                </p>
              )}
            </>
          )}

          <label className="mb-1 block text-xs font-medium text-gray-700">
            {mode === 'consumption' ? 'What was it for? (required)' : 'Note (optional)'}
          </label>
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={mode === 'consumption' ? 'e.g. Snare re-head — prepping job 16412' : ''}
            className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />

          <button
            onClick={submit}
            disabled={!canSubmit}
            className="w-full rounded bg-ooosh-600 px-4 py-3 text-base font-semibold text-white hover:bg-ooosh-700 disabled:bg-gray-300"
          >
            {saving ? 'Recording…' : mode === 'sale' ? `Take ${money(totals.gross)}` : 'Record use'}
          </button>
        </div>
      )}
    </div>
  );
}
