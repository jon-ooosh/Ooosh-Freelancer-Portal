/**
 * Carnet — Letter of Authorisation PDF.
 *
 * Two-signature document (ported from the Ooosh Jotform):
 *   Block 1 — Ooosh (a director) appoints the lead as our agent for the carnet.
 *   Block 2 — the lead accepts full liability.
 *
 * The Ooosh signatory name / role / address + signature image come from
 * system_settings (Settings → Carnet). The client (lead) signature is captured
 * by the public request form; until then a signature line is drawn for wet-sign.
 *
 * Modelled on storage-tcs-pdf.ts (pdf-lib + Roboto). See docs/CARNET-SPEC.md.
 */
import { PDFDocument, rgb, PDFFont, PDFImage, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadRobotoFonts } from './pdf-fonts';
import { fetchLogo } from './hire-form-pdf';

const MARGIN = 50;
const PAGE_W = 595; // A4 portrait
const PAGE_H = 842;
const PURPLE = rgb(0.482, 0.369, 0.655); // #7B5EA7

export interface CarnetAuthorityPdfData {
  date: Date;
  companyAddress: string;             // comma-separated lines
  signatoryName: string;              // Ooosh signatory (Block 1)
  signatoryRole: string;
  signatureBuffer?: Buffer | null;    // Ooosh signature image (PNG/JPG)
  leadName: string;                   // client lead (agent / Block 2)
  leadRole: string;                   // their role / designation
  clientSignatureBuffer?: Buffer | null; // captured by the form, if present
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = (text || '').split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

async function embedSig(pdf: PDFDocument, buf?: Buffer | null): Promise<PDFImage | null> {
  if (!buf) return null;
  try { return await pdf.embedPng(buf); } catch { /* not png */ }
  try { return await pdf.embedJpg(buf); } catch { /* not jpg */ }
  return null;
}

export async function generateCarnetAuthorityPdf(data: CarnetAuthorityPdfData): Promise<Uint8Array> {
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

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const contentW = PAGE_W - MARGIN * 2;

  const para = (s: string, size: number, font: PDFFont, color = rgb(0.1, 0.1, 0.1), gap = 4) => {
    for (const ln of wrap(s, font, size, contentW)) {
      page.drawText(ln, { x: MARGIN, y, size, font, color });
      y -= size + gap;
    }
  };
  const drawRight = (s: string, yy: number, size: number, font: PDFFont, color = rgb(0.3, 0.3, 0.3)) => {
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: PAGE_W - MARGIN - w, y: yy, size, font, color });
  };

  // ── Header: logo (left) + address (right) ──
  const logo = await fetchLogo().catch(() => null);
  let headerBottom = PAGE_H - MARGIN;
  if (logo) {
    const img = await embedSig(pdf, logo);
    if (img) {
      const w = 110;
      const h = (img.height / img.width) * w;
      page.drawImage(img, { x: MARGIN, y: PAGE_H - MARGIN - h, width: w, height: h });
      headerBottom = PAGE_H - MARGIN - h;
    }
  }
  let ay = PAGE_H - MARGIN - 4;
  const addressLines = (data.companyAddress || '').split(',').map((l) => l.trim()).filter(Boolean);
  for (const ln of addressLines) { drawRight(ln, ay, 9, regular); ay -= 13; }
  drawRight(data.date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), ay, 9, bold, rgb(0.1, 0.1, 0.1));

  y = Math.min(headerBottom, ay) - 30;

  // ── Title ──
  page.drawText('Letter of Authorisation', { x: MARGIN, y, size: 18, font: bold, color: PURPLE });
  y -= 34;

  // ── Block 1: Ooosh appoints the lead as agent ──
  para(
    `I, ${data.signatoryName || '—'}, of Ooosh! Tours Ltd, hereby appoint ${data.leadName || '—'} to be our agent for the purpose of dealing with and signing ATA Carnets, under the appropriate International Convention, and guaranteed by the appropriate Chamber of Commerce, and to deliver to Customs any documents in this connection.`,
    11, regular, rgb(0.15, 0.15, 0.15), 5
  );
  y -= 16;
  y = drawSignatureBlock(page, pdf, regular, bold, y, 'Signed:', await embedSig(pdf, data.signatureBuffer), data.signatoryRole);

  y -= 30;

  // ── Block 2: lead accepts liability ──
  para(
    `By this declaration I, ${data.leadName || '—'}, accept full responsibility for any charges, fees, taxes or similar that may become due by the use or misuse of said Carnet, and under no circumstances will Ooosh! Tours Ltd be held responsible for any such costs.`,
    11, regular, rgb(0.15, 0.15, 0.15), 5
  );
  y -= 6;
  para(
    'This responsibility will last until the closure of the carnet in the usual timeframe (usually eighteen (18) months from the end date of the carnet).',
    11, regular, rgb(0.15, 0.15, 0.15), 5
  );
  y -= 16;
  drawSignatureBlock(page, pdf, regular, bold, y, 'Signed:', await embedSig(pdf, data.clientSignatureBuffer), data.leadRole);

  return pdf.save();
}

// Draws "Signed:" + a signature image (or a line for wet-signing) + the role.
// Returns the new y. (page/pdf captured from the closure scope above via params.)
function drawSignatureBlock(
  page: ReturnType<PDFDocument['addPage']>,
  _pdf: PDFDocument,
  regular: PDFFont,
  bold: PDFFont,
  yIn: number,
  label: string,
  sigImg: PDFImage | null,
  role: string
): number {
  let y = yIn;
  page.drawText(label, { x: MARGIN, y: y - 18, size: 10, font: bold, color: rgb(0.2, 0.2, 0.2) });
  if (sigImg) {
    const w = 150;
    const h = (sigImg.height / sigImg.width) * w;
    page.drawImage(sigImg, { x: MARGIN + 60, y: y - h, width: w, height: h });
    y -= Math.max(h, 24);
  } else {
    page.drawLine({ start: { x: MARGIN + 60, y: y - 20 }, end: { x: MARGIN + 260, y: y - 20 }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });
    y -= 26;
  }
  y -= 6;
  page.drawText('Role / designation:', { x: MARGIN, y, size: 10, font: bold, color: rgb(0.2, 0.2, 0.2) });
  page.drawText(role || '—', { x: MARGIN + 110, y, size: 10, font: regular });
  return y - 8;
}
