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
 * Saves to OP instantly; the drain sends each transaction to HireHop after the
 * push hold (Window A). A sale that has reached HireHop is refunded from the
 * Recent Sales list (Window B, spec §8) — it is never deleted.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { jobDisplayOrgName } from '../lib/jobOrgName';
import ShopWeekPanel from '../components/shop/ShopWeekPanel';
import { TENDERS } from '../lib/shopTenders';

type BottomTab = 'recent' | 'attention' | 'review' | 'week' | 'used' | 'reorder';
const BOTTOM_TABS: BottomTab[] = ['recent', 'attention', 'review', 'week', 'used', 'reorder'];
const TAB_KEY = 'shopTill.tab';

interface StockItem {
  hhStockId: number;
  title: string;
  altTitle: string | null;
  partNumber: string | null;
  categoryPath: string | null;
  priceExVat: number | null;
  /** Resolved server-side — the UI must never apply the VAT rule itself. */
  priceIncVat: number | null;
  vatRatePct: number | null;
  vatRateIndex: number | null;
  maxDiscount: number | null;
  quantity: number;
  reorderLevel?: number | null;
  reorderQty?: number | null;
  refreshedAt: string;
}

interface BasketLine {
  stock: StockItem;
  qty: number;
  /**
   * Ex-VAT unit price, held as the TEXT the operator typed.
   *
   * A number here renders "1.6" where a price should read "1.60", and
   * reformatting on every keystroke fights whoever is mid-type. Kept as a
   * string, parsed for arithmetic, tidied on blur.
   */
  priceText: string;
}

interface RecentSale {
  id: string;
  kind: string;
  status: string;
  tender: string | null;
  gross_amount: string | number;
  notes: string | null;
  push_error: string | null;
  created_at: string;
  recorded_by_name: string | null;
  /** OT-SHOP-00100 — sales only. */
  sale_ref: string | null;
  /** On a reversal: the sale it refunds. */
  reverses_sale_ref: string | null;
  /** On a sale: its live reversal, once refunded. */
  reversal_id: string | null;
  /** On a reversal: when the customer actually got their money back. */
  refund_settled_at: string | null;
  /** What was bought (sales and consumption). */
  lines?: { name: string; qty: number | string }[];
  /** On a reversal: what the refunded sale contained. */
  reverses_lines?: { name: string; qty: number | string }[] | null;
  /** Cash or card: refunded there and then, so pressing Refund confirms it. */
  refund_at_counter: boolean;
  /** Where the latest receipt for this sale went, if one was sent. */
  last_receipt_to?: string | null;
  /** Taken on a studio sitter's phone — staff tick these off. */
  recorded_in?: string;
  needs_review?: boolean;
  reviewed_at?: string | null;
  /** The job a routed sale went on (a reversal shows its original's). */
  sold_to_hh_job_number: number | null;
  sold_to_job_name: string | null;
  sold_to_lead_org_name: string | null;
  sold_to_client_org_name: string | null;
  sold_to_company_name: string | null;
  sold_to_client_name: string | null;
}

/** A job a sale can go on — from GET /shop/jobs/today or /shop/jobs/search. */
interface SellableJob {
  id: string;
  hhJobNumber: number;
  jobName: string | null;
  lead_org_name: string | null;
  client_org_name: string | null;
  company_name: string | null;
  client_name: string | null;
  rooms?: string[];
}

/** "Whose job is this" — through THE definition, falling back to the job name. */
const jobLabel = (j: SellableJob) => jobDisplayOrgName(j) || j.jobName || `Job ${j.hhJobNumber}`;

interface ReceiptSuggestion { email: string; label: string }

/** Email a receipt for a sale, or a refund receipt for a refund. Returns an error message, or null. */
async function sendReceipt(saleId: string, to: string): Promise<string | null> {
  try {
    await api.post(`/shop/sales/${saleId}/receipt`, { to: to.trim() });
    return null;
  } catch (e: any) {
    return e?.body?.error || e?.message || 'The receipt did not send.';
  }
}

interface PeriodInfo {
  periodStart: string;
  period: { hh_job_number: number | null; period_end: string } | null;
}

interface ConsumptionRow {
  hh_stock_id: number;
  name: string;
  total_qty: string | number;
  occasions: number;
  last_used: string;
  on_shelf: string | number | null;
  reorder_level: string | number | null;
}

interface Totals {
  net: number;
  vat: number;
  gross: number;
  discount: number;
  discountPct: number;
}


const money = (n: number) => `£${n.toFixed(2)}`;

/** How the money physically goes back — OP can't do this part until Stripe. */
function refundHow(tender: string | null, amount: number): string {
  const a = money(Math.abs(amount));
  switch (tender) {
    case 'till_cash': return `Give ${a} back from the till`;
    case 'worldpay':
    case 'amex': return `Refund ${a} on the card terminal`;
    case 'stripe_gbp': return `Refund ${a} in Stripe`;
    case 'paypal': return `Refund ${a} in PayPal`;
    case 'wise_bacs': return `Send ${a} back by bank transfer`;
    // It was never paid — it simply comes off the job, and their invoice.
    case 'invoice_later': return `Nothing to hand back — ${a} comes off their bill`;
    default: return `Return ${a} to the customer`;
  }
}
/** Parse a typed price. A half-typed "1." must read as 1, not NaN. */
const num = (t: string) => { const n = parseFloat(t); return Number.isFinite(n) ? n : 0; };

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
  // Card is what almost every walk-in pays with, so it is the default.
  const [tender, setTender] = useState('worldpay');
  const [notes, setNotes] = useState('');
  const [maxDiscountPct, setMaxDiscountPct] = useState(0);
  const [cacheAge, setCacheAge] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Record<string, number | null>>({});
  const [availChecked, setAvailChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ gross: number; id: string; kind: string; receipt?: string } | null>(null);
  // Receipts (step 11). The checkout's optional box, the one Recent Sales row
  // whose receipt form is open, and the refund form's refund-receipt box.
  const [receiptTo, setReceiptTo] = useState('');
  const [jobContacts, setJobContacts] = useState<ReceiptSuggestion[]>([]);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [receiptFormTo, setReceiptFormTo] = useState('');
  const [receiptSuggestions, setReceiptSuggestions] = useState<ReceiptSuggestion[]>([]);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [refundReceiptTo, setRefundReceiptTo] = useState('');
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [usage, setUsage] = useState<ConsumptionRow[] | null>(null);
  const [period, setPeriod] = useState<PeriodInfo | null>(null);
  const [creatingPeriod, setCreatingPeriod] = useState(false);
  // The bottom tabs. null = folded away, which is how most visits leave it.
  // `?tab=review` (the lock-up report and the reminder email link here) wins
  // over the remembered tab, so a link always lands on what it's about.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<BottomTab | null>(() => {
    const linked = searchParams.get('tab');
    if (BOTTOM_TABS.includes(linked as BottomTab)) return linked as BottomTab;
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return BOTTOM_TABS.includes(saved as BottomTab) ? (saved as BottomTab) : null;
    } catch {
      return null;   // private window / blocked storage — just start folded
    }
  });
  const pickTab = (t: BottomTab | null) => {
    setTab(t);
    try {
      if (t) localStorage.setItem(TAB_KEY, t); else localStorage.removeItem(TAB_KEY);
    } catch { /* a convenience, not state — ignore */ }
  };
  const [attention, setAttention] = useState<RecentSale[]>([]);
  // Sitter sales staff haven't ticked off yet (spec §5).
  const [toReview, setToReview] = useState<RecentSale[]>([]);
  const [reorder, setReorder] = useState<StockItem[] | null>(null);
  // The refund form open on one Recent Sales row at a time.
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const canRefund = hasManagerRole(user?.role);

  // Who the sale is for: null = walk-in (the week's shop job), or a real job.
  // Editable right up to payment — "oh, can it go on the band's bill?" is the
  // normal case, not an exception (spec §4.1).
  const [route, setRoute] = useState<SellableJob | null>(null);
  const [todayJobs, setTodayJobs] = useState<SellableJob[]>([]);
  const [jobTerm, setJobTerm] = useState('');
  const [jobResults, setJobResults] = useState<SellableJob[]>([]);
  const [jobSearchOpen, setJobSearchOpen] = useState(false);

  /** Change route, and re-check the tender: "their bill" needs a job (§4.1). */
  const chooseRoute = (j: SellableJob | null) => {
    // A receipt address belongs to whoever the sale was for. Switching who it's
    // for clears it, so band A's manager can't get walk-in B's receipt (jon).
    if ((j?.id ?? null) !== (route?.id ?? null)) setReceiptTo('');
    setRoute(j);
    setJobSearchOpen(false);
    setJobTerm('');
    setJobResults([]);
    if (!j && tender === 'invoice_later') setTender('worldpay');
  };

  // A band's job: offer its contacts in the receipt box (THE contact pool, server-side).
  useEffect(() => {
    if (!route) { setJobContacts([]); return; }
    let cancelled = false;
    api.get<{ data: ReceiptSuggestion[] }>(`/shop/jobs/${route.id}/receipt-contacts`)
      .then(r => { if (!cancelled) setJobContacts(r.data); })
      .catch(() => { if (!cancelled) setJobContacts([]); });
    return () => { cancelled = true; };
  }, [route]);

  useEffect(() => {
    if (jobTerm.trim().length < 2) { setJobResults([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.get<{ data: SellableJob[] }>(`/shop/jobs/search?q=${encodeURIComponent(jobTerm)}`)
        .then(r => { if (!cancelled) setJobResults(r.data); })
        .catch(() => { if (!cancelled) setJobResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [jobTerm]);

  // The success note is a nod, not a record — the Recent Sales list is the
  // record — so it goes after a few seconds. Errors stay until dealt with.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 4000);
    return () => clearTimeout(t);
  }, [saved]);

  /** Requeue a failed push once whatever broke has been fixed. */
  const retrySale = useCallback(async (id: string) => {
    try {
      await api.post(`/shop/sales/${id}/retry`, {});
      await api.post('/shop/drain', {});   // don't make them wait for the tick
    } catch {
      /* the row's own status is the feedback */
    }
    loadRecentRef.current?.();
  }, []);

  const loadRecentRef = useRef<(() => void) | null>(null);

  /** Window A: a true undo — nothing has reached HireHop yet. */
  const cancelSale = useCallback(async (id: string) => {
    if (!window.confirm('Cancel this? Nothing has reached HireHop yet, so it simply won\'t happen.')) return;
    setError(null);
    try {
      await api.post(`/shop/sales/${id}/cancel`, {});
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not cancel that.');
    }
    loadRecentRef.current?.();
  }, []);

  /** Window B: lines off the job and a refund against the payment (spec §8). */
  const refundSale = useCallback(async (id: string) => {
    setRefundBusy(true);
    setError(null);
    try {
      const r = await api.post<{ data: { reversalId: string } }>(`/shop/sales/${id}/reverse`, { reason: refundReason.trim() });
      if (refundReceiptTo.trim()) {
        const err = await sendReceipt(r.data.reversalId, refundReceiptTo);
        if (err) setError(`Refund recorded, but the refund receipt didn't send: ${err}`);
      }
      setRefundFor(null);
      setRefundReason('');
      setRefundReceiptTo('');
      // The refund drains straight away; give it a moment to land.
      setTimeout(() => loadRecentRef.current?.(), 6000);
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not refund that sale.');
    } finally {
      setRefundBusy(false);
    }
    loadRecentRef.current?.();
  }, [refundReason, refundReceiptTo]);

  /** Open (or close) one row's "email a receipt" form. */
  const openReceipt = useCallback((r: RecentSale) => {
    if (receiptFor === r.id) { setReceiptFor(null); return; }
    setReceiptFor(r.id);
    setReceiptFormTo('');
    setReceiptSuggestions([]);
    api.get<{ data: ReceiptSuggestion[] }>(`/shop/sales/${r.id}/receipt/suggestions`)
      .then(res => {
        setReceiptSuggestions(res.data);
        if (res.data[0]) setReceiptFormTo(res.data[0].email);
      })
      .catch(() => { /* typing the address still works */ });
  }, [receiptFor]);

  const sendRowReceipt = useCallback(async (id: string) => {
    setReceiptBusy(true);
    setError(null);
    const err = await sendReceipt(id, receiptFormTo);
    setReceiptBusy(false);
    if (err) { setError(err); return; }
    setReceiptFor(null);
    loadRecentRef.current?.();
  }, [receiptFormTo]);

  /** The customer has their money back — clears an outstanding refund. */
  const settleRefund = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.post(`/shop/sales/${id}/refund-settled`, {});
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not mark that refund as done.');
    }
    loadRecentRef.current?.();
  }, []);

  const loadPeriod = useCallback(() => {
    api.get<{ data: PeriodInfo }>('/shop/period')
      .then(r => setPeriod(r.data))
      .catch(() => setPeriod(null));
  }, []);

  /** Bring this week's HireHop job into being without waiting for a sale. */
  const createPeriod = useCallback(async () => {
    setCreatingPeriod(true);
    setError(null);
    try {
      await api.post('/shop/period/ensure', {});
      loadPeriod();
    } catch (e: any) {
      // The backend's messages name what to go and fix in HireHop.
      setError(e?.body?.error || e?.message || "Could not create this week's shop job.");
    } finally {
      setCreatingPeriod(false);
    }
  }, [loadPeriod]);

  // Recent and needs-attention move together: anything that changes one
  // (a sale, a refund, a retry) can change the other.
  const loadRecent = useCallback(() => {
    api.get<{ data: RecentSale[] }>('/shop/sales?limit=10')
      .then(r => setRecent(r.data))
      .catch(() => setRecent([]));
    api.get<{ data: RecentSale[] }>('/shop/sales?attention=1&limit=50')
      .then(r => setAttention(r.data))
      .catch(() => setAttention([]));
    api.get<{ data: RecentSale[] }>('/shop/sales?review=1&limit=200')
      .then(r => setToReview(r.data))
      .catch(() => setToReview([]));
  }, []);

  /** Tick off sitter sales — one, or the whole list. */
  const markReviewed = useCallback(async (ids: string[]) => {
    setError(null);
    try {
      await api.post('/shop/sales/review', { ids });
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not mark those as reviewed.');
    }
    loadRecentRef.current?.();
  }, []);

  // retrySale is defined above loadRecent so the list can call it; this closes
  // the loop without making either depend on the other's identity.
  useEffect(() => { loadRecentRef.current = loadRecent; }, [loadRecent]);

  // Loaded on demand — most till visits are a sale, not a stock review.
  useEffect(() => {
    if (tab !== 'reorder' || reorder !== null) return;
    api.get<{ data: StockItem[] }>('/shop/stock/reorder')
      .then(r => setReorder(r.data))
      .catch(() => setReorder([]));
  }, [tab, reorder]);

  useEffect(() => {
    if (tab !== 'used' || usage !== null) return;
    api.get<{ data: { summary: ConsumptionRow[] } }>('/shop/consumption?days=30')
      .then(r => setUsage(r.data.summary))
      .catch(() => setUsage([]));
  }, [tab, usage]);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ data: { maxDiscountPct: number } }>('/shop/discount-cap')
      .then(r => setMaxDiscountPct(r.data.maxDiscountPct))
      .catch(() => setMaxDiscountPct(0));
    api.get<{ data: { refreshedAt: string | null } }>('/shop/stock/status')
      .then(r => setCacheAge(r.data.refreshedAt))
      .catch(() => setCacheAge(null));
    api.get<{ data: SellableJob[] }>('/shop/jobs/today')
      .then(r => setTodayJobs(r.data))
      .catch(() => setTodayJobs([]));
    loadRecent();
    loadPeriod();
  }, [loadRecent, loadPeriod]);

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
        setAvailChecked(Object.keys(flat).length > 0);
      })
      .catch(() => { /* advisory only — never block a sale on it */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketIds]);

  /** Clear the box and hand focus back, so the next scan just works. */
  const clearSearch = useCallback(() => {
    setTerm('');
    setResults([]);
    searchRef.current?.focus();
  }, []);

  const addItem = useCallback((item: StockItem) => {
    setBasket(prev => {
      const existing = prev.find(l => l.stock.hhStockId === item.hhStockId);
      if (existing) {
        return prev.map(l => l.stock.hhStockId === item.hhStockId ? { ...l, qty: l.qty + 1 } : l);
      }
      return [...prev, { stock: item, qty: 1, priceText: (item.priceExVat ?? 0).toFixed(2) }];
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

  const setPriceText = (id: number, priceText: string) =>
    setBasket(prev => prev.map(l => l.stock.hhStockId === id ? { ...l, priceText } : l));

  /** Tidy on blur, so "7.5" becomes "7.50" without fighting mid-type. */
  const normalisePrice = (id: number) =>
    setBasket(prev => prev.map(l =>
      l.stock.hhStockId === id ? { ...l, priceText: num(l.priceText).toFixed(2) } : l));

  // Mirrors the backend arithmetic: VAT is rounded PER LINE, because a basket
  // can mix rates and total-then-tax would be wrong the moment a zero-rated
  // item is in it.
  const totals: Totals = (() => {
    let net = 0, vat = 0, listTotal = 0;
    for (const l of basket) {
      const lineNet = Math.round(num(l.priceText) * l.qty * 100) / 100;
      // The rate comes from the server, never from a rule written here — a UI
      // that assumes 20% is wrong the day a 5%-rated item appears.
      const pct = l.stock.vatRatePct ?? 20;
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
          unitPriceCharged: num(l.priceText),
        })),
        tender: mode === 'sale' ? tender : null,
        soldToJobId: mode === 'sale' && route ? route.id : null,
        notes: notes.trim() || null,
      };
      const r = await api.post<{ data: { id: string; kind: string; totals: Totals } }>('/shop/sales', body);
      // The sale is recorded whatever happens to the email — a receipt that
      // fails to send is said so, never a reason to lose the sale.
      let receipt: string | undefined;
      const wantsReceipt = mode === 'sale' && tender !== 'invoice_later' && receiptTo.trim();
      if (wantsReceipt) {
        const err = await sendReceipt(r.data.id, receiptTo);
        receipt = err ? undefined : receiptTo.trim();
        if (err) setError(`Sale recorded, but the receipt didn't send: ${err}`);
      }
      setSaved({ gross: r.data.totals.gross, id: r.data.id, kind: r.data.kind, receipt });
      setBasket([]);
      setNotes('');
      setReceiptTo('');
      chooseRoute(null);
      loadRecent();
      searchRef.current?.focus();
    } catch (e: any) {
      setError(e?.body?.error || e?.message || 'Could not record that.');
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = basket.length > 0 && !saving && !overDiscountCap
    && (mode === 'consumption' ? notes.trim().length > 0 : true);

  /** One Recent Sales / Needs attention row — the same row in both lists. */
  const renderSaleRow = (r: RecentSale) => {
    const isReversal = r.kind === 'reversal';
    const gross = Number(r.gross_amount);
    // Refund outstanding: HireHop/Xero may be done, but the customer
    // doesn't have their money until someone hands it over.
    const refundOwed = isReversal && r.status !== 'cancelled' && !r.refund_settled_at;
    const created = new Date(r.created_at);
    const today = created.toDateString() === new Date().toDateString();
    // What was bought — the thing people actually remember about a sale,
    // where the OT-SHOP number means nothing to most of them. A refund shows
    // the items of the sale it refunds.
    const itemLines = (isReversal ? r.reverses_lines : r.lines) ?? [];
    const items = itemLines.map(l => `${Number(l.qty)}× ${l.name}`).join(', ');
    const jobName = r.sold_to_hh_job_number
      ? `${jobDisplayOrgName({
          lead_org_name: r.sold_to_lead_org_name,
          client_org_name: r.sold_to_client_org_name,
          company_name: r.sold_to_company_name,
          client_name: r.sold_to_client_name,
        }) || r.sold_to_job_name || 'job'} #${r.sold_to_hh_job_number}${r.tender === 'invoice_later' ? ' · on their bill' : ''}`
      : null;
    // One status per row. A refunded sale was necessarily in HireHop first.
    const chip = r.reversal_id
      ? { label: 'refunded', cls: 'bg-amber-100 text-amber-800' }
      : r.status === 'pushed' ? { label: 'in HireHop', cls: 'bg-green-100 text-green-800' }
      : r.status === 'queued' ? { label: 'queued', cls: 'bg-gray-100 text-gray-600' }
      : r.status === 'cancelled' ? { label: 'cancelled', cls: 'bg-gray-100 text-gray-400 line-through' }
      : { label: r.status, cls: 'bg-red-100 text-red-800' };
    return (
      <li key={r.id} className="px-3 py-2">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 sm:flex-nowrap">
          <span className="w-12 shrink-0 pt-px text-xs tabular-nums text-gray-500" title={created.toLocaleString('en-GB')}>
            {today
              ? created.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : created.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {r.sale_ref && <span className="font-mono text-xs text-gray-500">{r.sale_ref}</span>}
              <span className={`font-medium ${isReversal ? 'text-red-700' : 'text-gray-900'}`}>
                {r.kind === 'consumption'
                  ? 'Used for Ooosh'
                  : isReversal
                    ? `Refund of ${r.reverses_sale_ref ?? 'sale'} · −${money(Math.abs(gross))}`
                    : money(gross)}
              </span>
              {jobName && <span className="text-xs text-gray-500">→ {jobName}</span>}
            </div>
            {(items || r.notes) && (
              <p className="truncate text-xs text-gray-500" title={[items, r.notes].filter(Boolean).join(' — ')}>
                {items}
                {items && r.notes ? ' — ' : ''}
                {r.notes && <span className="italic">{r.notes}</span>}
                {r.last_receipt_to && <span className="text-gray-400"> · ✉ {r.last_receipt_to}</span>}
              </p>
            )}
          </div>

          {/* Fixed-width columns, so who / status / action line up down the
              list. On a phone they drop to their own line under the sale. */}
          <div className="flex w-full shrink-0 items-center gap-2 pl-[3.75rem] sm:w-auto sm:pl-0">
            <span className="hidden w-24 truncate text-right text-xs text-gray-400 sm:inline">
              {r.recorded_by_name}
            </span>
            {/* The status is the answer to "did it reach HireHop?" —
                queued means not yet, pushed means it did. */}
            <span className={`w-20 rounded px-2 py-0.5 text-center text-xs ${chip.cls}`}>{chip.label}</span>
            <span className="ml-auto flex justify-end gap-2 sm:ml-0 sm:w-36">
              {(r.status === 'queued' || r.status === 'failed') && (
                <button
                  onClick={() => cancelSale(r.id)}
                  className="text-xs font-medium text-gray-500 hover:text-red-600"
                >
                  Cancel
                </button>
              )}
              {r.status === 'failed' && (
                <button
                  onClick={() => retrySale(r.id)}
                  className="text-xs font-medium text-ooosh-600 hover:underline"
                >
                  Retry
                </button>
              )}
              {/* A receipt: for a paid sale, or a refund receipt for a refund.
                  Not for "their bill" (their invoice is the document). */}
              {(r.kind === 'sale' || r.kind === 'reversal') && r.status !== 'cancelled' && r.tender !== 'invoice_later' && (
                <button
                  onClick={() => openReceipt(r)}
                  className="text-xs font-medium text-gray-500 hover:text-ooosh-700"
                  title={r.last_receipt_to ? `Last sent to ${r.last_receipt_to}` : 'Email a receipt'}
                >
                  Receipt
                </button>
              )}
              {r.needs_review && !r.reviewed_at && r.status !== 'cancelled' && (
                <button
                  onClick={() => markReviewed([r.id])}
                  className="text-xs font-medium text-green-700 hover:underline"
                  title="Taken on the sitter till — tick it off once you've checked it"
                >
                  Reviewed ✓
                </button>
              )}
              {/* Refund = money out of the door, so manager tier (the API
                  enforces the same). Never "delete" — spec §4.1. */}
              {canRefund && r.kind === 'sale' && r.status === 'pushed' && !r.reversal_id && refundFor !== r.id && (
                <button
                  onClick={() => { setRefundFor(r.id); setRefundReason(''); setRefundReceiptTo(r.last_receipt_to ?? ''); }}
                  className="text-xs font-medium text-ooosh-600 hover:underline"
                >
                  Refund
                </button>
              )}
            </span>
          </div>
        </div>
        {refundOwed && (
          <span className="mt-1 flex w-full flex-wrap items-center gap-2 text-xs sm:pl-[3.75rem]">
            <span className="font-medium text-amber-700">
              Refund outstanding — {refundHow(r.tender, gross)}.
            </span>
            <button
              onClick={() => settleRefund(r.id)}
              className="rounded border border-amber-300 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-50"
            >
              Done — they have it
            </button>
          </span>
        )}
        {receiptFor === r.id && (
          <div className="mt-2 flex w-full flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs sm:ml-[3.75rem] sm:w-auto">
            <span className="text-gray-600">{r.kind === 'reversal' ? 'Refund receipt to' : 'Receipt to'}</span>
            <input
              type="email"
              list={`receipt-sugg-${r.id}`}
              value={receiptFormTo}
              onChange={e => setReceiptFormTo(e.target.value)}
              placeholder="name@example.com"
              className="min-w-[14rem] flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
              autoFocus
            />
            <datalist id={`receipt-sugg-${r.id}`}>
              {receiptSuggestions.map(sg => <option key={sg.email} value={sg.email}>{sg.label}</option>)}
            </datalist>
            <button
              onClick={() => sendRowReceipt(r.id)}
              disabled={receiptBusy || !receiptFormTo.trim()}
              className="rounded bg-gray-800 px-3 py-1 font-medium text-white disabled:bg-gray-300"
            >
              {receiptBusy ? 'Sending…' : 'Send'}
            </button>
            <button onClick={() => setReceiptFor(null)} className="text-gray-500 hover:text-gray-800">Close</button>
          </div>
        )}
        {refundFor === r.id && (
          <div className="mt-2 w-full rounded border border-amber-300 bg-amber-50 p-3 text-xs">
            <p className="mb-2 text-amber-900">
              Refunds the whole of {r.sale_ref ?? 'this sale'}: its items come off the HireHop job
              (stock back on the shelf){r.tender === 'invoice_later'
                ? ''
                : ` and ${money(gross)} is refunded against its payment in HireHop and Xero`}.
              To refund part of a basket, refund it all and ring the rest again.
            </p>
            <input
              value={refundReason}
              onChange={e => setRefundReason(e.target.value)}
              placeholder="Why? (required) — e.g. wrong size, brought it back"
              className="mb-2 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              autoFocus
            />
            {r.tender !== 'invoice_later' && (
              <input
                type="email"
                value={refundReceiptTo}
                onChange={e => setRefundReceiptTo(e.target.value)}
                placeholder="Email a refund receipt to… (optional)"
                className="mb-2 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            )}
            {/* Cash and card go back there and then, so the button
                IS the confirmation. Transfers happen later, from
                another screen, and stay outstanding until ticked. */}
            <p className="mb-2 font-medium text-amber-900">
              {r.tender === 'invoice_later'
                ? `${refundHow(r.tender, gross)}.`
                : r.refund_at_counter
                ? `${refundHow(r.tender, gross)}, then confirm.`
                : `${refundHow(r.tender, gross)} afterwards — it stays on the list as outstanding until you tick it off.`}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => refundSale(r.id)}
                disabled={refundBusy || !refundReason.trim()}
                className="rounded bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 disabled:bg-gray-300"
              >
                {refundBusy
                  ? 'Refunding…'
                  : r.tender === 'invoice_later'
                    ? `Take ${money(gross)} off their bill`
                    : r.refund_at_counter
                    ? `Done — ${money(gross)} given back`
                    : `Record refund of ${money(gross)}`}
              </button>
              <button
                onClick={() => setRefundFor(null)}
                className="rounded px-3 py-1.5 text-gray-600 hover:bg-gray-100"
              >
                Back
              </button>
            </div>
          </div>
        )}
        {r.push_error && (
          <span className="mt-1 block w-full break-all text-xs text-red-700 sm:pl-[3.75rem]">{r.push_error}</span>
        )}
      </li>
    );
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Shop Till</h1>
        <span className="text-xs text-gray-500">Stock as of {ago(cacheAge)}</span>
      </div>

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

      {/* This week's HireHop job. Sales can be taken without it — they queue —
          but nothing reaches HireHop until it exists. */}
      {period && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          {/* Only ever says something when something is WRONG. A permanent
              "everything is fine" line is noise at a counter, and the job
              number itself is deliberately not shown: the shop job is
              machinery, and anyone who opens it in HireHop is one status
              change away from releasing a week of sale stock (§2.1). */}
          {period.period?.hh_job_number ? null : (
            <>
              <span className="text-amber-700">
                No HireHop job for this week yet — sales will queue until there is one.
              </span>
              <button
                onClick={createPeriod}
                disabled={creatingPeriod}
                className="rounded border border-ooosh-300 px-2 py-1 font-medium text-ooosh-700 hover:bg-ooosh-50 disabled:opacity-50"
              >
                {creatingPeriod ? 'Creating…' : "Create this week's job"}
              </button>
            </>
          )}
        </div>
      )}

      {saved && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
          {saved.kind === 'consumption'
            ? 'Stock use recorded. Next one?'
            : `Recorded — ${money(saved.gross)}${saved.receipt ? `, receipt sent to ${saved.receipt}` : ''}. Next one?`}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Two columns on a laptop: what's being rung up on the left, the
          checkout on the right — the goods on the counter vs the card
          machine. Stacks into one column on a phone. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
      <div className="min-w-0">
      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <input
            ref={searchRef}
            autoFocus
            value={term}
            onChange={e => setTerm(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') clearSearch(); }}
            placeholder="Search or scan — name, part number…"
            className="w-full rounded border border-gray-300 py-3 pl-4 pr-10 text-base focus:border-ooosh-500 focus:outline-none"
          />
          {term && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-400 hover:text-gray-700"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
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
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold text-gray-900">
                      {money(item.priceIncVat ?? 0)}
                    </span>
                    {/* Staff read HireHop all day, where prices are ex-VAT. An
                        unlabelled number here gets quoted at the wrong price by
                        someone who never opens the basket. */}
                    <span className="block text-[11px] text-gray-400">inc VAT</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Basket */}
      {basket.length > 0 && (
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          {mode === 'sale' ? 'Basket' : 'Items used'} · {basket.reduce((n, l) => n + l.qty, 0)}{' '}
          {basket.reduce((n, l) => n + l.qty, 0) === 1 ? 'item' : 'items'}
        </h2>
      )}
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
                {/* Full width on a phone, so the name gets its own line and the
                    qty/price controls wrap underneath rather than squeezing it. */}
                <div className="min-w-0 w-full sm:w-auto sm:flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">{l.stock.title}</p>
                  <p className="text-xs text-gray-500">
                    {l.stock.quantity} on shelf
                    {reserved && (
                      <span className={short ? 'text-red-600 font-medium' : 'text-amber-600'}>
                        {' '}· only {avail} free ({l.stock.quantity - (avail ?? 0)} reserved for jobs)
                      </span>
                    )}
                    {!availChecked && <span className="text-gray-400"> · reservations unavailable</span>}
                    {l.stock.vatRatePct === 0 && <span className="text-gray-400"> · zero-rated</span>}
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
                      type="text" inputMode="decimal" value={l.priceText}
                      onChange={e => setPriceText(l.stock.hhStockId, e.target.value)}
                      onBlur={() => normalisePrice(l.stock.hhStockId)}
                      className={`w-20 rounded border px-2 py-1.5 text-right text-sm ${
                        num(l.priceText) < list ? 'border-amber-400 bg-amber-50' : 'border-gray-300'
                      }`}
                      aria-label="Unit price excluding VAT"
                    />
                    <span className="text-[11px] text-gray-400">ex VAT</span>
                    {num(l.priceText) < list && (
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

      </div>

      {/* Checkout. Deliberately a different-looking thing from the basket:
          a coloured frame and the total in its header, so the running total
          never reads as one more line in the list. On a phone it only
          appears once there is something to pay for. */}
      <aside className={`${basket.length ? '' : 'hidden lg:block'} mt-4 lg:sticky lg:top-4 lg:mt-0`}>
        {/* Colour roles (same as the sitter till): a dark total bar, a CHOICE
            is an outlined ✓, and only the button that records it is green —
            so the header, the choices and the action don't all read alike. */}
        <div className="overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm">
          <div className="flex items-baseline justify-between gap-2 bg-gray-900 px-4 py-3 text-white">
            <span className="text-sm font-semibold">
              {mode === 'sale' ? 'Total (inc VAT)' : 'Record stock use'}
            </span>
            {mode === 'sale' && (
              <span className="text-2xl font-bold tabular-nums">{money(totals.gross)}</span>
            )}
          </div>
      {basket.length === 0 ? (
        <p className="p-4 text-sm text-gray-400">Add items to start.</p>
      ) : (
        <div className="p-4">
          {mode === 'sale' && (
            <>
              <div className="mb-3 space-y-1 text-sm">
                <div className="flex justify-between text-gray-600">
                  <span>Net (ex VAT)</span><span>{money(totals.net)}</span>
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
              </div>

              {overDiscountCap && (
                <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                  That is a {totals.discountPct.toFixed(1)}% discount and your limit is {maxDiscountPct}%
                  {user?.role ? ` (${user.role.replace(/_/g, ' ')})` : ''}. Ask a manager to apply it.
                </p>
              )}

              {/* Who it's for. Walk-in pools on the week's shop job; a band's
                  job takes it onto their own job (and, if they like, their bill). */}
              <label className="mb-1 block text-xs font-medium text-gray-700">Who&rsquo;s it for?</label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => chooseRoute(null)}
                  className={`rounded border-2 px-2.5 py-1.5 text-xs font-medium ${
                    !route ? 'border-ooosh-600 bg-ooosh-50 text-ooosh-800' : 'border-transparent bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {!route ? '✓ ' : ''}Walk-in
                </button>
                {todayJobs.map(j => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => chooseRoute(j)}
                    title={j.rooms?.join(', ')}
                    className={`rounded border-2 px-2.5 py-1.5 text-left text-xs font-medium ${
                      route?.id === j.id ? 'border-ooosh-600 bg-ooosh-50 text-ooosh-800' : 'border-transparent bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {route?.id === j.id ? '✓ ' : ''}{jobLabel(j)}
                    <span className="block text-[10px] font-normal text-gray-500">
                      In today{j.rooms?.length ? ` · ${j.rooms.join(', ')}` : ''}
                    </span>
                  </button>
                ))}
                {route && !todayJobs.some(j => j.id === route.id) && (
                  <span className="rounded border-2 border-ooosh-600 bg-ooosh-50 px-2.5 py-1.5 text-xs font-medium text-ooosh-800">✓ 
                    {jobLabel(route)} · #{route.hhJobNumber}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setJobSearchOpen(o => !o)}
                  className="rounded px-2.5 py-1.5 text-xs text-ooosh-600 hover:underline"
                >
                  Other job…
                </button>
              </div>
              {jobSearchOpen && (
                <div className="mb-3">
                  <input
                    autoFocus
                    value={jobTerm}
                    onChange={e => setJobTerm(e.target.value)}
                    placeholder="Job number or band name"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                  {jobResults.length > 0 && (
                    <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-gray-200 divide-y text-sm">
                      {jobResults.map(j => (
                        <li key={j.id}>
                          <button
                            type="button"
                            onClick={() => chooseRoute(j)}
                            className="w-full px-3 py-2 text-left hover:bg-ooosh-50"
                          >
                            <span className="font-medium text-gray-900">{jobLabel(j)}</span>
                            <span className="text-gray-500"> · #{j.hhJobNumber}{j.jobName && j.jobName !== jobLabel(j) ? ` · ${j.jobName}` : ''}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {jobTerm.trim().length >= 2 && jobResults.length === 0 && (
                    <p className="mt-1 text-xs text-gray-400">No open job matches.</p>
                  )}
                </div>
              )}

              <label className="mb-1 block text-xs font-medium text-gray-700">Payment</label>
              <select
                value={tender}
                onChange={e => setTender(e.target.value)}
                className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                {/* "Their bill" only exists once there is a job to bill: the
                    weekly shop job pools every customer, so its invoice can
                    never go to one of them (spec §9). */}
                {TENDERS.filter(t => !t.needsJob || route).map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              {route && tender === 'invoice_later' && (
                <p className="mb-3 text-xs text-gray-600">
                  Nothing taken now — it goes on job #{route.hhJobNumber} and onto their invoice.
                </p>
              )}
            </>
          )}

          {mode === 'sale' && tender !== 'invoice_later' && (
            <>
              <label className="mb-1 block text-xs font-medium text-gray-700">Email a receipt (optional)</label>
              <input
                type="email"
                list="checkout-receipt-sugg"
                value={receiptTo}
                onChange={e => setReceiptTo(e.target.value)}
                placeholder={jobContacts.length ? 'Pick a contact or type an address' : 'name@example.com'}
                className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <datalist id="checkout-receipt-sugg">
                {jobContacts.map(c => <option key={c.email} value={c.email}>{c.label}</option>)}
              </datalist>
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
            className="w-full rounded bg-green-600 px-4 py-3 text-base font-semibold text-white hover:bg-green-700 disabled:bg-gray-300"
          >
            {saving
              ? 'Recording…'
              : mode !== 'sale'
                ? 'Record use'
                : tender === 'invoice_later'
                  ? `Put ${money(totals.gross)} on their bill`
                  : `Take ${money(totals.gross)}`}
          </button>
        </div>
      )}
        </div>
      </aside>
      </div>

      {/* Everything that isn't ringing up a sale lives down here, one tab at a
          time — 9 in 10 visits never open it. The last tab used is remembered
          per browser; clicking the open tab folds it away. */}
      <div className="mt-24 border-t border-gray-200 pt-3">
        <div className="flex flex-wrap gap-1">
          {([
            ['recent', 'Recent sales'],
            ['attention', attention.length ? `Needs attention (${attention.length})` : 'Needs attention'],
            ['review', toReview.length ? `Sitter sales to review (${toReview.length})` : 'Sitter sales'],
            ['week', 'This week'],
            ['used', 'What we’ve used'],
            ['reorder', 'Reorder'],
          ] as [BottomTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => pickTab(tab === key ? null : key)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                tab === key
                  ? 'bg-gray-700 text-white'
                  : key === 'attention' && attention.length
                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                    : key === 'review' && toReview.length
                    ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'recent' && (
          <div className="mt-3">
            <div className="mb-2 flex justify-end">
              <button onClick={loadRecent} className="text-xs text-gray-400 hover:text-gray-700">Refresh</button>
            </div>
            {recent.length === 0 ? (
              <p className="text-sm text-gray-400">Nothing yet.</p>
            ) : (
              <ul className="rounded border border-gray-200 divide-y text-sm">{recent.map(renderSaleRow)}</ul>
            )}
          </div>
        )}

        {tab === 'attention' && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-gray-500">
              Transactions that failed or are stuck on their way to HireHop, and refunds whose money
              hasn&rsquo;t gone back yet. jon is emailed about the first two.
            </p>
            {attention.length === 0 ? (
              <p className="text-sm text-green-700">All clear.</p>
            ) : (
              <ul className="rounded border border-gray-200 divide-y text-sm">{attention.map(renderSaleRow)}</ul>
            )}
          </div>
        )}

        {tab === 'review' && (
          <div className="mt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                Sales a studio sitter took on their phone. They&rsquo;ve already gone to HireHop like any
                other sale — this is the morning check that each one makes sense.
              </p>
              {toReview.length > 1 && (
                <button
                  onClick={() => markReviewed(toReview.map(r => r.id))}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Mark all {toReview.length} reviewed
                </button>
              )}
            </div>
            {toReview.length === 0 ? (
              <p className="text-sm text-green-700">Nothing waiting.</p>
            ) : (
              <ul className="rounded border border-gray-200 divide-y text-sm">{toReview.map(renderSaleRow)}</ul>
            )}
          </div>
        )}

        {tab === 'week' && (
          <div className="mt-3">
            <ShopWeekPanel />
          </div>
        )}

        {tab === 'used' && (
          <div className="mt-3">
            <p className="text-xs text-gray-500">Stock we&rsquo;ve used ourselves in the last 30 days, by item.</p>
            {usage === null ? (
              <p className="mt-2 text-xs text-gray-400">Loading…</p>
            ) : usage.length === 0 ? (
              <p className="mt-2 text-xs text-gray-400">
                Nothing recorded yet. Only usage that reached HireHop is counted.
              </p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 font-medium">Item</th>
                    <th className="py-1 text-right font-medium">Used</th>
                    <th className="py-1 text-right font-medium">Times</th>
                    <th className="py-1 text-right font-medium">On shelf</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {usage.map(u => {
                    const shelf = u.on_shelf != null ? Number(u.on_shelf) : null;
                    const level = u.reorder_level != null ? Number(u.reorder_level) : null;
                    // Knowing on Monday beats running out on Friday.
                    const low = shelf != null && level != null && level > 0 && shelf <= level;
                    return (
                      <tr key={u.hh_stock_id}>
                        <td className="py-1.5 pr-2">{u.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{Number(u.total_qty)}</td>
                        <td className="py-1.5 text-right tabular-nums text-gray-500">{u.occasions}</td>
                        <td className={`py-1.5 text-right tabular-nums ${low ? 'font-medium text-amber-700' : 'text-gray-500'}`}>
                          {shelf ?? '—'}{low ? ' · low' : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'reorder' && (
          <div className="mt-3">
            {reorder === null ? (
              <p className="text-xs text-gray-400">Loading…</p>
            ) : reorder.length === 0 ? (
              <p className="text-sm text-gray-400">Nothing at or below its reorder level.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 font-medium">Item</th>
                    <th className="py-1 text-right font-medium">On shelf</th>
                    <th className="py-1 text-right font-medium">Reorder at</th>
                    <th className="py-1 text-right font-medium">Usual order</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {reorder.map(i => (
                    <tr key={i.hhStockId}>
                      <td className="py-1.5 pr-2">{i.title}</td>
                      <td className={`py-1.5 text-right tabular-nums ${i.quantity <= 0 ? 'font-medium text-red-700' : 'text-amber-700'}`}>
                        {i.quantity}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{i.reorderLevel ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{i.reorderQty ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-gray-400">
              All sale stock, not just shop categories. Levels are set per item in HireHop.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
