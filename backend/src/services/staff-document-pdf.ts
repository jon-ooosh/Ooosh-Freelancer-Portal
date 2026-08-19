/**
 * Staff-document signed-agreement PDF.
 *
 * Durable record of a staff member completing (ticking/signing) a staff
 * document: the document text (as completed), who / when (+ IP), the version,
 * and the signature image (sign mode). Stored in R2 against the completion
 * (staff_document_completions.pdf_r2_key) at completion time.
 *
 * Modelled on services/storage-tcs-pdf.ts. Body is staff-authored markdown-lite
 * (**bold**, numbered lists) — rendered as wrapped plain text (the content is
 * prose, so stripping markers reads fine); no markdown engine needed.
 */
import { PDFDocument, rgb, PDFFont, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadRobotoFonts } from './pdf-fonts';
import { fetchLogo } from './hire-form-pdf';

const MARGIN = 50;
const PAGE_W = 595; // A4 portrait
const PAGE_H = 842;
const PURPLE = rgb(0.482, 0.369, 0.655); // #7B5EA7

export interface StaffDocumentPdfData {
  documentTitle: string;
  version: string | number | null;
  bodyText: string;            // already merged (name/last4 substituted)
  completedByName: string;
  completedAt: Date;
  mode: 'tick' | 'sign';
  tickLabel?: string | null;
  signaturePng?: Buffer | null;
  ip?: string | null;
}

/** Strip markdown-lite markers to readable text. */
function mdToText(md: string): string {
  return (md || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export async function generateStaffDocumentPdf(data: StaffDocumentPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  let regular: PDFFont;
  let bold: PDFFont;
  const roboto = loadRobotoFonts();
  if (roboto) {
    pdf.registerFontkit(fontkit);
    regular = await pdf.embedFont(roboto.regular);
    bold = await pdf.embedFont(roboto.bold);
  } else {
    regular = await pdf.embedFont(StandardFonts.Helvetica);
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const contentW = PAGE_W - MARGIN * 2;

  const newPageIfNeeded = (needed: number) => {
    if (y - needed < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const text = (s: string, size: number, font: PDFFont, color = rgb(0.2, 0.2, 0.2)) => {
    for (const ln of wrapLine(s, font, size, contentW)) {
      newPageIfNeeded(size + 4);
      page.drawText(ln, { x: MARGIN, y, size, font, color });
      y -= size + 4;
    }
  };

  // Header band with logo top-left.
  page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: PURPLE });
  let textX = MARGIN;
  const logo = await fetchLogo();
  if (logo) {
    try {
      const img = await pdf.embedPng(logo);
      const h = 42;
      const w = (img.width / img.height) * h;
      page.drawImage(img, { x: MARGIN, y: PAGE_H - 70 + (70 - h) / 2, width: w, height: h });
      textX = MARGIN + w + 14;
    } catch { /* logo unreadable — fall back to text only */ }
  }
  page.drawText('Ooosh Tours', { x: textX, y: PAGE_H - 42, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Transport · Backline · Rehearsals', { x: textX, y: PAGE_H - 58, size: 9, font: regular, color: rgb(0.9, 0.88, 0.95) });
  y = PAGE_H - 90;

  // Title
  text(data.documentTitle, 14, bold, PURPLE);
  y -= 6;

  // Meta block
  const meta: [string, string][] = [
    ['Version', data.version != null ? String(data.version) : '—'],
    ['Completed by', data.completedByName],
    ['Completed on', data.completedAt.toLocaleString('en-GB')],
    ['Method', data.mode === 'sign' ? 'Signed' : 'Acknowledged (tick)'],
  ];
  if (data.ip) meta.push(['IP address', data.ip]);
  for (const [label, value] of meta) {
    newPageIfNeeded(16);
    page.drawText(label, { x: MARGIN, y, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) });
    page.drawText(value, { x: MARGIN + 110, y, size: 9, font: regular });
    y -= 16;
  }
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 18;

  // Document body
  for (const para of mdToText(data.bodyText).split('\n')) {
    if (!para) { y -= 6; continue; }
    text(para, 9, regular);
  }

  // Confirmation / signature
  y -= 20;
  newPageIfNeeded(120);
  if (data.tickLabel) {
    text(`Confirmed: "${data.tickLabel}"`, 9, bold, rgb(0.1, 0.1, 0.1));
    y -= 6;
  }
  if (data.mode === 'sign') {
    page.drawText('Signature', { x: MARGIN, y, size: 11, font: bold }); y -= 8;
    if (data.signaturePng) {
      try {
        const img = await pdf.embedPng(data.signaturePng);
        const w = 200;
        const h = (img.height / img.width) * w;
        newPageIfNeeded(h + 24);
        page.drawImage(img, { x: MARGIN, y: y - h, width: w, height: h });
        y -= h + 6;
      } catch { /* signature image unreadable — skip */ }
    }
  }
  page.drawText(`${data.mode === 'sign' ? 'Signed' : 'Acknowledged'} by ${data.completedByName} on ${data.completedAt.toLocaleDateString('en-GB')}`,
    { x: MARGIN, y, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });

  return pdf.save();
}
