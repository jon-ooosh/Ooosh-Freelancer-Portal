/**
 * Freelancer Prep Shell (STAFF-CALENDAR-SPEC §21.6)
 *
 * Public entrypoint for a freelancer who tapped "Open prep sheet" on a van-prep
 * task in the portal. Lives OUTSIDE ProtectedRoute + Layout — no staff nav, no
 * staff login.
 *
 *   1. `?prepToken=` in the URL → swap it for a 4h session scoped to that one
 *      van, store it, drop the token from the URL, render PrepPage on the van.
 *   2. No token, but a live session → resume (refresh-safe).
 *   3. Neither → "head back to the portal".
 *
 * Renders only PrepPage — the one page a freelancer needs here. The server
 * holds the session to that van whatever the page does.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrepPage } from '../modules/vehicles/pages/PrepPage'
import {
  clearFreelancerPrepSession,
  getFreelancerPrepSession,
  resolveFreelancerPrepToken,
  setFreelancerPrepSession,
  type FreelancerPrepContext,
} from '../modules/vehicles/adapters/freelancer-prep-session'

type ShellState =
  | { kind: 'loading' }
  | { kind: 'ready'; context: FreelancerPrepContext }
  | { kind: 'error'; message: string; returnUrl: string | null }

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 60 * 2, retry: 1 } },
})

export default function FreelancerPrepShell() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<ShellState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function init() {
      const prepToken = searchParams.get('prepToken')
      const returnUrl = searchParams.get('returnUrl')

      if (prepToken) {
        const result = await resolveFreelancerPrepToken(prepToken, returnUrl)
        if (cancelled) return
        if (result.kind === 'error') {
          setState({ kind: 'error', message: result.error, returnUrl })
          return
        }
        // A new link always replaces an older prep session on this phone.
        setFreelancerPrepSession(result.token, result.context, result.ttlSeconds)
        // Drop the one-shot token so a refresh resumes rather than re-redeems.
        const next = new URLSearchParams(searchParams)
        next.delete('prepToken')
        next.delete('returnUrl')
        setSearchParams(next, { replace: true })
        setState({ kind: 'ready', context: result.context })
        return
      }

      const existing = getFreelancerPrepSession()
      if (existing) {
        setState({ kind: 'ready', context: existing.context })
        return
      }
      setState({
        kind: 'error',
        message: 'Your prep session has ended (they last 4 hours). Head back to the freelancer portal and tap “Open prep sheet” again.',
        returnUrl,
      })
    }
    void init()
    return () => { cancelled = true }
  }, [searchParams, setSearchParams])

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-ooosh-navy border-t-transparent" />
          <p className="mt-4 text-sm text-gray-600">Opening the prep sheet…</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'error') {
    clearFreelancerPrepSession()
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-base font-semibold text-gray-900">We could not open the prep sheet</h1>
          <p className="mt-2 text-sm text-gray-600">{state.message}</p>
          <p className="mt-2 text-xs text-gray-400">If it keeps happening, call the office.</p>
          {state.returnUrl && (
            <a href={state.returnUrl}
              className="mt-5 block rounded-lg bg-ooosh-navy py-3 text-sm font-medium text-white">
              Back to the freelancer portal
            </a>
          )}
        </div>
      </div>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-50">
        <div className="border-b border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500">Prepping for Ooosh as {state.context.personName}</p>
          <p className="text-sm font-semibold text-gray-900">{state.context.taskTitle}</p>
        </div>
        <PrepPage freelancerPrep={{ vehicleReg: state.context.vehicleReg, returnUrl: state.context.returnUrl }} />
      </div>
    </QueryClientProvider>
  )
}
