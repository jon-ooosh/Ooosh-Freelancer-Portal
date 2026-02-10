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

// Retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,  // 1 second, then 2s, then 4s
  retryableStatusCodes: [429, 500, 502, 503, 504],
}

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    // Retry on rate limits, timeouts, and server errors
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      RETRY_CONFIG.retryableStatusCodes.some(code => message.includes(String(code)))
    )
  }
  return false
}

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

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      const response = await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
          'API-Version': '2024-10',
        },
        body: JSON.stringify({ query, variables }),
      })

      // Check for HTTP-level errors that might be retryable
      if (!response.ok) {
        const errorText = await response.text()
        const error = new Error(`HTTP ${response.status}: ${errorText}`)
        
        if (RETRY_CONFIG.retryableStatusCodes.includes(response.status) && attempt < RETRY_CONFIG.maxAttempts) {
          const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
          console.warn(`Warehouse: Monday API returned ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
          await sleep(delay)
          lastError = error
          continue
        }
        throw error
      }

      const data = await response.json()
      
      // Check for GraphQL-level errors
      if (data.errors) {
        const errorMessage = JSON.stringify(data.errors)
        const error = new Error(errorMessage)
        
        // Check if it's a rate limit error (retryable)
        if (errorMessage.toLowerCase().includes('rate limit') && attempt < RETRY_CONFIG.maxAttempts) {
          const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
          console.warn(`Warehouse: Monday API rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
          await sleep(delay)
          lastError = error
          continue
        }
        
        console.error('Monday API errors:', data.errors)
        throw error
      }

      // Success!
      if (attempt > 1) {
        console.log(`Warehouse: Monday API succeeded on attempt ${attempt}`)
      }
      return data.data as T

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      
      if (isRetryableError(err) && attempt < RETRY_CONFIG.maxAttempts) {
        const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
        console.warn(`Warehouse: Monday API error (${lastError.message}), retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
        await sleep(delay)
        continue
      }
      
      throw lastError
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error('Monday API failed after retries')
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
    // IMPORTANT: File uploads use a different endpoint and format!
    if (signatureBase64) {
      try {
        // Convert base64 to buffer
        const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, '')
        const imageBuffer = Buffer.from(base64Data, 'base64')

        // Create form data for file upload
        const FormData = (await import('form-data')).default

        // Monday.com file upload format (from their docs):
        // - Endpoint: /v2/file (not /v2)
        // - map: maps form field name to GraphQL variable path
        // - The mutation has update_id hardcoded, file as variable
        const query = `mutation ($file: File!) { add_file_to_update (update_id: ${updateId}, file: $file) { id } }`

        const token = process.env.MONDAY_API_TOKEN
        
        // Use the FILE endpoint, not the regular GraphQL endpoint
        // With retry logic for transient failures
        let uploadSuccess = false
        for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
          try {
            // Need to recreate form for each attempt (streams can only be read once)
            const retryForm = new FormData()
            retryForm.append('query', query)
            retryForm.append('map', JSON.stringify({ image: 'variables.file' }))
            retryForm.append('image', imageBuffer, {
              filename: `signature_${itemId}_${Date.now()}.png`,
              contentType: 'image/png',
            })

            const uploadResponse = await fetch('https://api.monday.com/v2/file', {
              method: 'POST',
              headers: {
                'Authorization': token!,
                ...retryForm.getHeaders(),
              },
              body: retryForm as unknown as BodyInit,
            })

            // Check for HTTP errors
            if (!uploadResponse.ok && RETRY_CONFIG.retryableStatusCodes.includes(uploadResponse.status)) {
              if (attempt < RETRY_CONFIG.maxAttempts) {
                const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
                console.warn(`Warehouse: File upload returned ${uploadResponse.status}, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
                await sleep(delay)
                continue
              }
            }

            // SAFE JSON PARSING: Read as text first to handle empty/malformed responses
            const responseText = await uploadResponse.text()
            
            if (!responseText) {
              console.warn(`Warehouse: File upload returned empty response (HTTP ${uploadResponse.status}), attempt ${attempt}/${RETRY_CONFIG.maxAttempts}`)
              if (attempt < RETRY_CONFIG.maxAttempts) {
                const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
                await sleep(delay)
                continue
              }
              break
            }

            let uploadResult: Record<string, unknown>
            try {
              uploadResult = JSON.parse(responseText)
            } catch {
              console.warn(`Warehouse: File upload returned non-JSON response (HTTP ${uploadResponse.status}): ${responseText.substring(0, 200)}`)
              if (attempt < RETRY_CONFIG.maxAttempts) {
                const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
                await sleep(delay)
                continue
              }
              break
            }
            
            if (uploadResult.errors) {
              // Check if rate limited
              const errorStr = JSON.stringify(uploadResult.errors)
              if (errorStr.toLowerCase().includes('rate limit') && attempt < RETRY_CONFIG.maxAttempts) {
                const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
                console.warn(`Warehouse: File upload rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
                await sleep(delay)
                continue
              }
              console.warn('Warehouse: Signature upload had errors:', errorStr)
            } else if ((uploadResult.data as Record<string, Record<string, string>>)?.add_file_to_update?.id) {
              console.log('Warehouse: Signature image uploaded to update successfully')
              uploadSuccess = true
            } else {
              console.warn('Warehouse: Signature upload response:', JSON.stringify(uploadResult))
            }
            break  // Exit retry loop on success or non-retryable error

          } catch (uploadErr) {
            if (isRetryableError(uploadErr) && attempt < RETRY_CONFIG.maxAttempts) {
              const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
              console.warn(`Warehouse: File upload error, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts}):`, uploadErr)
              await sleep(delay)
              continue
            }
            console.warn('Warehouse: Failed to upload signature image:', uploadErr)
            break
          }
        }
        
        if (!uploadSuccess) {
          console.warn('Warehouse: Signature upload did not succeed after retries, but continuing with completion')
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
 * Send delivery note email (with retry logic)
 */
async function sendDeliveryEmail(
  clientEmails: string[],
  clientName: string,
  jobDate: string,
  hhRef: string,
  pdfBuffer: Buffer
): Promise<boolean> {
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
  const mailOptions = {
    from: process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>',
    to: clientEmails.join(', '),
    subject: `📦 Delivery Note - Job ${hhRef} - ${formattedDate}`,
    html,
    attachments: [{
      filename: `Ooosh_Delivery_Note_${safeRef}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  }

  // Retry logic for email sending
  let lastError: Error | null = null
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      await transporter.sendMail(mailOptions)
      console.log(`Warehouse: Email sent to ${clientEmails.join(', ')}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      return true
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      
      // Check if retryable (connection errors, timeouts)
      const errorMessage = lastError.message.toLowerCase()
      const isRetryable = 
        errorMessage.includes('econnreset') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('etimedout') ||
        errorMessage.includes('socket') ||
        errorMessage.includes('timeout')
      
      if (isRetryable && attempt < RETRY_CONFIG.maxAttempts) {
        const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1)
        console.warn(`Warehouse: Email send failed (${lastError.message}), retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.maxAttempts})`)
        await sleep(delay)
        continue
      }
      
      console.error('Warehouse: Email send failed:', lastError)
      return false
    }
  }

  console.error('Warehouse: Email send failed after all retries:', lastError)
  return false
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