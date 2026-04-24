/**
 * Freelancer Book-Out Shell
 *
 * Public entrypoint for freelancers arriving from the portal with an
 * HMAC token. Lives OUTSIDE the staff `<ProtectedRoute>` + `<Layout>`
 * wrappers — freelancers never see the staff nav, never touch the
 * staff auth store.
 *
 * Lifecycle:
 *   1. URL has `?freelancerToken=...` → exchange with OP for a scoped
 *      session JWT, persist to localStorage, drop URL params, render
 *      BookOutPage.
 *   2. No token param but localStorage has a live session → resume
 *      (refresh-safe, tab-restore-safe). Session JWT is 4h; past that
 *      we clear and send them back to the portal.
 *   3. No token and no session → "Session expired" screen with a
 *      "Back to portal" link (using returnUrl if we still have it).
 *
 * The shell does NOT mount the QueryClientProvider or the full
 * VehicleRoutes — it renders just BookOutPage, because that's the only
 * page a freelancer needs. Extra surface area = extra risk.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BookOutPage } from '../modules/vehicles/pages/BookOutPage'
import {
  clearFreelancerSession,
  getFreelancerSession,
  resolveFreelancerToken,
  setFreelancerSession,
} from '../modules/vehicles/adapters/freelancer-session'

type ShellState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'expired'; returnUrl: string | null }
  | { kind: 'error'; message: string; returnUrl: string | null }

const OP_API_BASE = '/api/vehicles'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 60 * 2, retry: 1 },
  },
})

export default function FreelancerBookoutShell() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<ShellState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function init() {
      const hmacToken = searchParams.get('freelancerToken')
      const returnUrl = searchParams.get('returnUrl')

      // Fresh arrival from portal — exchange the token.
      if (hmacToken) {
        const result = await resolveFreelancerToken(OP_API_BASE, hmacToken, returnUrl)
        if (cancelled) return

        if (!result.ok) {
          setState({ kind: 'error', message: result.error, returnUrl })
          return
        }

        setFreelancerSession(result.token, result.context)

        // Strip the token/returnUrl from the URL so a refresh/back-button
        // doesn't try to re-exchange a one-shot HMAC and fail.
        const next = new URLSearchParams(searchParams)
        next.delete('freelancerToken')
        next.delete('returnUrl')
        setSearchParams(next, { replace: true })

        setState({ kind: 'ready' })
        return
      }

      // No token in URL — resume existing session if it's still valid.
      const existing = getFreelancerSession()
      if (existing) {
        setState({ kind: 'ready' })
        return
      }

      // No token, no session → expired or arrived directly.
      setState({ kind: 'expired', returnUrl })
    }

    init()
    return () => {
      cancelled = true
    }
  }, [searchParams, setSearchParams])

  if (state.kind === 'loading') {
    return <LoadingScreen />
  }

  if (state.kind === 'error') {
    return <ErrorScreen message={state.message} returnUrl={state.returnUrl} />
  }

  if (state.kind === 'expired') {
    return <ExpiredScreen returnUrl={state.returnUrl} />
  }

  // Freelancer session is live — render BookOutPage. It reads scope +
  // context from useAuth (via the auth adapter) and will pre-fill the
  // vehicle, driver name, and job number from the resolve payload.
  return (
    <QueryClientProvider client={queryClient}>
      <BookOutPage />
    </QueryClientProvider>
  )
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-ooosh-navy border-t-transparent" />
        <p className="mt-4 text-sm text-gray-600">Authorising your book-out…</p>
      </div>
    </div>
  )
}

function ErrorScreen({ message, returnUrl }: { message: string; returnUrl: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md rounded-lg border border-red-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-red-700">Couldn&apos;t start book-out</h1>
        <p className="mt-2 text-sm text-gray-700">{message}</p>
        <p className="mt-4 text-xs text-gray-500">
          Go back to the freelancer portal and try starting the delivery again. If this keeps
          happening, ask Ooosh Tours to check the allocation.
        </p>
        {returnUrl && (
          <a
            href={returnUrl}
            className="mt-4 inline-block rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-semibold text-white"
          >
            Back to portal
          </a>
        )}
      </div>
    </div>
  )
}

function ExpiredScreen({ returnUrl }: { returnUrl: string | null }) {
  // Wipe any stale scraps just in case.
  clearFreelancerSession()
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md rounded-lg border border-amber-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-amber-700">Session expired</h1>
        <p className="mt-2 text-sm text-gray-700">
          Your book-out session has ended (sessions last 4 hours). Head back to the freelancer
          portal and click &ldquo;Start delivery&rdquo; again to resume.
        </p>
        {returnUrl && (
          <a
            href={returnUrl}
            className="mt-4 inline-block rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-semibold text-white"
          >
            Back to portal
          </a>
        )}
      </div>
    </div>
  )
}
