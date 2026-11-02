/**
 * Studio Sitter Shop Till API (proxy)
 *
 * GET  /api/studio-sitter/shifts/[date]/till/context          → tonight's bands, payment methods, open?
 * GET  /api/studio-sitter/shifts/[date]/till/search?q=…       → price lookup
 * GET  /api/studio-sitter/shifts/[date]/till/sales            → tonight's sales + totals
 * GET  /api/studio-sitter/shifts/[date]/till/jobs/[id]/receipt-contacts → a band's contacts for a receipt
 * POST /api/studio-sitter/shifts/[date]/till/sales            → take a sale
 * POST /api/studio-sitter/shifts/[date]/till/sales/[id]/cancel → undo one inside its hold
 * POST /api/studio-sitter/shifts/[date]/till/sales/[id]/receipt → email a receipt
 * GET  /api/studio-sitter/shifts/[date]/till/reader/readers   → the card reader(s)
 * POST /api/studio-sitter/shifts/[date]/till/reader/pay       → send a basket to the card reader
 * GET  /api/studio-sitter/shifts/[date]/till/reader/sessions/[id]?check=1 → how that payment is going
 * POST /api/studio-sitter/shifts/[date]/till/reader/sessions/[id]/retry|cancel|simulate
 *
 * OP-only. Access is enforced OP-side — the sitter must be rostered to this
 * evening (or be the shared staff account), else OP returns 403. Only the
 * paths above are forwarded; anything else is a 404 here, so this route can't
 * be used to reach other OP endpoints.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { sitterTillOP, isOpClientError, OpApiError } from '@/lib/op-api'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = { params: Promise<{ date: string; path: string[] }> }

function allowed(method: 'GET' | 'POST', path: string[]): boolean {
  const p = path.join('/')
  if (method === 'GET') {
    return p === 'context' || p === 'search' || p === 'sales'
      || (path.length === 3 && path[0] === 'jobs' && UUID_RE.test(path[1]) && path[2] === 'receipt-contacts')
      // The card reader (STRIPE-TERMINAL-SPEC §14).
      || p === 'reader/readers'
      || (path.length === 3 && path[0] === 'reader' && path[1] === 'sessions' && UUID_RE.test(path[2]))
  }
  if (p === 'sales' || p === 'reader/pay') return true
  if (path.length === 4 && path[0] === 'reader' && path[1] === 'sessions' && UUID_RE.test(path[2])) {
    return path[3] === 'retry' || path[3] === 'cancel' || path[3] === 'simulate'
  }
  return path.length === 3 && path[0] === 'sales' && UUID_RE.test(path[1])
    && (path[2] === 'cancel' || path[2] === 'receipt')
}

async function handle(request: NextRequest, method: 'GET' | 'POST', { params }: Params) {
  try {
    const { date, path } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }
    if (!allowed(method, path || [])) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    const body = method === 'POST' ? await request.json().catch(() => ({})) : undefined
    const q = request.nextUrl.searchParams.get('q')
    // `check=1` asks Stripe directly (the card reader's poll) — the only other query passed on.
    const check = request.nextUrl.searchParams.get('check') === '1'
    try {
      const data = await sitterTillOP(sessionToken, date, path.join('/'), {
        method,
        body,
        search: q ? `q=${encodeURIComponent(q)}` : check ? 'check=1' : undefined,
      })
      return NextResponse.json(data)
    } catch (opError) {
      // 4xx = a real answer (not rostered, till closed, "pick how they paid").
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP sitter till error:', opError)
      return NextResponse.json(
        { success: false, error: 'The till couldn’t reach the office system. Check your signal and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter till API error:', error)
    return NextResponse.json({ success: false, error: 'Something went wrong with the till' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, ctx: Params) {
  return handle(request, 'GET', ctx)
}

export async function POST(request: NextRequest, ctx: Params) {
  return handle(request, 'POST', ctx)
}
