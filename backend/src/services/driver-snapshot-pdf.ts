/**
 * Driver Verification Snapshot PDF
 *
 * Creates a multi-page PDF capturing all driver verification data and document
 * images at the point of hire form submission. Used for audit/insurance purposes.
 *
 * Ported from netlify/functions/generate-driver-snapshot.js v1.1.
 * Sources data from OP drivers table + R2 document storage instead of Monday.com.
 */
import { PDFDocument, rgb, PDFFont, PDFImage, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getFromR2 } from '../config/r2';

// ── Types ──

export interface DriverSnapshotData {
  driverName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  nationality: string;
  homeAddress: string;
  licenceAddress: string;
  licenceNumber: string;
  licenceIssuedBy: string;
  licenceValidTo: string;
  datePassedTest: string;
  // DVLA
  dvlaPoints: string;
  dvlaEndorsements: string;
  calculatedExcess: string;
  isUkDriver: boolean;
  // Insurance questions
  hasDisability: boolean;
  hasConvictions: boolean;
  hasProsecution: boolean;
  hasAccidents: boolean;
  hasInsuranceIssues: boolean;
  hasDrivingBan: boolean;
  additionalDetails: string;
  // Job reference
  jobId: string;
  // Document images (buffers from R2)
  documents: Record<string, Buffer | null>;
  // Logo
  logoImage: Buffer | null;
}

// ── Constants ──

const PAGE_WIDTH = 595.28;  // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

// ── Font Loading ──

async function loadFonts(pdfDoc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const fontsDir = join(__dirname, '..', '..', 'fonts');
  const regularPath = join(fontsDir, 'Roboto-Regular.ttf');
  const boldPath = join(fontsDir, 'Roboto-Bold.ttf');

  try {
    if (existsSync(regularPath) && existsSync(boldPath)) {
      pdfDoc.registerFontkit(fontkit);
      const regular = await pdfDoc.embedFont(readFileSync(regularPath));
      const bold = await pdfDoc.embedFont(readFileSync(boldPath));
      return { regular, bold };
    }
  } catch (e) {
    console.log('[snapshot] Custom fonts unavailable, using standard');
  }

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold };
}

// ── Image Helpers ──

async function embedImage(pdfDoc: PDFDocument, buffer: Buffer): Promise<PDFImage | null> {
  try {
    return await pdfDoc.embedPng(buffer);
  } catch {
    try {
      return await pdfDoc.embedJpg(buffer);
    } catch {
      return null;
    }
  }
}

function fitImage(image: PDFImage, maxWidth: number, maxHeight: number) {
  const dims = image.scale(1);
  const scale = Math.min(maxWidth / dims.width, maxHeight / dims.height, 1);
  return { width: dims.width * scale, height: dims.height * scale };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

// ── Date Formatting ──

function formatDate(d: string | null): string {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function yesNo(v: boolean): string {
  return v ? 'Yes' : 'No';
}

// ── PDF Generation ──

export async function generateDriverSnapshot(data: DriverSnapshotData): Promise<{ pdfBytes: Uint8Array; filename: string }> {
  const pdfDoc = await PDFDocument.create();
  const { regular: mainFont, bold: boldFont } = await loadFonts(pdfDoc);

  const generatedDate = new Date().toLocaleDateString('en-GB') + ' ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // ── Page 1: Driver Details ──
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // Logo
  if (data.logoImage) {
    try {
      const logo = await embedImage(pdfDoc, data.logoImage);
      if (logo) {
        const dims = logo.scale(1);
        const scale = 40 / dims.height;
        page.drawImage(logo, { x: PAGE_WIDTH - MARGIN - dims.width * scale, y: y - 30, width: dims.width * scale, height: 40 });
      }
    } catch { /* skip logo if it fails */ }
  }

  // Title
  page.drawText(data.driverName || 'Driver Verification Snapshot', { x: MARGIN, y, size: 16, font: boldFont, color: rgb(0.2, 0.2, 0.2) });
  y -= 20;
  page.drawText(`Generated: ${generatedDate}`, { x: MARGIN, y, size: 10, font: mainFont, color: rgb(0.4, 0.4, 0.4) });
  y -= 14;
  page.drawText(`Job Number: ${data.jobId}`, { x: MARGIN, y, size: 10, font: mainFont, color: rgb(0.4, 0.4, 0.4) });
  y -= 25;

  // Divider
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
  y -= 20;

  const drawField = (label: string, value: string) => {
    page.drawText(label + ':', { x: MARGIN, y, size: 9, font: boldFont, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(value || '-', { x: MARGIN + 120, y, size: 9, font: mainFont });
    y -= 14;
  };

  const drawSection = (title: string) => {
    y -= 10;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    y -= 15;
    page.drawText(title, { x: MARGIN, y, size: 12, font: boldFont });
    y -= 18;
  };

  // Driver details
  page.drawText('DRIVER DETAILS', { x: MARGIN, y, size: 12, font: boldFont });
  y -= 18;
  drawField('Name', data.driverName);
  drawField('Email', data.email);
  drawField('Phone', data.phone);
  drawField('Date of Birth', formatDate(data.dateOfBirth));
  drawField('Nationality', data.nationality);
  y -= 8;
  drawField('Home Address', (data.homeAddress || '').substring(0, 60));
  if (data.licenceAddress && data.licenceAddress !== data.homeAddress) {
    drawField('Licence Address', (data.licenceAddress || '').substring(0, 60));
  }

  drawSection('LICENCE INFORMATION');
  drawField('Licence Number', data.licenceNumber);
  drawField('Issued By', data.licenceIssuedBy);
  drawField('Valid Until', formatDate(data.licenceValidTo));
  drawField('Passed Test', formatDate(data.datePassedTest));

  // DVLA section (UK only)
  if (data.isUkDriver && (data.dvlaPoints || data.dvlaEndorsements || data.calculatedExcess)) {
    drawSection('DVLA CHECK RESULTS');
    drawField('Points', data.dvlaPoints || '0');
    drawField('Endorsements', data.dvlaEndorsements || 'None');
    drawField('Calculated Excess', data.calculatedExcess || '£1,200');
  }

  drawSection('INSURANCE QUESTIONNAIRE');
  drawField('Disability', yesNo(data.hasDisability));
  drawField('Convictions', yesNo(data.hasConvictions));
  drawField('Prosecution pending', yesNo(data.hasProsecution));
  drawField('Accidents (3 years)', yesNo(data.hasAccidents));
  drawField('Insurance issues', yesNo(data.hasInsuranceIssues));
  drawField('Driving ban', yesNo(data.hasDrivingBan));
  if (data.additionalDetails?.trim()) {
    drawField('Additional Details', data.additionalDetails.substring(0, 70));
  }

  // ── Document pages ──
  const docPages = [
    { key: 'licenceFront', label: 'DRIVING LICENCE — Front' },
    { key: 'licenceBack', label: 'DRIVING LICENCE — Back' },
    { key: 'dvlaCheck', label: 'DVLA CHECK DOCUMENT' },
    { key: 'passport', label: 'PASSPORT' },
    { key: 'poa1', label: 'PROOF OF ADDRESS — Document 1' },
    { key: 'poa2', label: 'PROOF OF ADDRESS — Document 2' },
    { key: 'signature', label: 'DRIVER SIGNATURE' },
  ];

  for (const { key, label } of docPages) {
    const buffer = data.documents[key];
    if (!buffer) continue;

    if (isPdf(buffer)) {
      // Embed PDF pages
      try {
        const sourcePdf = await PDFDocument.load(buffer);
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
        page.drawText(label, { x: MARGIN, y, size: 14, font: boldFont });
        y -= 30;
        page.drawText(`(${sourcePdf.getPageCount()} page${sourcePdf.getPageCount() > 1 ? 's' : ''})`, { x: MARGIN, y, size: 10, font: mainFont, color: rgb(0.5, 0.5, 0.5) });
        const copiedPages = await pdfDoc.copyPages(sourcePdf, sourcePdf.getPageIndices());
        for (const cp of copiedPages) pdfDoc.addPage(cp);
      } catch (e) {
        console.log(`[snapshot] Failed to embed PDF for ${label}`);
      }
    } else {
      // Embed image
      const img = await embedImage(pdfDoc, buffer);
      if (img) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
        page.drawText(label, { x: MARGIN, y, size: 14, font: boldFont });
        y -= 30;
        const dims = fitImage(img, PAGE_WIDTH - MARGIN * 2, PAGE_HEIGHT - MARGIN * 2 - 50);
        page.drawImage(img, { x: MARGIN, y: y - dims.height, width: dims.width, height: dims.height });
      }
    }
  }

  const pdfBytes = await pdfDoc.save();

  const safeName = (data.driverName || 'Driver').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const filename = `${data.jobId}-${safeName}-${dateStr}.pdf`;

  return { pdfBytes, filename };
}

/**
 * Load document buffers from R2 for a driver's uploaded files.
 */
export async function loadDriverDocuments(files: Array<{ label?: string; url: string }>): Promise<Record<string, Buffer | null>> {
  const docs: Record<string, Buffer | null> = {};
  const labelMap: Record<string, string> = {
    'licence front': 'licenceFront',
    'licence back': 'licenceBack',
    'passport': 'passport',
    'poa 1': 'poa1',
    'proof of address 1': 'poa1',
    'poa 2': 'poa2',
    'proof of address 2': 'poa2',
    'dvla check': 'dvlaCheck',
    'signature': 'signature',
  };

  for (const file of files) {
    const key = labelMap[(file.label || '').toLowerCase()];
    if (!key || docs[key]) continue;  // Skip unknown labels or already loaded

    try {
      const r2Result = await getFromR2(file.url);
      if (r2Result) {
        const chunks: Buffer[] = [];
        const stream = r2Result.Body as any;
        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          docs[key] = Buffer.concat(chunks);
        } else if (Buffer.isBuffer(stream)) {
          docs[key] = stream;
        }
      }
    } catch (e) {
      console.log(`[snapshot] Failed to load ${file.label}: ${(e as Error).message}`);
    }
  }
  return docs;
}
