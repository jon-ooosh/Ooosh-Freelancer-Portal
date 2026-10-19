/**
 * Broker PDF for a possible-claim case (docs/INCIDENT-CLAIMS-SPEC.md §11).
 *
 * Follows the broker form's section order, omits empty sections, and is the
 * ONLY place the driver's personal details (DOB, address, licence) are joined
 * to the incident (spec D6). Built with pdf-lib, like hire-form-pdf.ts.
 *
 * Photos: the small thumbnail stored at upload (incident_claim_files.thumb_r2_key)
 * is embedded, each with a "View full size" link to the public, token-gated
 * route in routes/incident-claims.ts — NOT the public vehicle-photo bucket the
 * book-out report links to: claim photos carry faces, other people's number
 * plates and injuries.
 */
import { PDFDocument, PDFFont, PDFPage, PDFImage, PDFString, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { query } from '../config/database';
import { getFromR2 } from '../config/r2';
import { frontendLink } from '../config/app-urls';
import { getSystemSettings } from '../routes/system-settings';
import { loadRobotoFonts } from './pdf-fonts';
import { fetchLogo } from './hire-form-pdf';
import { decryptDriverRow } from './driver-pii';
import {
  CLAIM_SECTIONS, ClaimSectionDef, BROKER_DECLARATION, CLAIM_PRIVACY_NOTICE,
  isFieldShown, hasValue, formatAnswer,
} from './claim-form-fields';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const NAVY = rgb(0.0, 0.2, 0.4);
const LIGHT = rgb(0.4, 0.55, 0.95);
const GREY = rgb(0.35, 0.35, 0.35);
const TEXT = rgb(0.12, 0.12, 0.12);

type Row = Record<string, unknown>;

async function readR2(key: string | null | undefined): Promise<Buffer | null> {
  if (!key) return null;
  try {
    const obj = await getFromR2(key);
    if (!obj.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of obj.Body as NodeJS.ReadableStream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
        out.push(cur);
        cur = w;
        // A single unbreakable word wider than the line: hard-split it.
        while (font.widthOfTextAtSize(cur, size) > maxWidth && cur.length > 1) {
          let cut = cur.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(cur.slice(0, cut), size) > maxWidth) cut--;
          out.push(cur.slice(0, cut));
          cur = cur.slice(cut);
        }
      } else {
        cur = test;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

function yesNo(v: unknown): string {
  return v === true ? 'Yes' : v === false ? 'No' : '';
}

function ukDate(v: unknown): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
}

async function embedImage(pdf: PDFDocument, buf: Buffer | null): Promise<PDFImage | null> {
  if (!buf) return null;
  try { return await pdf.embedPng(buf); } catch { /* not a PNG */ }
  try { return await pdf.embedJpg(buf); } catch { /* not a JPEG either */ }
  return null;
}

export async function buildClaimPdf(
  claimId: string,
  opts: { photoLinkToken: string },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const cRes = await query(
    `SELECT c.*, COALESCE(fv.reg, c.vehicle_reg) AS reg, fv.make, fv.model, fv.cylinder_capacity_cc
     FROM incident_claims c
     LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
     WHERE c.id = $1`,
    [claimId],
  );
  if (cRes.rowCount === 0) throw new Error('Claim not found');
  const c = cRes.rows[0];
  const form = (c.form_data || {}) as Record<string, unknown>;
  const sec = (key: string): Row => {
    const v = form[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
  };
  const list = (key: string): Row[] => {
    const v = form[key];
    return Array.isArray(v) ? (v.filter((r) => r && typeof r === 'object') as Row[]) : [];
  };

  let driver: Row | null = null;
  if (c.driver_id) {
    const d = await query(`SELECT * FROM drivers WHERE id = $1`, [c.driver_id]);
    if (d.rows[0]) driver = decryptDriverRow(d.rows[0]);
  }

  const settings = await getSystemSettings([
    'claims_insured_name', 'claims_insured_address', 'claims_policy_number', 'claims_insured_email',
    'claims_insured_phone', 'claims_insured_business', 'claims_depot',
  ]);

  const filesRes = await query(
    `SELECT id, filename, thumb_r2_key, r2_key, content_type, caption, taken_at
     FROM incident_claim_files
     WHERE claim_id = $1 AND file_type = 'photo' AND share_with_insurer = true
     ORDER BY taken_at NULLS LAST, uploaded_at`,
    [claimId],
  );

  // ── Document + fonts ──
  const pdf = await PDFDocument.create();
  let regular: PDFFont;
  let bold: PDFFont;
  const roboto = loadRobotoFonts();
  if (roboto) {
    pdf.registerFontkit(fontkit);
    // Subset: embeds only the glyphs used — ~40KB instead of ~500KB of font
    // in every emailed claim.
    regular = await pdf.embedFont(roboto.regular, { subset: true });
    bold = await pdf.embedFont(roboto.bold, { subset: true });
  } else {
    regular = await pdf.embedFont(StandardFonts.Helvetica);
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const ensure = (h: number) => { if (y - h < MARGIN + 14) newPage(); };

  const drawLines = (lines: string[], x: number, size: number, font: PDFFont, color = TEXT) => {
    for (const ln of lines) {
      ensure(size + 3);
      page.drawText(ln, { x, y: y - size, size, font, color });
      y -= size + 3;
    }
  };

  const heading = (title: string) => {
    ensure(40);
    y -= 6;
    page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_W, height: 16, color: NAVY });
    page.drawText(title, { x: MARGIN + 6, y: y - 12, size: 10, font: bold, color: rgb(1, 1, 1) });
    y -= 22;
  };

  const LABEL_W = 190;
  // Label and value side by side, line by line, so a long answer breaks
  // across pages cleanly instead of overprinting.
  const field = (label: string, value: string) => {
    if (!hasValue(value)) return;
    const labelLines = wrap(label, bold, 8.5, LABEL_W - 8);
    const valueLines = wrap(value, regular, 9, CONTENT_W - LABEL_W);
    const n = Math.max(labelLines.length, valueLines.length);
    for (let i = 0; i < n; i++) {
      ensure(12);
      if (labelLines[i]) page.drawText(labelLines[i], { x: MARGIN, y: y - 9, size: 8.5, font: bold, color: GREY });
      if (valueLines[i]) page.drawText(valueLines[i], { x: MARGIN + LABEL_W, y: y - 9, size: 9, font: regular, color: TEXT });
      y -= 12;
    }
    y -= 3;
  };

  const para = (text: string, size = 9, font = regular, color = TEXT) => {
    drawLines(wrap(text, font, size, CONTENT_W), MARGIN, size, font, color);
  };

  /** Print one catalogue section's shown, non-empty answers. */
  const printSection = (def: ClaimSectionDef, title = def.title) => {
    const row = sec(def.key);
    const items = def.fields
      .filter((f) => isFieldShown(f, row) && hasValue(row[f.key]))
      .map((f) => [f.label, formatAnswer(f, row[f.key])] as const);
    if (!items.length) return;
    heading(title);
    for (const [l, v] of items) field(l, v);
  };
  const def = (key: string) => CLAIM_SECTIONS.find((s) => s.key === key)!;

  // ── Header ──
  const logo = await embedImage(pdf, await fetchLogo());
  if (logo) {
    const h = 36;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: MARGIN, y: y - h, width: w, height: h });
  }
  page.drawText('Motor Claim Form', { x: PAGE_W - MARGIN - bold.widthOfTextAtSize('Motor Claim Form', 16), y: y - 18, size: 16, font: bold, color: NAVY });
  const refLine = [
    c.broker_ref ? `Claim reference: ${c.broker_ref}` : null,
    c.insurer_ref ? `Insurer reference: ${c.insurer_ref}` : null,
  ].filter(Boolean).join('   ');
  if (refLine) page.drawText(refLine, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(refLine, 9), y: y - 32, size: 9, font: regular, color: GREY });
  y -= 48;
  const ours = `Our reference: ${c.reg || 'vehicle'}${c.hh_job_number ? ` · job #${c.hh_job_number}` : ''} · prepared ${ukDate(new Date())}`;
  page.drawText(ours, { x: MARGIN, y, size: 8.5, font: regular, color: GREY });
  y -= 10;

  // ── Insured ──
  heading('Insured');
  field('Name', settings.claims_insured_name || '');
  field('Depot', settings.claims_depot || '');
  field('Policy number', settings.claims_policy_number || '');
  field('Address', settings.claims_insured_address || '');
  field('Registered for VAT?', 'Yes');
  field('Able to recover VAT on repair / replacement?', 'Yes');
  field('Email', settings.claims_insured_email || '');
  field('Business of insured', settings.claims_insured_business || '');
  field('Telephone (work)', settings.claims_insured_phone || '');

  const cover = sec('cover');
  heading('Driver type');
  field('Driver type', String(cover.driver_type || 'On Hire (driver details below)'));

  // ── Driver (joined here and only here — D6) ──
  const drv = sec('driver');
  heading('Driver');
  if (driver) {
    const name = String(driver.full_name || '');
    field('Name', [drv.title, name].filter(hasValue).join(' '));
    field('Date of birth', ukDate(driver.date_of_birth));
    field('Occupation', String(drv.occupation || ''));
    const address = driver.address_full
      ? String(driver.address_full)
      : [driver.address_line1, driver.address_line2, driver.city, driver.postcode].filter(hasValue).join(', ');
    field('Address', address);
    field('Telephone (mobile)', String(driver.phone || ''));
    if (drv.details_changed === true) field('Changes since hire form', String(drv.changes || 'Yes (no detail given)'));

    // Declarations: the case's own answers win; otherwise the hire form (§7.3).
    const endorsements = Array.isArray(driver.licence_endorsements) ? (driver.licence_endorsements as unknown[]) : [];
    const fromHire = {
      accidents: !!driver.has_accidents,
      convictions: !!driver.has_convictions || !!driver.has_prosecution
        || Number(driver.licence_points || 0) > 0 || endorsements.length > 0,
      disability: !!driver.has_disability,
    };
    const pick = (caseVal: unknown, hireVal: boolean) => (caseVal === true || caseVal === false ? caseVal : hireVal);
    field('(a) Motor accident or claim in the past 3 years?', yesNo(pick(drv.decl_accidents, fromHire.accidents)));
    field('(b) Driving conviction in the last 5 years, or prosecution pending?', yesNo(pick(drv.decl_convictions, fromHire.convictions)));
    field('(c) Defect in vision or hearing, or any physical or mental disability?', yesNo(pick(drv.decl_disability, fromHire.disability)));
    const endorsementText = endorsements
      .map((e) => (e && typeof e === 'object'
        ? [(e as Row).code, (e as Row).points != null ? `${(e as Row).points} pts` : null, (e as Row).date ? ukDate((e as Row).date) : null].filter(hasValue).join(' ')
        : String(e)))
      .filter(hasValue).join('; ');
    const details = [
      hasValue(drv.decl_details) ? String(drv.decl_details) : null,
      !hasValue(drv.decl_details) && hasValue(driver.additional_details) ? String(driver.additional_details) : null,
      endorsementText ? `Licence endorsements: ${endorsementText}` : null,
    ].filter(hasValue).join('\n');
    field('Full details', details);

    // Licence
    heading('Driving licence');
    const cats = String(driver.licence_categories || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    const hgv = cats.some((k) => k === 'C' || k === 'C1' || k === 'CE' || k === 'C1E');
    const passed = ukDate(driver.date_passed_test);
    field('HGV', hgv ? `Yes${passed ? ` (licence obtained ${passed})` : ''}` : 'No');
    field('Car — full', String(driver.licence_type || '').toLowerCase().includes('provisional') ? 'No' : `Yes${passed ? ` (obtained ${passed})` : ''}`);
    if (String(driver.licence_type || '').toLowerCase().includes('provisional')) field('Car — provisional', 'Yes');
  } else if (hasValue(sec('non_hire_driver').name)) {
    // Not a hire client (one of us, a freelancer) — staff typed the details in.
    const nh = sec('non_hire_driver');
    field('Name', [drv.title, nh.name].filter(hasValue).join(' '));
    field('Date of birth', ukDate(nh.date_of_birth));
    field('Occupation', String(drv.occupation || ''));
    field('Address', String(nh.address || ''));
    field('Telephone (mobile)', String(nh.phone || ''));
    field('(a) Motor accident or claim in the past 3 years?', yesNo(drv.decl_accidents));
    field('(b) Driving conviction in the last 5 years, or prosecution pending?', yesNo(drv.decl_convictions));
    field('(c) Defect in vision or hearing, or any physical or mental disability?', yesNo(drv.decl_disability));
    field('Full details', String(drv.decl_details || ''));
    heading('Driving licence');
    field('Licence', String(nh.licence || ''));
  } else {
    para('Driver not yet identified on this case.', 9, regular, GREY);
  }

  // ── Use / vehicle / ownership ──
  heading('Use');
  field('Use', String(cover.use || 'Carriage of own goods'));

  const ov = sec('our_vehicle');
  const inc = sec('incident');
  heading('Your vehicle details');
  field('Make', String(c.make || ''));
  field('Exact model', String(c.model || ''));
  field('Vehicle CC', c.cylinder_capacity_cc ? String(c.cylinder_capacity_cc) : '');
  field('Registration number', String(c.reg || ''));
  for (const f of def('our_vehicle').fields) {
    if (isFieldShown(f, ov) && hasValue(ov[f.key])) field(f.label, formatAnswer(f, ov[f.key]));
  }
  field('Nature of goods being carried', String(inc.goods || ''));

  heading('Ownership');
  field('Ownership', String(cover.ownership || 'Owned'));
  if (cover.ownership && cover.ownership !== 'Owned') field('Owner / finance contact', String(cover.owner_details || ''));

  // ── Incident ──
  const incDef = { ...def('incident'), fields: def('incident').fields.filter((f) => f.key !== 'goods') };
  printSection(incDef, 'Incident details');
  field('Were photographs taken?', filesRes.rows.length ? `Yes (${filesRes.rows.length} attached below)` : '');
  printSection(def('police'));

  // ── People — sorted back into the broker's tables (§7.2.1) ──
  const people = list('people');
  const hasRole = (p: Row, r: string) => Array.isArray(p.roles) && (p.roles as unknown[]).includes(r);
  const contact = (p: Row) => [p.address, p.phone, p.email].filter(hasValue).join(' · ');
  const passengers = people.filter((p) => hasRole(p, 'Passenger in our van'));
  const witnesses = people.filter((p) => hasRole(p, 'Witness') || hasValue(p.witness_type));
  const others = people.filter((p) => !passengers.includes(p) && !witnesses.includes(p));
  const personTable = (title: string, rows: Row[], extra: (p: Row) => string) => {
    if (!rows.length) return;
    heading(title);
    rows.forEach((p, i) => {
      // A name alone is still worth a row — print a dash rather than drop it.
      field(`${i + 1}. ${hasValue(p.name) ? String(p.name) : '(name not given)'}`,
        [contact(p), extra(p), hasValue(p.notes) ? String(p.notes) : ''].filter(hasValue).join('\n') || 'No contact details given');
    });
  };
  personTable('Passengers', passengers, (p) => (p.injured === true ? 'Injured: Yes' : p.injured === false ? 'Injured: No' : ''));
  // The broker's witness type, from the roles + "do they know you?" (witness_type is the pre-Oct-2026 field).
  const witnessType = (p: Row) => (hasRole(p, 'Passenger in our van') ? 'Passenger'
    : p.knows_us === true ? 'Connected (knows the driver)'
      : p.knows_us === false ? 'Independent'
        : hasValue(p.witness_type) ? String(p.witness_type) : '');
  personTable('Witnesses', witnesses, (p) => [
    witnessType(p) ? `Witness type: ${witnessType(p)}` : '',
    p.injured === true ? 'Injured: Yes' : '',
  ].filter(hasValue).join(' · '));
  personTable('Other people involved', others, (p) => [
    Array.isArray(p.roles) ? (p.roles as string[]).join(', ') : '',
    p.injured === true ? 'Injured: Yes' : '',
  ].filter(hasValue).join(' · '));

  // ── Account, fault, sketch ──
  const acc = sec('account');
  if (hasValue(acc.description)) {
    heading('Incident description');
    para(String(acc.description));
  }
  const sketch = await embedImage(pdf, await readR2(c.sketch_key));
  if (sketch) {
    heading('Sketch');
    const w = Math.min(CONTENT_W, sketch.width);
    const h = (sketch.height / sketch.width) * w;
    ensure(Math.min(h, PAGE_H - 2 * MARGIN));
    page.drawImage(sketch, { x: MARGIN, y: y - h, width: w, height: h });
    y -= h + 6;
  }
  const accRest = { ...def('account'), fields: def('account').fields.filter((f) => f.key !== 'description') };
  printSection(accRest, 'Fault and circumstances');

  // ── Damage ──
  const dmg = sec('damage');
  const marks = await embedImage(pdf, await readR2(c.damage_marks_png_key));
  if (marks || hasValue(dmg.description) || hasValue(dmg.airbags)) {
    heading('Vehicle damage');
    if (marks) {
      const w = Math.min(CONTENT_W, marks.width);
      const h = (marks.height / marks.width) * w;
      ensure(h + 6);
      page.drawImage(marks, { x: MARGIN, y: y - h, width: w, height: h });
      y -= h + 6;
    }
    field('Description of the damage', String(dmg.description || ''));
    field('Did airbags deploy?', yesNo(dmg.airbags));
  }

  // ── Third parties ──
  const vehicles = list('other_vehicles');
  if (vehicles.length) {
    const vdef = def('other_vehicles');
    vehicles.forEach((v, i) => {
      heading(`Third party vehicle or property ${vehicles.length > 1 ? i + 1 : ''}`.trim());
      for (const f of vdef.fields) if (hasValue(v[f.key])) field(f.label, formatAnswer(f, v[f.key]));
    });
  }

  // ── Photos: thumbnails, each linking to the full-size image ──
  if (filesRes.rows.length) {
    heading('Photographs');
    para('Tap or click "View full size" under any photo to open the original.', 8, regular, GREY);
    y -= 4;
    const COLS = 3;
    const GAP = 10;
    const cellW = (CONTENT_W - GAP * (COLS - 1)) / COLS;
    const imgH = cellW * 0.75;
    let col = 0;
    let rowTop = y;
    for (const f of filesRes.rows) {
      if (col === 0) {
        if (y - (imgH + 50) < MARGIN + 14) newPage();
        rowTop = y;
      }
      const x = MARGIN + col * (cellW + GAP);
      const img = await embedImage(pdf, await readR2(f.thumb_r2_key));
      if (img) {
        const scale = Math.min(cellW / img.width, imgH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: x + (cellW - w) / 2, y: rowTop - h, width: w, height: h });
      } else {
        page.drawRectangle({ x, y: rowTop - imgH, width: cellW, height: imgH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
        page.drawText('(preview unavailable)', { x: x + 6, y: rowTop - imgH / 2, size: 7.5, font: regular, color: GREY });
      }
      let ty = rowTop - imgH - 10;
      // Caption (max two lines), then the capture time on its own line so a
      // long caption can never push it off the card.
      const lines = wrap(hasValue(f.caption) ? String(f.caption) : String(f.filename), regular, 7, cellW).slice(0, 2);
      if (f.taken_at) lines.push(`taken ${new Date(f.taken_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
      for (const ln of lines) {
        page.drawText(ln, { x, y: ty, size: 7, font: regular, color: GREY });
        ty -= 9;
      }
      const linkText = 'View full size';
      page.drawText(linkText, { x, y: ty, size: 7.5, font: bold, color: LIGHT });
      const url = frontendLink(`/api/claims/photo/${opts.photoLinkToken}/${f.id}`);
      const annot = pdf.context.register(pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x, ty - 2, x + bold.widthOfTextAtSize(linkText, 7.5), ty + 8],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
      }));
      page.node.addAnnot(annot);
      col++;
      if (col === COLS) { col = 0; y = rowTop - imgH - 50; }
    }
    if (col !== 0) y = rowTop - imgH - 50;
  }

  // ── Declaration + signatures ──
  heading('Declaration');
  para(BROKER_DECLARATION, 8.5);
  y -= 6;
  const sigBlock = async (label: string, key: string | null, name: string, date: unknown, missing: string) => {
    ensure(80);
    page.drawText(label, { x: MARGIN, y: y - 10, size: 9.5, font: bold, color: TEXT });
    y -= 14;
    const img = await embedImage(pdf, await readR2(key));
    if (img) {
      const w = 160;
      const h = Math.min(60, (img.height / img.width) * w);
      page.drawImage(img, { x: MARGIN, y: y - h, width: (img.width / img.height) * h, height: h });
      y -= h + 4;
    } else {
      para(missing, 8.5, regular, GREY);
    }
    field('Print name', name);
    field('Date', ukDate(date));
    y -= 4;
  };
  await sigBlock('Signature of driver', c.driver_signature_key,
    String(c.driver_signed_name || driver?.full_name || ''), c.driver_signed_at,
    'Not signed by the driver - details provided to Ooosh and entered by Ooosh staff.');
  await sigBlock('Signature of policyholder', c.policyholder_signature_key,
    String(c.policyholder_signed_name || ''), c.policyholder_signed_at, 'Not yet signed.');

  y -= 6;
  para(CLAIM_PRIVACY_NOTICE, 7, regular, GREY);

  // Page numbers
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const t = `Ooosh! Tours Ltd · Motor claim · ${c.reg || ''} · page ${i + 1} of ${pages.length}`;
    p.drawText(t, { x: MARGIN, y: 20, size: 7, font: regular, color: GREY });
  });
  pdf.setTitle(`Motor claim - ${c.reg || 'vehicle'}`);
  pdf.setAuthor('Ooosh! Tours Ltd');

  const dateBit = c.incident_at ? new Date(c.incident_at).toISOString().slice(0, 10) : 'undated';
  const filename = `Ooosh-motor-claim-${String(c.reg || 'vehicle').replace(/\s+/g, '')}-${dateBit}.pdf`;
  return { bytes: await pdf.save(), filename };
}
