'use client'

/**
 * Earnings (docs/FREELANCER-PORTAL-SPEC.md §5.2, jon, Oct 2026).
 *
 * Their invoices as the office linked them in Costs, with where each one has
 * got to (Received, Queried, Approved and due, Paying, Paid), and their
 * finished work for the period, each marked To invoice / Invoiced / Paid. The
 * point (jon): a freelancer asking "have you paid invoice 2?" can be pointed
 * here instead of being sent the remittance again.
 *
 * Money is counted by invoice (OP services/freelancer-earnings.ts): Paid in the
 * period, Invoiced in the period and not paid yet, and To invoice for work
 * that isn't on an invoice. "To invoice" only starts from when the office began
 * ticking work (22 Oct 2026), so older work shows its fee with no label.
 *
 * There is no "Send invoice" button: invoices are still emailed (PDF) to
 * whoever booked them, and the "How to invoice" guide is on Resources.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import BottomNav from '@/components/BottomNav'
import { cls, Banner, Chip, SectionLabel, Segmented, Chevron } from '@/components/ui'
import { shortUkDate } from '@/lib/ukDate'
import type { EarningsInvoice, EarningsPeriodKey, EarningsResponse, EarningsWork } from '@/lib/op-api'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "3 Oct" (the Paid chip, as the design has it). */
function dayMonth(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  return m && d ? `${d} ${MONTHS[m - 1]}` : ymd
}

/** £1,140, or £918.51 when there are pennies. */
function money(n: number): string {
  const whole = Math.abs(n % 1) < 0.005
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function InvoiceChip({ inv }: { inv: EarningsInvoice }) {
  switch (inv.status) {
    case 'paid': return <Chip tone="green">{inv.statusDate ? `Paid ${dayMonth(inv.statusDate)}` : 'Paid'}</Chip>
    case 'scheduled': return <Chip tone="plum">{inv.statusDate ? `Paying ${shortUkDate(inv.statusDate)}` : 'Paying soon'}</Chip>
    case 'approved': return <Chip tone="plum">{inv.statusDate ? `Approved, due ${shortUkDate(inv.statusDate)}` : 'Approved'}</Chip>
    case 'queried': return <Chip tone="amber">Queried</Chip>
    default: return <Chip>Received</Chip>
  }
}

function WorkChip({ w }: { w: EarningsWork }) {
  if (w.label === 'paid') return <Chip tone="green">{w.paidDate ? `Paid ${dayMonth(w.paidDate)}` : 'Paid'}</Chip>
  if (w.label === 'invoiced') return <Chip tone="amber">Invoiced</Chip>
  if (w.label === 'to_invoice') return <Chip>To invoice</Chip>
  return null
}

function InvoiceRow({ inv }: { inv: EarningsInvoice }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold text-hf-ink">
            {inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : 'Invoice'}
          </div>
          <div className="text-[14px] text-hf-muted">{inv.date ? shortUkDate(inv.date) : 'No date'}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cls.money}>{money(inv.amount)}</span>
          <InvoiceChip inv={inv} />
        </div>
      </div>
      {inv.status === 'queried' && (
        <Banner tone="warning" className="mt-2.5 !text-[14px]">
          <span className="font-semibold">We have a question about this invoice.</span>
          {inv.queryNote ? <> {inv.queryNote}</> : null}
          <span className="block mt-1">Please reply to whoever booked you.</span>
        </Banner>
      )}
      {inv.work.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer list-none text-[14px] text-hf-link font-semibold inline-flex items-center gap-1">
            Covers {plural(inv.work.length, 'job', 'jobs')}
            <Chevron className="transition-transform group-open:rotate-90 !text-hf-link" />
          </summary>
          <ul className="mt-1.5 space-y-1">
            {inv.work.map((w, i) => (
              <li key={i} className="text-[14px] text-hf-body flex gap-2">
                <span className="tabular text-hf-muted shrink-0 w-[5.5rem]">{shortUkDate(w.date)}</span>
                <span className="min-w-0">
                  {w.title}
                  {w.jobNumber ? <span className="text-hf-muted"> · Job {w.jobNumber}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function WorkRow({ w }: { w: EarningsWork }) {
  const sub = [shortUkDate(w.date), w.jobNumber ? `Job ${w.jobNumber}` : null].filter(Boolean).join(' · ')
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <div className="truncate text-[16px] font-semibold text-hf-ink">{w.title}</div>
        <div className="text-[14px] text-hf-muted">{sub}</div>
        {w.detail && <div className="truncate text-[13px] text-hf-muted">{w.detail}</div>}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {w.fee > 0 ? <span className={cls.money}>{money(w.fee)}</span> : null}
        <WorkChip w={w} />
      </div>
    </div>
  )
}

function List({ children }: { children: ReactNode }) {
  return <div className={`${cls.card} divide-y divide-hf-border overflow-hidden`}>{children}</div>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={`${cls.card} px-4 py-4 text-[15px] text-hf-muted`}>{children}</div>
}

export default function EarningsPage() {
  const router = useRouter()
  const [period, setPeriod] = useState<EarningsPeriodKey>('this_month')
  const [data, setData] = useState<EarningsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/earnings?period=${period}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.status === 401) { router.push('/login'); return }
        if (!res.ok) throw new Error(body.error || 'Unable to load your earnings.')
        setData(body as EarningsResponse)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load your earnings.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [period, router])

  const p = data?.period
  const t = data?.totals
  const pct = (n: number) => (t && t.total > 0 ? `${(n / t.total) * 100}%` : '0%')
  // The card is money by invoice (paid in the period, or sent in it and not
  // paid yet), so its second line counts invoices, not jobs: a job done in
  // September and paid in October is October's money.
  const counts = data?.counts
  const countLine = counts
    ? [
        counts.paid ? `${plural(counts.paid, 'invoice', 'invoices')} paid` : null,
        counts.waiting ? `${counts.paid ? counts.waiting : plural(counts.waiting, 'invoice', 'invoices')} waiting` : null,
        data?.toInvoiceCount ? `${plural(data.toInvoiceCount, 'job', 'jobs')} to invoice` : null,
      ].filter(Boolean).join(' · ')
    : ''
  // "in October" / "in the tax year 2026/27"
  const inPeriod = p ? (p.key.endsWith('month') ? `in ${p.label}` : `in the ${p.label.toLowerCase()}`) : ''
  const toInvoiceCount = data?.toInvoiceCount || 0

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-6 pb-2">
        <h1 className={cls.pageTitle}>Earnings</h1>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-3 space-y-4">
        {data?.shared ? (
          <Banner>
            Earnings shows a freelancer&apos;s own invoices and pay, so there&apos;s nothing to show on the shared login.
          </Banner>
        ) : (
          <>
            {data?.periods && data.periods.length > 1 && (
              <Segmented
                options={data.periods.map((o) => ({ value: o.key, label: o.tab }))}
                value={period}
                onChange={(v) => setPeriod(v)}
              />
            )}

            {error && <Banner tone="error">{error}</Banner>}

            {!data && loading && (
              <div className="py-16 flex justify-center">
                <div className="w-10 h-10 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin" />
              </div>
            )}

            {data && p && t && (
              <div className={`space-y-4 transition-opacity ${loading ? 'opacity-50' : ''}`}>
                {/* The period, by invoice. */}
                <section className={`${cls.card} p-5`}>
                  <div className="text-[15px] font-semibold text-hf-muted">{p.label}</div>
                  <div className="tabular text-[40px] font-bold tracking-[-0.03em] leading-[1.1] text-hf-ink mt-1">{money(t.total)}</div>
                  <div className="text-[15px] text-hf-muted mt-1">{countLine || 'Nothing paid or invoiced'}</div>
                  <div className="mt-4 h-2 rounded-full bg-hf-track overflow-hidden flex" aria-hidden>
                    <div className="h-full bg-hf-green" style={{ width: pct(t.paid) }} />
                    <div className="h-full bg-hf-amber-border" style={{ width: pct(t.invoiced) }} />
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2">
                    {([
                      ['Paid', t.paid, 'bg-hf-green'],
                      ['Invoiced', t.invoiced, 'bg-hf-amber-border'],
                      ['To invoice', t.toInvoice, 'bg-hf-track border border-hf-border'],
                    ] as const).map(([label, amount, dot]) => (
                      <div key={label}>
                        <dt className="text-[14px] text-hf-muted flex items-center gap-1.5">
                          <span className={`w-2.5 h-2.5 rounded-sm ${dot}`} />{label}
                        </dt>
                        <dd className="tabular text-[18px] font-semibold text-hf-ink mt-0.5">{money(amount)}</dd>
                      </div>
                    ))}
                  </dl>
                  {data.nextPayment && (
                    <div className="mt-4 pt-3 border-t border-hf-border flex items-center justify-between text-[15px]">
                      <span className="text-hf-muted">Next payment</span>
                      <span className="font-semibold text-hf-ink tabular">
                        {shortUkDate(data.nextPayment.date)} · {money(data.nextPayment.amount)}
                      </span>
                    </div>
                  )}
                </section>

                {/* Work waiting for their invoice: no button, invoices are emailed. */}
                {toInvoiceCount > 0 && (
                  <section className={`${cls.card} p-4`}>
                    <div className="text-[17px] font-semibold text-hf-ink">
                      {plural(toInvoiceCount, 'job needs', 'jobs need')} an invoice
                    </div>
                    <div className="text-[15px] text-hf-muted">{money(t.toInvoice)} in fees, plus any expenses</div>
                    <p className="text-[15px] text-hf-body mt-2">Email your invoice (PDF) to whoever booked you.</p>
                    <Link href="/resources" className={`${cls.link} inline-flex items-center gap-1 mt-1 text-[15px]`}>
                      How to invoice <Chevron className="!text-hf-link" />
                    </Link>
                  </section>
                )}

                {(data.earlierWaiting?.length || 0) > 0 && (
                  <section className="space-y-2">
                    <SectionLabel count={data.earlierWaiting!.length}>Still waiting from before</SectionLabel>
                    <List>{data.earlierWaiting!.map((inv) => <InvoiceRow key={inv.id} inv={inv} />)}</List>
                  </section>
                )}

                <section className="space-y-2">
                  <SectionLabel count={data.invoices?.length || undefined}>Your invoices</SectionLabel>
                  {data.invoices && data.invoices.length > 0
                    ? <List>{data.invoices.map((inv) => <InvoiceRow key={inv.id} inv={inv} />)}</List>
                    : <Empty>No invoices {inPeriod}.</Empty>}
                </section>

                <section className="space-y-2">
                  <SectionLabel count={data.work?.length || undefined}>Your work</SectionLabel>
                  {data.work && data.work.length > 0
                    ? <List>{data.work.map((w) => <WorkRow key={w.key} w={w} />)}</List>
                    : <Empty>No finished work {inPeriod}.</Empty>}
                </section>

                {toInvoiceCount === 0 && (
                  <p className="px-1 text-[14px] text-hf-muted">
                    Invoices are emailed (PDF) to whoever booked you.{' '}
                    <Link href="/resources" className={cls.link}>How to invoice</Link>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <BottomNav active="earnings" />
    </div>
  )
}
