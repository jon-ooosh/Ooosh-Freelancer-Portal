'use client'

/**
 * Resources Page (Oct 2026 refresh, design 2g)
 *
 * Company documents and guides for freelancers, sourced from the Operations
 * Platform (staff documents flagged shareable_with_freelancers). File-backed
 * docs open via a presigned url; markdown docs open in an in-portal reader.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BookOpen, ArrowUpRight } from 'lucide-react'
import BottomNav from '@/components/BottomNav'
import { cls, IconTile, Chevron, SectionLabel, Banner, ICON } from '@/components/ui'

// =============================================================================
// TYPES
// =============================================================================

interface Resource {
  id: string
  title: string
  category: string
  kind: 'file' | 'markdown'
  fileName: string | null
  fileType: string | null
  url: string | null
}

interface ResourcesApiResponse {
  success: boolean
  resources?: Resource[]
  totalCount?: number
  error?: string
}

// =============================================================================
// HELPERS
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  policy: 'Policy',
  training: 'Training',
  other: 'Guide',
  agreement: 'Agreement',
  official_doc: 'Official',
  contract: 'Contract',
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || 'Document'
}

/** Guides first, then the paperwork (design 2g). */
const GUIDE_CATEGORIES = new Set(['training', 'other'])

/** The short file-type label on a document's tile ("PDF", "DOC"). */
function fileBadge(r: Resource): string {
  const t = (r.fileType || '').toLowerCase()
  if (t === 'docx') return 'DOC'
  if (t === 'xlsx') return 'XLS'
  if (t === 'pptx') return 'PPT'
  if (t === 'jpeg') return 'JPG'
  return (t || 'FILE').toUpperCase().slice(0, 4)
}

// =============================================================================
// COMPONENTS
// =============================================================================

function ResourceRow({ resource, onOpen }: { resource: Resource; onOpen: (r: Resource) => void }) {
  const unavailable = resource.kind === 'file' && !resource.url
  const isRead = resource.kind === 'markdown'
  return (
    <button
      type="button"
      onClick={() => !unavailable && onOpen(resource)}
      disabled={unavailable}
      className="w-full min-h-[64px] px-4 py-2.5 flex items-center gap-3 text-left hover:bg-hf-inset disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      {isRead ? (
        <IconTile kind="backline"><BookOpen {...ICON} /></IconTile>
      ) : (
        <div className="w-10 h-10 rounded-[11px] bg-hf-track text-hf-body flex-none flex items-center justify-center text-[11px] font-bold tracking-[0.04em]">
          {fileBadge(resource)}
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-[16px] font-semibold text-hf-ink">{resource.title}</span>
        <span className="text-[14px] text-hf-muted">
          {categoryLabel(resource.category)}
          {isRead && ' · read'}
          {unavailable && ' · temporarily unavailable'}
        </span>
      </div>
      {!unavailable && (isRead
        ? <Chevron />
        : <ArrowUpRight size={18} strokeWidth={2} className="text-hf-chevron flex-none" aria-label="Opens in a new tab" />)}
    </button>
  )
}

function Group({ label, items, onOpen }: { label: string; items: Resource[]; onOpen: (r: Resource) => void }) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>{label}</SectionLabel>
      <div className={`${cls.card} overflow-hidden flex flex-col`}>
        {items.map((r, i) => (
          <div key={r.id}>
            {i > 0 && <div className="h-px bg-hf-divider ml-[68px]" />}
            <ResourceRow resource={r} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </section>
  )
}

function LoadingSkeleton() {
  return (
    <div className={`${cls.card} p-4 animate-pulse flex flex-col gap-4`}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-10 h-10 bg-hf-track rounded-[11px]" />
          <div className="flex-1">
            <div className="h-4 bg-hf-track rounded w-2/3 mb-1.5" />
            <div className="h-3 bg-hf-track rounded w-1/4" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className={`${cls.card} p-8 text-center flex flex-col items-center gap-2`}>
      <IconTile kind="backline" size={44}><BookOpen {...ICON} /></IconTile>
      <h3 className="text-[17px] font-semibold text-hf-ink mt-1">Nothing here yet</h3>
      <p className="text-[15px] text-hf-muted">There are no guides or documents at the moment.</p>
    </div>
  )
}

// =============================================================================
// MAIN PAGE
// =============================================================================
export default function ResourcesPage() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resources, setResources] = useState<Resource[]>([])

  useEffect(() => {
    async function fetchResources() {
      try {
        const response = await fetch('/api/resources')
        const data: ResourcesApiResponse = await response.json()

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch resources')
        }

        setResources(data.resources || [])
      } catch (err) {
        console.error('Error fetching resources:', err)
        setError(err instanceof Error ? err.message : 'Failed to load resources')
      } finally {
        setLoading(false)
      }
    }

    fetchResources()
  }, [router])

  const handleOpen = (resource: Resource) => {
    if (resource.kind === 'markdown') {
      router.push(`/resources/${resource.id}`)
      return
    }
    if (resource.url) {
      window.open(resource.url, '_blank')
    }
  }

  const guides = resources.filter((r) => GUIDE_CATEGORIES.has(r.category))
  const papers = resources.filter((r) => !GUIDE_CATEGORIES.has(r.category))

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-6 pb-2 flex flex-col gap-0.5">
        <h1 className={cls.pageTitle}>Resources</h1>
        <p className="text-[16px] text-hf-muted">Guides &amp; documents</p>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-3 flex flex-col gap-5">
        {error && (
          <Banner tone="error">
            {error}{' '}
            <button type="button" onClick={() => window.location.reload()} className="underline font-semibold">Try again</button>
          </Banner>
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : resources.length === 0 ? (
          !error && <EmptyState />
        ) : (
          <>
            <Group label="Guides" items={guides} onOpen={handleOpen} />
            <Group label="Policies & agreements" items={papers} onOpen={handleOpen} />
          </>
        )}
      </main>

      <BottomNav active="resources" />
    </div>
  )
}
