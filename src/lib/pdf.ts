/**
 * PDF Generation Service
 * 
 * Generates PDF documents for:
 * - Delivery notes (sent to clients upon job completion)
 * 
 * Uses pdf-lib for pure JavaScript PDF generation (no external dependencies)
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// =============================================================================
// TYPES
// =============================================================================

export interface DeliveryNoteData {
  // Job details
  hhRef: string
  jobDate: string
  completedAt: string
  
  // Client info
  clientName?: string
  
  // Venue/delivery info
  venueName: string
  deliveryAddress?: string
  
  // Equipment
  items: Array<{
    name: string
    quantity: number
    category?: string
  }>
  
  // Signature (optional - base64 PNG)
  signatureBase64?: string
  
  // Photos (optional - array of base64 images)
  photos?: string[]
  
  // Driver info
  driverName?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format date nicely for PDF - e.g., "Monday, 27 January 2026"
 */
function formatDateNice(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  } catch {
    return dateStr
  }
}

/**
 * Format datetime for PDF - e.g., "27 Jan 2026 at 14:35"
 */
function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    
    const datePart = date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
    const timePart = date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    })
    
    return `${datePart} at ${timePart}`
  } catch {
    return dateStr
  }
}

/**
 * Wrap text to fit within a given width
 * Returns an array of lines
 */
function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''
  
  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxCharsPerLine) {
      currentLine += (currentLine ? ' ' : '') + word
    } else {
      if (currentLine) lines.push(currentLine)
      currentLine = word
    }
  }
  if (currentLine) lines.push(currentLine)
  
  return lines
}

/**
 * Fetch logo image from URL and return as bytes
 */
async function fetchLogoImage(): Promise<Uint8Array | null> {
  try {
    const logoUrl = 'https://ooosh-freelancer-portal.netlify.app/ooosh-tours-logo-small.png'
    const response = await fetch(logoUrl)
    if (!response.ok) {
      console.warn('Failed to fetch logo:', response.status)
      return null
    }
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  } catch (err) {
    console.warn('Error fetching logo:', err)
    return null
  }
}

// =============================================================================
// PDF GENERATION
// =============================================================================

/**
 * Generate a delivery note PDF
 * 
 * @param data - The delivery note data
 * @returns Buffer containing the PDF
 */
export async function generateDeliveryNotePdf(data: DeliveryNoteData): Promise<Buffer> {
  // Create a new PDF document
  const pdfDoc = await PDFDocument.create()
  
  // Embed fonts
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  
  // Page settings
  const pageWidth = 595.28  // A4 width in points
  const pageHeight = 841.89 // A4 height in points
  const margin = 40
  const contentWidth = pageWidth - (margin * 2)
  
  // Colors - Ooosh purple (matching logo)
  const primaryColor = rgb(0.486, 0.361, 0.906)  // #7c5ce7 - Ooosh purple
  const textColor = rgb(0.2, 0.2, 0.2)
  const lightGray = rgb(0.5, 0.5, 0.5)
  const borderColor = rgb(0.85, 0.85, 0.85)
  const headerBg = rgb(0.96, 0.96, 0.98)
  
  // Add first page
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let yPosition = pageHeight - margin
  
  // ==========================================================================
  // HEADER SECTION - HireHop style with logo
  // ==========================================================================
  
  // Try to fetch and embed logo
  const logoBytes = await fetchLogoImage()
  let logoHeight = 50
  
  if (logoBytes) {
    try {
      const logoImage = await pdfDoc.embedPng(logoBytes)
      const logoAspect = logoImage.width / logoImage.height
      const logoDisplayHeight = 50
      const logoDisplayWidth = logoDisplayHeight * logoAspect
      
      page.drawImage(logoImage, {
        x: margin,
        y: yPosition - logoDisplayHeight,
        width: logoDisplayWidth,
        height: logoDisplayHeight,
      })
      logoHeight = logoDisplayHeight
    } catch (err) {
      console.warn('Failed to embed logo, using text fallback:', err)
      // Fallback to text
      page.drawText('OOOSH TOURS', {
        x: margin,
        y: yPosition - 25,
        size: 22,
        font: helveticaBold,
        color: primaryColor,
      })
    }
  } else {
    // Text fallback
    page.drawText('OOOSH TOURS', {
      x: margin,
      y: yPosition - 25,
      size: 22,
      font: helveticaBold,
      color: primaryColor,
    })
  }
  
  // "Delivery Note" title on the right - SOLID PURPLE to match logo
  const titleText = 'Delivery Note'
  const titleSize = 24
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, titleSize)
  page.drawText(titleText, {
    x: pageWidth - margin - titleWidth,
    y: yPosition - 30,
    size: titleSize,
    font: helveticaBold,
    color: primaryColor,
  })
  
  yPosition -= logoHeight + 10
  
  // Company details line
  page.drawText('Compass House, 7 East Street, Portslade, BN41 1DL', {
    x: margin,
    y: yPosition,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  // Job number on the right
  const jobNumText = `Job Number: ${data.hhRef}`
  const jobNumWidth = helvetica.widthOfTextAtSize(jobNumText, 9)
  page.drawText(jobNumText, {
    x: pageWidth - margin - jobNumWidth,
    y: yPosition,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  yPosition -= 25
  
  // Thick divider line
  page.drawLine({
    start: { x: margin, y: yPosition },
    end: { x: pageWidth - margin, y: yPosition },
    thickness: 2,
    color: primaryColor,
  })
  
  yPosition -= 25
  
  // ==========================================================================
  // JOB DETAILS SECTION - in a bordered box with proper two-column layout
  // ==========================================================================
  
  const detailsBoxTop = yPosition
  const detailsBoxHeight = 80  // Fixed height for consistent layout
  
  // Draw box border
  page.drawRectangle({
    x: margin,
    y: yPosition - detailsBoxHeight,
    width: contentWidth,
    height: detailsBoxHeight,
    borderColor: borderColor,
    borderWidth: 1,
    color: headerBg,
  })
  
  // Two-column layout - calculate positions
  const leftColX = margin + 15
  const rightColX = pageWidth / 2 + 20
  const labelSize = 9
  const valueSize = 11
  const rowHeight = 32  // Height for each row (label + value)
  
  // Row 1: Client (left) and Job Date (right)
  const row1Y = detailsBoxTop - 18
  
  if (data.clientName) {
    page.drawText('Client:', {
      x: leftColX,
      y: row1Y,
      size: labelSize,
      font: helvetica,
      color: lightGray,
    })
    page.drawText(data.clientName, {
      x: leftColX,
      y: row1Y - 13,
      size: valueSize,
      font: helveticaBold,
      color: textColor,
    })
  } else {
    // If no client, put venue in row 1
    page.drawText('Venue:', {
      x: leftColX,
      y: row1Y,
      size: labelSize,
      font: helvetica,
      color: lightGray,
    })
    page.drawText(data.venueName || 'N/A', {
      x: leftColX,
      y: row1Y - 13,
      size: valueSize,
      font: helveticaBold,
      color: textColor,
    })
  }
  
  page.drawText('Job Date:', {
    x: rightColX,
    y: row1Y,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(formatDateNice(data.jobDate), {
    x: rightColX,
    y: row1Y - 13,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  // Row 2: Venue (left) and Completed (right) - only if we have client name
  const row2Y = row1Y - rowHeight
  
  if (data.clientName) {
    page.drawText('Venue:', {
      x: leftColX,
      y: row2Y,
      size: labelSize,
      font: helvetica,
      color: lightGray,
    })
    page.drawText(data.venueName || 'N/A', {
      x: leftColX,
      y: row2Y - 13,
      size: valueSize,
      font: helveticaBold,
      color: textColor,
    })
  }
  
  page.drawText('Completed:', {
    x: rightColX,
    y: row2Y,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(formatDateTime(data.completedAt), {
    x: rightColX,
    y: row2Y - 13,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition = detailsBoxTop - detailsBoxHeight - 20
  
  // Delivery address (if provided) - outside the box
  if (data.deliveryAddress) {
    page.drawText('Delivery Address:', {
      x: margin,
      y: yPosition,
      size: labelSize,
      font: helvetica,
      color: lightGray,
    })
    
    const addressLines = wrapText(data.deliveryAddress, 80)
    addressLines.forEach((line, index) => {
      page.drawText(line, {
        x: margin,
        y: yPosition - 13 - (index * 13),
        size: valueSize,
        font: helvetica,
        color: textColor,
      })
    })
    
    yPosition -= 15 + (addressLines.length * 13) + 10
  }
  
  // ==========================================================================
  // EQUIPMENT LIST SECTION - in a bordered box
  // ==========================================================================
  
  // Section header
  page.drawText('Equipment Delivered', {
    x: margin,
    y: yPosition,
    size: 14,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= 20
  
  // Calculate table height needed
  const tableRowHeight = 22
  const tableHeaderHeight = 28
  const itemCount = data.items.length
  const estimatedTableHeight = tableHeaderHeight + (itemCount * tableRowHeight) + 20
  
  // Draw table border
  const tableTop = yPosition
  const tableBottom = Math.max(yPosition - estimatedTableHeight, margin + 150) // Leave room for signature
  
  page.drawRectangle({
    x: margin,
    y: tableBottom,
    width: contentWidth,
    height: tableTop - tableBottom,
    borderColor: borderColor,
    borderWidth: 1,
  })
  
  // Table header
  const qtyColWidth = 50
  const itemColX = margin + 10
  const qtyColX = pageWidth - margin - qtyColWidth
  
  page.drawRectangle({
    x: margin,
    y: yPosition - tableHeaderHeight,
    width: contentWidth,
    height: tableHeaderHeight,
    color: headerBg,
    borderColor: borderColor,
    borderWidth: 1,
  })
  
  page.drawText('Item', {
    x: itemColX,
    y: yPosition - 18,
    size: 10,
    font: helveticaBold,
    color: textColor,
  })
  
  page.drawText('Qty', {
    x: qtyColX + 10,
    y: yPosition - 18,
    size: 10,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= tableHeaderHeight
  
  // Table rows
  let currentCategory = ''
  
  for (const item of data.items) {
    // Check if we need a new page
    if (yPosition < margin + 150) {
      // Draw closing border for current table
      page.drawLine({
        start: { x: margin, y: yPosition },
        end: { x: pageWidth - margin, y: yPosition },
        thickness: 1,
        color: borderColor,
      })
      
      page = pdfDoc.addPage([pageWidth, pageHeight])
      yPosition = pageHeight - margin
      
      // Re-draw table header on new page
      page.drawRectangle({
        x: margin,
        y: yPosition - tableHeaderHeight,
        width: contentWidth,
        height: tableHeaderHeight,
        color: headerBg,
        borderColor: borderColor,
        borderWidth: 1,
      })
      
      page.drawText('Item (continued)', {
        x: itemColX,
        y: yPosition - 18,
        size: 10,
        font: helveticaBold,
        color: textColor,
      })
      
      page.drawText('Qty', {
        x: qtyColX + 10,
        y: yPosition - 18,
        size: 10,
        font: helveticaBold,
        color: textColor,
      })
      
      yPosition -= tableHeaderHeight
      currentCategory = ''
    }
    
    // Category header (if category changed)
    if (item.category && item.category !== currentCategory) {
      currentCategory = item.category
      yPosition -= 5
      
      page.drawText(item.category, {
        x: itemColX,
        y: yPosition - 12,
        size: 9,
        font: helveticaBold,
        color: primaryColor,
      })
      
      yPosition -= 18
    }
    
    // Item row
    const itemLines = item.name.length > 65 
      ? wrapText(item.name, 65)
      : [item.name]
    
    itemLines.forEach((line, index) => {
      page.drawText(line, {
        x: itemColX + 10,
        y: yPosition - 12 - (index * 12),
        size: 10,
        font: helvetica,
        color: textColor,
      })
    })
    
    // Quantity (only on first line)
    page.drawText(String(item.quantity), {
      x: qtyColX + 15,
      y: yPosition - 12,
      size: 10,
      font: helvetica,
      color: textColor,
    })
    
    // Row separator
    const rowBottom = yPosition - 10 - ((itemLines.length - 1) * 12) - 8
    page.drawLine({
      start: { x: margin + 5, y: rowBottom },
      end: { x: pageWidth - margin - 5, y: rowBottom },
      thickness: 0.5,
      color: rgb(0.92, 0.92, 0.92),
    })
    
    yPosition = rowBottom - 2
  }
  
  // Close the table box
  yPosition -= 10
  
  // ==========================================================================
  // SIGNATURE SECTION - in a bordered box
  // ==========================================================================
  
  yPosition -= 20
  
  // Check if we need a new page for signature
  if (yPosition < margin + 100) {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    yPosition = pageHeight - margin
  }
  
  // Signature box
  const sigBoxTop = yPosition
  const sigBoxHeight = 100
  
  page.drawRectangle({
    x: margin,
    y: yPosition - sigBoxHeight,
    width: contentWidth,
    height: sigBoxHeight,
    borderColor: borderColor,
    borderWidth: 1,
  })
  
  // Section header inside box
  page.drawText('Acknowledgement of Delivery', {
    x: margin + 15,
    y: yPosition - 20,
    size: 11,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= 35
  
  // If we have a signature, embed it
  if (data.signatureBase64) {
    try {
      const base64Data = data.signatureBase64.replace(/^data:image\/\w+;base64,/, '')
      const signatureBytes = Buffer.from(base64Data, 'base64')
      const signatureImage = await pdfDoc.embedPng(signatureBytes)
      
      // Scale signature to fit
      const maxWidth = 180
      const maxHeight = 50
      const scale = Math.min(maxWidth / signatureImage.width, maxHeight / signatureImage.height)
      const scaledWidth = signatureImage.width * scale
      const scaledHeight = signatureImage.height * scale
      
      page.drawImage(signatureImage, {
        x: margin + 15,
        y: yPosition - scaledHeight,
        width: scaledWidth,
        height: scaledHeight,
      })
      
      // "Received by customer" text
      const receivedText = data.driverName 
        ? `Received by customer - delivered by ${data.driverName}`
        : 'Received by customer'
      
      page.drawText(receivedText, {
        x: margin + 15,
        y: sigBoxTop - sigBoxHeight + 12,
        size: 9,
        font: helvetica,
        color: lightGray,
      })
    } catch (err) {
      console.error('Failed to embed signature image:', err)
      drawSignatureLines(page, margin + 15, yPosition, sigBoxTop - sigBoxHeight + 12, helvetica, lightGray)
    }
  } else {
    // No signature - draw signature and date lines
    drawSignatureLines(page, margin + 15, yPosition, sigBoxTop - sigBoxHeight + 12, helvetica, lightGray)
  }
  
  yPosition = sigBoxTop - sigBoxHeight - 20
  
  // ==========================================================================
  // PHOTOS SECTION (if any photos provided)
  // ==========================================================================
  
  if (data.photos && data.photos.length > 0) {
    // Check if we need a new page for photos
    if (yPosition < margin + 200) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      yPosition = pageHeight - margin
    }
    
    // Section header
    page.drawText('Delivery Photos', {
      x: margin,
      y: yPosition,
      size: 14,
      font: helveticaBold,
      color: textColor,
    })
    
    yPosition -= 25
    
    // Embed each photo
    const maxPhotoWidth = 250
    const maxPhotoHeight = 200
    const photosPerRow = 2
    const photoSpacing = 20
    
    for (let i = 0; i < data.photos.length; i++) {
      try {
        const photoBase64 = data.photos[i].replace(/^data:image\/\w+;base64,/, '')
        const photoBytes = Buffer.from(photoBase64, 'base64')
        
        // Try to embed as JPEG first, then PNG
        let photoImage
        try {
          photoImage = await pdfDoc.embedJpg(photoBytes)
        } catch {
          // If JPEG fails, try PNG
          photoImage = await pdfDoc.embedPng(photoBytes)
        }
        
        // Calculate scaled dimensions
        const photoAspect = photoImage.width / photoImage.height
        let scaledWidth = maxPhotoWidth
        let scaledHeight = scaledWidth / photoAspect
        
        if (scaledHeight > maxPhotoHeight) {
          scaledHeight = maxPhotoHeight
          scaledWidth = scaledHeight * photoAspect
        }
        
        // Calculate position (2 photos per row)
        const colIndex = i % photosPerRow
        const xPos = margin + (colIndex * (maxPhotoWidth + photoSpacing))
        
        // Check if we need a new row or new page
        if (colIndex === 0 && i > 0) {
          yPosition -= maxPhotoHeight + photoSpacing + 20
        }
        
        if (yPosition - scaledHeight < margin) {
          page = pdfDoc.addPage([pageWidth, pageHeight])
          yPosition = pageHeight - margin
        }
        
        // Draw photo with border
        page.drawRectangle({
          x: xPos - 2,
          y: yPosition - scaledHeight - 2,
          width: scaledWidth + 4,
          height: scaledHeight + 4,
          borderColor: borderColor,
          borderWidth: 1,
        })
        
        page.drawImage(photoImage, {
          x: xPos,
          y: yPosition - scaledHeight,
          width: scaledWidth,
          height: scaledHeight,
        })
        
        // Photo label
        page.drawText(`Photo ${i + 1}`, {
          x: xPos,
          y: yPosition - scaledHeight - 15,
          size: 9,
          font: helvetica,
          color: lightGray,
        })
        
      } catch (err) {
        console.error(`Failed to embed photo ${i + 1}:`, err)
        // Continue with other photos
      }
    }
    
    yPosition -= maxPhotoHeight + 30
  }
  
  // ==========================================================================
  // FOOTER
  // ==========================================================================
  
  // Get the last page for footer
  const pages = pdfDoc.getPages()
  const lastPage = pages[pages.length - 1]
  
  const footerY = margin - 10
  lastPage.drawText('Thank you for choosing Ooosh Tours', {
    x: margin,
    y: footerY,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  const websiteText = 'www.oooshtours.co.uk'
  lastPage.drawText(websiteText, {
    x: pageWidth - margin - helvetica.widthOfTextAtSize(websiteText, 9),
    y: footerY,
    size: 9,
    font: helvetica,
    color: primaryColor,
  })
  
  // Serialize the PDF to bytes
  const pdfBytes = await pdfDoc.save()
  
  return Buffer.from(pdfBytes)
}

/**
 * Helper to draw signature and date lines when no signature provided
 */
function drawSignatureLines(
  page: ReturnType<PDFDocument['addPage']>,
  x: number,
  y: number,
  bottomY: number,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  color: ReturnType<typeof rgb>
): void {
  // Signature line
  page.drawLine({
    start: { x, y: y - 25 },
    end: { x: x + 180, y: y - 25 },
    thickness: 1,
    color: rgb(0.75, 0.75, 0.75),
  })
  
  page.drawText('Signature', {
    x,
    y: bottomY,
    size: 9,
    font,
    color,
  })
  
  // Date line
  page.drawLine({
    start: { x: x + 220, y: y - 25 },
    end: { x: x + 350, y: y - 25 },
    thickness: 1,
    color: rgb(0.75, 0.75, 0.75),
  })
  
  page.drawText('Date', {
    x: x + 220,
    y: bottomY,
    size: 9,
    font,
    color,
  })
}