/**
 * Studio Sitter — log lost property found during a shift, into the Holding module.
 *
 * POST /api/studio-sitter/shifts/[date]/lost-property  (multipart: description,
 *   found_location, photos) → creates a Holding lost_property record OP-side.
 *
 * OP-only. Access enforced OP-side (rostered sitter / shared staff account).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { logShiftLostPropertyOP, isOpClientError, OpApiError } from '@/lib/op-api'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

    // Re-forward multipart (never reference the `File` global — see lockup route).
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

    try {
      const data = await logShiftLostPropertyOP(sessionToken, date, outForm)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP lost-property error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to log lost property. Please try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Lost-property POST error:', error)
    return NextResponse.json({ success: false, error: 'Failed to log lost property' }, { status: 500 })
  }
}
