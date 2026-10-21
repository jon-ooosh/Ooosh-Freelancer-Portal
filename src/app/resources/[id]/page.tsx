'use client'

/**
 * Resource Reader Page
 *
 * In-portal read-only reader for a markdown-backed staff document shared with
 * freelancers. File-backed docs never land here (the list opens their presigned
 * url directly); if one does, we redirect to its url.
 */

import { useEffect, useState, Fragment, type ReactNode } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { cls, BackLink, Banner } from '@/components/ui'

interface ResourceDetail {
  id: string
  title: string
  category: string
  kind: 'file' | 'markdown'
  body?: string
  url?: string | null
}

// =============================================================================
// MARKDOWN-LITE RENDERER
// Handles the subset staff documents use: headings, bold, bullet/numbered
// lists, links and paragraphs. Storage stays plain text — this only renders.
// =============================================================================

const INLINE_RE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_RE).filter((p) => p !== '')
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key} className="font-semibold text-hf-ink">{part.slice(2, -2)}</strong>
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-hf-link underline">
          {link[1]}
        </a>
      )
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="text-hf-link underline break-all">
          {part}
        </a>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

function renderMarkdown(body: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let listItems: { ordered: boolean; text: string }[] = []
  let paragraph: string[] = []
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(
        <p key={`p-${key++}`} className="text-[16px] text-hf-body leading-[1.55]">
          {renderInline(paragraph.join(' '), `p-${key}`)}
        </p>
      )
      paragraph = []
    }
  }
  const flushList = () => {
    if (listItems.length) {
      const ordered = listItems[0].ordered
      const items = listItems.map((it, i) => (
        <li key={`li-${key}-${i}`} className="text-[16px] text-hf-body leading-[1.55]">
          {renderInline(it.text, `li-${key}-${i}`)}
        </li>
      ))
      blocks.push(
        ordered
          ? <ol key={`l-${key++}`} className="list-decimal pl-5 space-y-2 marker:text-hf-muted">{items}</ol>
          : <ul key={`l-${key++}`} className="list-disc pl-5 space-y-2 marker:text-hf-muted">{items}</ul>
      )
      listItems = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') { flushParagraph(); flushList(); continue }

    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flushParagraph(); flushList()
      const level = heading[1].length
      const hcls = level === 1 ? 'text-[20px] font-bold text-hf-ink' : level === 2 ? 'text-[17px] font-semibold text-hf-ink' : 'text-[16px] font-semibold text-hf-ink'
      blocks.push(<h2 key={`h-${key++}`} className={`${hcls} mt-2`}>{renderInline(heading[2], `h-${key}`)}</h2>)
      continue
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (ordered || bullet) {
      flushParagraph()
      const text = (ordered ? ordered[1] : bullet![1])
      const isOrdered = !!ordered
      if (listItems.length && listItems[0].ordered !== isOrdered) flushList()
      listItems.push({ ordered: isOrdered, text })
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}

// =============================================================================
// PAGE
// =============================================================================

export default function ResourceReaderPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = params?.id

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resource, setResource] = useState<ResourceDetail | null>(null)

  useEffect(() => {
    if (!id) return
    async function load() {
      try {
        const res = await fetch(`/api/resources/${id}`)
        const data = await res.json()
        if (!res.ok) {
          if (res.status === 401) { router.push('/login'); return }
          throw new Error(data.error || 'Failed to load document')
        }
        const r: ResourceDetail = data.resource
        // A file-backed doc shouldn't reach the reader — bounce to its url.
        if (r.kind === 'file' && r.url) { window.location.href = r.url; return }
        setResource(r)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load document')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, router])

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-16">
      <header className="max-w-lg mx-auto px-5 pt-3 flex flex-col gap-2">
        <BackLink href="/resources" label="Resources" />
        <h1 className="text-[26px] font-bold tracking-[-0.02em] leading-[1.2] text-hf-ink">
          {resource?.title || (loading ? '' : 'Document')}
        </h1>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-4">
        {error && (
          <Banner tone="error" className="mb-4">
            {error}{' '}
            <Link href="/resources" className="underline font-semibold">Back to resources</Link>
          </Banner>
        )}

        {loading ? (
          <div className={`${cls.card} p-5 animate-pulse flex flex-col gap-3`}>
            <div className="h-4 bg-hf-track rounded w-3/4" />
            <div className="h-4 bg-hf-track rounded w-full" />
            <div className="h-4 bg-hf-track rounded w-5/6" />
          </div>
        ) : resource && resource.kind === 'markdown' ? (
          <article className={`${cls.card} p-5 flex flex-col gap-3.5`}>
            {renderMarkdown(resource.body || '')}
          </article>
        ) : !error ? (
          <div className={`${cls.card} p-8 text-center text-hf-muted text-[15px]`}>
            This document isn&apos;t available to read here.
          </div>
        ) : null}
      </main>
    </div>
  )
}
