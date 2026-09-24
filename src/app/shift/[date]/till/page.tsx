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
  stock_as_of: string | null
  error?: string
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
  lines: { name: string; qty: number }[]
}
interface TonightSummary {
  sales: number
  taken: number
  byTender: { tender: string; label: string; amount: number }[]
  onTheirBill: number
}

const money = (n: number) => `£${n.toFixed(2)}`

/** One band in → them; two or more → make the sitter choose; none → walk-in. */
function defaultRoute(c: TillContext): string | null | undefined {
  if (c.jobs.length === 1) return c.jobs[0].job_id
  return c.jobs.length === 0 ? null : undefined
}

/**
 * Colour roles, so the checkout reads at a glance on a small screen: the total
 * bar is dark, a CHOICE is an outlined ✓ (not a filled block), and the one
 * button that records the sale is green. Filled-blue-everything made the
 * header, both choices and the final button look like the same thing.
 */
const choice = (on: boolean) =>
  on
    ? 'border-2 border-ooosh-600 bg-ooosh-50 text-ooosh-800'
    : 'border-2 border-transparent bg-gray-100 text-gray-800'
const round2 = (n: number) => Math.round(n * 100) / 100

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [sales, setSales] = useState<TonightSale[]>([])
  const [summary, setSummary] = useState<TonightSummary | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const loadContext = useCallback(async () => {
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/context`)
      if (r.status === 401) { router.push('/login'); return }
      const data = await r.json()
      if (!r.ok) { setLoadError(data.error || 'Could not open the till.'); return }
      setCtx(data)
      setJobId(defaultRoute(data))
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

  // "Their bill" only exists once a band is picked; going back to walk-in
  // clears it rather than leaving an impossible choice selected.
  const pickJob = (id: string | null | undefined) => {
    setJobId(id)
    if (!id && ctx?.tenders.find((t) => t.key === tender)?.needsJob) setTender(null)
  }

  const total = round2(basket.reduce((s, l) => s + lineGross(l), 0))
  const tenderObj = ctx?.tenders.find((t) => t.key === tender)
  const canTake = !!ctx?.open && basket.length > 0 && !!tender && jobId !== undefined && !saving

  async function take() {
    if (!canTake) return
    setSaving(true)
    setError(null)
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
      if (!r.ok) { setError(data.error || 'That didn’t go through — nothing was recorded.'); return }
      setDone(tenderObj?.needsJob ? `${money(total)} put on their bill.` : `Taken — ${money(total)}.`)
      setBasket([])
      setTender(null)
      setJobId(ctx ? defaultRoute(ctx) : undefined)
      loadSales()
      searchRef.current?.focus()
    } catch {
      setError('Couldn’t reach the office system — check your signal. Nothing was recorded; try again.')
    } finally {
      setSaving(false)
    }
  }

  async function cancel(id: string) {
    if (!window.confirm('Cancel this sale? It hasn’t gone through to the office yet, so it simply won’t happen.')) return
    setError(null)
    try {
      const r = await fetch(`/api/studio-sitter/shifts/${date}/till/sales/${id}/cancel`, { method: 'POST' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) setError(data.error || 'Couldn’t cancel that — ask the office.')
    } catch {
      setError('Couldn’t reach the office system — check your signal.')
    }
    loadSales()
  }

  const bandName = (hh: number | null) => ctx?.jobs.find((j) => j.hh_job_number === hh)?.label ?? (hh ? `#${hh}` : null)

  return (
    <div className="min-h-screen bg-gray-50 safe-top safe-bottom pb-10 flex flex-col">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href={`/shift/${date}`}
            className="p-2 -ml-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            title="Back to the shift"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-xl">🛒</span>
            <h1 className="text-lg font-semibold text-gray-900">Shop till</h1>
          </div>
        </div>
      </header>

      <main className="max-w-lg w-full mx-auto px-4 py-5 flex flex-1 flex-col gap-5">
        {loadError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{loadError}</div>
        )}

        {ctx && !ctx.open && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
            {ctx.locked_up
              ? 'You’ve locked up, so the till has closed for the night. Price lookup still works — leave the office a note about anything else.'
              : 'Price lookup only — the till takes sales on the night of your shift.'}
          </div>
        )}

        {done && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm font-medium">
            ✓ {done}
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">OK</button>
          </div>
        )}

        {/* Search — price lookup is the headline feature */}
        <section>
          <input
            ref={searchRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Look up an item — strings, jack lead, gaffa…"
            className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3.5 text-base focus:border-ooosh-500 focus:outline-none"
            inputMode="search"
            autoComplete="off"
          />
          {searching && <p className="mt-1 text-xs text-gray-400">Searching…</p>}
          {results.length > 0 && (
            <ul className="mt-2 rounded-xl border border-gray-200 bg-white divide-y overflow-hidden">
              {results.map((it) => (
                <li key={it.hhStockId}>
                  <button
                    onClick={() => ctx?.open && add(it)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-gray-50"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900">{it.title}</span>
                      <span className="block text-xs text-gray-500">
                        {it.quantity > 0 ? `${it.quantity} in stock` : 'none showing in stock'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base font-semibold text-gray-900">{money(it.priceIncVat ?? 0)}</span>
                      {ctx?.open && <span className="block text-[11px] text-ooosh-600">tap to add</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {term.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="mt-2 text-sm text-gray-500">Nothing matches — try another word.</p>
          )}
        </section>

        {ctx?.open && basket.length > 0 && (
          <>
            {/* Basket */}
            <section className="rounded-xl border border-gray-200 bg-white divide-y">
              {basket.map((l) => (
                <div key={l.item.hhStockId} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">{l.item.title}</p>
                    <p className="text-xs text-gray-500">{money(l.item.priceIncVat ?? 0)} each</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => bump(l.item.hhStockId, -1)} aria-label="One fewer"
                      className="h-10 w-10 rounded-lg border border-gray-300 text-lg text-gray-700 active:bg-gray-100">−</button>
                    <span className="w-7 text-center text-base font-semibold tabular-nums">{l.qty}</span>
                    <button onClick={() => bump(l.item.hhStockId, 1)} aria-label="One more"
                      className="h-10 w-10 rounded-lg border border-gray-300 text-lg text-gray-700 active:bg-gray-100">+</button>
                  </div>
                  <span className="w-16 text-right text-sm font-semibold tabular-nums">{money(lineGross(l))}</span>
                </div>
              ))}
            </section>

            {/* Checkout */}
            <section className="rounded-xl border border-gray-300 bg-white overflow-hidden shadow-sm">
              <div className="flex items-baseline justify-between bg-gray-900 px-4 py-3 text-white">
                <span className="text-sm font-semibold">Total</span>
                <span className="text-2xl font-bold tabular-nums">{money(total)}</span>
              </div>
              <div className="p-4 space-y-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Who&apos;s it for?</p>
                  <div className="space-y-2">
                    <button
                      onClick={() => pickJob(null)}
                      className={`w-full rounded-lg px-4 py-3 text-left text-sm font-medium ${choice(jobId === null)}`}
                    >
                      {jobId === null ? '✓ ' : ''}Walk-in
                    </button>
                    {ctx.jobs.map((j) => (
                      <button
                        key={j.job_id}
                        onClick={() => pickJob(j.job_id)}
                        className={`w-full rounded-lg px-4 py-3 text-left text-sm font-medium ${choice(jobId === j.job_id)}`}
                      >
                        {jobId === j.job_id ? '✓ ' : ''}{j.label}
                        {j.rooms.length > 0 && (
                          <span className="block text-xs font-normal text-gray-500">
                            {j.rooms.join(', ')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">How did they pay?</p>
                  <div className="grid grid-cols-2 gap-2">
                    {ctx.tenders.filter((t) => !t.needsJob || jobId).map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setTender(t.key)}
                        className={`rounded-lg px-3 py-3 text-sm font-medium ${choice(tender === t.key)} ${t.needsJob ? 'col-span-2' : ''}`}
                      >
                        {tender === t.key ? '✓ ' : ''}{t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={take}
                  disabled={!canTake}
                  className="w-full rounded-xl bg-green-600 px-4 py-4 text-base font-semibold text-white active:bg-green-700 disabled:bg-gray-300"
                >
                  {saving
                    ? 'Recording…'
                    : jobId === undefined
                      ? 'Pick who it’s for'
                      : !tender
                      ? 'Pick how they paid'
                      : tenderObj?.needsJob
                        ? `Put ${money(total)} on their bill`
                        : `Take ${money(total)}`}
                </button>
              </div>
            </section>
          </>
        )}

        {/* Tonight — what this till has taken. Pushed to the foot of the
            screen (mt-auto) so it's out of the way while selling. */}
        {summary && summary.sales > 0 && (
          <section className="mt-auto pt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Tonight</h2>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-base font-semibold text-gray-900">
                {summary.sales} sale{summary.sales === 1 ? '' : 's'} · {money(summary.taken)} taken
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {summary.byTender.map((t) => `${t.label} ${money(t.amount)}`).join(' · ')}
                {summary.onTheirBill > 0 ? `${summary.byTender.length ? ' · ' : ''}on bills ${money(summary.onTheirBill)}` : ''}
              </p>
              <ul className="mt-3 divide-y text-sm">
                {sales.map((s) => {
                  // Cancellable only until it goes to the office (the push hold).
                  const cancellable = s.mine && s.status === 'queued' && new Date(s.push_after).getTime() > Date.now()
                  return (
                    <li key={s.id} className="flex items-start gap-3 py-2">
                      <span className="w-11 shrink-0 text-xs tabular-nums text-gray-500">{timeOf(s.created_at)}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`font-medium ${s.status === 'cancelled' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                          {money(s.gross)}
                        </span>
                        {s.sold_to_hh_job_number && (
                          <span className="text-xs text-gray-500"> → {bandName(s.sold_to_hh_job_number)}</span>
                        )}
                        <span className="block truncate text-xs text-gray-500">
                          {s.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
                        </span>
                      </span>
                      {cancellable ? (
                        <button onClick={() => cancel(s.id)} className="shrink-0 text-xs font-medium text-red-600">Cancel</button>
                      ) : s.status === 'cancelled' ? (
                        <span className="shrink-0 text-xs text-gray-400">cancelled</span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          </section>
        )}

        <p className={`text-center text-xs text-gray-400 ${summary && summary.sales > 0 ? '' : 'mt-auto'}`}>
          Prices include VAT. Made a mistake? Cancel it from the list straight away — after a couple of
          minutes it&apos;s gone to the office, so leave them a note instead.
        </p>
      </main>
    </div>
  )
}
