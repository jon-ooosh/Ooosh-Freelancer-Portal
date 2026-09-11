'use client'

/**
 * Resources Page
 *
 * Company documents and guides for freelancers, sourced from the Operations
 * Platform (staff documents flagged shareable_with_freelancers). File-backed
 * docs open via a presigned url; markdown docs open in an in-portal reader.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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

function resourceIcon(r: Resource): string {
  if (r.kind === 'markdown') return '📄'
  switch (r.fileType?.toLowerCase()) {
    case 'pdf': return '📕'
    case 'doc':
    case 'docx': return '📘'
    case 'xls':
    case 'xlsx': return '📊'
    case 'ppt':
    case 'pptx': return '📙'
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp': return '🖼️'
    case 'mp4':
    case 'mov':
    case 'avi': return '🎬'
    default: return '📄'
  }
}

function actionLabel(r: Resource): string {
  return r.kind === 'markdown' ? 'Read' : `Open${r.fileType ? ` ${r.fileType}` : ''}`
}

// =============================================================================
// COMPONENTS
// =============================================================================

function ResourceCard({ resource, onOpen }: { resource: Resource; onOpen: (r: Resource) => void }) {
  const unavailable = resource.kind === 'file' && !resource.url
  return (
    <button
      onClick={() => !unavailable && onOpen(resource)}
      disabled={unavailable}
      className="w-full flex items-center gap-3 px-4 py-3 bg-white rounded-xl shadow-sm border border-gray-100 hover:bg-gray-50 transition-colors text-left disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <span className="text-2xl flex-shrink-0">{resourceIcon(resource)}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{resource.title}</p>
        <p className="text-xs text-gray-500">
          {categoryLabel(resource.category)}
          {unavailable && ' · temporarily unavailable'}
        </p>
      </div>
      <span className="text-xs font-medium text-ooosh-600 flex-shrink-0">
        {unavailable ? '—' : actionLabel(resource)}
      </span>
    </button>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-200 rounded"></div>
            <div className="flex-1">
              <div className="h-4 bg-gray-200 rounded w-2/3 mb-1"></div>
              <div className="h-3 bg-gray-200 rounded w-1/4"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
      <div className="text-gray-400 text-5xl mb-4">📚</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">No Resources Available</h3>
      <p className="text-gray-500 text-sm">
        There are no documents or guides available at the moment.
      </p>
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

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/dashboard"
                className="p-2 -ml-2 text-gray-600 hover:text-gray-900 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Resources</h1>
                <p className="text-sm text-gray-500">Guides & documents</p>
              </div>
            </div>
            <button
              onClick={() => window.location.reload()}
              disabled={loading}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button
              onClick={() => window.location.reload()}
              className="ml-2 underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : resources.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {resources.map((resource) => (
              <ResourceCard key={resource.id} resource={resource} onOpen={handleOpen} />
            ))}
          </div>
        )}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom">
        <div className="max-w-lg mx-auto px-4 py-2 flex justify-around">
          <Link href="/dashboard" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span className="text-xs mt-1">Jobs</span>
          </Link>
          <Link href="/earnings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs mt-1">Earnings</span>
          </Link>
          <Link href="/resources" className="flex flex-col items-center py-2 px-3 text-ooosh-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span className="text-xs mt-1">Resources</span>
          </Link>
          <Link href="/settings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-xs mt-1">Settings</span>
          </Link>
        </div>
      </nav>
    </div>
  )
}
