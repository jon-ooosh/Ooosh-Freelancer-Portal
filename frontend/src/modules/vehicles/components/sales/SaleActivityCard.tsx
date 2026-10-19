/**
 * A van sale's activity log (docs/VEHICLE-SALES-SPEC.md §7).
 *
 * Any staff member logs what happened — a viewing, a listing, a contact, an
 * offer, a note — optionally with a follow-up, which lands in To Do (made by
 * the backend through the To Do module). Offers are accepted / declined here;
 * accepting moves the sale to "Under offer", and "Mark sold" pre-fills from it.
 * OP adds its own lines (stage changes, links made / revoked).
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ACTIVITY_TYPES,
  fetchSaleActivity,
  addSaleActivity,
  setOfferStatus,
  fetchAssignablePeople,
  type ActivityEntry,
  type StaffActivityType,
  type SaleView,
} from '../../lib/vehicle-sales'

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function todayLondon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
}

const money = (n: number) => n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })

const TYPE_STYLE: Record<string, { label: string; cls: string }> = {
  viewing: { label: 'Viewing', cls: 'bg-blue-100 text-blue-800' },
  listed: { label: 'Listed', cls: 'bg-purple-100 text-purple-800' },
  contact: { label: 'Contact', cls: 'bg-sky-100 text-sky-800' },
  offer: { label: 'Offer', cls: 'bg-green-100 text-green-800' },
  note: { label: 'Note', cls: 'bg-gray-100 text-gray-700' },
  status_change: { label: 'Stage', cls: 'bg-indigo-50 text-indigo-700' },
  link_created: { label: 'Link', cls: 'bg-gray-50 text-gray-500' },
  link_revoked: { label: 'Link', cls: 'bg-gray-50 text-gray-500' },
}

export function activityQueryKey(saleId: string) {
  return ['sale-activity', saleId]
}

/** The accepted offer "Mark sold" pre-fills from — the most recent one. */
export function latestAcceptedOffer(entries: ActivityEntry[] | undefined): ActivityEntry | null {
  return (entries ?? []).find(e => e.type === 'offer' && e.offerStatus === 'accepted') ?? null
}

export function SaleActivityCard({ sale, onSaleChanged }: { sale: SaleView; onSaleChanged: () => void }) {
  const queryClient = useQueryClient()
  const key = activityQueryKey(sale.id)
  const { data: entries, isLoading } = useQuery({ queryKey: key, queryFn: () => fetchSaleActivity(sale.id) })
  const { data: people } = useQuery({ queryKey: ['assignable-people'], queryFn: fetchAssignablePeople, staleTime: 5 * 60_000 })

  const today = todayLondon()
  const [type, setType] = useState<StaffActivityType>('viewing')
  const [occurredOn, setOccurredOn] = useState(today)
  const [who, setWho] = useState('')
  const [text, setText] = useState('')
  const [amount, setAmount] = useState('')
  const [site, setSite] = useState('')
  const [url, setUrl] = useState('')
  const [followOn, setFollowOn] = useState(false)
  const [followDate, setFollowDate] = useState('')
  const [followPerson, setFollowPerson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setOccurredOn(today); setWho(''); setText(''); setAmount(''); setSite(''); setUrl('')
    setFollowOn(false); setFollowDate(''); setFollowPerson('')
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const list = await addSaleActivity(sale.id, {
        type,
        occurredOn,
        who: who.trim() || undefined,
        text: text.trim() || undefined,
        amount: type === 'offer' && amount.trim() ? Number(amount) : null,
        listingSite: type === 'listed' ? site.trim() : undefined,
        listingUrl: type === 'listed' ? url.trim() || undefined : undefined,
        followUp: followOn && followDate ? { dueDate: followDate, personId: followPerson || null } : null,
      })
      queryClient.setQueryData(key, list)
      reset()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function offer(e: ActivityEntry, status: 'open' | 'accepted' | 'declined') {
    setBusy(true)
    setError(null)
    try {
      queryClient.setQueryData(key, await setOfferStatus(sale.id, e.id, status))
      // Accepting moves the stage to Under offer — reload the sale.
      if (status === 'accepted') onSaleChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !busy
    && (type !== 'offer' || (who.trim() && Number(amount) > 0))
    && (type !== 'listed' || site.trim())
    && (type === 'offer' || type === 'listed' || who.trim() || text.trim())
    && (!followOn || followDate)

  const me = people?.me ?? null

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Activity</h3>
        <p className="text-xs text-gray-500">Viewings, listings, contacts and offers. A follow-up goes on someone's To Do.</p>
      </div>

      {/* New entry */}
      <div className="rounded border border-dashed border-gray-300 p-3 space-y-2">
        <div className="flex flex-wrap gap-1">
          {ACTIVITY_TYPES.map(t => (
            <button key={t.value} type="button" onClick={() => setType(t.value)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${type === t.value ? 'bg-ooosh-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-[11px] text-gray-500">
            When
            <input type="date" value={occurredOn} max={today} onChange={e => setOccurredOn(e.target.value)}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
          </label>
          <label className="text-[11px] text-gray-500 sm:col-span-2">
            {type === 'offer' ? 'Who made the offer' : type === 'listed' ? 'Who (optional)' : 'Who'}
            <input value={who} onChange={e => setWho(e.target.value)} placeholder="e.g. the dealer, Dave (client)"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
          </label>
        </div>
        {type === 'offer' && (
          <label className="block text-[11px] text-gray-500">
            Amount (£)
            <input type="number" min="0" step="50" value={amount} onChange={e => setAmount(e.target.value)}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none sm:w-48" />
          </label>
        )}
        {type === 'listed' && (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-[11px] text-gray-500">
              Where
              <input value={site} onChange={e => setSite(e.target.value)} placeholder="AutoTrader, eBay…"
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
            </label>
            <label className="text-[11px] text-gray-500 sm:col-span-2">
              Link to the listing (optional)
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…"
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
            </label>
          </div>
        )}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={type === 'viewing' ? 'How did it go?' : 'Details (optional)'}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />

        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          {/* '' = "Me" — the backend defaults the task to the caller. */}
          <input type="checkbox" checked={followOn} onChange={e => setFollowOn(e.target.checked)} />
          Follow up
        </label>
        {followOn && (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-[11px] text-gray-500">
              On
              <input type="date" value={followDate} min={today} onChange={e => setFollowDate(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
            </label>
            <label className="text-[11px] text-gray-500 sm:col-span-2">
              Who follows up
              <select value={followPerson} onChange={e => setFollowPerson(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none">
                <option value="">Me</option>
                {(people?.people ?? []).filter(p => p.person_id !== me).map(p => (
                  <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="button" onClick={submit} disabled={!canSubmit}
          className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? 'Saving…' : 'Add to activity'}
        </button>
      </div>

      {/* Log */}
      {isLoading && <p className="text-sm text-gray-400">Loading activity…</p>}
      {!isLoading && (entries ?? []).length === 0 && <p className="text-sm text-gray-500">Nothing logged yet.</p>}
      <ul className="divide-y divide-gray-100">
        {(entries ?? []).map(e => {
          const style = TYPE_STYLE[e.type] ?? TYPE_STYLE.note
          const system = e.type === 'status_change' || e.type === 'link_created' || e.type === 'link_revoked'
          return (
            <li key={e.id} className={`py-2 text-sm ${system ? 'text-gray-500' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${style.cls}`}>{style.label}</span>
                <span className="text-xs text-gray-500">{fmtDate(e.occurredOn)}</span>
                {e.who && <span className="font-medium text-gray-900">{e.who}</span>}
                {e.amount != null && <span className="font-semibold text-gray-900">{money(e.amount)}</span>}
                {e.type === 'offer' && e.offerStatus === 'accepted' && (
                  <span className="rounded bg-green-600 px-1.5 py-0.5 text-[11px] font-medium text-white">Accepted</span>
                )}
                {e.type === 'offer' && e.offerStatus === 'declined' && (
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">Declined</span>
                )}
                {e.listingSite && (
                  e.listingUrl
                    ? <a href={e.listingUrl} target="_blank" rel="noreferrer" className="text-ooosh-blue underline">{e.listingSite}</a>
                    : <span className="text-gray-700">{e.listingSite}</span>
                )}
                {e.createdByName && !system && <span className="text-[11px] text-gray-400">· {e.createdByName}</span>}
              </div>
              {e.text && <p className="mt-0.5 whitespace-pre-line text-sm text-gray-700">{e.text}</p>}
              {e.followUp && (
                <a href="/me?tab=todo"
                  className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] ${
                    e.followUp.status === 'open' ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-500 line-through'
                  }`}>
                  Follow-up {fmtDate(e.followUp.dueDate)}{e.followUp.ownerName ? ` · ${e.followUp.ownerName}` : ''}
                  {e.followUp.status !== 'open' && ` (${e.followUp.status})`}
                </a>
              )}
              {e.type === 'offer' && (
                <div className="mt-1 flex gap-1.5">
                  {e.offerStatus !== 'accepted' && (
                    <button type="button" disabled={busy} onClick={() => offer(e, 'accepted')}
                      className="rounded border border-green-300 px-2 py-0.5 text-[11px] font-medium text-green-700 hover:bg-green-50 disabled:opacity-50">
                      Accept
                    </button>
                  )}
                  {e.offerStatus !== 'declined' && (
                    <button type="button" disabled={busy} onClick={() => offer(e, 'declined')}
                      className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                      Decline
                    </button>
                  )}
                  {e.offerStatus !== 'open' && (
                    <button type="button" disabled={busy} onClick={() => offer(e, 'open')}
                      className="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:underline disabled:opacity-50">
                      Undo
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
