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
  const margin = 50
  const contentWidth = pageWidth - (margin * 2)
  
  // Colors
  const primaryColor = rgb(0.4, 0.49, 0.92)  // Purple-ish (matches Ooosh brand)
  const textColor = rgb(0.2, 0.2, 0.2)
  const lightGray = rgb(0.6, 0.6, 0.6)
  const tableHeaderBg = rgb(0.95, 0.95, 0.95)
  
  // Add first page
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let yPosition = pageHeight - margin
  
  // ==========================================================================
  // HEADER SECTION
  // ==========================================================================
  
  // Company name (since we can't easily load external images in all environments)
  page.drawText('OOOSH TOURS', {
    x: margin,
    y: yPosition,
    size: 24,
    font: helveticaBold,
    color: primaryColor,
  })
  
  // "Delivery Note" title on the right
  const titleText = 'Delivery Note'
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, 20)
  page.drawText(titleText, {
    x: pageWidth - margin - titleWidth,
    y: yPosition,
    size: 20,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= 15
  
  // Company address line
  page.drawText('Compass House, 7 East Street, Portslade, BN41 1DL', {
    x: margin,
    y: yPosition,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  yPosition -= 30
  
  // Divider line
  page.drawLine({
    start: { x: margin, y: yPosition },
    end: { x: pageWidth - margin, y: yPosition },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  })
  
  yPosition -= 25
  
  // ==========================================================================
  // JOB DETAILS SECTION
  // ==========================================================================
  
  // Two-column layout for job details
  const leftColX = margin
  const rightColX = pageWidth / 2 + 20
  const labelSize = 9
  const valueSize = 11
  const rowHeight = 18
  
  // Left column
  page.drawText('Job Reference:', {
    x: leftColX,
    y: yPosition,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(data.hhRef || 'N/A', {
    x: leftColX,
    y: yPosition - 12,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  // Right column
  page.drawText('Job Date:', {
    x: rightColX,
    y: yPosition,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(formatDateNice(data.jobDate), {
    x: rightColX,
    y: yPosition - 12,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= rowHeight + 20
  
  // Venue
  page.drawText('Venue:', {
    x: leftColX,
    y: yPosition,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(data.venueName || 'N/A', {
    x: leftColX,
    y: yPosition - 12,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  // Completed at
  page.drawText('Completed:', {
    x: rightColX,
    y: yPosition,
    size: labelSize,
    font: helvetica,
    color: lightGray,
  })
  page.drawText(formatDateTime(data.completedAt), {
    x: rightColX,
    y: yPosition - 12,
    size: valueSize,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= rowHeight + 20
  
  // Delivery address (if provided)
  if (data.deliveryAddress) {
    page.drawText('Delivery Address:', {
      x: leftColX,
      y: yPosition,
      size: labelSize,
      font: helvetica,
      color: lightGray,
    })
    
    // Wrap long addresses
    const addressLines = wrapText(data.deliveryAddress, 60)
    addressLines.forEach((line, index) => {
      page.drawText(line, {
        x: leftColX,
        y: yPosition - 12 - (index * 14),
        size: valueSize,
        font: helvetica,
        color: textColor,
      })
    })
    
    yPosition -= rowHeight + (addressLines.length * 14) + 10
  }
  
  yPosition -= 15
  
  // ==========================================================================
  // EQUIPMENT LIST SECTION
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
  
  // Table header background
  const tableHeaderHeight = 25
  page.drawRectangle({
    x: margin,
    y: yPosition - tableHeaderHeight + 5,
    width: contentWidth,
    height: tableHeaderHeight,
    color: tableHeaderBg,
  })
  
  // Table headers
  const qtyColWidth = 50
  const itemColWidth = contentWidth - qtyColWidth
  
  page.drawText('Item', {
    x: margin + 10,
    y: yPosition - 12,
    size: 10,
    font: helveticaBold,
    color: textColor,
  })
  
  page.drawText('Qty', {
    x: margin + itemColWidth + 15,
    y: yPosition - 12,
    size: 10,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= tableHeaderHeight + 5
  
  // Table rows
  const rowPadding = 8
  const itemFontSize = 10
  let currentCategory = ''
  
  for (const item of data.items) {
    // Check if we need a new page
    if (yPosition < margin + 100) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      yPosition = pageHeight - margin
      
      // Re-draw table header on new page
      page.drawRectangle({
        x: margin,
        y: yPosition - tableHeaderHeight + 5,
        width: contentWidth,
        height: tableHeaderHeight,
        color: tableHeaderBg,
      })
      
      page.drawText('Item', {
        x: margin + 10,
        y: yPosition - 12,
        size: 10,
        font: helveticaBold,
        color: textColor,
      })
      
      page.drawText('Qty', {
        x: margin + itemColWidth + 15,
        y: yPosition - 12,
        size: 10,
        font: helveticaBold,
        color: textColor,
      })
      
      yPosition -= tableHeaderHeight + 5
      currentCategory = '' // Reset category on new page
    }
    
    // Category header (if category changed)
    if (item.category && item.category !== currentCategory) {
      currentCategory = item.category
      yPosition -= 5
      
      page.drawText(item.category, {
        x: margin + 5,
        y: yPosition - rowPadding,
        size: 9,
        font: helveticaBold,
        color: primaryColor,
      })
      
      yPosition -= 18
    }
    
    // Item row
    // Wrap long item names
    const maxItemChars = 70
    const itemLines = item.name.length > maxItemChars 
      ? wrapText(item.name, maxItemChars)
      : [item.name]
    
    itemLines.forEach((line, index) => {
      page.drawText(line, {
        x: margin + 15,
        y: yPosition - rowPadding - (index * 12),
        size: itemFontSize,
        font: helvetica,
        color: textColor,
      })
    })
    
    // Quantity (only on first line)
    page.drawText(String(item.quantity), {
      x: margin + itemColWidth + 20,
      y: yPosition - rowPadding,
      size: itemFontSize,
      font: helvetica,
      color: textColor,
    })
    
    // Draw subtle row separator
    const rowBottom = yPosition - rowPadding - ((itemLines.length - 1) * 12) - 8
    page.drawLine({
      start: { x: margin, y: rowBottom },
      end: { x: pageWidth - margin, y: rowBottom },
      thickness: 0.5,
      color: rgb(0.9, 0.9, 0.9),
    })
    
    yPosition = rowBottom - 5
  }
  
  // ==========================================================================
  // SIGNATURE SECTION
  // ==========================================================================
  
  yPosition -= 30
  
  // Check if we need a new page for signature
  if (yPosition < margin + 120) {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    yPosition = pageHeight - margin
  }
  
  // Signature section header
  page.drawText('Acknowledgement of Delivery', {
    x: margin,
    y: yPosition,
    size: 12,
    font: helveticaBold,
    color: textColor,
  })
  
  yPosition -= 25
  
  // If we have a signature, embed it
  if (data.signatureBase64) {
    try {
      // Remove data URL prefix if present
      const base64Data = data.signatureBase64.replace(/^data:image\/\w+;base64,/, '')
      const signatureBytes = Buffer.from(base64Data, 'base64')
      
      // Embed the PNG image
      const signatureImage = await pdfDoc.embedPng(signatureBytes)
      
      // Scale signature to fit (max 200x80)
      const maxWidth = 200
      const maxHeight = 80
      const scale = Math.min(maxWidth / signatureImage.width, maxHeight / signatureImage.height)
      const scaledWidth = signatureImage.width * scale
      const scaledHeight = signatureImage.height * scale
      
      // Draw signature image
      page.drawImage(signatureImage, {
        x: margin,
        y: yPosition - scaledHeight,
        width: scaledWidth,
        height: scaledHeight,
      })
      
      yPosition -= scaledHeight + 10
      
      // "Signed by" text
      if (data.driverName) {
        page.drawText(`Received by customer - delivered by ${data.driverName}`, {
          x: margin,
          y: yPosition,
          size: 9,
          font: helvetica,
          color: lightGray,
        })
      }
    } catch (err) {
      console.error('Failed to embed signature image:', err)
      // Fall back to signature line
      drawSignatureLine(page, margin, yPosition, helvetica, lightGray)
    }
  } else {
    // No signature - draw signature line
    drawSignatureLine(page, margin, yPosition, helvetica, lightGray)
    yPosition -= 50
  }
  
  // ==========================================================================
  // FOOTER
  // ==========================================================================
  
  // Footer at bottom of last page
  const footerY = margin
  page.drawText('Thank you for choosing Ooosh Tours', {
    x: margin,
    y: footerY,
    size: 9,
    font: helvetica,
    color: lightGray,
  })
  
  page.drawText('www.oooshtours.co.uk', {
    x: pageWidth - margin - helvetica.widthOfTextAtSize('www.oooshtours.co.uk', 9),
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
 * Helper to draw signature line when no signature provided
 */
function drawSignatureLine(
  page: ReturnType<PDFDocument['addPage']>,
  x: number,
  y: number,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  color: ReturnType<typeof rgb>
): void {
  // Signature line
  page.drawLine({
    start: { x, y: y - 30 },
    end: { x: x + 200, y: y - 30 },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  })
  
  page.drawText('Signature', {
    x,
    y: y - 45,
    size: 9,
    font,
    color,
  })
  
  // Date line
  page.drawLine({
    start: { x: x + 250, y: y - 30 },
    end: { x: x + 400, y: y - 30 },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  })
  
  page.drawText('Date', {
    x: x + 250,
    y: y - 45,
    size: 9,
    font,
    color,
  })
}