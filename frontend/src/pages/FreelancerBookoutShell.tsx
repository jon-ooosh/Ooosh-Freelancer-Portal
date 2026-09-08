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
import { FreelancerLinkError } from '../modules/vehicles/components/FreelancerLinkError'
import { FreelancerVanPicker } from '../modules/vehicles/components/FreelancerVanPicker'
import {
  clearFreelancerSession,
  getFreelancerSession,
  resolveFreelancerToken,
  setFreelancerSession,
} from '../modules/vehicles/adapters/freelancer-session'
import type { FreelancerVanCandidate } from '../modules/vehicles/adapters/freelancer-session'

type ShellState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  // More than one van allocated to this job — the freelancer picks the reg in
  // front of them before we mint a session (the HH 15307 failure, delivery
  // side). The HMAC token stays in the URL until they pick, so a refresh
  // re-shows the picker rather than dying.
  | { kind: 'select'; candidates: FreelancerVanCandidate[]; hmacToken: string; returnUrl: string | null }
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
  const [pickBusyId, setPickBusyId] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  // Strip the one-shot token from the URL once a session exists (see below).
  const stripTokenParams = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('freelancerToken')
    next.delete('returnUrl')
    setSearchParams(next, { replace: true })
  }

  // Claim one van from the picker. Same endpoint, now with the chosen
  // assignment — the server re-checks it's genuinely a van on this job.
  const handleSelect = async (candidate: FreelancerVanCandidate) => {
    if (state.kind !== 'select') return
    setPickBusyId(candidate.assignmentId)
    setPickError(null)
    const result = await resolveFreelancerToken(
      OP_API_BASE,
      state.hmacToken,
      state.returnUrl,
      'freelancer-bookout/resolve',
      candidate.assignmentId,
    )
    if (result.kind === 'ok') {
      setFreelancerSession(result.token, result.context)
      stripTokenParams()
      setState({ kind: 'ready' })
      return
    }
    setPickBusyId(null)
    setPickError(
      result.kind === 'error'
        ? result.error
        : 'That van could not be claimed — please try another or call the office.',
    )
  }

  useEffect(() => {
    let cancelled = false

    async function init() {
      const hmacToken = searchParams.get('freelancerToken')
      const returnUrl = searchParams.get('returnUrl')

      // Fresh arrival from portal — exchange the token.
      if (hmacToken) {
        const result = await resolveFreelancerToken(OP_API_BASE, hmacToken, returnUrl)
        if (cancelled) return

        if (result.kind === 'error') {
          setState({ kind: 'error', message: result.error, returnUrl })
          return
        }

        if (result.kind === 'select') {
          // Bin any session left over from an earlier van on this device —
          // otherwise abandoning the picker and coming back without a token
          // would resume the OLD van, which is the bug we're fixing.
          clearFreelancerSession()
          // Leave the token in the URL — no session yet, and a refresh should
          // land back on the picker.
          setState({ kind: 'select', candidates: result.candidates, hmacToken, returnUrl })
          return
        }

        setFreelancerSession(result.token, result.context)

        // Strip the token/returnUrl from the URL so a refresh/back-button
        // doesn't try to re-exchange a one-shot HMAC and fail.
        stripTokenParams()

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
    return <FreelancerLinkError message={state.message} returnUrl={state.returnUrl} action="book-out" />
  }

  if (state.kind === 'select') {
    return (
      <FreelancerVanPicker
        candidates={state.candidates}
        action="book-out"
        busyAssignmentId={pickBusyId}
        error={pickError}
        onSelect={handleSelect}
      />
    )
  }

  if (state.kind === 'expired') {
    clearFreelancerSession()
    return (
      <FreelancerLinkError
        message="Your book-out session has ended (sessions last 4 hours). Head back to the freelancer portal and click “Start delivery” again to resume."
        returnUrl={state.returnUrl}
        action="book-out"
      />
    )
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

