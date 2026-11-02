'use client'

/**
 * Studio Sitter — Shop Till
 *
 * Route: /shift/[date]/till   (date = YYYY-MM-DD)
 *
 * The sitter's till, on their phone, one-handed, mid-conversation with a band
 * member (docs/SHOP-SALES-SPEC.md §5). Two jobs:
 *
 *   1. PRICE LOOKUP — "how much is a jack lead?" — any time the sitter can see
 *      the shift.
 *   2. SELL — on the night only: pick items, who it's for (a walk-in or one of
 *      tonight's bands), how they paid, done. List price only; no discounts.
 *
 * A sale lands in OP instantly and goes to HireHop a couple of minutes later,
 * exactly like one taken in the office — so it can be cancelled from tonight's
 * list until then. After that, refunds are the office's. Every sitter sale is
 * checked by staff the next morning.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Search, Check, Minus, Plus } from 'lucide-react'
import { cls, BackLink, Banner, SectionLabel } from '@/components/ui'

interface Tender { key: string; label: string; needsJob?: boolean }
interface TillJob { job_id: string; hh_job_number: number | null; label: string; rooms: string[] }
interface TillContext {
  success: boolean
  date: string
  open: boolean
  /** The lock-up report is in — the till has closed for the night. */
  locked_up?: boolean
  jobs: TillJob[]
  tenders: Tender[]
  /** The card reader, when switched on for this sitter (STRIPE-TERMINAL-SPEC §14). */
  card_reader?: { enabled: boolean; mode?: 'test' | 'live' }
  stock_as_of: string | null
  error?: string
}
/** A card-reader payment, as OP shows it to the phone. */
interface ReaderSession {
  id: string
  status: 'pending' | 'failed' | 'recording' | 'succeeded' | 'record_failed' | 'cancelled'
  amount: string
  reader_label: string | null
  failure_code: string | null
  failure_message: string | null
  livemode: boolean
  shop_sale_id: string | null
  warning: string | null
}
interface StockItem {
  hhStockId: number
  title: string
  categoryPath: string | null
  priceIncVat: number | null
  priceExVat: number | null
  vatRatePct: number | null
  quantity: number
}
interface BasketLine { item: StockItem; qty: number }
interface TonightSale {
  id: string
  sale_ref: string | null
  status: string
  tender: string | null
  gross: number
  created_at: string
  push_after: string
  mine: boolean
  sold_to_hh_job_number: number | null
  /** Where this sale's latest receipt went, if one was sent. */
  last_receipt_to: string | null
  lines: { name: string; qty: number }[]
}
interface TonightSummary {
  sales: number
  taken: number
  byTender: { tender: string; label: string; amount: number }[]
  onTheirBill: number
}

const money = (n: number) => `£${n.toFixed(2)}`

/** Blank = no receipt wanted. Anything else must look like an address BEFORE the sale is taken. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const receiptAddressProblem = (v: string) =>
  v.trim() === '' || EMAIL_RE.test(v.trim()) ? null : 'That receipt email doesn’t look right. Fix it or clear the box.'

/** One band in → them; two or more → make the sitter choose; none → walk-in. */
function defaultRoute(c: TillContext): string | null | undefined {
  if (c.jobs.length === 1) return c.jobs[0].job_id
  return c.jobs.length === 0 ? null : undefined
}

/**
 * Where every sale starts: the card reader when it's on for this sitter (almost
 * every sale is card, jon Oct 2026), else nothing, so they pick. A wrong card-reader
 * default shows itself (the reader waits for a card); a wrong Cash one would record.
 */
function defaultTender(c: TillContext): string | null {
  return c.tenders.some((t) => t.key === 'card_reader') ? 'card_reader' : null
}

/**
 * Colour roles, so the checkout reads at a glance on a small screen: the total
 * bar is dark, a CHOICE is an outlined tick (not a filled block), and the one
 * button that records the sale is green. Filled-blue-everything made the
 * header, both choices and the final button look like the same thing.
 * Oct 2026 refresh: choices are plum-outlined; the tender is the one choice the
 * design fills (ink), since it decides which button comes next.
 */
const choice = (on: boolean) =>
  on
    ? 'border-[1.5px] border-hf-accent bg-hf-tint text-hf-tint-text font-semibold'
    : 'border-[1.5px] border-hf-control bg-white text-hf-ink'
const tenderChoice = (on: boolean) =>
  on
    ? 'border-[1.5px] border-hf-ink bg-hf-ink text-white font-semibold'
    : 'border-[1.5px] border-hf-control bg-white text-hf-ink'

/** The tick shown inside a chosen option. */
function Tick() {
  return <Check size={15} strokeWidth={2.6} className="inline -mt-0.5 mr-1" aria-hidden />
}
const round2 = (n: number) => Math.round(n * 100) / 100

/** Coins and notes a customer is likely to hand over for a cash sale. */
const CASH_DENOMINATIONS = [2, 5, 10, 20, 50]

/** The next three above the total: £1.50 → £2, £5, £10; £18 → £20, £50; over £50 → none (Other). */
function likelyTendered(total: number): number[] {
  return CASH_DENOMINATIONS.filter((d) => d > total).slice(0, 3)
}

/** A typed amount ("25", "£25.50", "1,000") as pounds, or null if it isn't one. */
function parseAmount(v: string): number | null {
  const cleaned = v.replace(/[£,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? round2(n) : null
}

/**
 * Mirrors the office till and the server: VAT per LINE, rounded per line — a
 * basket can mix VAT rates. The server re-prices everything anyway; this is
 * only so the sitter can tell the customer the right number.
 */
function lineGross(l: BasketLine): number {
  const net = round2((l.item.priceExVat ?? 0) * l.qty)
  const vat = round2(net * ((l.item.vatRatePct ?? 20) / 100))
  return round2(net + vat)
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export default function SitterTillPage() {
  const params = useParams()
  const router = useRouter()
  const date = String(params?.date || '')

  const [ctx, setCtx] = useState<TillContext | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<StockItem[]>([])
  const [searching, setSearching] = useState(false)
  const [basket, setBasket] = useState<BasketLine[]>([])
  // undefined = not chosen yet, null = walk-in, else the band's job. With ONE
  // band in, it defaults to them (most sitter sales are to the band in the
  // room — jon); with two, the sitter has to pick, so nobody's strings land on
  // the wrong band's bill.
  const [jobId, setJobId] = useState<string | null | undefined>(undefined)
  const [tender, setTender] = useState<string | null>(null)
  // Cash change helper: what the customer handed over, so the till can work out
  // the change. Optional and display only (never sent or saved). 'exact' follows
  // the total if the basket changes.
  const [cashGiven, setCashGiven] = useState<'exact' | 'other' | number | null>(null)
  const [cashOther, setCashOther] = useState('')
  const [saving, setSaving] = useState(false)
  // The card reader: the basket goes to the reader, and the sale is made once the
  // card is approved — so a declined card leaves nothing behind.
  const [reader, setReader] = useState<ReaderSession | null>(null)
  const [readerBusy, setReaderBusy] = useState(false)
  const readerReceipt = useRef('')
  const readerTick = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [sales, setSales] = useState<TonightSale[]>([])
  const [summary, setSummary] = useState<TonightSummary | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Receipts: the checkout's optional box, and one list row's resend form.
  const [receiptTo, setReceiptTo] = useState('')
  const [receiptFor, setReceiptFor] = useState<string | null>(null)
  const [receiptFormTo, setReceiptFormTo] = useState('')
  const [receiptBusy, setReceiptBusy] = useState(false)
  // Tonight's band's contacts, offered in the receipt box — the same joined-up
  // experience as the office till (jon, Sep 2026: sitters are entitled to
  // contact the people they're looking after).
  const [bandContacts, setBandContacts] = useState<{ email: string; label: string }[]>([])

  const loadContext = useCallback(async () => {
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/context`)
      if (r.status === 401) { router.push('/login'); return }
      const data = await r.json()
      if (!r.ok) { setLoadError(data.error || 'Could not open the till.'); return }
      setCtx(data)
      setJobId(defaultRoute(data))
      setTender(defaultTender(data))
    } catch {
      setLoadError('Could not reach the till. Check your signal and try again.')
    }
  }, [date, router])

  const loadSales = useCallback(async () => {
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/sales`)
      if (!r.ok) return
      const data = await r.json()
      setSales(data.sales || [])
      setSummary(data.summary || null)
    } catch { /* the list is a convenience; selling still works */ }
  }, [date])

  useEffect(() => {
    if (!date) return
    loadContext()
    loadSales()
  }, [date, loadContext, loadSales])

  // Debounced search — the office's own catalogue copy, so it's quick.
  useEffect(() => {
    if (term.trim().length < 2) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/studio-sitter/shifts/${date}/till/search?q=${encodeURIComponent(term)}`)
        const data = await r.json()
        if (!cancelled) setResults(r.ok ? (data.items || []) : [])
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [term, date])

  useEffect(() => {
    if (!jobId) { setBandContacts([]); return }
    let cancelled = false
    fetch(`/api/studio-sitter/shifts/${date}/till/jobs/${jobId}/receipt-contacts`)
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((d) => { if (!cancelled) setBandContacts(d.contacts || []) })
      .catch(() => { if (!cancelled) setBandContacts([]) })
    return () => { cancelled = true }
  }, [jobId, date])

  // The success note is a nod, not a record — tonight's list is the record.
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(null), 4000)
    return () => clearTimeout(t)
  }, [done])

  const add = (item: StockItem) => {
    setBasket((prev) => {
      const ex = prev.find((l) => l.item.hhStockId === item.hhStockId)
      if (ex) return prev.map((l) => (l.item.hhStockId === item.hhStockId ? { ...l, qty: l.qty + 1 } : l))
      return [...prev, { item, qty: 1 }]
    })
    setTerm('')
    setResults([])
    setDone(null)
  }
  const bump = (id: number, delta: number) =>
    setBasket((prev) => prev
      .map((l) => (l.item.hhStockId === id ? { ...l, qty: l.qty + delta } : l))
      .filter((l) => l.qty > 0))

  // An emptied basket (a sale taken, or everything removed) starts the cash helper afresh.
  useEffect(() => {
    if (basket.length === 0) { setCashGiven(null); setCashOther('') }
  }, [basket.length])

  const pickTender = (key: string) => {
    if (key !== tender) { setCashGiven(null); setCashOther('') }
    setTender(key)
  }

  // "Their bill" only exists once a band is picked; going back to walk-in
  // returns to the default rather than leaving an impossible choice selected.
  const pickJob = (id: string | null | undefined) => {
    // A receipt address belongs to whoever the sale is for — switching clears it.
    if (id !== jobId) setReceiptTo('')
    setJobId(id)
    if (!id && ctx?.tenders.find((t) => t.key === tender)?.needsJob) setTender(defaultTender(ctx))
  }

  const total = round2(basket.reduce((s, l) => s + lineGross(l), 0))
  const cashGivenAmount = tender !== 'till_cash' || cashGiven === null
    ? null
    : cashGiven === 'exact' ? total
    : cashGiven === 'other' ? parseAmount(cashOther)
    : cashGiven
  /** Positive = change to give; negative = they've handed over too little. */
  const cashChange = cashGivenAmount === null ? null : round2(cashGivenAmount - total)
  const tenderObj = ctx?.tenders.find((t) => t.key === tender)
  const canTake = !!ctx?.open && basket.length > 0 && !!tender && jobId !== undefined && !saving

  // ── Card reader ────────────────────────────────────────────────────────
  const readerUrl = (p: string) => `/api/studio-sitter/shifts/${date}/till/reader/${p}`
  const readerOpen = !!reader && ['pending', 'failed', 'recording'].includes(reader.status)

  async function readerCall(p: string, body?: unknown): Promise<ReaderSession | null> {
    setReaderBusy(true)
    try {
      const r = await fetch(readerUrl(p), body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { setError(data.error || 'The card reader didn’t answer.'); return null }
      if (data.session) setReader(data.session)
      return data.session ?? null
    } catch {
      setError('Couldn’t reach the office system. Check your signal.')
      return null
    } finally {
      setReaderBusy(false)
    }
  }

  async function takeOnReader() {
    // Which reader: the first one that's online (there is one, at reception).
    const rr = await fetch(readerUrl('readers')).then((r) => r.json()).catch(() => null)
    const pick = rr?.readers?.find((x: { status: string }) => x.status === 'online') ?? rr?.readers?.[0]
    if (!pick) { setError(rr?.error || 'No card reader is available.'); return }
    readerReceipt.current = receiptTo
    readerTick.current = 0
    await readerCall('pay', {
      lines: basket.map((l) => ({ hhStockId: l.item.hhStockId, qty: l.qty })),
      jobId,
      readerId: pick.id,
    })
  }

  // Poll while the card is on the reader (every 5th poll asks Stripe directly).
  useEffect(() => {
    if (!reader || !readerOpen) return
    const t = setInterval(async () => {
      readerTick.current += 1
      try {
        const r = await fetch(readerUrl(`sessions/${reader.id}${readerTick.current % 5 === 0 ? '?check=1' : ''}`))
        const data = await r.json()
        if (r.ok && data.session) setReader(data.session)
      } catch { /* a blip — keep polling */ }
    }, 2000)
    return () => clearInterval(t)
  }, [reader?.id, readerOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Approved: the sale is in — send the receipt, then clear the till as a cash sale does.
  useEffect(() => {
    if (reader?.status !== 'succeeded' || !reader.shop_sale_id) return
    const saleId = reader.shop_sale_id
    const paid = Number(reader.amount)
    ;(async () => {
      let receiptNote = ''
      if (readerReceipt.current.trim()) {
        const err = await postReceipt(saleId, readerReceipt.current)
        if (err) setError(`Sale recorded, but the receipt didn’t send: ${err}`)
        else receiptNote = ` Receipt sent to ${readerReceipt.current.trim()}.`
      }
      setDone(`Paid on the card reader: ${money(paid)}.${reader.warning ? ` ${reader.warning}` : ''}` + receiptNote)
      readerReceipt.current = ''
      setReceiptTo('')
      setBasket([])
      setTender(ctx ? defaultTender(ctx) : null)
      setJobId(ctx ? defaultRoute(ctx) : undefined)
      setReader(null)
      loadSales()
    })()
  }, [reader?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function take() {
    if (!canTake) return
    setError(null)
    // A typo in the receipt box stops here, before anything is recorded.
    const addrProblem = !tenderObj?.needsJob ? receiptAddressProblem(receiptTo) : null
    if (addrProblem) { setError(addrProblem); return }
    if (tender === 'card_reader') { await takeOnReader(); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: basket.map((l) => ({ hhStockId: l.item.hhStockId, qty: l.qty })),
          tender,
          jobId,
        }),
      })
      const data = await r.json()
      if (!r.ok) { setError(data.error || 'That didn’t go through. Nothing was recorded.'); return }
      // The sale is in whatever happens to the email.
      let receiptNote = ''
      if (!tenderObj?.needsJob && receiptTo.trim() && data.id) {
        const err = await postReceipt(data.id, receiptTo)
        if (err) setError(`Sale recorded, but the receipt didn’t send: ${err}`)
        else receiptNote = ` Receipt sent to ${receiptTo.trim()}.`
      }
      // Repeat the change, in case they tapped Take before counting it out.
      const changeNote = tender === 'till_cash' && cashChange !== null && cashChange > 0
        ? ` Give ${money(cashChange)} change.`
        : ''
      setDone((tenderObj?.needsJob ? `${money(total)} put on their bill.` : `Taken: ${money(total)}.`) + changeNote + receiptNote)
      setReceiptTo('')
      setBasket([])
      setTender(ctx ? defaultTender(ctx) : null)
      setJobId(ctx ? defaultRoute(ctx) : undefined)
      loadSales()
      searchRef.current?.focus()
    } catch {
      setError('Couldn’t reach the office system. Check your signal. Nothing was recorded; try again.')
    } finally {
      setSaving(false)
    }
  }

  /** Email a receipt for one of tonight's sales. Returns an error message, or null. */
  async function postReceipt(id: string, to: string): Promise<string | null> {
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/sales/${id}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim() }),
      })
      if (r.ok) return null
      const data = await r.json().catch(() => ({}))
      return data.error || 'The receipt didn’t send.'
    } catch {
      return 'Couldn’t reach the office system. Check your signal.'
    }
  }

  async function sendRowReceipt(id: string) {
    setError(null)
    const addrProblem = receiptAddressProblem(receiptFormTo)
    if (addrProblem) { setError(addrProblem); return }
    setReceiptBusy(true)
    const err = await postReceipt(id, receiptFormTo)
    setReceiptBusy(false)
    if (err) { setError(err); return }
    setReceiptFor(null)
    setDone(`Receipt sent to ${receiptFormTo.trim()}.`)
    loadSales()
  }

  async function cancel(id: string) {
    if (!window.confirm('Cancel this sale? It hasn’t gone through to the office yet, so it simply won’t happen.')) return
    setError(null)
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/sales/${id}/cancel`, { method: 'POST' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) setError(data.error || 'Couldn’t cancel that. Ask the office.')
    } catch {
      setError('Couldn’t reach the office system. Check your signal.')
    }
    loadSales()
  }

  const bandName = (hh: number | null) => ctx?.jobs.find((j) => j.hh_job_number === hh)?.label ?? (hh ? `#${hh}` : null)

  return (
    <div className="min-h-screen bg-hf-page safe-top safe-bottom pb-10 flex flex-col">
      <header className="max-w-lg w-full mx-auto px-2 pt-2 flex items-center gap-2">
        <div className="px-2.5"><BackLink href={`/shift/${date}`} label="Shift" /></div>
        <h1 className="ml-auto text-[16px] font-semibold text-hf-ink">Shop till</h1>
        {/* The how-to guide is a PDF in Resources (a Staff Document shared with
            freelancers). A new tab, so reading it mid-sale doesn't lose the basket. */}
        <Link
          href="/resources"
          target="_blank"
          rel="noopener noreferrer"
          className="mr-2 h-10 px-3 rounded-[10px] border-[1.5px] border-hf-control bg-white flex items-center text-[14px] font-semibold text-hf-link hover:bg-hf-inset"
        >
          How to use
        </Link>
      </header>

      <main className="max-w-lg w-full mx-auto px-4 pt-2 pb-5 flex flex-1 flex-col gap-3.5">
        {loadError && <Banner tone="error">{loadError}</Banner>}

        {ctx && !ctx.open && (
          <Banner tone="warning">
            {ctx.locked_up
              ? 'You’ve locked up, so the till has closed for the night. Price lookup still works. Leave the office a note about anything else.'
              : 'Price lookup only. The till takes sales on the night of your shift.'}
          </Banner>
        )}

        {done && (
          <div role="status" className="rounded-[14px] bg-hf-green-tint text-hf-green-text px-4 py-3 text-[15px] font-semibold flex gap-2">
            <Check size={18} strokeWidth={2.6} className="flex-none mt-0.5" /> <span>{done}</span>
          </div>
        )}
        {error && (
          <Banner tone="error">
            {error}
            <button type="button" onClick={() => setError(null)} className="ml-2 underline font-semibold">OK</button>
          </Banner>
        )}

        {/* Search — price lookup is the headline feature */}
        <section className="flex flex-col gap-2">
          <div className="relative">
            <Search size={20} strokeWidth={1.8} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-hf-muted pointer-events-none" />
            <input
              ref={searchRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Look up an item: strings, jack lead, gaffa…"
              className={`${cls.input} h-[52px] !pl-11 !text-[17px]`}
              inputMode="search"
              autoComplete="off"
            />
          </div>
          {searching && <p className="px-1 text-[13px] text-hf-muted">Searching…</p>}
          {results.length > 0 && (
            <ul className={`${cls.card} overflow-hidden`}>
              {results.map((it, i) => (
                <li key={it.hhStockId}>
                  {i > 0 && <div className="h-px bg-hf-divider mx-4" />}
                  <button
                    type="button"
                    onClick={() => ctx?.open && add(it)}
                    className="flex w-full min-h-[58px] items-center justify-between gap-3 px-4 py-2 text-left active:bg-hf-inset"
                  >
                    <span className="min-w-0 flex flex-col">
                      <span className="text-[16px] font-semibold text-hf-ink">{it.title}</span>
                      <span className="text-[13px] text-hf-muted">
                        {it.quantity > 0 ? `${it.quantity} in stock` : 'none showing in stock'}
                        {ctx?.open && <span className="font-semibold text-hf-link"> · tap to add</span>}
                      </span>
                    </span>
                    <span className="shrink-0 text-[16px] font-semibold text-hf-ink tabular">{money(it.priceIncVat ?? 0)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {term.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="px-1 text-[15px] text-hf-muted">Nothing matches. Try another word.</p>
          )}
        </section>

        {ctx?.open && basket.length > 0 && (
          <>
            {/* Basket */}
            <section className={`${cls.card} overflow-hidden`}>
              {basket.map((l, i) => (
                <div key={l.item.hhStockId}>
                  {i > 0 && <div className="h-px bg-hf-divider mx-4" />}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-semibold text-hf-ink">{l.item.title}</p>
                      <p className="text-[13px] text-hf-muted tabular">{money(l.item.priceIncVat ?? 0)} each</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => bump(l.item.hhStockId, -1)} aria-label="One fewer"
                        className="h-10 w-10 rounded-[10px] border-[1.5px] border-hf-control text-hf-body flex items-center justify-center active:bg-hf-inset">
                        <Minus size={18} strokeWidth={2} />
                      </button>
                      <span className="w-7 text-center text-[16px] font-semibold tabular">{l.qty}</span>
                      <button type="button" onClick={() => bump(l.item.hhStockId, 1)} aria-label="One more"
                        className="h-10 w-10 rounded-[10px] border-[1.5px] border-hf-control text-hf-body flex items-center justify-center active:bg-hf-inset">
                        <Plus size={18} strokeWidth={2} />
                      </button>
                    </div>
                    <span className="w-16 text-right text-[16px] font-semibold tabular">{money(lineGross(l))}</span>
                  </div>
                </div>
              ))}
            </section>

            {/* Checkout */}
            <section className={`${cls.card} overflow-hidden`}>
              <div className="flex items-baseline justify-between bg-hf-ink px-4 py-3 text-white">
                <span className="text-[15px] font-semibold">
                  Total <span className="text-[13px] font-normal text-white/70">(inc VAT)</span>
                </span>
                <span className="text-[26px] font-bold tabular">{money(total)}</span>
              </div>
              <div className="p-4 flex flex-col gap-4">
                <div>
                  <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.06em] text-hf-muted">Who&apos;s it for?</p>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      aria-pressed={jobId === null}
                      onClick={() => pickJob(null)}
                      className={`w-full min-h-[48px] rounded-xl px-4 py-3 text-left text-[15px] ${choice(jobId === null)}`}
                    >
                      {jobId === null && <Tick />}Walk-in
                    </button>
                    {ctx.jobs.map((j) => (
                      <button
                        key={j.job_id}
                        type="button"
                        aria-pressed={jobId === j.job_id}
                        onClick={() => pickJob(j.job_id)}
                        className={`w-full min-h-[48px] rounded-xl px-4 py-3 text-left text-[15px] ${choice(jobId === j.job_id)}`}
                      >
                        {jobId === j.job_id && <Tick />}{j.label}
                        {j.rooms.length > 0 && (
                          <span className="block text-[13px] font-normal text-hf-muted">
                            {j.rooms.join(', ')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.06em] text-hf-muted">How did they pay?</p>
                  <div className="grid grid-cols-2 gap-2">
                    {ctx.tenders.filter((t) => !t.needsJob || jobId).map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        aria-pressed={tender === t.key}
                        onClick={() => pickTender(t.key)}
                        className={`min-h-[48px] rounded-xl px-3 py-3 text-[15px] ${tenderChoice(tender === t.key)} ${t.needsJob ? 'col-span-2' : ''}`}
                      >
                        {tender === t.key && <Tick />}{t.label}
                        {t.key === 'card_reader' && ctx.card_reader?.mode === 'test' ? ' (TEST)' : ''}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cash: tap what they handed over and the till works out the change.
                    Optional (Take works without it) and display only. */}
                {tender === 'till_cash' && (
                  <div>
                    <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.06em] text-hf-muted">
                      They gave you <span className="font-normal normal-case tracking-normal">(optional)</span>
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        aria-pressed={cashGiven === 'exact'}
                        onClick={() => setCashGiven('exact')}
                        className={`min-h-[46px] rounded-xl px-2 py-3 text-[15px] ${choice(cashGiven === 'exact')}`}
                      >
                        {cashGiven === 'exact' && <Tick />}Exact
                      </button>
                      {likelyTendered(total).map((d) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={cashGiven === d}
                          onClick={() => setCashGiven(d)}
                          className={`min-h-[46px] rounded-xl px-2 py-3 text-[15px] tabular ${choice(cashGiven === d)}`}
                        >
                          {cashGiven === d && <Tick />}£{d}
                        </button>
                      ))}
                      <button
                        type="button"
                        aria-pressed={cashGiven === 'other'}
                        onClick={() => setCashGiven('other')}
                        className={`min-h-[46px] rounded-xl px-2 py-3 text-[15px] ${choice(cashGiven === 'other')}`}
                      >
                        {cashGiven === 'other' && <Tick />}Other
                      </button>
                    </div>
                    {cashGiven === 'other' && (
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        autoFocus
                        value={cashOther}
                        onChange={(e) => setCashOther(e.target.value)}
                        placeholder="How much did they give you? e.g. 25"
                        className={`${cls.input} mt-2`}
                      />
                    )}
                    {cashChange !== null && cashChange > 0 && (
                      <div className="mt-2 flex items-baseline justify-between rounded-xl border-2 border-hf-ink px-4 py-3">
                        <span className="text-[15px] font-semibold text-hf-ink">Change to give</span>
                        <span className="text-[26px] font-bold tabular text-hf-ink">{money(cashChange)}</span>
                      </div>
                    )}
                    {cashChange === 0 && (
                      <p className="mt-2 rounded-xl border-2 border-hf-ink px-4 py-3 text-[15px] font-semibold text-hf-ink">
                        No change to give.
                      </p>
                    )}
                    {cashChange !== null && cashChange < 0 && (
                      <p className="mt-2 rounded-xl border border-hf-amber-border bg-hf-amber-bg px-4 py-3 text-[15px] text-hf-amber-text">
                        That’s {money(-cashChange)} short of the {money(total)} total.
                      </p>
                    )}
                  </div>
                )}

                {/* Optional receipt — typed only. Band contacts' addresses are
                    never sent to a sitter's phone. Not for "their bill": nothing
                    was paid, and their invoice is the document. */}
                {!tenderObj?.needsJob && (
                  <div>
                    <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.06em] text-hf-muted">
                      Email a receipt? <span className="font-normal normal-case tracking-normal">(optional)</span>
                    </p>
                    {bandContacts.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {bandContacts.map((c) => (
                          <button
                            key={c.email}
                            type="button"
                            aria-pressed={receiptTo === c.email}
                            onClick={() => setReceiptTo(c.email)}
                            className={`rounded-xl px-3 py-2 text-left text-[13px] ${choice(receiptTo === c.email)}`}
                          >
                            {receiptTo === c.email && <Tick />}{c.label}
                            <span className="block font-normal text-hf-muted">{c.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      value={receiptTo}
                      onChange={(e) => setReceiptTo(e.target.value)}
                      placeholder={bandContacts.length ? 'or type another address' : 'their@email.com'}
                      className={cls.input}
                    />
                  </div>
                )}

                {/* The card on the reader — replaces the Take button until it's done. */}
                {reader && reader.status !== 'succeeded' && (
                  <div className="rounded-2xl border border-hf-border bg-hf-inset p-4">
                    {reader.status === 'pending' && (
                      <>
                        <p className="text-[17px] font-semibold text-hf-ink">Waiting for card…</p>
                        <p className="mt-1 text-[15px] text-hf-body">
                          {money(Number(reader.amount))} is on {reader.reader_label || 'the reader'}. Ask them to tap their card.
                        </p>
                      </>
                    )}
                    {reader.status === 'recording' && <p className="text-[17px] font-semibold text-hf-ink">Card approved. Recording…</p>}
                    {reader.status === 'failed' && (
                      <>
                        <p className="text-[17px] font-semibold text-hf-error">Not taken</p>
                        <p className="mt-1 text-[15px] text-hf-error">{reader.failure_message || 'The card was declined.'}</p>
                      </>
                    )}
                    {reader.status === 'record_failed' && (
                      <p className="text-[15px] text-hf-error">
                        The card was charged but the sale didn’t record ({reader.failure_message}). The office has been told. Don’t take it again.
                      </p>
                    )}
                    {reader.status === 'cancelled' && <p className="text-[15px] text-hf-body">Cancelled. Nothing was taken.</p>}

                    {!reader.livemode && reader.status === 'pending' && (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button type="button" disabled={readerBusy} onClick={() => readerCall(`sessions/${reader.id}/simulate`, { outcome: 'approve' })}
                          className="min-h-[46px] rounded-xl border-[1.5px] border-hf-green bg-white px-3 py-3 text-[15px] font-semibold text-hf-green-text">Test: approve</button>
                        <button type="button" disabled={readerBusy} onClick={() => readerCall(`sessions/${reader.id}/simulate`, { outcome: 'decline' })}
                          className="min-h-[46px] rounded-xl border-[1.5px] border-red-300 bg-white px-3 py-3 text-[15px] font-semibold text-hf-error">Test: decline</button>
                      </div>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {reader.status === 'failed' && (
                        <button type="button" disabled={readerBusy} onClick={() => readerCall(`sessions/${reader.id}/retry`, {})}
                          className="min-h-[48px] rounded-xl bg-hf-green px-3 py-3 text-[15px] font-semibold text-white">Try again</button>
                      )}
                      {(reader.status === 'pending' || reader.status === 'failed') && (
                        <button type="button" disabled={readerBusy} onClick={() => readerCall(`sessions/${reader.id}/cancel`, {})}
                          className="min-h-[48px] rounded-xl border-[1.5px] border-hf-control bg-white px-3 py-3 text-[15px] font-semibold text-hf-body">Cancel payment</button>
                      )}
                      {(reader.status === 'cancelled' || reader.status === 'record_failed') && (
                        <button type="button" onClick={() => setReader(null)}
                          className="col-span-2 min-h-[48px] rounded-xl border-[1.5px] border-hf-control bg-white px-3 py-3 text-[15px] font-semibold text-hf-body">OK</button>
                      )}
                    </div>
                  </div>
                )}

                {!reader && <button
                  type="button"
                  onClick={take}
                  disabled={!canTake}
                  className={`${cls.btnGreen} w-full !h-14`}
                >
                  {saving
                    ? 'Recording…'
                    : jobId === undefined
                      ? 'Pick who it’s for'
                      : !tender
                      ? 'Pick how they paid'
                      : tenderObj?.needsJob
                        ? `Put ${money(total)} on their bill`
                        : tender === 'card_reader'
                          ? `Take ${money(total)} on card reader`
                          : `Take ${money(total)}`}
                </button>}
              </div>
            </section>
          </>
        )}

        {/* Tonight — what this till has taken. Pushed to the foot of the
            screen (mt-auto) so it's out of the way while selling. */}
        {summary && summary.sales > 0 && (
          <section className="mt-auto pt-6 flex flex-col gap-2.5">
            <SectionLabel>Tonight</SectionLabel>
            <div className={`${cls.card} p-4`}>
              <p className="text-[17px] font-semibold text-hf-ink tabular">
                {summary.sales} sale{summary.sales === 1 ? '' : 's'} · {money(summary.taken)} taken
              </p>
              <p className="mt-0.5 text-[14px] text-hf-muted tabular">
                {summary.byTender.map((t) => `${t.label} ${money(t.amount)}`).join(' · ')}
                {summary.onTheirBill > 0 ? `${summary.byTender.length ? ' · ' : ''}on bills ${money(summary.onTheirBill)}` : ''}
              </p>
              <ul className="mt-3 divide-y divide-hf-divider text-[15px]">
                {sales.map((s) => {
                  // Cancellable only until it goes to the office (the push hold).
                  const cancellable = s.mine && s.status === 'queued' && new Date(s.push_after).getTime() > Date.now()
                  return (
                    <li key={s.id} className="flex items-start gap-3 py-2.5">
                      <span className="w-12 shrink-0 text-[13px] tabular text-hf-muted pt-px">{timeOf(s.created_at)}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`font-semibold tabular ${s.status === 'cancelled' ? 'text-hf-placeholder line-through' : 'text-hf-ink'}`}>
                          {money(s.gross)}
                        </span>
                        {s.sold_to_hh_job_number && (
                          <span className="text-[13px] text-hf-muted"> → {bandName(s.sold_to_hh_job_number)}</span>
                        )}
                        <span className="block truncate text-[13px] text-hf-muted">
                          {s.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
                          {s.last_receipt_to ? ` · receipt to ${s.last_receipt_to}` : ''}
                        </span>
                        {receiptFor === s.id && (
                          <span className="mt-2 flex gap-2">
                            <input
                              type="email"
                              inputMode="email"
                              autoFocus
                              value={receiptFormTo}
                              onChange={(e) => setReceiptFormTo(e.target.value)}
                              placeholder="their@email.com"
                              className={`${cls.input} min-w-0 flex-1 !py-2 !text-[15px]`}
                            />
                            <button
                              type="button"
                              onClick={() => sendRowReceipt(s.id)}
                              disabled={receiptBusy || !receiptFormTo.trim()}
                              className="h-11 rounded-xl bg-hf-ink px-4 text-[15px] font-semibold text-white disabled:bg-hf-disabled"
                            >
                              {receiptBusy ? '…' : 'Send'}
                            </button>
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {cancellable ? (
                          <button type="button" onClick={() => cancel(s.id)} className="min-h-[32px] text-[13px] font-semibold text-hf-error">Cancel</button>
                        ) : s.status === 'cancelled' ? (
                          <span className="text-[13px] text-hf-placeholder">cancelled</span>
                        ) : null}
                        {s.status !== 'cancelled' && s.tender !== 'invoice_later' && (
                          <button
                            type="button"
                            onClick={() => {
                              setReceiptFor(receiptFor === s.id ? null : s.id)
                              setReceiptFormTo(s.last_receipt_to ?? '')
                            }}
                            className="min-h-[32px] text-[13px] font-semibold text-hf-link"
                          >
                            {receiptFor === s.id ? 'Close' : 'Receipt'}
                          </button>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </section>
        )}

        <p className={`px-1 text-center text-[13px] text-hf-muted leading-[1.45] ${summary && summary.sales > 0 ? '' : 'mt-auto'}`}>
          Prices include VAT. Made a mistake? Cancel it from the list straight away. After a couple of
          minutes it&apos;s gone to the office, so leave them a note instead.
        </p>
      </main>
    </div>
  )
}
