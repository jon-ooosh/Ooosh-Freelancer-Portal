/**
 * Completion Background Function
 * 
 * Handles the "slow" parts of job completion that the freelancer
 * doesn't need to wait for:
 * 
 * - Fetches mirror data (client name, venue) from Monday
 * - Generates PDF delivery note (for deliveries with photos embedded)
 * - Sends client email (delivery note or collection confirmation)
 * - Fetches related upcoming jobs
 * - Sends driver notes alert to staff
 * 
 * Triggered by POST from the main completion API endpoint.
 * Runs independently - failures don't affect the freelancer's completion.
 */

import type { Handler } from '@netlify/functions'

// =============================================================================
// CONFIGURATION
// =============================================================================

const MONDAY_API_URL = 'https://api.monday.com/v2'
const STAFF_ALERT_EMAIL = 'info@oooshtours.co.uk'

// =============================================================================
// TYPES
// =============================================================================

interface BackgroundPayload {
  jobId: string
  jobName: string
  jobType: 'delivery' | 'collection'
  jobDate: string
  jobHhRef?: string
  jobVenueId?: string
  jobVenueAddress?: string
  driverEmail: string
  driverName: string
  notes: string | null
  customerPresent: boolean
  clientEmails: string[]
  sendClientEmail: boolean
  completedAt: string
  signatureBase64: string | null
  photos: string[]
}

interface HireHopItem {
  id: string
  name: string
  quantity: number
  category?: string
}

interface RelatedJob {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  time?: string
}

// =============================================================================
// MONDAY API HELPERS
// =============================================================================

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
  if (data.errors) throw new Error(JSON.stringify(data.errors))
  return data.data as T
}

// =============================================================================
// DATA FETCHING
// =============================================================================

async function getJobMirrorData(jobId: string): Promise<{ clientName?: string; venueName?: string }> {
  const boardId = process.env.MONDAY_BOARD_ID_DELIVERIES
  try {
    const query = `
      query ($boardId: [ID!]!, $itemId: [ID!]!) {
        boards(ids: $boardId) {
          items_page(query_params: { ids: $itemId }) {
            items {
              column_values(ids: ["lookup_mm01477j", "mirror467"]) {
                id
                text
                ... on MirrorValue { display_value }
              }
            }
          }
        }
      }
    `
    const result = await mondayQuery<{
      boards: Array<{ items_page: { items: Array<{ column_values: Array<{ id: string; text: string; display_value?: string }> }> } }>
    }>(query, { boardId: [boardId], itemId: [jobId] })
    
    const item = result.boards[0]?.items_page?.items?.[0]
    if (!item) return {}
    
    const data: { clientName?: string; venueName?: string } = {}
    for (const col of item.column_values) {
      const value = col.display_value ?? col.text
      if (col.id === 'lookup_mm01477j' && value?.trim()) data.clientName = value.trim()
      if (col.id === 'mirror467' && value?.trim()) data.venueName = value.trim()
    }
    return data
  } catch (err) {
    console.error('Background: Mirror data fetch failed:', err)
    return {}
  }
}

async function getRelatedUpcomingJobs(excludeJobId: string, venueId?: string, hhRef?: string): Promise<RelatedJob[]> {
  if (!venueId && !hhRef) return []
  const boardId = process.env.MONDAY_BOARD_ID_DELIVERIES
  
  try {
    const query = `
      query ($boardId: [ID!]!) {
        boards(ids: $boardId) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["date4", "hour", "status_1", "connect_boards6", "dup__of_hh_job_"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `
    const result = await mondayQuery<{
      boards: Array<{ items_page: { items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string; value: string }> }> } }>
    }>(query, { boardId: [boardId] })

    const items = result.boards[0]?.items_page?.items || []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    const related: RelatedJob[] = []
    for (const item of items) {
      if (item.id === excludeJobId) continue
      
      const cols: Record<string, string> = {}
      for (const c of item.column_values) cols[c.id] = c.text || ''
      
      const jobDate = cols['date4']
      if (!jobDate || new Date(jobDate) < today) continue
      
      let isRelated = false
      if (venueId) {
        try {
          const venueVal = item.column_values.find(c => c.id === 'connect_boards6')?.value
          if (venueVal) {
            const parsed = JSON.parse(venueVal)
            if (parsed?.linkedPulseIds?.some((p: { linkedPulseId: number }) => p.linkedPulseId.toString() === venueId)) {
              isRelated = true
            }
          }
        } catch { /* ignore */ }
      }
      if (!isRelated && hhRef && cols['dup__of_hh_job_'] === hhRef) isRelated = true
      
      if (isRelated) {
        related.push({
          id: item.id,
          name: item.name,
          type: cols['status_1']?.toLowerCase().includes('delivery') ? 'delivery' : 'collection',
          date: jobDate,
          time: cols['hour'] || undefined,
        })
      }
    }
    return related.slice(0, 5)
  } catch (err) {
    console.error('Background: Related jobs fetch failed:', err)
    return []
  }
}

/**
 * Fetch equipment items from HireHop via our internal API
 * 
 * NOTE: We pass the background secret header to authenticate,
 * since this server-to-server call doesn't have a user session.
 */
async function getHireHopItems(hhRef: string): Promise<HireHopItem[]> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
    const secret = process.env.BACKGROUND_FUNCTION_SECRET || process.env.MONDAY_WEBHOOK_SECRET
    
    console.log(`Background: Fetching HireHop items for job ${hhRef}`)
    
    const response = await fetch(`${appUrl}/api/hirehop/items/${hhRef}?filter=equipment`, {
      headers: secret ? { 'x-background-secret': secret } : {},
    })
    
    if (!response.ok) {
      console.error(`Background: HireHop fetch failed with status ${response.status}`)
      return []
    }
    
    const data = await response.json()
    console.log(`Background: HireHop returned ${data.items?.length || 0} items`)
    return data.items || []
  } catch (err) {
    console.error('Background: HireHop fetch error:', err)
    return []
  }
}

// =============================================================================
// EMAIL FUNCTIONS
// =============================================================================

async function sendEmail(to: string, subject: string, html: string, attachments?: Array<{ filename: string; content: Buffer; contentType: string }>): Promise<boolean> {
  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.default.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
    })
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>',
      to,
      subject,
      html,
      attachments,
    })
    return true
  } catch (err) {
    console.error('Background: Email send failed:', err)
    return false
  }
}

async function sendDriverNotesAlert(
  driverName: string,
  job: { id: string; name: string; type: 'delivery' | 'collection'; date: string; venue: string },
  notes: string,
  relatedJobs: RelatedJob[]
): Promise<boolean> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
  const typeLabel = job.type === 'delivery' ? 'Delivery' : 'Collection'
  const typeIcon = job.type === 'delivery' ? '📦' : '🚚'
  
  let relatedHtml = ''
  if (relatedJobs.length > 0) {
    const items = relatedJobs.map(rj => {
      const rjType = rj.type === 'delivery' ? 'Delivery' : 'Collection'
      const rjIcon = rj.type === 'delivery' ? '📦' : '🚚'
      return `<li style="margin:8px 0;padding:8px 0;border-bottom:1px solid #eee;">${rjIcon} <strong>${rjType}</strong> - ${rj.name.replace(/^(DEL|COL)\s*[-:]\s*/i, '')}<br><span style="color:#666;font-size:13px;">📅 ${rj.date}${rj.time ? ' at ' + rj.time : ''}</span></li>`
    }).join('')
    relatedHtml = `<div style="background:#fff3cd;border-radius:8px;padding:15px;margin-top:20px;border-left:4px solid #ffc107;"><h3 style="margin:0 0 10px 0;color:#856404;font-size:14px;">⚠️ Related Upcoming Jobs</h3><ul style="margin:0;padding-left:0;list-style:none;">${items}</ul></div>`
  }
  
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#17a2b8;padding:30px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:white;margin:0;font-size:24px;">📝 Driver Note Submitted</h1></div>
    <div style="background:#f8f9fa;padding:30px;border-radius:0 0 12px 12px;">
      <div style="background:white;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #17a2b8;">
        <h2 style="margin:0 0 15px 0;color:#333;font-size:18px;">${typeIcon} ${typeLabel} - ${job.venue}</h2>
        <p style="margin:8px 0;color:#555;"><strong>📅 Date:</strong> ${job.date}</p>
        <p style="margin:8px 0;color:#555;"><strong>👤 Driver:</strong> ${driverName}</p>
      </div>
      <div style="background:white;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #28a745;">
        <p style="margin:0 0 10px 0;color:#666;font-size:13px;">DRIVER'S NOTE</p>
        <p style="margin:0;color:#333;white-space:pre-wrap;">${notes}</p>
      </div>
      ${relatedHtml}
      <div style="text-align:center;margin-top:25px;"><a href="${appUrl}/job/${job.id}" style="display:inline-block;background:#17a2b8;color:white;text-decoration:none;padding:12px 30px;border-radius:6px;font-weight:600;">View Job in Portal</a></div>
    </div></body></html>`
  
  return sendEmail(STAFF_ALERT_EMAIL, `📝 Driver Note: ${typeLabel} - ${job.venue} - ${job.date}`, html)
}

async function sendClientDeliveryNote(clientEmails: string[], venueName: string, jobDate: string, hhRef: string, pdfBuffer: Buffer, clientName?: string): Promise<boolean> {
  const greeting = clientName ? `Hello ${clientName.split(' ')[0]},` : 'Hello,'
  const formattedDate = new Date(jobDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#7c5ce7;padding:30px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:white;margin:0;font-size:24px;">📦 Delivery Note</h1></div>
    <div style="background:#f8f9fa;padding:30px;border-radius:0 0 12px 12px;">
      <p style="font-size:16px;margin-bottom:20px;">${greeting}</p>
      <p style="font-size:16px;margin-bottom:20px;">Please find attached the delivery note for your recent equipment hire from Ooosh Tours.</p>
      <div style="background:white;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #7c5ce7;">
        <p style="margin:8px 0;color:#555;"><strong>📍 Venue:</strong> ${venueName}</p>
        <p style="margin:8px 0;color:#555;"><strong>📅 Date:</strong> ${formattedDate}</p>
        <p style="margin:8px 0;color:#555;"><strong>🔖 Job Reference:</strong> ${hhRef}</p>
      </div>
      <p style="font-size:14px;color:#666;">If you have any questions or notice any discrepancies, please get in touch asap.</p>
      <p style="font-size:14px;color:#555;margin-top:25px;">Many thanks,<br><strong>The Ooosh Tours Team</strong></p>
    </div></body></html>`
  
  const safeVenue = venueName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
  return sendEmail(clientEmails.join(', '), `📦 Delivery Note - ${venueName} - ${formattedDate} (Ref: ${hhRef})`, html, [{
    filename: `Ooosh_Delivery_Note_${hhRef}_${safeVenue}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }])
}

async function sendClientCollectionConfirmation(clientEmails: string[], venueName: string, jobDate: string, hhRef: string, clientName?: string): Promise<boolean> {
  const greeting = clientName ? `Hello ${clientName.split(' ')[0]},` : 'Hello,'
  const formattedDate = new Date(jobDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#7c5ce7;padding:30px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:white;margin:0;font-size:24px;">🚚 Collection Complete</h1></div>
    <div style="background:#f8f9fa;padding:30px;border-radius:0 0 12px 12px;">
      <p style="font-size:16px;margin-bottom:20px;">${greeting}</p>
      <p style="font-size:16px;margin-bottom:20px;">Just to let you know - we've collected the equipment for job <strong>${hhRef}</strong> from <strong>${venueName}</strong>.</p>
      <div style="background:white;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #7c5ce7;">
        <p style="margin:8px 0;color:#555;"><strong>📍 Venue:</strong> ${venueName}</p>
        <p style="margin:8px 0;color:#555;"><strong>📅 Collection Date:</strong> ${formattedDate}</p>
        <p style="margin:8px 0;color:#555;"><strong>🔖 Job Reference:</strong> ${hhRef}</p>
      </div>
      <div style="background:#fff8e6;border-radius:8px;padding:15px;margin-bottom:20px;border-left:4px solid #f59e0b;">
        <p style="margin:0;color:#92400e;font-size:14px;"><strong>📋 Please note:</strong> We'll verify that all items are present and in good condition once everything is back at our warehouse. We'll be in touch if there are any issues.</p>
      </div>
      <p style="font-size:14px;color:#555;margin-top:25px;">Cheers,<br><strong>The Ooosh Tours Team</strong></p>
    </div></body></html>`
  
  return sendEmail(clientEmails.join(', '), `🚚 Collection Complete - ${venueName} - ${formattedDate} (Ref: ${hhRef})`, html)
}

// =============================================================================
// PDF GENERATION
// =============================================================================

/**
 * Fetch logo image from the portal URL
 */
async function fetchLogoImage(): Promise<Uint8Array | null> {
  try {
    const logoUrl = 'https://ooosh-freelancer-portal.netlify.app/ooosh-tours-logo-small.png'
    const response = await fetch(logoUrl)
    if (!response.ok) {
      console.warn('Background: Failed to fetch logo:', response.status)
      return null
    }
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  } catch (err) {
    console.warn('Background: Error fetching logo:', err)
    return null
  }
}

async function generateDeliveryNotePdf(data: {
  hhRef: string; jobDate: string; completedAt: string; clientName?: string; venueName: string;
  items: HireHopItem[]; signatureBase64?: string; photos?: string[]; driverName?: string;
}): Promise<Buffer> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib')
  
  const pdfDoc = await PDFDocument.create()
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  
  // Page settings
  const pageWidth = 595.28  // A4 width in points
  const pageHeight = 841.89 // A4 height in points
  const margin = 40
  const contentWidth = pageWidth - margin * 2
  
  // Colors - Ooosh purple
  const primaryColor = rgb(0.486, 0.361, 0.906)  // #7c5ce7
  const textColor = rgb(0.2, 0.2, 0.2)
  const lightGray = rgb(0.5, 0.5, 0.5)
  const borderColor = rgb(0.85, 0.85, 0.85)
  const headerBg = rgb(0.96, 0.96, 0.98)
  
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin
  
  // ==========================================================================
  // HEADER SECTION - Logo, Title, Address, Job Number
  // ==========================================================================
  
  // Try to fetch and embed logo
  const logoBytes = await fetchLogoImage()
  let logoBottomY = y - 50  // Default if no logo
  
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
      console.log('Background: Logo embedded in PDF')
    } catch (err) {
      console.warn('Background: Failed to embed logo, using text fallback:', err)
      // Fallback to text
      page.drawText('OOOSH TOURS', {
        x: margin,
        y: y - 25,
        size: 22,
        font: helveticaBold,
        color: primaryColor,
      })
      logoBottomY = y - 30
    }
  } else {
    // Text fallback if logo fetch failed
    page.drawText('OOOSH TOURS', {
      x: margin,
      y: y - 25,
      size: 22,
      font: helveticaBold,
      color: primaryColor,
    })
    logoBottomY = y - 30
  }
  
  // "Delivery Note" title on the right - aligned with logo bottom
  const titleText = 'Delivery Note'
  const titleSize = 24
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, titleSize)
  page.drawText(titleText, {
    x: pageWidth - margin - titleWidth,
    y: logoBottomY + 5,  // Slightly above logo bottom for visual alignment
    size: titleSize,
    font: helveticaBold,
    color: primaryColor,
  })
  
  // Company address under the logo
  const addressY = logoBottomY - 12
  page.drawText('Compass House, 7 East Street, Portslade, BN41 1DL', {
    x: margin,
    y: addressY,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  // Job number on the right, below "Delivery Note"
  const jobNumText = `Job Number: ${data.hhRef}`
  const jobNumWidth = helvetica.widthOfTextAtSize(jobNumText, 9)
  page.drawText(jobNumText, {
    x: pageWidth - margin - jobNumWidth,
    y: addressY,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  y = addressY - 20
  
  // Thick purple divider line
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 2,
    color: primaryColor,
  })
  
  y -= 25
  
  // ==========================================================================
  // JOB DETAILS BOX
  // ==========================================================================
  
  const detailsBoxHeight = 80
  
  page.drawRectangle({
    x: margin,
    y: y - detailsBoxHeight,
    width: contentWidth,
    height: detailsBoxHeight,
    borderColor,
    borderWidth: 1,
    color: headerBg,
  })
  
  // Two-column layout
  const leftColX = margin + 15
  const rightColX = pageWidth / 2 + 20
  const labelSize = 9
  const valueSize = 11
  
  // Row 1: Client (left) and Job Date (right)
  const row1Y = y - 18
  
  if (data.clientName) {
    page.drawText('Client:', { x: leftColX, y: row1Y, size: labelSize, font: helvetica, color: lightGray })
    page.drawText(data.clientName, { x: leftColX, y: row1Y - 13, size: valueSize, font: helveticaBold, color: textColor })
  }
  
  page.drawText('Job Date:', { x: rightColX, y: row1Y, size: labelSize, font: helvetica, color: lightGray })
  page.drawText(new Date(data.jobDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), {
    x: rightColX, y: row1Y - 13, size: valueSize, font: helveticaBold, color: textColor
  })
  
  // Row 2: Venue (left) and Completed (right)
  const row2Y = row1Y - 32
  
  page.drawText('Venue:', { x: leftColX, y: row2Y, size: labelSize, font: helvetica, color: lightGray })
  page.drawText(data.venueName || 'N/A', { x: leftColX, y: row2Y - 13, size: valueSize, font: helveticaBold, color: textColor })
  
  page.drawText('Completed:', { x: rightColX, y: row2Y, size: labelSize, font: helvetica, color: lightGray })
  const completedDate = new Date(data.completedAt)
  page.drawText(`${completedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${completedDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, {
    x: rightColX, y: row2Y - 13, size: valueSize, font: helveticaBold, color: textColor
  })
  
  // Move past the details box with extra space before Equipment section
  y = y - detailsBoxHeight - 35  // Increased gap (was 20, now 35) for clear section separation
  
  // ==========================================================================
  // EQUIPMENT SECTION
  // ==========================================================================
  
  page.drawText('Equipment Delivered', {
    x: margin,
    y,
    size: 14,
    font: helveticaBold,
    color: textColor,
  })
  
  y -= 20  // Reduced gap between header and table (was 25)
  
  // Table header
  const tableHeaderHeight = 28
  page.drawRectangle({
    x: margin,
    y: y - tableHeaderHeight,
    width: contentWidth,
    height: tableHeaderHeight,
    color: headerBg,
    borderColor,
    borderWidth: 1,
  })
  
  page.drawText('Item', { x: margin + 10, y: y - 18, size: 10, font: helveticaBold, color: textColor })
  page.drawText('Qty', { x: pageWidth - margin - 40, y: y - 18, size: 10, font: helveticaBold, color: textColor })
  y -= tableHeaderHeight
  
  // Equipment rows
  for (const item of data.items) {
    if (y < margin + 150) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    
    // Draw row separator line
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageWidth - margin, y },
      thickness: 0.5,
      color: borderColor,
    })
    
    page.drawText(item.name.substring(0, 70), { x: margin + 10, y: y - 15, size: 10, font: helvetica, color: textColor })
    page.drawText(String(item.quantity), { x: pageWidth - margin - 35, y: y - 15, size: 10, font: helvetica, color: textColor })
    y -= 22
  }
  
  // Close the table with bottom border
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 1,
    color: borderColor,
  })
  
  // ==========================================================================
  // SIGNATURE SECTION
  // ==========================================================================
  
  y -= 30
  if (y < margin + 120) {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    y = pageHeight - margin
  }
  
  const sigBoxHeight = 100
  page.drawRectangle({
    x: margin,
    y: y - sigBoxHeight,
    width: contentWidth,
    height: sigBoxHeight,
    borderColor,
    borderWidth: 1,
  })
  
  page.drawText('Acknowledgement of Delivery', {
    x: margin + 15,
    y: y - 20,
    size: 11,
    font: helveticaBold,
    color: textColor,
  })
  
  if (data.signatureBase64) {
    try {
      const sigData = data.signatureBase64.replace(/^data:image\/\w+;base64,/, '')
      const sigBytes = Buffer.from(sigData, 'base64')
      const sigImg = await pdfDoc.embedPng(sigBytes)
      const scale = Math.min(180 / sigImg.width, 50 / sigImg.height)
      page.drawImage(sigImg, {
        x: margin + 15,
        y: y - 80,
        width: sigImg.width * scale,
        height: sigImg.height * scale,
      })
    } catch (err) {
      console.warn('Background: Failed to embed signature:', err)
    }
  }
  
  const receivedText = data.driverName
    ? `Received by customer - delivered by ${data.driverName}`
    : 'Received by customer'
  page.drawText(receivedText, {
    x: margin + 15,
    y: y - sigBoxHeight + 12,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  y -= sigBoxHeight + 20
  
  // ==========================================================================
  // PHOTOS SECTION (if any)
  // ==========================================================================
  
  if (data.photos && data.photos.length > 0) {
    if (y < margin + 250) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    
    page.drawText('Delivery Photos', {
      x: margin,
      y,
      size: 14,
      font: helveticaBold,
      color: textColor,
    })
    y -= 25
    
    const maxPhotoWidth = 250
    const maxPhotoHeight = 200
    
    for (let i = 0; i < data.photos.length; i++) {
      try {
        const photoData = data.photos[i].replace(/^data:image\/\w+;base64,/, '')
        const photoBytes = Buffer.from(photoData, 'base64')
        
        let photoImg
        try {
          photoImg = await pdfDoc.embedJpg(photoBytes)
        } catch {
          photoImg = await pdfDoc.embedPng(photoBytes)
        }
        
        const scale = Math.min(maxPhotoWidth / photoImg.width, maxPhotoHeight / photoImg.height)
        const w = photoImg.width * scale
        const h = photoImg.height * scale
        
        const col = i % 2
        const xPos = margin + col * (maxPhotoWidth + 20)
        
        if (col === 0 && i > 0) y -= maxPhotoHeight + 30
        if (y - h < margin) {
          page = pdfDoc.addPage([pageWidth, pageHeight])
          y = pageHeight - margin
        }
        
        page.drawRectangle({
          x: xPos - 2,
          y: y - h - 2,
          width: w + 4,
          height: h + 4,
          borderColor,
          borderWidth: 1,
        })
        page.drawImage(photoImg, { x: xPos, y: y - h, width: w, height: h })
        page.drawText(`Photo ${i + 1}`, { x: xPos, y: y - h - 15, size: 9, font: helvetica, color: lightGray })
      } catch (err) {
        console.warn(`Background: Failed to embed photo ${i + 1}:`, err)
      }
    }
  }
  
  // ==========================================================================
  // FOOTER
  // ==========================================================================
  
  const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1]
  lastPage.drawText('Thank you for choosing Ooosh Tours', {
    x: margin,
    y: margin - 10,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  const websiteText = 'www.oooshtours.co.uk'
  lastPage.drawText(websiteText, {
    x: pageWidth - margin - helvetica.widthOfTextAtSize(websiteText, 9),
    y: margin - 10,
    size: 9,
    font: helvetica,
    color: primaryColor,
  })
  
  return Buffer.from(await pdfDoc.save())
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export const handler: Handler = async (event) => {
  console.log('Background: Function started')
  
  // Verify secret
  const secret = event.headers['x-background-secret']
  const expected = process.env.BACKGROUND_FUNCTION_SECRET || process.env.MONDAY_WEBHOOK_SECRET
  if (!expected || secret !== expected) {
    console.error('Background: Unauthorized')
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }
  
  let payload: BackgroundPayload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload' }) }
  }
  
  const { jobId, jobName, jobType, jobDate, jobHhRef, jobVenueId, driverName, notes, customerPresent, clientEmails, sendClientEmail, completedAt, signatureBase64, photos } = payload
  console.log(`Background: Processing job ${jobId}, type=${jobType}, sendEmail=${sendClientEmail}, hasNotes=${!!notes}`)
  
  const results: Record<string, boolean | string> = {}
  
  try {
    // 1. Fetch mirror data
    const mirrorData = await getJobMirrorData(jobId)
    const venueName = mirrorData.venueName || jobName.replace(/^(DEL|COL)\s*[-:]\s*/i, '')
    const clientName = mirrorData.clientName
    console.log(`Background: venue="${venueName}", client="${clientName || 'N/A'}"`)
    results.mirrorData = true
    
    // 2. Send client email if requested
    if (sendClientEmail && clientEmails.length > 0) {
      console.log(`Background: Sending client ${jobType} email to ${clientEmails.join(', ')}`)
      
      if (jobType === 'delivery') {
        const items = jobHhRef ? await getHireHopItems(jobHhRef) : []
        console.log(`Background: Fetched ${items.length} equipment items for PDF`)
        
        const pdfBuffer = await generateDeliveryNotePdf({
          hhRef: jobHhRef || 'N/A',
          jobDate,
          completedAt,
          clientName,
          venueName,
          items,
          signatureBase64: signatureBase64 || undefined,
          photos: photos.length > 0 ? photos : undefined,
          driverName,
        })
        console.log(`Background: PDF generated (${pdfBuffer.length} bytes)`)
        
        results.clientEmail = await sendClientDeliveryNote(clientEmails, venueName, jobDate, jobHhRef || 'N/A', pdfBuffer, clientName)
      } else {
        results.clientEmail = await sendClientCollectionConfirmation(clientEmails, venueName, jobDate, jobHhRef || 'N/A', clientName)
      }
      console.log(`Background: Client email sent=${results.clientEmail}`)
    }
    
    // 3. Send driver notes alert if notes provided
    if (notes) {
      console.log('Background: Sending driver notes alert')
      const relatedJobs = await getRelatedUpcomingJobs(jobId, jobVenueId, jobHhRef)
      console.log(`Background: Found ${relatedJobs.length} related jobs`)
      
      const notesText = customerPresent ? notes : `Customer not present\n\n${notes}`
      const formattedDate = new Date(jobDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      
      results.driverNotesAlert = await sendDriverNotesAlert(
        driverName,
        { id: jobId, name: jobName, type: jobType, date: formattedDate, venue: venueName },
        notesText,
        relatedJobs
      )
      console.log(`Background: Driver notes alert sent=${results.driverNotesAlert}`)
    }
    
    console.log('Background: All tasks completed', results)
    return { statusCode: 200, body: JSON.stringify({ success: true, results }) }
    
  } catch (err) {
    console.error('Background: Error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error', results }) }
  }
}