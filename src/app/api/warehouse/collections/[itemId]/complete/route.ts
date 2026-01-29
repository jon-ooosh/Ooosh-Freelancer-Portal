/**
 * Warehouse Collection Completion API
 * 
 * Handles the sign-off process for in-person collections:
 * 1. Adds signature as an update to the Monday item
 * 2. Changes on-hire status to "On hire!"
 * 3. Generates PDF delivery note
 * 4. Sends email to client (if requested)
 */

import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const QH_BOARD_ID = '2431480012'

// Column IDs
const COLUMNS = {
  ON_HIRE_STATUS: 'status51',
}

interface CompleteRequest {
  signatureBase64: string
  clientName: string  // May be edited by staff
  clientEmails: string[]
  sendEmail: boolean
  jobName: string
  hireStartDate: string
  hhRef: string
  items: Array<{ name: string; quantity: number }>
}

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not configured')

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  })

  const data = await response.json()
  if (data.errors) {
    console.error('Monday API errors:', data.errors)
    throw new Error(JSON.stringify(data.errors))
  }
  return data.data as T
}

/**
 * Add an update (comment) to a Monday item with signature info and image
 */
async function addSignatureUpdate(itemId: string, clientName: string, timestamp: string, signatureBase64: string): Promise<boolean> {
  try {
    const updateText = `📝 **Collected in-person**\n\n👤 Collected by: ${clientName || 'Customer'}\n📅 Date/Time: ${timestamp}\n\n_Signature captured via Warehouse Portal_`

    // First create the update
    const createMutation = `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
    `

    const updateResult = await mondayQuery<{ create_update: { id: string } }>(createMutation, { itemId, body: updateText })
    const updateId = updateResult.create_update?.id

    if (!updateId) {
      console.error('Warehouse: Failed to create update - no ID returned')
      return false
    } 

    console.log(`Warehouse: Created update ${updateId} for item ${itemId}`)

    // Now upload the signature image to the update
    if (signatureBase64) {
      try {
        // Convert base64 to buffer
        const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, '')
        const imageBuffer = Buffer.from(base64Data, 'base64')

        // Create form data for file upload
        const FormData = (await import('form-data')).default
        const form = new FormData()

        // Monday.com file upload requires specific format
        const query = `mutation ($updateId: ID!) { add_file_to_update(update_id: $updateId, file: $file) { id } }`
        form.append('query', query)
        form.append('variables[updateId]', updateId)
        form.append('map', JSON.stringify({ file: 'variables.file' }))
        form.append('file', imageBuffer, {
          filename: `signature_${itemId}_${Date.now()}.png`,
          contentType: 'image/png',
        })

        const token = process.env.MONDAY_API_TOKEN
        const uploadResponse = await fetch(MONDAY_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': token!,
            ...form.getHeaders(),
          },
          body: form as unknown as BodyInit,
        })

        const uploadResult = await uploadResponse.json()
        if (uploadResult.errors) {
          console.warn('Warehouse: Signature upload had errors:', uploadResult.errors)
        } else {
          console.log('Warehouse: Signature image uploaded to update')
        }
      } catch (uploadErr) {
        // Log but don't fail - the text update is more important
        console.warn('Warehouse: Failed to upload signature image:', uploadErr)
      }
    }

    return true
  } catch (err) {
    console.error('Failed to add signature update:', err)
    return false
  }
}

/**
 * Update the on-hire status to "On hire!"
 */
async function updateOnHireStatus(itemId: string): Promise<boolean> {
  try {
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
          id
        }
      }
    `

    // Status columns use JSON with "label" key
    const value = JSON.stringify({ label: 'On hire!' })

    await mondayQuery(mutation, {
      boardId: QH_BOARD_ID,
      itemId,
      columnId: COLUMNS.ON_HIRE_STATUS,
      value,
    })

    console.log(`Warehouse: Updated item ${itemId} to "On hire!"`)
    return true
  } catch (err) {
    console.error('Failed to update on-hire status:', err)
    return false
  }
}

/**
 * Fetch logo image from the portal URL
 */
async function fetchLogoImage(): Promise<Uint8Array | null> {
  try {
    const logoUrl = 'https://ooosh-freelancer-portal.netlify.app/ooosh-tours-logo-small.png'
    const response = await fetch(logoUrl)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  } catch {
    return null
  }
}

/**
 * Generate delivery note PDF (same format as freelancer deliveries)
 */
async function generateDeliveryNotePdf(data: {
  hhRef: string
  jobDate: string
  completedAt: string
  clientName: string
  items: Array<{ name: string; quantity: number }>
  signatureBase64: string
}): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create()
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 40
  const contentWidth = pageWidth - margin * 2

  const primaryColor = rgb(0.486, 0.361, 0.906)
  const textColor = rgb(0.2, 0.2, 0.2)
  const lightGray = rgb(0.5, 0.5, 0.5)
  const borderColor = rgb(0.85, 0.85, 0.85)
  const headerBg = rgb(0.96, 0.96, 0.98)

  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  // Header with logo
  const logoBytes = await fetchLogoImage()
  let logoBottomY = y - 50

  if (logoBytes) {
    try {
      const logoImage = await pdfDoc.embedPng(logoBytes)
      const logoAspect = logoImage.width / logoImage.height
      const logoDisplayHeight = 50
      const logoDisplayWidth = logoDisplayHeight * logoAspect

      page.drawImage(logoImage, {
        x: margin,
        y: y - logoDisplayHeight,
        width: logoDisplayWidth,
        height: logoDisplayHeight,
      })
      logoBottomY = y - logoDisplayHeight
    } catch {
      page.drawText('OOOSH TOURS', { x: margin, y: y - 25, size: 22, font: helveticaBold, color: primaryColor })
      logoBottomY = y - 30
    }
  } else {
    page.drawText('OOOSH TOURS', { x: margin, y: y - 25, size: 22, font: helveticaBold, color: primaryColor })
    logoBottomY = y - 30
  }

  // "Delivery Note" title
  const titleText = 'Delivery Note'
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, 24)
  page.drawText(titleText, { x: pageWidth - margin - titleWidth, y: logoBottomY + 5, size: 24, font: helveticaBold, color: primaryColor })

  // Address and job number
  const addressY = logoBottomY - 12
  page.drawText('Compass House, 7 East Street, Portslade, BN41 1DL', { x: margin, y: addressY, size: 9, font: helvetica, color: lightGray })
  const jobNumText = `Job Number: ${data.hhRef}`
  const jobNumWidth = helvetica.widthOfTextAtSize(jobNumText, 9)
  page.drawText(jobNumText, { x: pageWidth - margin - jobNumWidth, y: addressY, size: 9, font: helvetica, color: lightGray })

  y = addressY - 20

  // Purple divider
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 2, color: primaryColor })
  y -= 25

  // Details box
  const detailsBoxHeight = 80
  page.drawRectangle({ x: margin, y: y - detailsBoxHeight, width: contentWidth, height: detailsBoxHeight, borderColor, borderWidth: 1, color: headerBg })

  const leftColX = margin + 15
  const rightColX = pageWidth / 2 + 20
  const row1Y = y - 18

  page.drawText('Client:', { x: leftColX, y: row1Y, size: 9, font: helvetica, color: lightGray })
  page.drawText(data.clientName || 'N/A', { x: leftColX, y: row1Y - 13, size: 11, font: helveticaBold, color: textColor })

  page.drawText('Job Date:', { x: rightColX, y: row1Y, size: 9, font: helvetica, color: lightGray })
  page.drawText(new Date(data.jobDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), { x: rightColX, y: row1Y - 13, size: 11, font: helveticaBold, color: textColor })

  const row2Y = row1Y - 32
  page.drawText('Collection:', { x: leftColX, y: row2Y, size: 9, font: helvetica, color: lightGray })
  page.drawText('In-person at Ooosh warehouse', { x: leftColX, y: row2Y - 13, size: 11, font: helveticaBold, color: textColor })

  page.drawText('Completed:', { x: rightColX, y: row2Y, size: 9, font: helvetica, color: lightGray })
  const completedDate = new Date(data.completedAt)
  page.drawText(`${completedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${completedDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, { x: rightColX, y: row2Y - 13, size: 11, font: helveticaBold, color: textColor })

  y = y - detailsBoxHeight - 35

  // Equipment section
  page.drawText('Equipment Collected', { x: margin, y, size: 14, font: helveticaBold, color: textColor })
  y -= 20

  // Table header
  const tableHeaderHeight = 28
  page.drawRectangle({ x: margin, y: y - tableHeaderHeight, width: contentWidth, height: tableHeaderHeight, color: headerBg, borderColor, borderWidth: 1 })
  page.drawText('Item', { x: margin + 10, y: y - 18, size: 10, font: helveticaBold, color: textColor })
  page.drawText('Qty', { x: pageWidth - margin - 40, y: y - 18, size: 10, font: helveticaBold, color: textColor })
  y -= tableHeaderHeight

  // Equipment rows
  for (const item of data.items) {
    if (y < margin + 150) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: borderColor })
    page.drawText(item.name.substring(0, 70), { x: margin + 10, y: y - 15, size: 10, font: helvetica, color: textColor })
    page.drawText(String(item.quantity), { x: pageWidth - margin - 35, y: y - 15, size: 10, font: helvetica, color: textColor })
    y -= 22
  }

  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: borderColor })

  // Signature section
  y -= 30
  if (y < margin + 120) {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    y = pageHeight - margin
  }

  const sigBoxHeight = 100
  page.drawRectangle({ x: margin, y: y - sigBoxHeight, width: contentWidth, height: sigBoxHeight, borderColor, borderWidth: 1 })
  page.drawText('Acknowledgement of Collection', { x: margin + 15, y: y - 20, size: 11, font: helveticaBold, color: textColor })

  if (data.signatureBase64) {
    try {
      const sigData = data.signatureBase64.replace(/^data:image\/\w+;base64,/, '')
      const sigBytes = Buffer.from(sigData, 'base64')
      const sigImg = await pdfDoc.embedPng(sigBytes)
      const scale = Math.min(180 / sigImg.width, 50 / sigImg.height)
      page.drawImage(sigImg, { x: margin + 15, y: y - 80, width: sigImg.width * scale, height: sigImg.height * scale })
    } catch (err) {
      console.warn('Failed to embed signature:', err)
    }
  }

  page.drawText(`Collected by ${data.clientName || 'customer'} at Ooosh warehouse`, { x: margin + 15, y: y - sigBoxHeight + 12, size: 9, font: helvetica, color: lightGray })

  // Footer
  const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1]
  lastPage.drawText('Thank you for choosing Ooosh Tours', { x: margin, y: margin - 10, size: 9, font: helvetica, color: lightGray })
  const websiteText = 'www.oooshtours.co.uk'
  lastPage.drawText(websiteText, { x: pageWidth - margin - helvetica.widthOfTextAtSize(websiteText, 9), y: margin - 10, size: 9, font: helvetica, color: primaryColor })

  return Buffer.from(await pdfDoc.save())
}

/**
 * Send delivery note email
 */
async function sendDeliveryEmail(
  clientEmails: string[],
  clientName: string,
  jobDate: string,
  hhRef: string,
  pdfBuffer: Buffer
): Promise<boolean> {
  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.default.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
    })

    const greeting = clientName ? `Hello ${clientName.split(' ')[0]},` : 'Hello,'
    const formattedDate = new Date(jobDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#7c5ce7;padding:30px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:white;margin:0;font-size:24px;">📦 Delivery Note</h1></div>
      <div style="background:#f8f9fa;padding:30px;border-radius:0 0 12px 12px;">
        <p style="font-size:16px;margin-bottom:20px;">${greeting}</p>
        <p style="font-size:16px;margin-bottom:20px;">Please find attached the delivery note for equipment you collected from Ooosh Tours.</p>
        <div style="background:white;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #7c5ce7;">
          <p style="margin:8px 0;color:#555;"><strong>📍 Collection:</strong> In-person at Ooosh warehouse</p>
          <p style="margin:8px 0;color:#555;"><strong>📅 Hire Start Date:</strong> ${formattedDate}</p>
          <p style="margin:8px 0;color:#555;"><strong>🔖 Job Reference:</strong> ${hhRef}</p>
        </div>
        <p style="font-size:14px;color:#666;">If you have any questions or notice any discrepancies, please get in touch asap.</p>
        <p style="font-size:14px;color:#555;margin-top:25px;">Many thanks,<br><strong>The Ooosh Tours Team</strong></p>
      </div></body></html>`

    const safeRef = hhRef.replace(/[^a-zA-Z0-9]/g, '_')
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>',
      to: clientEmails.join(', '),
      subject: `📦 Delivery Note - Job ${hhRef} - ${formattedDate}`,
      html,
      attachments: [{
        filename: `Ooosh_Delivery_Note_${safeRef}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    })

    console.log(`Warehouse: Email sent to ${clientEmails.join(', ')}`)
    return true
  } catch (err) {
    console.error('Warehouse: Email send failed:', err)
    return false
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params

    // Verify PIN
    const pin = request.headers.get('x-warehouse-pin')
    const expectedPin = process.env.WAREHOUSE_PIN

    if (!expectedPin || pin !== expectedPin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body: CompleteRequest = await request.json()
    const { signatureBase64, clientName, clientEmails, sendEmail, jobName, hireStartDate, hhRef, items } = body

    if (!signatureBase64) {
      return NextResponse.json({ success: false, error: 'Signature required' }, { status: 400 })
    }

    const completedAt = new Date().toISOString()
    const timestamp = new Date().toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    console.log(`Warehouse: Completing collection for item ${itemId} (${jobName})`)

    const results: Record<string, boolean> = {}

    // 1. Add signature update to Monday (with image)
    results.signatureUpdate = await addSignatureUpdate(itemId, clientName, timestamp, signatureBase64)

    // 2. Update status to "On hire!"
    results.statusUpdate = await updateOnHireStatus(itemId)

    // 3. Generate PDF and send email (if requested)
    if (sendEmail && clientEmails.length > 0) {
      const pdfBuffer = await generateDeliveryNotePdf({
        hhRef: hhRef || 'N/A',
        jobDate: hireStartDate,
        completedAt,
        clientName,
        items,
        signatureBase64,
      })
      console.log(`Warehouse: PDF generated (${pdfBuffer.length} bytes)`)

      results.emailSent = await sendDeliveryEmail(clientEmails, clientName, hireStartDate, hhRef || 'N/A', pdfBuffer)
    } else {
      results.emailSent = false
      console.log('Warehouse: Email not requested, skipping')
    }

    console.log('Warehouse: Collection completed', results)

    return NextResponse.json({
      success: true,
      results,
      completedAt,
    })

  } catch (error) {
    console.error('Warehouse completion API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to complete collection' },
      { status: 500 }
    )
  }
}