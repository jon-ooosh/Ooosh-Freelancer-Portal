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
      return <strong key={key} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-ooosh-600 underline">
          {link[1]}
        </a>
      )
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="text-ooosh-600 underline break-all">
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
        <p key={`p-${key++}`} className="text-sm text-gray-700 leading-relaxed">
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
        <li key={`li-${key}-${i}`} className="text-sm text-gray-700 leading-relaxed">
          {renderInline(it.text, `li-${key}-${i}`)}
        </li>
      ))
      blocks.push(
        ordered
          ? <ol key={`l-${key++}`} className="list-decimal pl-5 space-y-1.5">{items}</ol>
          : <ul key={`l-${key++}`} className="list-disc pl-5 space-y-1.5">{items}</ul>
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
      const cls = level === 1 ? 'text-lg font-semibold text-gray-900' : level === 2 ? 'text-base font-semibold text-gray-900' : 'text-sm font-semibold text-gray-900'
      blocks.push(<h2 key={`h-${key++}`} className={`${cls} mt-1`}>{renderInline(heading[2], `h-${key}`)}</h2>)
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
    <div className="min-h-screen bg-gray-50 pb-20">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/resources" className="p-2 -ml-2 text-gray-600 hover:text-gray-900 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-lg font-semibold text-gray-900 truncate">
            {resource?.title || 'Document'}
          </h1>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <Link href="/resources" className="ml-2 underline hover:no-underline">Back to resources</Link>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 animate-pulse space-y-3">
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 rounded w-full"></div>
            <div className="h-4 bg-gray-200 rounded w-5/6"></div>
          </div>
        ) : resource && resource.kind === 'markdown' ? (
          <article className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-3">
            {renderMarkdown(resource.body || '')}
          </article>
        ) : !error ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-500 text-sm">
            This document isn&apos;t available to read here.
          </div>
        ) : null}
      </main>
    </div>
  )
}
