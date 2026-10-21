'use client'

/**
 * Job Details Page
 *
 * Displays full details for a single job including venue information.
 * Supports both D&C jobs and Crew jobs.
 * Route: /job/[id]
 *
 * Query params:
 * - ?board=crew → open as a crew job before the data arrives (the job's own
 *   boardType from OP decides once it does — links without the param, like the
 *   completion reminder email, used to render a crew job as a delivery)
 * - ?run=X → multi-drop run view (D&C only)
 *
 * Look: the Oct 2026 refresh (design 1c). Kind label + HH number, the venue as
 * the title, key notes in amber, an address card with Directions / Copy, one
 * "Who to contact" card, the equipment list as an expandable row with the fee,
 * and Start as a sticky button at the bottom. Behaviour is unchanged.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle, Search, RefreshCw, MapPin, Navigation, Copy, Check, Phone, Mail,
  FileText, Image as ImageIcon, Paperclip, ExternalLink, ChevronDown, Play, CalendarPlus,
  Bell, BellOff, Receipt, PoundSterling, User, Minus, Plus, Timer, Users, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { downloadIcs } from '@/lib/calendar'
import { ukToday, ukDatePlus } from '@/lib/ukDate'
import { cls, BackLink, Banner, Chip, IconTile, PageSpinner, KIND_TEXT, ICON } from '@/components/ui'
import type { Kind } from '@/components/ui'

// =============================================================================
// TYPES
// =============================================================================

interface Job {
  id: string
  name: string
  type: 'delivery' | 'collection'
  whatIsIt?: 'equipment' | 'vehicle' | 'people'  // Raw quotes.what_is_it
  date?: string
  time?: string
  venueName?: string
  venueId?: string
  status: string
  hhRef?: string
  keyNotes?: string
  contacts?: Array<{ name: string; label?: string | null; phone?: string | null; email?: string | null }>
  runGroup?: string
  driverPay?: number
  completedAtDate?: string
  completionNotes?: string
  // Crew and People work: YYYY-MM-DD it can be completed from (its last day)
  completeFrom?: string | null
  // Crew job fields
  board?: 'dc' | 'crew'
  jobType?: string                    // "Transport + Crew" or "Crew Only"
  destination?: string                // Venue name (text)
  finishDate?: string                 // End date for multi-day jobs
  workType?: string                   // "Backline Tech", "General Assist", etc.
  workTypeOther?: string              // Custom description if "Other"
  workDurationHours?: number          // Hours of on-site work
  workDescription?: string            // Details of the work
  freelancerFee?: number              // What we pay them
  numberOfDays?: number               // For multi-day jobs
  expenseBreakdown?: string           // Itemised expense detail
  expensesIncluded?: number           // £ included in quote
  expensesNotIncluded?: number        // £ on top of quote
  expenseArrangement?: string         // How expenses are handled
  pdArrangement?: string              // Per diem arrangement
  pdAmount?: number                   // Per diem daily rate
  files?: VenueFile[]                 // Shared job-level files (OP only)
  // Plain-English pay/reimburse breakdown for the freelancer (OP only).
  crewMoney?: {
    perDiem: { label: string; message: string; tone: 'ooosh' | 'client' | 'claim' | 'none' }
    expenses: { label: string; message: string; tone: 'ooosh' | 'client' | 'claim' | 'none' }[]
  }
}

interface Venue {
  id: string
  name: string
  address?: string
  loadInAddress?: string | null
  whatThreeWords?: string
  contact1?: string
  contact2?: string
  phone?: string | null
  phone2?: string | null
  phoneHidden?: boolean
  phoneVisibleFrom?: string | null
  email?: string
  accessNotes?: string
  stageNotes?: string
  files?: VenueFile[]
}

interface VenueFile {
  assetId: string
  name: string
  fileType?: string
  url?: string
}

interface JobApiResponse {
  success: boolean
  job?: Job
  venue?: Venue | null
  contactsVisible?: boolean
  boardType?: string
  error?: string
}

interface EquipmentItem {
  id: string
  name: string
  quantity: number
  category?: string
  categoryId?: number
  isVirtual?: boolean
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDate(dateStr?: string): string {
  if (!dateStr) return 'TBC'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

/** "10:00" / "10:00:00" → "10:00 AM" (as on the job cards); already-formatted passes through. */
function formatTime(timeStr?: string): string {
  if (!timeStr) return ''
  if (/[AP]M/i.test(timeStr)) return timeStr
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match) return timeStr
  const hours = parseInt(match[1], 10)
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? 'PM' : 'AM'}`
}

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** YYYY-MM-DD → "Tue 21 Oct" (built by hand: browsers disagree on the comma). */
function shortDay(dateStr?: string | null): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  if (Number.isNaN(date.getTime())) return dateStr
  return `${DAYS_SHORT[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`
}

/** "Today, Tue 21 Oct" / "Tomorrow, Wed 22 Oct" / "Thu 23 Oct" (UK days). */
function dayLabel(dateStr?: string): string {
  if (!dateStr) return 'Date TBC'
  const ymd = dateStr.slice(0, 10)
  const short = shortDay(ymd)
  if (ymd === ukToday()) return `Today, ${short}`
  if (ymd === ukDatePlus(1)) return `Tomorrow, ${short}`
  return short
}

function getGoogleMapsUrl(address?: string | null): string | null {
  if (!address) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}

function getWhat3WordsUrl(w3w?: string): string | null {
  if (!w3w) return null
  const words = w3w.replace(/^\/+/, '').trim()
  if (!words) return null
  return `https://what3words.com/${words}`
}

/**
 * Translate Monday.com status to user-friendly display
 * Works for both D&C and Crew job statuses
 */
function translateStatus(status: string): { label: string; tone: 'green' | 'plum' | 'neutral' | 'red'; Icon: LucideIcon | null } {
  const normalised = status.toLowerCase().trim()

  // Confirmed / Arranged (matches both "email driver" and "email crew")
  if (normalised.includes('arranged')) {
    return { label: 'Confirmed', tone: 'green', Icon: Check }
  }

  // In Progress / Working on it
  if (normalised.includes('working on it')) {
    return { label: 'In Progress', tone: 'plum', Icon: RefreshCw }
  }

  // Completed / All done
  if (normalised.includes('done') || normalised.includes('completed')) {
    return { label: 'Completed', tone: 'neutral', Icon: Check }
  }

  // Cancelled / Not needed
  if (normalised.includes('not needed') || normalised.includes('cancelled')) {
    return { label: 'Cancelled', tone: 'red', Icon: X }
  }

  // Still being set up by the office ('TO DO!' / 'Arranging' are office
  // labels from the Monday days; a freelancer shouldn't see them raw).
  if (normalised.includes('to do') || normalised.includes('arranging')) {
    return { label: 'Being arranged', tone: 'neutral', Icon: null }
  }

  // Default - show raw status
  return { label: status, tone: 'neutral', Icon: null }
}

function StatusChip({ status }: { status: string }) {
  const s = translateStatus(status)
  return (
    <Chip tone={s.tone}>
      {s.Icon && <s.Icon size={12} strokeWidth={2.6} />}
      {s.label}
    </Chip>
  )
}

/**
 * Get the filter mode for HireHop items based on job's whatIsIt value
 */
function getFilterMode(whatIsIt?: 'equipment' | 'vehicle' | 'people'): 'equipment' | 'vehicles' | 'all' {
  switch (whatIsIt) {
    case 'equipment':
      return 'equipment'  // Exclude vehicles and services
    case 'vehicle':
      return 'all'        // Show everything for vehicle deliveries
    default:
      return 'all'        // Unknown - show everything to be safe
  }
}

/**
 * Translate crew job type for freelancer-friendly display
 */
function translateJobType(jobType?: string): string {
  if (!jobType) return ''
  if (jobType.toLowerCase().includes('transport')) return 'Driving + Crew'
  return jobType
}

/**
 * Format crew job duration intelligently
 */
function formatDuration(hours?: number, days?: number): string {
  if (days && days > 1) {
    return `${days} days`
  }
  if (hours) {
    return `${hours} hour${hours !== 1 ? 's' : ''}`
  }
  return ''
}

/**
 * Get display work type — if "Other", use work description
 */
function getDisplayWorkType(workType?: string, workDescription?: string): string {
  if (!workType) return 'Crew Work'
  if (workType.toLowerCase() === 'other' && workDescription) return workDescription
  return workType
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Kind label for a D&C job, the same rule as the dashboard's cards (design 2a). */
function describeDcJob(job: Job): { kind: Kind; label: string } {
  const leg = job.type === 'collection' ? 'collection' : 'delivery'
  if (job.whatIsIt === 'equipment') return { kind: 'backline', label: `Backline ${leg}` }
  if (job.whatIsIt === 'vehicle') return { kind: 'van', label: `Van ${leg}` }
  if (job.whatIsIt === 'people') return { kind: 'van', label: `People ${leg}` }
  return { kind: 'backline', label: leg === 'delivery' ? 'Delivery' : 'Collection' }
}

// =============================================================================
// SHARED LAYOUT PIECES (this page only)
// =============================================================================

/** Kind label · HH n, the title, the date line, and any chips. */
function JobHeading({ kind, label, hhRef, title, dateLine, chips }: {
  kind: Kind
  label: string
  hhRef?: string
  title: string
  dateLine: string
  chips?: ReactNode
}) {
  return (
    <div className="px-1 pb-1.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`${cls.kindLabel} ${KIND_TEXT[kind]}`}>{label}</span>
        {hhRef && <span className="text-[13px] text-hf-muted">· HH {hhRef}</span>}
      </div>
      <h1 className={cls.pageTitle}>{title}</h1>
      <p className="text-[16px] text-hf-body">{dateLine}</p>
      {chips && <div className="flex flex-wrap gap-1.5 pt-0.5">{chips}</div>}
    </div>
  )
}

/** The amber "Key notes" card (also used for access info). */
function NoteCard({ title, text, tone = 'amber' }: { title: string; text: string; tone?: 'amber' | 'plain' }) {
  const box = tone === 'amber'
    ? 'bg-hf-amber-bg border border-hf-amber-border'
    : 'bg-white border border-hf-border'
  const head = tone === 'amber' ? 'text-hf-amber-text' : 'text-hf-muted'
  return (
    <div className={`${box} rounded-[14px] px-3.5 py-3 flex flex-col gap-1`}>
      <div className={`${cls.kindLabel} ${head}`}>{title}</div>
      <p className="text-[15px] leading-[1.45] text-hf-body whitespace-pre-wrap">{text}</p>
    </div>
  )
}

/** A card with a section label and free text. */
function TextCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`${cls.card} p-4 flex flex-col gap-2`}>
      <div className={`${cls.kindLabel} text-hf-muted`}>{title}</div>
      {children}
    </div>
  )
}

/**
 * The venue's address: first line bold, the rest muted, then Directions / Copy.
 * Load-in address and what3words stay alongside (never instead of the postal
 * address: a note like "round the back via Mill Lane" won't geocode).
 */
function AddressCard({ venue }: { venue: Venue }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const googleMapsUrl = getGoogleMapsUrl(venue.address)
  const what3WordsUrl = getWhat3WordsUrl(venue.whatThreeWords)
  const parts = (venue.address || '').split(',').map((p) => p.trim()).filter(Boolean)
  const firstLine = parts[0] || ''
  const rest = parts.slice(1).join(', ')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(venue.address || '')
      setCopied('done')
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied('idle'), 2000)
  }

  return (
    <div className={`${cls.card} p-4 flex flex-col gap-3.5`}>
      {venue.address && (
        <div className="flex gap-3">
          <div className="w-9 h-9 flex-none rounded-[10px] bg-hf-track text-hf-body flex items-center justify-center">
            <MapPin size={18} strokeWidth={1.8} />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-[16px] font-semibold text-hf-ink">{firstLine}</div>
            {rest && <div className="text-[15px] text-hf-muted">{rest}</div>}
          </div>
        </div>
      )}

      {/* Load-in address (loading dock, stage door…) sits alongside the postal
          address, never instead of it. */}
      {venue.loadInAddress && (
        <p className="text-[15px] text-hf-body">
          <span className="font-semibold">Load-in:</span> {venue.loadInAddress}{' '}
          <a
            href={getGoogleMapsUrl(venue.loadInAddress) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className={`${cls.link} whitespace-nowrap`}
          >
            (map)
          </a>
        </p>
      )}

      {venue.whatThreeWords && (
        <p className="text-[14px] text-hf-muted font-mono">///{venue.whatThreeWords}</p>
      )}

      {(googleMapsUrl || venue.address) && (
        <div className="grid grid-cols-2 gap-2.5">
          {googleMapsUrl ? (
            <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer"
              className="h-12 rounded-xl border-[1.5px] border-hf-control flex items-center justify-center gap-2 text-[15px] font-semibold text-hf-ink hover:bg-hf-inset">
              <Navigation size={18} strokeWidth={1.8} />Directions
            </a>
          ) : <span />}
          {venue.address ? (
            <button type="button" onClick={copy}
              className="h-12 rounded-xl border-[1.5px] border-hf-control flex items-center justify-center gap-2 text-[15px] font-semibold text-hf-ink hover:bg-hf-inset">
              {copied === 'done' ? <Check size={18} strokeWidth={2} /> : <Copy size={18} strokeWidth={1.8} />}
              {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
          ) : <span />}
        </div>
      )}

      {what3WordsUrl && (
        <a href={what3WordsUrl} target="_blank" rel="noopener noreferrer"
          className="h-11 rounded-xl border-[1.5px] border-hf-control flex items-center justify-center gap-2 text-[15px] font-semibold text-hf-ink hover:bg-hf-inset">
          <span className="font-bold text-hf-error">///</span>What3Words
        </a>
      )}
    </div>
  )
}

/** Green round call button (design: 44×44, green tint). */
function CallButton({ phone, label }: { phone: string; label?: string }) {
  return (
    <a href={`tel:${phone.replace(/\s+/g, '')}`} aria-label={label ? `Call ${label}` : `Call ${phone}`}
      className="w-11 h-11 flex-none rounded-full bg-hf-green-tint text-hf-green-text flex items-center justify-center hover:brightness-95">
      <Phone size={18} strokeWidth={1.8} />
    </a>
  )
}

/**
 * "Who to contact": the venue's own contacts (phone numbers only from 48 hours
 * before the job: `phoneHidden` / `phoneVisibleFrom` come from OP) and the
 * on-site contacts staff picked for this leg (quote_contacts, OP migration 223).
 * Numbers are tel: links: this page is read on a phone at a loading bay, and
 * making someone copy a number out by hand is the reason drivers ring the office.
 */
function ContactsCard({ venue, contacts }: { venue: Venue | null; contacts?: Job['contacts'] }) {
  type Row = { key: string; name: string; sub?: string | null; phone?: string | null; email?: string | null; hiddenNote?: string | null }
  const rows: Row[] = []

  if (venue && (venue.contact1 || venue.contact2 || venue.phone || venue.phone2 || venue.email)) {
    const hidden = venue.phoneHidden
      ? `Phone available from ${venue.phoneVisibleFrom || 'closer to the day'}`
      : null
    if (venue.contact1) rows.push({ key: 'v1', name: venue.contact1, sub: hidden ? null : venue.phone, phone: hidden ? null : venue.phone, hiddenNote: hidden })
    if (venue.contact2) rows.push({ key: 'v2', name: venue.contact2, sub: hidden ? null : venue.phone2, phone: hidden ? null : venue.phone2, hiddenNote: hidden })
    // Numbers with no named contact: show them as the venue's own line.
    if (!venue.contact1 && (venue.phone || hidden)) {
      rows.push({ key: 'vp', name: venue.name || 'Venue', sub: hidden ? null : venue.phone, phone: hidden ? null : venue.phone, hiddenNote: hidden })
    }
    if (!venue.contact2 && venue.phone2 && !hidden && venue.contact1) {
      rows.push({ key: 'vp2', name: venue.name || 'Venue', sub: venue.phone2, phone: venue.phone2 })
    }
    if (venue.email) rows.push({ key: 've', name: rows.length ? 'Venue email' : (venue.name || 'Venue'), email: venue.email })
  }

  ;(contacts || []).forEach((c, i) => {
    rows.push({ key: `c${i}`, name: c.name, sub: c.label || c.phone || null, phone: c.phone, email: c.email })
  })

  if (rows.length === 0) return null

  return (
    <div className={`${cls.card} flex flex-col`}>
      <div className={`px-4 pt-3.5 pb-1 ${cls.kindLabel} text-hf-muted`}>Who to contact</div>
      {rows.map((r, i) => (
        <div key={r.key}>
          {i > 0 && <div className="h-px bg-hf-divider mx-4" />}
          <div className={`px-4 py-2.5 ${i === rows.length - 1 ? 'pb-3.5' : ''} flex items-center gap-3`}>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <div className="text-[16px] font-semibold text-hf-ink">{r.name}</div>
              {r.sub && <div className="text-[14px] text-hf-muted">{r.sub}</div>}
              {r.hiddenNote && <div className="text-[14px] text-hf-muted italic">{r.hiddenNote}</div>}
              {r.email && (
                <a href={`mailto:${r.email}`} className={`${cls.link} text-[14px] break-all inline-flex items-center gap-1`}>
                  <Mail size={14} strokeWidth={1.8} />{r.email}
                </a>
              )}
            </div>
            {r.phone && <CallButton phone={r.phone} label={r.name} />}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Sticky bottom action (design 1c): page-coloured fade, 56px button. */
function StickyAction({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 safe-bottom"
      style={{ background: 'linear-gradient(to top, #f6f4f2 70%, rgba(246,244,242,0))' }}
    >
      <div className="max-w-lg mx-auto px-4 pt-3.5 pb-8">{children}</div>
    </div>
  )
}

// =============================================================================
// EQUIPMENT LIST (read-only, no tickboxes) — an expandable row
// =============================================================================

interface EquipmentListProps {
  hhRef: string
  /** The OP job this list is shown on: the kit-list route checks it is the freelancer's. */
  quoteId: string
  whatIsIt?: 'equipment' | 'vehicle' | 'people'
  isReference?: boolean             // If true, label as "Equipment reference" instead of "Equipment list"
  /** Extra rows in the same card, under a divider (the D&C page's "Your fee"). */
  children?: ReactNode
}

function EquipmentList({ hhRef, quoteId, whatIsIt, isReference = false, children }: EquipmentListProps) {
  const [items, setItems] = useState<EquipmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const title = isReference ? 'Equipment reference' : 'Equipment list'

  useEffect(() => {
    async function fetchItems() {
      try {
        // Determine filter based on job type
        const filterMode = getFilterMode(whatIsIt)
        const response = await fetch(`/api/hirehop/items/${encodeURIComponent(hhRef)}?job=${encodeURIComponent(quoteId)}&filter=${filterMode}`)
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch equipment list')
        }

        setItems(data.items || [])
      } catch (err) {
        console.error('Error fetching equipment:', err)
        setError(err instanceof Error ? err.message : 'Failed to load equipment')
      } finally {
        setLoading(false)
      }
    }

    if (hhRef) {
      fetchItems()
    } else {
      setLoading(false)
      setError('No HireHop reference available')
    }
  }, [hhRef, quoteId, whatIsIt])

  const summary = loading ? 'Loading...'
    : error ? "Couldn't load"
    : items.length === 0 ? 'None'
    : `${items.length} item${items.length !== 1 ? 's' : ''}`
  const canExpand = !loading && (items.length > 0 || !!error)

  return (
    <div className={`${cls.card} flex flex-col overflow-hidden`}>
      <button
        type="button"
        onClick={() => canExpand && setExpanded(!expanded)}
        disabled={!canExpand}
        aria-expanded={expanded}
        className="h-[54px] px-4 flex items-center justify-between gap-3 text-left hover:bg-hf-inset/60 disabled:hover:bg-transparent"
      >
        <span className="text-[16px] font-semibold text-hf-ink">{title}</span>
        <span className="flex items-center gap-1.5 text-[15px] text-hf-muted">
          {summary}
          {canExpand && (
            <ChevronDown size={18} strokeWidth={2} className={`text-hf-chevron transition-transform ${expanded ? 'rotate-180' : '-rotate-90'}`} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-3">
          {/* Filter indicator */}
          {whatIsIt === 'equipment' && !isReference && (
            <p className="text-[13px] text-hf-muted mb-1">Showing equipment only (vehicles filtered out)</p>
          )}
          {isReference && (
            <p className="text-[13px] text-hf-muted mb-1">For reference: equipment on this HireHop job</p>
          )}
          {error ? (
            <Banner tone="error">{error}</Banner>
          ) : (
            <div className="flex flex-col">
              {items.map((item, index) => (
                <div key={item.id || index} className="flex items-center justify-between gap-3 py-2.5 border-b border-hf-divider last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] text-hf-ink">{item.name}</p>
                    {item.category && <p className="text-[13px] text-hf-muted">{item.category}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular text-[15px] text-hf-muted">×{item.quantity}</span>
                    {item.isVirtual && (
                      <span className="text-[12px] text-hf-muted" title="Virtual item">(V)</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {children && (
        <>
          <div className="h-px bg-hf-divider mx-4" />
          {children}
        </>
      )}
    </div>
  )
}

/** "Your fee" row (design: 54px, fee in ink, tabular). */
function FeeRow({ fee, sub }: { fee: number; sub?: string }) {
  return (
    <div className="min-h-[54px] px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-[16px] font-semibold text-hf-ink">Your fee</span>
        {sub && <span className="text-[14px] text-hf-muted">{sub}</span>}
      </div>
      <span className="tabular text-[16px] font-semibold text-hf-ink">£{fee.toFixed(0)}</span>
    </div>
  )
}

// =============================================================================
// NOTIFICATION MUTE TOGGLE COMPONENT
// =============================================================================

function NotificationMuteToggle({ jobId }: { jobId: string }) {
  const [isMuted, setIsMuted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Fetch current mute status
  useEffect(() => {
    async function checkMuteStatus() {
      try {
        const res = await fetch('/api/settings/notifications')
        const data = await res.json()
        if (data.success && data.notifications) {
          setIsMuted(data.notifications.mutedJobIds?.includes(jobId) || false)
        }
      } catch (err) {
        console.error('Failed to check mute status:', err)
      } finally {
        setLoading(false)
      }
    }
    checkMuteStatus()
  }, [jobId])

  const toggleMute = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isMuted ? 'unmute_job' : 'mute_job',
          jobId,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setIsMuted(!isMuted)
      }
    } catch (err) {
      console.error('Failed to toggle mute:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return null // Don't show anything while loading
  }

  const on = !isMuted
  return (
    <div className={`${cls.card} px-4 py-3.5 flex items-center gap-3`}>
      <IconTile kind="neutral">{on ? <Bell {...ICON} /> : <BellOff {...ICON} />}</IconTile>
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-semibold text-hf-ink">Emails about this job</div>
        <div className="text-[14px] text-hf-muted">
          {on ? 'Turn off to stop email updates about this job' : 'Off for this job'}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? 'Turn off emails about this job' : 'Turn on emails about this job'}
        onClick={toggleMute}
        disabled={saving}
        className={`relative w-[51px] h-[31px] flex-none rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-hf-green' : 'bg-hf-toggle-off'}`}
      >
        <span className={`absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

// =============================================================================
// VENUE FILES COMPONENT
// =============================================================================

function VenueFiles({ files, title = 'Venue files' }: { files: VenueFile[]; title?: string }) {
  if (!files || files.length === 0) return null

  const handleFileClick = (file: VenueFile) => {
    if (file.url) {
      window.open(file.url, '_blank')
    } else {
      alert('Unable to load this file.')
    }
  }

  // Pick a file icon based on file name
  const getFileIcon = (name: string, fileType?: string): LucideIcon => {
    if (fileType === 'GOOGLE_DRIVE') return FileText
    const lower = name.toLowerCase()
    if (lower.endsWith('.pdf')) return FileText
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')) return ImageIcon
    if (lower.endsWith('.doc') || lower.endsWith('.docx')) return FileText
    return Paperclip
  }

  return (
    <div className={`${cls.card} flex flex-col`}>
      <div className={`px-4 pt-3.5 pb-1 ${cls.kindLabel} text-hf-muted`}>
        {title} · {files.length}
      </div>
      {files.map((file, index) => {
        const Icon = getFileIcon(file.name, file.fileType)
        return (
          <div key={file.assetId || index}>
            {index > 0 && <div className="h-px bg-hf-divider mx-4" />}
            <button
              type="button"
              onClick={() => handleFileClick(file)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-hf-inset/60"
            >
              <Icon size={20} strokeWidth={1.8} className="text-hf-link flex-none" />
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-hf-link truncate">{file.name}</p>
                {file.fileType && file.fileType !== 'ASSET' && (
                  <p className="text-[13px] text-hf-muted">{file.fileType === 'GOOGLE_DRIVE' ? 'Google Drive' : file.fileType}</p>
                )}
              </div>
              <ExternalLink size={16} strokeWidth={1.8} className="text-hf-chevron flex-none" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// =============================================================================
// CREW JOB DETAIL VIEW
// =============================================================================

/** "Add to Calendar": hand the phone an .ics for this job. */
function addJobToCalendar(job: Job, venue: Venue | null, isCrew: boolean) {
  const place = venue?.name || job.destination || job.venueName || ''
  const kind = isCrew
    ? 'Crew'
    : job.type === 'delivery' ? 'Delivery' : 'Collection'
  const ok = job.date && downloadIcs({
    uid: `job-${job.id}`,
    title: place ? `Ooosh ${kind}: ${place}` : `Ooosh ${kind}`,
    date: job.date,
    time: job.time || null,
    durationHours: isCrew ? job.workDurationHours || null : 1,
    endDate: isCrew ? job.finishDate || null : null,
    location: venue?.address || place || null,
    description: [
      job.hhRef ? `HireHop job ${job.hhRef}` : null,
      `Details: https://freelancer.oooshtours.co.uk/job/${job.id}`,
    ].filter(Boolean).join('\n'),
  }, `ooosh-${job.hhRef || job.id}.ics`)
  if (!ok) alert('This job has no date yet, so it can\'t go in your calendar.')
}

function CalendarButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${cls.btnSecondary} w-full`}>
      <CalendarPlus size={18} strokeWidth={1.8} />Add to Calendar
    </button>
  )
}

function CompletedBanner({ date }: { date: string }) {
  return (
    <Banner tone="success" className="flex items-center justify-center gap-2 font-semibold">
      <Check size={18} strokeWidth={2.4} />Completed on {formatDate(date)}
    </Banner>
  )
}

/** One "Expenses & Per Diem" line: what to do about it, coloured by who pays. */
function MoneyLine({ line }: { line: { label: string; message: string; tone: 'ooosh' | 'client' | 'claim' | 'none' } }) {
  const tone = line.tone === 'claim' ? 'text-hf-amber-text'
    : line.tone === 'ooosh' ? 'text-hf-green-text'
    : line.tone === 'client' ? 'text-hf-body' : 'text-hf-muted'
  const Icon = line.tone === 'claim' ? Receipt : line.tone === 'ooosh' ? PoundSterling
    : line.tone === 'client' ? User : Minus
  return (
    <li className="flex items-start gap-2.5 text-[15px] leading-[1.4]">
      <Icon size={16} strokeWidth={1.8} className={`mt-[3px] flex-none ${tone}`} />
      <span><span className="font-semibold text-hf-ink">{line.label}:</span>{' '}
        <span className={tone}>{line.message}</span></span>
    </li>
  )
}

function CrewJobDetail({ job, venue }: { job: Job; venue: Venue | null }) {
  const displayWorkType = getDisplayWorkType(job.workType, job.workDescription)
  const displayJobType = translateJobType(job.jobType)
  const duration = formatDuration(job.workDurationHours, job.numberOfDays)

  // Multi-day date display
  const isMultiDay = job.finishDate && job.finishDate !== job.date
  const dateDisplay = isMultiDay
    ? `${dayLabel(job.date)} – ${shortDay(job.finishDate)}`
    : dayLabel(job.date)
  const time = formatTime(job.time)

  // Fee — crew jobs use freelancerFee directly
  const fee = job.freelancerFee || job.driverPay
  const hasMoney = (fee && fee > 0) || job.expenseBreakdown || job.crewMoney

  return (
    <>
      <JobHeading
        kind="crew"
        label={`Crew · ${titleCase(displayWorkType)}`}
        hhRef={job.hhRef}
        title={venue?.name || job.destination || job.venueName || job.name}
        dateLine={[dateDisplay, time ? `arrive by ${time}` : ''].filter(Boolean).join(' · ')}
        chips={<>
          <StatusChip status={job.status} />
          {displayJobType && <Chip tone="neutral"><Users size={12} strokeWidth={2.2} />{displayJobType}</Chip>}
          {duration && <Chip tone="neutral"><Timer size={12} strokeWidth={2.2} />{duration}</Chip>}
        </>}
      />

      {/* Key Notes — the quote's freelancer_notes from OP. The D&C layout has
          always rendered this card; the crew layout never did, so notes staff
          wrote for crewed jobs were invisible to the freelancer (Jul 2026). */}
      {job.keyNotes && <NoteCard title="Key notes" text={job.keyNotes} />}

      {/* Work Description — always shown, with fallback if empty */}
      <TextCard title="Work details">
        {job.workDescription ? (
          <p className="text-[15px] leading-[1.45] text-hf-body whitespace-pre-wrap">{job.workDescription}</p>
        ) : (
          <p className="text-[15px] leading-[1.45] text-hf-muted italic">No additional details in the system yet. Please contact Ooosh if you need more information.</p>
        )}
      </TextCard>

      {/* Location */}
      {venue && (venue.address || venue.loadInAddress || venue.whatThreeWords) && (
        <AddressCard venue={venue} />
      )}

      {/* Contacts — the venue's own and the on-site ones staff picked for this
          leg (quote_contacts, OP migration 223). These used to be typed by hand
          into Key Notes, which is why that card still renders: nothing
          backfills older jobs. */}
      <ContactsCard venue={venue} contacts={job.contacts} />

      {/* Fee & Expenses — combined section */}
      {hasMoney ? (
        <div className={`${cls.card} flex flex-col`}>
          {fee && fee > 0 ? <FeeRow fee={fee} /> : null}

          {/* Your money on this job — plain-English pay/reimburse breakdown */}
          {job.crewMoney ? (
            <div className={`px-4 pb-4 ${fee && fee > 0 ? 'pt-1' : 'pt-4'}`}>
              {fee && fee > 0 ? <div className="h-px bg-hf-divider mb-3" /> : null}
              <p className={`${cls.kindLabel} text-hf-muted mb-2.5`}>Expenses &amp; Per Diem: what to do</p>
              <ul className="flex flex-col gap-2">
                {[job.crewMoney.perDiem, ...job.crewMoney.expenses].map((line, i) => (
                  <MoneyLine key={i} line={line} />
                ))}
              </ul>
            </div>
          ) : (
            <>
              {job.expensesIncluded !== undefined && job.expensesIncluded > 0 && (
                <>
                  <div className="h-px bg-hf-divider mx-4" />
                  <div className="min-h-[50px] px-4 py-2 flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-[15px] text-hf-body"><Check size={16} strokeWidth={2} className="text-hf-green-text" />Expenses included in fee</span>
                    <span className="tabular text-[16px] font-semibold text-hf-ink">£{job.expensesIncluded.toFixed(0)}</span>
                  </div>
                </>
              )}
              {job.expensesNotIncluded !== undefined && job.expensesNotIncluded > 0 && (
                <>
                  <div className="h-px bg-hf-divider mx-4" />
                  <div className="min-h-[50px] px-4 py-2 flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-[15px] text-hf-body"><Plus size={16} strokeWidth={2} className="text-hf-amber-text" />Additional expenses (on top)</span>
                    <span className="tabular text-[16px] font-semibold text-hf-ink">£{job.expensesNotIncluded.toFixed(0)}</span>
                  </div>
                </>
              )}
            </>
          )}

          {/* Expense breakdown detail */}
          {job.expenseBreakdown && (
            <div className="px-4 pb-4">
              <div className="bg-hf-amber-bg border border-hf-amber-border rounded-xl p-3">
                <p className="text-[15px] text-hf-body whitespace-pre-wrap">{job.expenseBreakdown}</p>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Venue Files — shared from the venue board */}
      {venue?.files && venue.files.length > 0 && (
        <VenueFiles files={venue.files} />
      )}

      {/* Job Files — tagged "share_with_freelancer" on the job in OP */}
      {job.files && job.files.length > 0 && (
        <VenueFiles files={job.files} title="Job files" />
      )}

      {/* Equipment Reference — same HireHop integration, labelled as reference */}
      {job.hhRef && (
        <EquipmentList hhRef={job.hhRef} quoteId={job.id} isReference={true} />
      )}

      {/* Access Info */}
      {venue?.accessNotes && <NoteCard title="Access info" text={venue.accessNotes} tone="plain" />}

      {/* Stage Notes */}
      {venue?.stageNotes && venue.stageNotes !== venue.accessNotes && (
        <NoteCard title="Stage notes" text={venue.stageNotes} tone="plain" />
      )}

      {/* Notification Toggle */}
      <NotificationMuteToggle jobId={job.id} />

      {/* Action Buttons — no "Start" for crew jobs; Complete from the last day
          (Oct 2026: crew complete in the portal, chased the day after). */}
      <div className="flex flex-col gap-2.5 pt-1">
        <CalendarButton onClick={() => addJobToCalendar(job, venue, true)} />

        {job.completedAtDate ? (
          <CompletedBanner date={job.completedAtDate} />
        ) : job.completeFrom && ukToday() >= job.completeFrom ? (
          <Link href={`/job/${job.id}/complete`} className={`${cls.btnGreen} w-full`}>
            <Check size={20} strokeWidth={2.4} />Complete job
          </Link>
        ) : job.completeFrom ? (
          <p className="text-center text-[15px] text-hf-muted px-2">
            You can mark this job complete from {shortDay(job.completeFrom)}, its last day.
          </p>
        ) : null}
      </div>
    </>
  )
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function JobDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobId = params.id as string
  const runGroup = searchParams.get('run')
  const boardType = searchParams.get('board') || 'dc'   // 'dc' or 'crew'

  const [job, setJob] = useState<Job | null>(null)
  const [venue, setVenue] = useState<Venue | null>(null)
  // The job's own board from OP ('crew' | 'dc'); the ?board= param only covers
  // the moment before it arrives.
  const [apiBoardType, setApiBoardType] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Multi-drop run state (D&C only)
  const [runJobs, setRunJobs] = useState<Job[]>([])
  const [runVenues, setRunVenues] = useState<Map<string, Venue>>(new Map())
  const [expandedStops, setExpandedStops] = useState<Set<string>>(new Set())
  const [loadingRun, setLoadingRun] = useState(false)
  // Combined fee for the run (from OP). When set, overrides the sum
  // of individual driverPay values — the single contractually-agreed
  // fee for the whole run.
  const [runCombinedFee, setRunCombinedFee] = useState<number | null>(null)
  const [runStandaloneFee, setRunStandaloneFee] = useState<number>(0)
  const [runNotes, setRunNotes] = useState<string | null>(null)

  // Fetch primary job — pass board type to API
  useEffect(() => {
    async function fetchJob() {
      try {
        // Build API URL with board type parameter
        const apiUrl = boardType === 'crew'
          ? `/api/jobs/${jobId}?board=crew`
          : `/api/jobs/${jobId}`

        const response = await fetch(apiUrl)
        const data: JobApiResponse = await response.json()

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        setJob(data.job || null)
        setVenue(data.venue || null)
        setApiBoardType(data.boardType || null)

        // If this is a grouped run (D&C only), fetch all jobs in the run
        if (runGroup && data.job?.date && (data.boardType || boardType) !== 'crew') {
          fetchRunJobs(runGroup, data.job.date)
        }
      } catch (err) {
        console.error('Error fetching job:', err)
        setError(err instanceof Error ? err.message : 'Failed to load job')
      } finally {
        setLoading(false)
      }
    }

    if (jobId) {
      fetchJob()
    }
  }, [jobId, router, runGroup, boardType])

  // Fetch all jobs in a run group (D&C only)
  const fetchRunJobs = async (group: string, date: string) => {
    setLoadingRun(true)
    try {
      const res = await fetch(`/api/jobs/run?group=${group}&date=${date}`)
      const data = await res.json()

      if (data.success && data.jobs) {
        setRunJobs(data.jobs)
        // Expand first stop by default
        if (data.jobs.length > 0) {
          setExpandedStops(new Set([data.jobs[0].id]))
        }
        // Fetch venues for all jobs
        if (data.venues) {
          setRunVenues(new Map(Object.entries(data.venues)))
        }
        // Capture combined-fee fields (OP mode only; Monday path omits these).
        setRunCombinedFee(data.hasCombinedFee ? Number(data.totalFee) : null)
        setRunStandaloneFee(Number(data.standaloneTotalFee ?? data.totalFee ?? 0))
        setRunNotes(data.runNotes ?? null)
      }
    } catch (err) {
      console.error('Error fetching run jobs:', err)
    } finally {
      setLoadingRun(false)
    }
  }

  const toggleStopExpanded = (stopId: string) => {
    setExpandedStops(prev => {
      const newSet = new Set(prev)
      if (newSet.has(stopId)) {
        newSet.delete(stopId)
      } else {
        newSet.add(stopId)
      }
      return newSet
    })
  }

  if (loading) {
    return <PageSpinner label="Loading job details..." />
  }

  if (error) {
    return (
      <div className="min-h-screen bg-hf-page p-4">
        <div className="max-w-lg mx-auto mt-16">
          <div className={`${cls.card} p-6 text-center`}>
            <AlertTriangle size={40} strokeWidth={1.8} className="mx-auto mb-3 text-hf-error" />
            <h1 className="text-[20px] font-bold text-hf-ink mb-2">Something went wrong</h1>
            <p className="text-[15px] text-hf-body mb-6">{error}</p>
            <Link href="/dashboard" className={`${cls.btnPrimary} w-full`}>Back to jobs</Link>
          </div>
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-hf-page p-4">
        <div className="max-w-lg mx-auto mt-16">
          <div className={`${cls.card} p-6 text-center`}>
            <Search size={40} strokeWidth={1.8} className="mx-auto mb-3 text-hf-muted" />
            <h1 className="text-[20px] font-bold text-hf-ink mb-2">Job not found</h1>
            <p className="text-[15px] text-hf-body mb-6">This job doesn&apos;t exist or isn&apos;t assigned to you.</p>
            <Link href="/dashboard" className={`${cls.btnPrimary} w-full`}>Back to jobs</Link>
          </div>
        </div>
      </div>
    )
  }

  // ── Crew Job View ──────────────────────────────────────────────────────────
  const isCrewJob = (apiBoardType || boardType) === 'crew'

  // D&C job variables (only used for D&C rendering)
  const isDelivery = job.type === 'delivery'
  const dc = describeDcJob(job)
  const isMultiStop = runGroup && runJobs.length > 1
  // Start sits at the bottom of a single D&C job that isn't done yet (as before).
  const showStart = !isCrewJob && !isMultiStop && !job.completedAtDate

  // A run's kind: backline unless every stop is a van (as on the job cards).
  const runAllVan = runJobs.length > 0 && runJobs.every((j) => j.whatIsIt === 'vehicle')
  const runAllBackline = runJobs.length > 0 && runJobs.every((j) => j.whatIsIt === 'equipment')
  const runKind: Kind = runAllVan ? 'van' : 'backline'
  const runWord = runAllVan ? 'Van run' : runAllBackline ? 'Backline run' : 'Run'

  return (
    <div className={`min-h-screen bg-hf-page safe-top ${showStart ? 'pb-36' : 'pb-10'}`}>
      <header className="max-w-lg mx-auto px-2 pt-2 flex items-center justify-between">
        <div className="px-2.5">
          <BackLink href="/dashboard" label="Jobs" />
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-11 h-11 mr-1 flex items-center justify-center text-hf-body rounded-xl hover:bg-hf-track"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={20} strokeWidth={1.8} />
        </button>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-1 flex flex-col gap-3.5">

        {/* ── CREW JOB DETAIL ── */}
        {isCrewJob && (
          <CrewJobDetail job={job} venue={venue} />
        )}

        {/* ── D&C JOB DETAIL ── */}
        {!isCrewJob && (
          <>
            {/* Multi-stop header */}
            {isMultiStop && (
              <JobHeading
                kind={runKind}
                label={`${runWord} · ${runJobs.length} stops`}
                title="Multi-drop run"
                dateLine={dayLabel(job.date)}
              />
            )}

            {/* Single job or first stop header */}
            {!isMultiStop && (
              <>
                <JobHeading
                  kind={dc.kind}
                  label={dc.label}
                  hhRef={job.hhRef}
                  title={venue?.name || job.venueName || job.name}
                  dateLine={[dayLabel(job.date), formatTime(job.time) || 'time TBC'].join(' · ')}
                  chips={<StatusChip status={job.status} />}
                />

                {/* Key Notes */}
                {job.keyNotes && <NoteCard title="Key notes" text={job.keyNotes} />}

                {/* Location */}
                {venue && (venue.address || venue.loadInAddress || venue.whatThreeWords) && (
                  <AddressCard venue={venue} />
                )}

                {/* Contacts — the venue's own (phone from 48 hours before) and the
                    on-site contacts staff picked for this leg. */}
                <ContactsCard venue={venue} contacts={job.contacts} />

                {/* Equipment List (read-only, filtered by job type) + the fee */}
                {job.hhRef ? (
                  <EquipmentList hhRef={job.hhRef} quoteId={job.id} whatIsIt={job.whatIsIt}>
                    {job.driverPay && job.driverPay > 0 ? <FeeRow fee={job.driverPay} sub="Plus expenses" /> : null}
                  </EquipmentList>
                ) : job.driverPay && job.driverPay > 0 ? (
                  <div className={cls.card}><FeeRow fee={job.driverPay} sub="Plus expenses" /></div>
                ) : null}

                {/* Venue Files — shared from the venue board */}
                {venue?.files && venue.files.length > 0 && (
                  <VenueFiles files={venue.files} />
                )}

                {/* Job Files — tagged "share_with_freelancer" on the job in OP */}
                {job.files && job.files.length > 0 && (
                  <VenueFiles files={job.files} title="Job files" />
                )}

                {/* Access Info */}
                {venue?.accessNotes && <NoteCard title="Access info" text={venue.accessNotes} tone="plain" />}

                {/* Stage Notes */}
                {venue?.stageNotes && venue.stageNotes !== venue.accessNotes && (
                  <NoteCard title="Stage notes" text={venue.stageNotes} tone="plain" />
                )}

                {/* Notification Toggle */}
                <NotificationMuteToggle jobId={job.id} />

                {/* Action Buttons */}
                <div className="flex flex-col gap-2.5 pt-1">
                  <CalendarButton onClick={() => addJobToCalendar(job, venue, false)} />
                  {job.completedAtDate && <CompletedBanner date={job.completedAtDate} />}
                </div>
              </>
            )}

            {/* Multi-stop accordion view */}
            {isMultiStop && !loadingRun && (
              <div className="flex flex-col gap-2.5">
                {runJobs.map((stopJob, index) => {
                  const stopVenue = runVenues.get(stopJob.venueId || '') || null
                  const isExpanded = expandedStops.has(stopJob.id)
                  const stopStatus = translateStatus(stopJob.status)
                  const stopMaps = getGoogleMapsUrl(stopVenue?.address)

                  return (
                    <div key={stopJob.id} className={`${cls.card} overflow-hidden`}>
                      {/* Stop header - always visible */}
                      <button
                        type="button"
                        onClick={() => toggleStopExpanded(stopJob.id)}
                        aria-expanded={isExpanded}
                        className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-hf-inset/60 transition-colors"
                      >
                        <div className="w-9 h-9 flex-none rounded-full bg-hf-tint text-hf-tint-text flex items-center justify-center font-bold text-[15px] tabular">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[16px] font-semibold text-hf-ink truncate">
                            {stopVenue?.name || stopJob.venueName || stopJob.name}
                          </p>
                          <p className="text-[14px] text-hf-muted">
                            {formatTime(stopJob.time) || 'TBC'} · {stopJob.type === 'delivery' ? 'Delivery' : 'Collection'}
                          </p>
                        </div>
                        <Chip tone={stopStatus.tone}>
                          {stopStatus.Icon ? <stopStatus.Icon size={12} strokeWidth={2.6} /> : stopStatus.label}
                        </Chip>
                        <ChevronDown size={18} strokeWidth={2} className={`text-hf-chevron flex-none transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 border-t border-hf-divider">
                          <div className="pt-3.5 flex flex-col gap-3.5">
                            {/* Location */}
                            {stopVenue?.address && (
                              <div>
                                <p className={`${cls.kindLabel} text-hf-muted mb-1 flex items-center gap-1`}><MapPin size={13} strokeWidth={2} />Location</p>
                                <p className="text-[15px] text-hf-body">{stopVenue.address}</p>
                                {stopVenue.whatThreeWords && (
                                  <p className="text-[14px] text-hf-muted font-mono mt-1">
                                    ///{stopVenue.whatThreeWords}
                                  </p>
                                )}
                                {stopMaps && (
                                  <a href={stopMaps} target="_blank" rel="noopener noreferrer"
                                    className={`${cls.link} mt-2 inline-flex items-center gap-1.5 text-[15px]`}>
                                    <Navigation size={16} strokeWidth={1.8} />Directions
                                  </a>
                                )}
                              </div>
                            )}

                            {/* Contact */}
                            {(stopVenue?.contact1 || stopVenue?.phone) && (
                              <div className="flex items-center gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className={`${cls.kindLabel} text-hf-muted mb-1`}>Contact</p>
                                  {stopVenue.contact1 && <p className="text-[15px] font-semibold text-hf-ink">{stopVenue.contact1}</p>}
                                  {stopVenue.phone && <p className="text-[14px] text-hf-muted">{stopVenue.phone}</p>}
                                </div>
                                {stopVenue.phone && <CallButton phone={stopVenue.phone} label={stopVenue.contact1 || stopVenue.name} />}
                              </div>
                            )}

                            {/* Access Notes */}
                            {stopVenue?.accessNotes && (
                              <div>
                                <p className={`${cls.kindLabel} text-hf-muted mb-1`}>Access</p>
                                <p className="text-[15px] text-hf-body whitespace-pre-wrap">{stopVenue.accessNotes}</p>
                              </div>
                            )}

                            {/* Key Notes */}
                            {stopJob.keyNotes && (
                              <div className="bg-hf-amber-bg border border-hf-amber-border rounded-xl px-3 py-2.5">
                                <p className={`${cls.kindLabel} text-hf-amber-text mb-1`}>Notes</p>
                                <p className="text-[15px] text-hf-body whitespace-pre-wrap">{stopJob.keyNotes}</p>
                              </div>
                            )}

                            {/* View full details link */}
                            <Link
                              href={`/job/${stopJob.id}`}
                              className={`${cls.link} inline-flex items-center gap-1 text-[15px]`}
                            >
                              View full details
                              <ChevronDown size={16} strokeWidth={2.2} className="-rotate-90" />
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Total fee for run. Prefer combined fee when set —
                    that's the single contractual fee for the whole run;
                    the per-stop driverPay sum is shown struck through as
                    a reference. */}
                {runJobs.length > 0 && (
                  <div className={`${cls.card} px-4 py-3.5 flex items-center justify-between gap-3`}>
                    <div className="min-w-0">
                      <span className="text-[16px] font-semibold text-hf-ink">Total agreed fee</span>
                      {runNotes && (
                        <p className="text-[14px] text-hf-muted mt-0.5">{runNotes}</p>
                      )}
                    </div>
                    {runCombinedFee != null ? (
                      <div className="text-right">
                        <div className="tabular text-[16px] font-semibold text-hf-ink">£{runCombinedFee.toFixed(0)}</div>
                        <div className="tabular text-[13px] text-hf-muted line-through">£{runStandaloneFee.toFixed(0)}</div>
                        <div className="text-[12px] font-semibold text-hf-link">combined run fee</div>
                      </div>
                    ) : (
                      <span className="tabular text-[16px] font-semibold text-hf-ink">
                        £{runJobs.reduce((sum, j) => sum + (j.driverPay || 0), 0).toFixed(0)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {loadingRun && (
              <div className="text-center py-8">
                <div className="w-10 h-10 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-[15px] text-hf-muted">Loading run details...</p>
              </div>
            )}
          </>
        )}

      </main>

      {/* Start — sticky at the bottom of a D&C job that isn't done (design 1c). */}
      {showStart && (
        <StickyAction>
          <Link
            href={`/job/${job.id}/start`}
            className={`${cls.btnPrimary} w-full !h-14 shadow-[0_8px_20px_-8px_rgba(167,83,144,0.6)]`}
          >
            <Play size={18} fill="currentColor" strokeWidth={0} />Start {isDelivery ? 'delivery' : 'collection'}
          </Link>
        </StickyAction>
      )}
    </div>
  )
}

