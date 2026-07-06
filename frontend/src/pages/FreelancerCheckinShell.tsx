/**
 * Freelancer Check-In / Collection Shell
 *
 * Public entrypoint for freelancers arriving from the portal to COLLECT a van
 * (a check-in, not a book-out — the Lewis mis-route, HH 15933). Mirror of
 * FreelancerBookoutShell: exchanges the HMAC token for a scoped checkin-mode
 * session, persists it, and renders CollectionPage (which reads scope + context
 * from useAuth and pre-fills the van + job).
 *
 * Lives OUTSIDE the staff ProtectedRoute + Layout — freelancers never see the
 * staff nav or touch the staff auth store. The session is a soft check-in: it
 * records interim state + closes the collection quote, but does NOT flip the
 * van to 'returned' (the warehouse does the final check-in).
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CollectionPage } from '../modules/vehicles/pages/CollectionPage'
import { FreelancerLinkError } from '../modules/vehicles/components/FreelancerLinkError'
import {
  clearFreelancerSession,
  getFreelancerSession,
  resolveFreelancerCheckinToken,
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

export default function FreelancerCheckinShell() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<ShellState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function init() {
      const hmacToken = searchParams.get('freelancerToken')
      const returnUrl = searchParams.get('returnUrl')

      if (hmacToken) {
        const result = await resolveFreelancerCheckinToken(OP_API_BASE, hmacToken, returnUrl)
        if (cancelled) return

        if (!result.ok) {
          setState({ kind: 'error', message: result.error, returnUrl })
          return
        }

        setFreelancerSession(result.token, result.context)

        const next = new URLSearchParams(searchParams)
        next.delete('freelancerToken')
        next.delete('returnUrl')
        setSearchParams(next, { replace: true })

        setState({ kind: 'ready' })
        return
      }

      const existing = getFreelancerSession()
      if (existing) {
        setState({ kind: 'ready' })
        return
      }

      setState({ kind: 'expired', returnUrl })
    }

    init()
    return () => {
      cancelled = true
    }
  }, [searchParams, setSearchParams])

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-ooosh-navy border-t-transparent" />
          <p className="mt-4 text-sm text-gray-600">Authorising your collection…</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'error') {
    return <FreelancerLinkError message={state.message} returnUrl={state.returnUrl} action="check-in" />
  }

  if (state.kind === 'expired') {
    clearFreelancerSession()
    return (
      <FreelancerLinkError
        message="Your session has ended (sessions last 4 hours). Head back to the freelancer portal and start the collection again."
        returnUrl={state.returnUrl}
        action="check-in"
      />
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <CollectionPage />
    </QueryClientProvider>
  )
}
