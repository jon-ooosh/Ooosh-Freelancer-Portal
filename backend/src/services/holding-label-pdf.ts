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

const PURPLE = rgb(0.482, 0.369, 0.655); // #7B5EA7

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

  // A6 landscape-ish label (420 x 298 pt)
  const W = 420, H = 298;
  for (let i = 1; i <= total; i++) {
    const page = pdf.addPage([W, H]);
    // Header band
    page.drawRectangle({ x: 0, y: H - 44, width: W, height: 44, color: PURPLE });
    page.drawText('OOOSH TOURS — DELIVERY LABEL', { x: 18, y: H - 30, size: 14, font: fontBold, color: rgb(1, 1, 1) });

    // Client + job
    page.drawText(clientName || 'Client', { x: 18, y: H - 78, size: 18, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    if (hhJobNumber) page.drawText(`Job #${hhJobNumber}`, { x: 18, y: H - 102, size: 14, font, color: rgb(0.3, 0.3, 0.3) });

    // Box count
    page.drawText(`Box ${i} of ${total}`, { x: 18, y: 60, size: 22, font: fontBold, color: PURPLE });
    page.drawText('Attach one label per box.', { x: 18, y: 36, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
    page.drawText('Items without a label may be delayed.', { x: 18, y: 24, size: 9, font, color: rgb(0.5, 0.5, 0.5) });

    // QR
    const qrSize = 120;
    page.drawImage(qrImage, { x: W - qrSize - 18, y: 28, width: qrSize, height: qrSize });
    page.drawText('Ooosh staff: scan on arrival', { x: W - qrSize - 18, y: 16, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
