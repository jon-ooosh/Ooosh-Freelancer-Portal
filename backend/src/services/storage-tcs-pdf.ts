/**
 * Storage T&Cs signed-agreement PDF.
 *
 * Generates a durable record of an accepted storage T&Cs: the version text,
 * who accepted + when (+ IP), and the signature image. Stored in R2 against
 * the agreement (storage_tcs_agreements.pdf_r2_key) at acceptance time.
 *
 * The T&Cs `body` is staff-authored HTML; we render it as wrapped plain text
 * (terms are prose, so stripping tags reads fine) — no HTML engine needed.
 */
import { PDFDocument, rgb, PDFFont, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadRobotoFonts } from './pdf-fonts';

const MARGIN = 50;
const PAGE_W = 595; // A4 portrait
const PAGE_H = 842;
const PURPLE = rgb(0.482, 0.369, 0.655); // #7B5EA7

export interface StorageTcsPdfData {
  orgName: string | null;
  roomName: string | null;
  version: string | null;
  bodyHtml: string;
  acceptedByName: string;
  acceptedAt: Date;
  signaturePng?: Buffer | null;
  ip?: string | null;
}

/** Strip HTML to readable text: block tags → newlines, decode common entities. */
function htmlToText(html: string): string {
  return (html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
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

export async function generateStorageTcsPdf(data: StorageTcsPdfData): Promise<Uint8Array> {
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
  const text = (s: string, size: number, font: PDFFont, color = rgb(0.1, 0.1, 0.1)) => {
    for (const ln of wrapLine(s, font, size, contentW)) {
      newPageIfNeeded(size + 4);
      page.drawText(ln, { x: MARGIN, y, size, font, color });
      y -= size + 4;
    }
  };

  // Header band
  page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: PURPLE });
  page.drawText('Ooosh Tours — Storage Terms & Conditions', { x: MARGIN, y: PAGE_H - 42, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Transport · Backline · Rehearsals', { x: MARGIN, y: PAGE_H - 58, size: 9, font: regular, color: rgb(0.9, 0.88, 0.95) });
  y = PAGE_H - 90;

  // Meta block
  const meta: [string, string][] = [
    ['Client', data.orgName || '—'],
    ['Storage unit', data.roomName || '—'],
    ['Terms version', data.version || '—'],
    ['Accepted by', data.acceptedByName],
    ['Accepted on', data.acceptedAt.toLocaleString('en-GB')],
  ];
  if (data.ip) meta.push(['IP address', data.ip]);
  for (const [label, value] of meta) {
    newPageIfNeeded(16);
    page.drawText(label, { x: MARGIN, y, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) });
    page.drawText(value, { x: MARGIN + 110, y, size: 9, font: regular });
    y -= 16;
  }
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 18;

  // Terms body
  text('Terms & Conditions', 12, bold, PURPLE);
  y -= 4;
  for (const para of htmlToText(data.bodyHtml).split('\n')) {
    if (!para) { y -= 6; continue; }
    text(para, 9, regular, rgb(0.2, 0.2, 0.2));
  }

  // Signature
  y -= 24;
  newPageIfNeeded(120);
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
  page.drawText(`Signed by ${data.acceptedByName} on ${data.acceptedAt.toLocaleDateString('en-GB')}`,
    { x: MARGIN, y, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });

  return pdf.save();
}
