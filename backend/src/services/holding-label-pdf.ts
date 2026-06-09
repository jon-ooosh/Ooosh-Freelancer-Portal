/**
 * Merch delivery label PDF — generated when a client submits the inbound merch
 * form. One page per box ("Box 1 of 3"), each carrying the job number, client
 * name and a QR code that opens the staff acknowledge-receipt page for this
 * consignment. Replaces the JotForm-generated labels.
 *
 * See docs/HOLDING-MODULE-SPEC.md §8.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { frontendLink } from '../config/app-urls';

export interface MerchLabelInput {
  heldItemId: string;
  hhJobNumber: number | null;
  clientName: string;
  boxCount: number;
}

export async function buildMerchLabelPdf(input: MerchLabelInput): Promise<Buffer> {
  const { heldItemId, hhJobNumber, clientName, boxCount } = input;
  const total = Math.max(1, boxCount || 1);

  // QR → the staff acknowledge-receipt page (behind staff login; UPS scanning
  // it just hits the login wall).
  const receiptUrl = frontendLink(`/holding/receipt/${heldItemId}`);
  const qrDataUrl = await QRCode.toDataURL(receiptUrl, { margin: 1, width: 320 });
  const qrPng = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const qrImage = await pdf.embedPng(qrPng);

  // A6 landscape-ish label (420 x 298 pt). Printer-friendly: black on white,
  // no colour fills (clients print these on home/office printers).
  const black = rgb(0, 0, 0);
  const grey = rgb(0.4, 0.4, 0.4);
  const W = 420, H = 298;
  for (let i = 1; i <= total; i++) {
    const page = pdf.addPage([W, H]);
    // Simple border
    page.drawRectangle({ x: 8, y: 8, width: W - 16, height: H - 16, borderColor: black, borderWidth: 1.5 });

    page.drawText('OOOSH TOURS — DELIVERY LABEL', { x: 20, y: H - 36, size: 12, font: fontBold, color: black });
    page.drawLine({ start: { x: 20, y: H - 46 }, end: { x: W - 20, y: H - 46 }, thickness: 0.75, color: grey });

    // Client + job
    page.drawText(clientName || 'Client', { x: 20, y: H - 78, size: 18, font: fontBold, color: black });
    if (hhJobNumber) page.drawText(`Job #${hhJobNumber}`, { x: 20, y: H - 100, size: 13, font, color: grey });

    // Box count
    page.drawText(`Box ${i} of ${total}`, { x: 20, y: 60, size: 22, font: fontBold, color: black });
    page.drawText('Attach one label per box.', { x: 20, y: 38, size: 9, font, color: grey });
    page.drawText('Items without a label may be delayed.', { x: 20, y: 26, size: 9, font, color: grey });

    // QR
    const qrSize = 120;
    page.drawImage(qrImage, { x: W - qrSize - 20, y: 30, width: qrSize, height: qrSize });
    page.drawText('Ooosh staff: scan on arrival', { x: W - qrSize - 20, y: 18, size: 7, font, color: grey });
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
