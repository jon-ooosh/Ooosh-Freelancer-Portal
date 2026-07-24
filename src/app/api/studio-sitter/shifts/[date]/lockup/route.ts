/**
 * Studio Sitter End-of-Day Lock-up Report API
 *
 * GET  /api/studio-sitter/shifts/[date]/lockup   → template + reference photos +
 *        DERIVED "continuing tomorrow?" + any prior submission
 * POST /api/studio-sitter/shifts/[date]/lockup   → submit the report
 *
 * OP-only. Access is enforced OP-side — the sitter must be rostered to this
 * evening (or be the shared staff account), else OP returns 403.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  getLockupContextFromOP,
  submitLockupReportOP,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

/**
 * Re-forward an incoming multipart request to OP. NOTE: do NOT reference the
 * `File` global — it isn't defined in the Netlify Node runtime (only `Blob` is),
 * so `x instanceof File` throws. formData entries are `string | Blob`; non-string
 * = a file, materialised to a fresh Blob so the re-forwarded body streams.
 */
async function reforwardFormData(request: NextRequest): Promise<FormData> {
  const inForm = await request.formData()
  const entries: [string, FormDataEntryValue][] = []
  inForm.forEach((value, name) => { entries.push([name, value]) })
  const outForm = new FormData()
  for (const [name, value] of entries) {
    if (typeof value === 'string') { outForm.append(name, value); continue }
    const blob = value as Blob
    const filename = (blob as { name?: string }).name || 'upload'
    const buf = Buffer.from(await blob.arrayBuffer())
    outForm.append(name, new Blob([buf], { type: blob.type }), filename)
  }
  return outForm
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const { date } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const data = await getLockupContextFromOP(sessionToken, date)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP lock-up context error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load the lock-up report. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Lock-up GET error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load lock-up report' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const { date } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const outForm = await reforwardFormData(request)
      const data = await submitLockupReportOP(sessionToken, date, outForm)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP lock-up submit error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to submit the report. Please try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Lock-up POST error:', error)
    return NextResponse.json({ success: false, error: 'Failed to submit lock-up report' }, { status: 500 })
  }
}
