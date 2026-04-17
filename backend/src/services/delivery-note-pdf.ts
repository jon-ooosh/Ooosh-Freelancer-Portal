/**
 * Delivery Note PDF Service
 *
 * Generates signed delivery notes for client emails on D&C job completion.
 * Ported from the Next.js freelancer portal (src/lib/pdf.ts) — same
 * visual layout, Ooosh-branded, photos + signature embedded.
 *
 * Logo is loaded from R2 via the shared fetchLogo helper in hire-form-pdf.ts.
 */
import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from 'pdf-lib';
import { fetchLogo } from './hire-form-pdf';

export interface DeliveryNoteItem {
  name: string;
  quantity: number;
  category?: string;
}

export interface DeliveryNoteData {
  hhRef: string;
  jobDate: string;
  completedAt: string;
  clientName?: string;
  venueName: string;
  deliveryAddress?: string;
  items: DeliveryNoteItem[];
  /** Base64 data URL or raw PNG bytes for customer signature */
  signature?: string | Buffer | null;
  /** Array of base64 data URLs or raw bytes for delivery photos */
  photos?: Array<string | Buffer>;
  driverName?: string;
}

function formatDateNice(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const datePart = d.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const timePart = d.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit',
    });
    return `${datePart} at ${timePart}`;
  } catch {
    return dateStr;
  }
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 <= maxCharsPerLine) {
      current += (current ? ' ' : '') + word;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Normalise an image input (base64 data URL or Buffer) to a Buffer */
function toImageBuffer(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  const base64 = input.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

function drawSignatureLines(
  page: PDFPage,
  x: number,
  y: number,
  bottomY: number,
  font: PDFFont,
  color: ReturnType<typeof rgb>
): void {
  page.drawLine({
    start: { x, y: y - 25 },
    end: { x: x + 180, y: y - 25 },
    thickness: 1,
    color: rgb(0.75, 0.75, 0.75),
  });
  page.drawText('Signature', { x, y: bottomY, size: 9, font, color });
  page.drawLine({
    start: { x: x + 220, y: y - 25 },
    end: { x: x + 350, y: y - 25 },
    thickness: 1,
    color: rgb(0.75, 0.75, 0.75),
  });
  page.drawText('Date', { x: x + 220, y: bottomY, size: 9, font, color });
}

/**
 * Generate a delivery-note PDF. Returns the raw bytes.
 */
export async function generateDeliveryNotePdf(data: DeliveryNoteData): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;

  const primaryColor = rgb(0.486, 0.361, 0.906);
  const textColor = rgb(0.2, 0.2, 0.2);
  const lightGray = rgb(0.5, 0.5, 0.5);
  const borderColor = rgb(0.85, 0.85, 0.85);
  const headerBg = rgb(0.96, 0.96, 0.98);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let yPosition = pageHeight - margin;

  // ── Header ────────────────────────────────────────────────────────
  const logoBytes = await fetchLogo().catch(() => null);
  let logoHeight = 50;

  if (logoBytes) {
    try {
      const logoImage = await pdfDoc.embedPng(logoBytes);
      const aspect = logoImage.width / logoImage.height;
      const h = 50;
      const w = h * aspect;
      page.drawImage(logoImage, {
        x: margin, y: yPosition - h, width: w, height: h,
      });
      logoHeight = h;
    } catch (err) {
      console.warn('[delivery-note-pdf] Logo embed failed, text fallback:', err);
      page.drawText('OOOSH TOURS', {
        x: margin, y: yPosition - 25, size: 22, font: helveticaBold, color: primaryColor,
      });
    }
  } else {
    page.drawText('OOOSH TOURS', {
      x: margin, y: yPosition - 25, size: 22, font: helveticaBold, color: primaryColor,
    });
  }

  const titleText = 'Delivery Note';
  const titleSize = 24;
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: pageWidth - margin - titleWidth,
    y: yPosition - 30,
    size: titleSize,
    font: helveticaBold,
    color: primaryColor,
  });

  yPosition -= logoHeight + 10;

  page.drawText('Compass House, 7 East Street, Portslade, BN41 1DL', {
    x: margin, y: yPosition, size: 9, font: helvetica, color: lightGray,
  });
  const jobNumText = `Job Number: ${data.hhRef}`;
  const jobNumWidth = helvetica.widthOfTextAtSize(jobNumText, 9);
  page.drawText(jobNumText, {
    x: pageWidth - margin - jobNumWidth, y: yPosition, size: 9, font: helvetica, color: lightGray,
  });

  yPosition -= 25;

  page.drawLine({
    start: { x: margin, y: yPosition },
    end: { x: pageWidth - margin, y: yPosition },
    thickness: 2,
    color: primaryColor,
  });

  yPosition -= 25;

  // ── Job details box ──────────────────────────────────────────────
  const detailsBoxTop = yPosition;
  const detailsBoxHeight = 80;

  page.drawRectangle({
    x: margin,
    y: yPosition - detailsBoxHeight,
    width: contentWidth,
    height: detailsBoxHeight,
    borderColor,
    borderWidth: 1,
    color: headerBg,
  });

  const leftColX = margin + 15;
  const rightColX = pageWidth / 2 + 20;
  const labelSize = 9;
  const valueSize = 11;
  const rowHeight = 32;
  const row1Y = detailsBoxTop - 18;

  if (data.clientName) {
    page.drawText('Client:', { x: leftColX, y: row1Y, size: labelSize, font: helvetica, color: lightGray });
    page.drawText(data.clientName, { x: leftColX, y: row1Y - 13, size: valueSize, font: helveticaBold, color: textColor });
  } else {
    page.drawText('Venue:', { x: leftColX, y: row1Y, size: labelSize, font: helvetica, color: lightGray });
    page.drawText(data.venueName || 'N/A', { x: leftColX, y: row1Y - 13, size: valueSize, font: helveticaBold, color: textColor });
  }

  page.drawText('Job Date:', { x: rightColX, y: row1Y, size: labelSize, font: helvetica, color: lightGray });
  page.drawText(formatDateNice(data.jobDate), { x: rightColX, y: row1Y - 13, size: valueSize, font: helveticaBold, color: textColor });

  const row2Y = row1Y - rowHeight;
  if (data.clientName) {
    page.drawText('Venue:', { x: leftColX, y: row2Y, size: labelSize, font: helvetica, color: lightGray });
    page.drawText(data.venueName || 'N/A', { x: leftColX, y: row2Y - 13, size: valueSize, font: helveticaBold, color: textColor });
  }

  page.drawText('Completed:', { x: rightColX, y: row2Y, size: labelSize, font: helvetica, color: lightGray });
  page.drawText(formatDateTime(data.completedAt), { x: rightColX, y: row2Y - 13, size: valueSize, font: helveticaBold, color: textColor });

  yPosition = detailsBoxTop - detailsBoxHeight - 20;

  if (data.deliveryAddress) {
    page.drawText('Delivery Address:', {
      x: margin, y: yPosition, size: labelSize, font: helvetica, color: lightGray,
    });
    // Venue addresses often arrive with literal newlines. pdf-lib's drawText
    // renders "\n" as extra lines WITHIN a single draw call but our yPosition
    // accounting wasn't tracking those — the address bled into the equipment
    // table. Split on newlines first, THEN wrap each piece by width, then
    // draw line-by-line so the height matches the actual rendered output.
    const addressLines: string[] = [];
    for (const rawLine of data.deliveryAddress.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      addressLines.push(...wrapText(trimmed, 80));
    }
    addressLines.forEach((line, idx) => {
      page.drawText(line, {
        x: margin, y: yPosition - 13 - idx * 13, size: valueSize, font: helvetica, color: textColor,
      });
    });
    yPosition -= 15 + addressLines.length * 13 + 10;
  }

  // ── Equipment table ──────────────────────────────────────────────
  page.drawText('Equipment Delivered', {
    x: margin, y: yPosition, size: 14, font: helveticaBold, color: textColor,
  });
  yPosition -= 20;

  const tableRowHeight = 22;
  const tableHeaderHeight = 28;
  const estimatedTableHeight = tableHeaderHeight + data.items.length * tableRowHeight + 20;
  const tableTop = yPosition;
  const tableBottom = Math.max(yPosition - estimatedTableHeight, margin + 150);

  page.drawRectangle({
    x: margin, y: tableBottom, width: contentWidth, height: tableTop - tableBottom,
    borderColor, borderWidth: 1,
  });

  const qtyColWidth = 50;
  const itemColX = margin + 10;
  const qtyColX = pageWidth - margin - qtyColWidth;

  page.drawRectangle({
    x: margin, y: yPosition - tableHeaderHeight, width: contentWidth, height: tableHeaderHeight,
    color: headerBg, borderColor, borderWidth: 1,
  });
  page.drawText('Item', { x: itemColX, y: yPosition - 18, size: 10, font: helveticaBold, color: textColor });
  page.drawText('Qty', { x: qtyColX + 10, y: yPosition - 18, size: 10, font: helveticaBold, color: textColor });

  yPosition -= tableHeaderHeight;

  let currentCategory = '';

  for (const item of data.items) {
    if (yPosition < margin + 150) {
      page.drawLine({
        start: { x: margin, y: yPosition },
        end: { x: pageWidth - margin, y: yPosition },
        thickness: 1, color: borderColor,
      });
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      yPosition = pageHeight - margin;
      page.drawRectangle({
        x: margin, y: yPosition - tableHeaderHeight, width: contentWidth, height: tableHeaderHeight,
        color: headerBg, borderColor, borderWidth: 1,
      });
      page.drawText('Item (continued)', { x: itemColX, y: yPosition - 18, size: 10, font: helveticaBold, color: textColor });
      page.drawText('Qty', { x: qtyColX + 10, y: yPosition - 18, size: 10, font: helveticaBold, color: textColor });
      yPosition -= tableHeaderHeight;
      currentCategory = '';
    }

    if (item.category && item.category !== currentCategory) {
      currentCategory = item.category;
      yPosition -= 5;
      page.drawText(item.category, {
        x: itemColX, y: yPosition - 12, size: 9, font: helveticaBold, color: primaryColor,
      });
      yPosition -= 18;
    }

    const itemLines = item.name.length > 65 ? wrapText(item.name, 65) : [item.name];
    itemLines.forEach((line, idx) => {
      page.drawText(line, {
        x: itemColX + 10, y: yPosition - 12 - idx * 12, size: 10, font: helvetica, color: textColor,
      });
    });
    page.drawText(String(item.quantity), {
      x: qtyColX + 15, y: yPosition - 12, size: 10, font: helvetica, color: textColor,
    });

    const rowBottom = yPosition - 10 - (itemLines.length - 1) * 12 - 8;
    page.drawLine({
      start: { x: margin + 5, y: rowBottom },
      end: { x: pageWidth - margin - 5, y: rowBottom },
      thickness: 0.5,
      color: rgb(0.92, 0.92, 0.92),
    });
    yPosition = rowBottom - 2;
  }

  yPosition -= 10;

  // ── Signature box ────────────────────────────────────────────────
  yPosition -= 20;
  if (yPosition < margin + 100) {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    yPosition = pageHeight - margin;
  }

  const sigBoxTop = yPosition;
  const sigBoxHeight = 100;

  page.drawRectangle({
    x: margin, y: yPosition - sigBoxHeight, width: contentWidth, height: sigBoxHeight,
    borderColor, borderWidth: 1,
  });
  page.drawText('Acknowledgement of Delivery', {
    x: margin + 15, y: yPosition - 20, size: 11, font: helveticaBold, color: textColor,
  });

  yPosition -= 35;

  if (data.signature) {
    try {
      const sigBytes = toImageBuffer(data.signature);
      const sigImage = await pdfDoc.embedPng(sigBytes);
      const maxWidth = 180;
      const maxHeight = 50;
      const scale = Math.min(maxWidth / sigImage.width, maxHeight / sigImage.height);
      const w = sigImage.width * scale;
      const h = sigImage.height * scale;
      page.drawImage(sigImage, {
        x: margin + 15, y: yPosition - h, width: w, height: h,
      });
      const receivedText = data.driverName
        ? `Received by customer — delivered by ${data.driverName}`
        : 'Received by customer';
      page.drawText(receivedText, {
        x: margin + 15, y: sigBoxTop - sigBoxHeight + 12, size: 9, font: helvetica, color: lightGray,
      });
    } catch (err) {
      console.error('[delivery-note-pdf] Failed to embed signature:', err);
      drawSignatureLines(page, margin + 15, yPosition, sigBoxTop - sigBoxHeight + 12, helvetica, lightGray);
    }
  } else {
    drawSignatureLines(page, margin + 15, yPosition, sigBoxTop - sigBoxHeight + 12, helvetica, lightGray);
  }

  yPosition = sigBoxTop - sigBoxHeight - 20;

  // ── Photos ───────────────────────────────────────────────────────
  if (data.photos && data.photos.length > 0) {
    if (yPosition < margin + 200) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      yPosition = pageHeight - margin;
    }
    page.drawText('Delivery Photos', {
      x: margin, y: yPosition, size: 14, font: helveticaBold, color: textColor,
    });
    yPosition -= 25;

    const maxPhotoWidth = 250;
    const maxPhotoHeight = 200;
    const photosPerRow = 2;
    const photoSpacing = 20;

    for (let i = 0; i < data.photos.length; i++) {
      try {
        const photoBytes = toImageBuffer(data.photos[i]);
        let photoImage;
        try {
          photoImage = await pdfDoc.embedJpg(photoBytes);
        } catch {
          photoImage = await pdfDoc.embedPng(photoBytes);
        }
        const aspect = photoImage.width / photoImage.height;
        let w = maxPhotoWidth;
        let h = w / aspect;
        if (h > maxPhotoHeight) {
          h = maxPhotoHeight;
          w = h * aspect;
        }
        const colIdx = i % photosPerRow;
        const xPos = margin + colIdx * (maxPhotoWidth + photoSpacing);
        if (colIdx === 0 && i > 0) {
          yPosition -= maxPhotoHeight + photoSpacing + 20;
        }
        if (yPosition - h < margin) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          yPosition = pageHeight - margin;
        }
        page.drawRectangle({
          x: xPos - 2, y: yPosition - h - 2, width: w + 4, height: h + 4,
          borderColor, borderWidth: 1,
        });
        page.drawImage(photoImage, { x: xPos, y: yPosition - h, width: w, height: h });
        page.drawText(`Photo ${i + 1}`, {
          x: xPos, y: yPosition - h - 15, size: 9, font: helvetica, color: lightGray,
        });
      } catch (err) {
        console.error(`[delivery-note-pdf] Failed to embed photo ${i + 1}:`, err);
      }
    }
    yPosition -= maxPhotoHeight + 30;
  }

  // ── Footer ──────────────────────────────────────────────────────
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const footerY = margin - 10;
  lastPage.drawText('Thank you for choosing Ooosh Tours', {
    x: margin, y: footerY, size: 9, font: helvetica, color: lightGray,
  });
  const websiteText = 'www.oooshtours.co.uk';
  lastPage.drawText(websiteText, {
    x: pageWidth - margin - helvetica.widthOfTextAtSize(websiteText, 9),
    y: footerY, size: 9, font: helvetica, color: primaryColor,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
