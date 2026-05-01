/**
 * VE103B Certificate PDF Generation Service
 *
 * Generates text-only overlay PDFs for printing onto pre-printed VE103B forms.
 * The VE103B is a UK document authorising a named driver to take a hired vehicle abroad.
 *
 * IMPORTANT: This outputs text at precise positions to overlay pre-printed forms.
 * Positioning is calibrated against the official VE103B paper (£8/sheet).
 *
 * CALIBRATION MODE: Set env var VE103B_CALIBRATION_MODE=true to draw visible
 * guide lines. Print on plain A4 and hold against a real VE103B to check alignment.
 *
 * Ported from netlify/functions/generate-ve103b.js
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// ── Types ────────────────────────────────────────────────────────────────

export interface VE103BData {
  // Vehicle V5 fields
  vehicleReg: string;       // A: Registration
  dateFirstReg: string;     // B: Date of first registration (formatted)
  make: string;             // D.1: Make
  type: string;             // D.2: Type (v5_type column)
  model: string;            // D.3: Model
  bodyType: string;         // D.5: Body type
  vinChassis: string;       // E: VIN/Chassis number
  f1Weight: string;         // F.1: Max permissible mass (kg)
  jCategory: string;        // J: Vehicle category (M1, N1, etc.)
  p1Cc: string;             // P.1: Cylinder capacity (cc)
  rColour: string;          // R: Colour
  s1Seats: string;          // S.1: Number of seats

  // Driver details
  driverName: string;
  driverAddress: string;    // Multi-line address (newline-separated)

  // Dates (formatted e.g. "28 Jun 2022")
  startDate: string;
  returnDate: string;
}

export interface VE103BResult {
  pdfBytes: Uint8Array;
  filename: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Format a date string or Date to "28 Jun 2022" format.
 */
export function formatDateForVE103B(dateInput: string | Date | null | undefined): string {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return typeof dateInput === 'string' ? dateInput : '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Assemble driver address from individual fields into multi-line string.
 */
export function assembleDriverAddress(
  line1?: string | null,
  line2?: string | null,
  city?: string | null,
  postcode?: string | null,
): string {
  return [line1, line2, city, postcode]
    .filter(s => s && s.trim())
    .join('\n');
}

/**
 * Resolve a driver address to multi-line form for the VE103B.
 *
 * Drivers can land in the DB in two shapes:
 *   - split: address_line1/line2/city/postcode populated separately
 *   - single: address_full (or address_line1) carrying the whole address
 *     as a comma-separated string (Idenfy / hire form app pattern)
 *
 * If two or more split columns are populated, use them. Otherwise comma-split
 * the single-string source. Capped at MAX_ADDRESS_LINES so a pathological
 * input (e.g. "1, Lancaster Road, Flat 2, Stoke-on-Trent, ST1 4AB, UK")
 * doesn't overrun the form.
 */
const MAX_ADDRESS_LINES = 5;

export function resolveDriverAddressLines(d: {
  address_full?:  string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?:          string | null;
  postcode?:      string | null;
}): string[] {
  const splitParts = [d.address_line1, d.address_line2, d.city, d.postcode]
    .map(s => (s || '').trim())
    .filter(Boolean);

  // Prefer split columns when two or more are populated — that's a real
  // structured address.
  if (splitParts.length >= 2) {
    return splitParts.slice(0, MAX_ADDRESS_LINES);
  }

  // Otherwise fall back to the single-string source: address_full first,
  // then address_line1 (which may itself be a stuffed comma-separated string).
  const single = (d.address_full || d.address_line1 || '').trim();
  if (!single) return [];

  // If the single string already has newlines, honour them.
  if (single.includes('\n')) {
    return single.split('\n').map(s => s.trim()).filter(Boolean).slice(0, MAX_ADDRESS_LINES);
  }

  // Comma-split. Trim each segment, drop empties.
  const parts = single.split(',').map(s => s.trim()).filter(Boolean);

  // No comma in a single field → render as one line as-is.
  if (parts.length <= 1) return [single];

  // Cap. If the input has more parts than the cap, fold any overflow into
  // the last visible line so we don't lose the postcode.
  if (parts.length <= MAX_ADDRESS_LINES) return parts;
  const head = parts.slice(0, MAX_ADDRESS_LINES - 1);
  const tail = parts.slice(MAX_ADDRESS_LINES - 1).join(', ');
  return [...head, tail];
}

// ── PDF Generation ──────────────────────────────────────────────────────

/**
 * Generate a VE103B overlay PDF.
 *
 * Returns a Uint8Array of PDF bytes and a filename.
 * The PDF contains ONLY positioned text — no background image.
 */
export async function generateVE103BPDF(
  data: VE103BData,
  certificateNumber: string,
): Promise<VE103BResult> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // A4 page size (standard for UK forms)
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  const fontSize = 9;
  const textColor = rgb(0, 0, 0);

  // ── X positions ──────────────────────────────────────────────────────
  const vehicleLeftX = 137;
  const vehicleRightX = 440;
  const driverX = 193;
  const datesLeftX = 190;
  const datesRightX = 425;

  // ── Y positions ──────────────────────────────────────────────────────
  const rowSpacing = 16;
  const vehicleStartY = 556;

  const positions = {
    // Vehicle left column
    vehicleReg:   vehicleStartY,
    dateFirstReg: vehicleStartY - rowSpacing,
    make:         vehicleStartY - (rowSpacing * 2),
    type:         vehicleStartY - (rowSpacing * 3),
    model:        vehicleStartY - (rowSpacing * 4),
    bodyType:     vehicleStartY - (rowSpacing * 5),
    vinChassis:   vehicleStartY - (rowSpacing * 6),

    // Vehicle right column (same Y as left)
    f1Weight:   vehicleStartY,
    jCategory:  vehicleStartY - rowSpacing,
    p1Cc:       vehicleStartY - (rowSpacing * 2),
    rColour:    vehicleStartY - (rowSpacing * 3),
    s1Seats:    vehicleStartY - (rowSpacing * 4),

    // Driver section
    driverName:    244,
    driverAddress: 224,

    // Dates section
    startDate:  130,
    returnDate: 130,
  };

  // ── Calibration mode ─────────────────────────────────────────────────
  const calibrationMode = process.env.VE103B_CALIBRATION_MODE === 'true';

  if (calibrationMode) {
    const guideColor = rgb(0.8, 0.8, 0.8);

    // Page border
    page.drawRectangle({
      x: 20, y: 20,
      width: pageWidth - 40,
      height: pageHeight - 40,
      borderColor: guideColor,
      borderWidth: 0.5,
    });

    // Horizontal guide lines
    const allYValues: Record<string, number> = { ...positions };
    for (const [label, y] of Object.entries(allYValues)) {
      page.drawLine({
        start: { x: 20, y },
        end: { x: pageWidth - 20, y },
        color: guideColor,
        thickness: 0.5,
      });
      page.drawText(`${label} (${y})`, {
        x: pageWidth - 120,
        y: y - 3,
        size: 5,
        font,
        color: rgb(0.6, 0.6, 0.6),
      });
    }

    // Vertical guide lines
    for (const x of [vehicleLeftX, vehicleRightX, driverX, datesLeftX, datesRightX]) {
      page.drawLine({
        start: { x, y: 100 },
        end: { x, y: pageHeight - 100 },
        color: guideColor,
        thickness: 0.5,
      });
    }

    // Calibration header
    page.drawText('CALIBRATION MODE — Print on plain A4, compare to real VE103B', {
      x: 50, y: pageHeight - 30,
      size: 10, font: fontBold, color: rgb(1, 0, 0),
    });
    page.drawText(
      `VehL: ${vehicleLeftX} | VehR: ${vehicleRightX} | Driver: ${driverX} | Dates: ${datesLeftX}/${datesRightX}`,
      { x: 50, y: pageHeight - 45, size: 8, font, color: rgb(0.5, 0.5, 0.5) },
    );
  }

  // ── Left column — Vehicle details ────────────────────────────────────

  page.drawText(data.vehicleReg || '', {
    x: vehicleLeftX, y: positions.vehicleReg,
    size: fontSize + 1, font: fontBold, color: textColor,
  });

  page.drawText(data.dateFirstReg || '', {
    x: vehicleLeftX, y: positions.dateFirstReg,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.make || '', {
    x: vehicleLeftX, y: positions.make,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.type || '', {
    x: vehicleLeftX, y: positions.type,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.model || '', {
    x: vehicleLeftX, y: positions.model,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.bodyType || '', {
    x: vehicleLeftX, y: positions.bodyType,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.vinChassis || '', {
    x: vehicleLeftX, y: positions.vinChassis,
    size: fontSize, font, color: textColor,
  });

  // ── Right column — Vehicle details ───────────────────────────────────

  page.drawText(data.f1Weight || '', {
    x: vehicleRightX, y: positions.f1Weight,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.jCategory || '', {
    x: vehicleRightX, y: positions.jCategory,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.p1Cc || '', {
    x: vehicleRightX, y: positions.p1Cc,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.rColour || '', {
    x: vehicleRightX, y: positions.rColour,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.s1Seats || '', {
    x: vehicleRightX, y: positions.s1Seats,
    size: fontSize, font, color: textColor,
  });

  // ── Driver section ───────────────────────────────────────────────────

  page.drawText(data.driverName || '', {
    x: driverX, y: positions.driverName,
    size: fontSize, font: fontBold, color: textColor,
  });

  // Address — split into lines, max 5 lines, 12pt spacing
  const addressLines = (data.driverAddress || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s);

  let addressY = positions.driverAddress;
  for (let i = 0; i < Math.min(addressLines.length, 5); i++) {
    page.drawText(addressLines[i]!, {
      x: driverX, y: addressY,
      size: fontSize, font, color: textColor,
    });
    addressY -= 12;
  }

  // ── Dates section ────────────────────────────────────────────────────

  page.drawText(data.startDate || '', {
    x: datesLeftX, y: positions.startDate,
    size: fontSize, font, color: textColor,
  });

  page.drawText(data.returnDate || '', {
    x: datesRightX, y: positions.returnDate,
    size: fontSize, font, color: textColor,
  });

  // ── Generate output ──────────────────────────────────────────────────

  const pdfBytes = await pdfDoc.save();
  const safeReg = (data.vehicleReg || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
  const safeCertNum = (certificateNumber || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
  const filename = `VE103B-${safeReg}-${safeCertNum}.pdf`;

  return { pdfBytes, filename };
}
