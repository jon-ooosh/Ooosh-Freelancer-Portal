/**
 * Hire Form PDF Generation Service
 *
 * Generates driver hire agreement PDFs matching the DocuGen/Netlify layout exactly.
 * Uses pdf-lib with Roboto fonts for full Unicode support.
 *
 * Ported from netlify/functions/generate-hire-form.js v5.6
 */
import { PDFDocument, rgb, PDFPage, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getFromR2, uploadToR2 } from '../config/r2';

// ── Types ────────────────────────────────────────────────────────────────

export interface HireFormData {
  // Driver details
  driverName: string;
  email: string;
  phoneCountry?: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  homeAddress?: string;
  licenceAddress?: string;
  licenceNumber?: string;
  licenceIssuedBy?: string;
  licenceValidTo?: string;
  datePassedTest?: string;

  // Hire details
  vehicleReg?: string;
  vehicleModel?: string;
  hireStartDate?: string;
  hireStartTime?: string;
  hireEndDate?: string;
  hireEndTime?: string;
  insuranceExcess?: string;
  hireFormNumber: string;
  contractNumber?: string;
  signatureDate?: string;

  // Signature image (PNG buffer)
  signatureImage?: Buffer | null;
  // Logo image (PNG buffer)
  logoImage?: Buffer | null;
}

export interface GeneratePdfResult {
  pdfBytes: Uint8Array;
  filename: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28;  // A4 width in points
const PAGE_HEIGHT = 841.89; // A4 height in points
const MARGIN = 40;

// Declaration text for page 1
const DECLARATION_TEXT = [
  'I hereby warrant the truth of my above statements and I declare that I have not withheld any information whatsoever which might in any way increase the risk of the insurers or influence the acceptance of this proposal.',
  'I agree that this proposal shall be the basis of the contract between myself and the insurers and I further agree to be bound by the terms and conditions of the insurance, which I am aware of and have had the opportunity to see and read. I further declare that my occupation and personal details and driving record do not render me ineligible to hire.',
  'I understand all entertainment and navigation systems are not included on insurance and provided as a courtesy. I also understand that windscreens and overhead damage are not covered by the insurance.',
  'I agree that while the rental agreement is in force I will be liable as owner/hirer of the vehicle, or any replacement vehicle, for any fixed penalty offence, penalty charge notice, notice to owner, parking charge notice for that vehicle under s66 Road Traffic Offenders Act 1988, Schedule 6 Road Traffic Act 1991, Traffic Management Act 2004, Protection of Freedoms Act 2012 and any other relevant legislation.',
  'I confirm that I am liable for a non waiverable insurance excess of the amount shown. I also acknowledge that this liability shall extend to any other vehicle let to me under the same hiring agreement and to any period by which the original period of hiring may be extended.',
  'I confirm that if payment hereunder is to be made by credit or charge card my signature below shall constitute authority to debit my nominated credit or charge card company with the total due amount plus any administration charges, extensions or additional charges resulting from this rental.',
  'The Hirer and, if I am not the Hirer, I consent to my personal information (including name, address, photo and drivers licence details) and information concerning the Hirer and the hire of the vehicle under this rental agreement (including details as to payment record, credit worthiness, accidents or claims or theft or damage to the vehicle, delays in vehicle return, threatening or abusive behaviour and any other relevant information) being shared with other vehicle rental companies, suppliers to such companies and the police and other regulatory authorities, insurers and credit reference agencies, for the purposes of crime detection, risk management and assessing whether or not others may wish to hire a vehicle to me.'
];

// T&Cs text (same as Netlify function — embedded for reliability)
const TERMS_AND_CONDITIONS = `Thank you for choosing Ooosh! Tours for your vehicle hire. These terms outline the agreement between you and Ooosh! Tours Ltd when you hire or drive a vehicle from us. Only persons that have read and signed a hire agreement form and been added to the insurance may drive the vehicle. It is the responsibility of the hirer(s) to ensure no-one else drives the vehicle during their hire period.
1. Booking and confirmation
BULLET We recommend booking your van as early as possible.
BULLET We do not usually confirm bookings of fewer than four days more than two weeks in advance.
BULLET To secure a booking we require either 25% of the total hire fee, or GBP100, whichever is the greater.
BULLET If the total hire fee is less than GBP400, the full balance is required to secure your booking.
BULLET You are welcome to pay more than 25%, up to the full hire amount, if preferred, at any time.
BULLET A booking is only confirmed when a deposit has been received and acknowledged by us.
BULLET Every effort will be made to supply the requested vehicle. However, we reserve the right to substitute a similar vehicle as close as possible in specification to the booked vehicle.
BULLET We reserve the right to cancel a booking at any time if we deem necessary or the reserved vehicle becomes unavailable due to breakdown or damage.
BULLET We reserve the right to refuse or cancel a booking at any time without stating a reason.
BULLET We can not be held responsible for any losses due to a booking being cancelled or amended by us, though you will usually be entitled to a reimbursement of any hire fee or deposit already paid. Travel insurance or a dedicated touring policy should always be taken out by the hirer.
2. Driver requirements
2.1 Each driver must:
BULLET Be aged between 23 and 75 years old at the start of the hire.
BULLET Complete our online hire form prior to the hire commencing.
BULLET Have held a full non-provisional driving licence for at least 24 months.
BULLET Have accrued no more than 6 points in the last 36 months.
BULLET Declare if they:
SUBBULLET Have ever received, or have a prosecution pending for, any of the following motoring offences:
SUBSUB AC10 to AC30 (inclusive)
SUBSUB BA10, BA30
SUBSUB CD40 to CD90 (inclusive)
SUBSUB CU80
SUBSUB DD40 to DD90 (inclusive)
SUBSUB DR10 to DR80 (inclusive)
SUBSUB IN10, MS50, MS90, or TT99
SUBBULLET Have received a single SP offence that yielded 6 or more points.
SUBBULLET Have been disqualified from driving for a period exceeding 12 months in the last 3 years.
SUBBULLET Have suffered loss or loss of use of limb, eye, defective hearing or vision (not corrected by spectacles or hearing aid), a heart/diabetic/epileptic condition or from any other infirmity that should be disclosed to DVLA/DVLNI.
SUBBULLET Have during the past 5 years been convicted of any of the following offences: manslaughter, causing death by dangerous or reckless driving, dangerous driving, driving whilst under the influence of drink or drugs, failing to stop after and/or report an accident to police or any combination of offences that have resulted in suspension or disqualification from driving.
SUBBULLET Have been told by your doctor not to drive, even temporarily.
BULLET If any of the above apply, or if you are in any doubt, then you must contact us first. Such drivers may incur a surcharge, or an increase in excess (or both), or may not be able to drive our vehicles at all. This decision is usually at the sole discretion of our insurer.
2.2 Driver documentation
Each driver must produce:
BULLET A valid driving licence.
BULLET Two proofs of address (dated within 90 days) from two different sources, such as utility bills; bank or credit card statements; government letters etc. These do not have to be paper copies; PDFs are acceptable.
BULLET UK drivers will need to supply a DVLA license summary.
BULLET Non-UK drivers will need to also submit their passport.
BULLET We will retain electronic copies of all documentation for our records.
3. Payments
BULLET The hire fee must be paid in full before the hire starts.
BULLET The insurance excess must also be paid in full before the hire starts (see section 4 below).
BULLET Accepted payment methods:
SUBBULLET Credit/debit card (including AmEx)
SUBBULLET Cleared bank transfer
SUBBULLET Cheque
SUBBULLET PayPal
SUBBULLET Cash is not accepted for vehicle hires
4. Self drive hire insurance
4.1 Cover and excess
BULLET Our standard insurance excess is GBP1,000+VAT.
BULLET This must be paid in full before the vehicle hire starts by any of the same payment methods shown above in 3.
BULLET An increased excess may apply if you fall outside our standard terms and must be paid as above.
BULLET The cover is fully comprehensive and covers the UK and EU as standard. A list of countries covered is available on request.
4.2 Deductions from the excess
BULLET If the van is returned in the same condition it left us, then the excess is usually refundable within 10 days after the last day of hire (please also section 5 for more information on this).
BULLET Examples of deductions from the excess include:
SUBBULLET Cleaning costs (ie excessive mud inside or out, or excessive litter): minimum GBP75+VAT
SUBBULLET Damage repairs (please see section 6.2 for more information on this)
SUBBULLET Evidence of smoking or vaping in the vehicle: minimum GBP150+VAT
SUBBULLET Late return of the vehicle (please see section 7.1 for more information on this)
SUBBULLET Underfuelling: charged at GBP2.50+VAT per litre.
SUBBULLET Parking or traffic fines or offences: liability is usually transferred to the driver plus a GBP35+VAT handling fee.
SUBBULLET Note that some fines may not be received by us until after your hire has ended: you remain liable for them regardless.
BULLET It is important to note that multiple incidents will require multiple excesses, which will be payable on demand.
SUBBULLET Each incident is treated separately and you are responsible for the costs, up to the excess, for each separate incident.
SUBBULLET Your rental may be suspended without payment of additional excesses.
SUBBULLET Multiple incidents could leave you liable for high costs. It may therefore be advisable to take out some form of insurance protection.
4.3 Limitations
Insurance does NOT cover:
BULLET Personal belongings.
BULLET Damage from illegal activities.
BULLET Internal fittings such as entertainment systems.
BULLET Drivers who have not completed a hire form and been approved by us.
BULLET Damage to windscreen, wing mirrors or tyres.
BULLET Any overhead damage to the vehicle.
BULLET Damage to the engine if caused by negligence of the driver (ie failure to adhere to warning lights, or improper fuelling, or failure to top up fluids).
Any charges arising from the above causes will be charged at the full cost of repair or replacement, which may be considerably more than the GBP1,000+VAT excess. This may include any loss of contractual obligations by the lessor, plus admin fees (as further detailed in 6.2).
5. Vehicle use and care
5.1 Vehicle condition
BULLET The vehicle will be supplied clean and ready for your hire.
BULLET At the start of the hire you will be allowed to inspect the vehicle and its contents.
BULLET We will document the vehicle condition, fuel level etc with photographs, which we will share with you and ask you to sign to confirm these are true and accurate.
BULLET You must return the vehicle:
SUBBULLET In the same condition (fair wear and tear notwithstanding)
SUBBULLET With the same fuel level
SUBBULLET With all contents present and intact
5.2 Maintenance responsibilities
During your hire you are responsible for:
BULLET Checking oil, water, and AdBlue, brake fluid levels daily and topping up if required (at your own cost).
BULLET Returning the vehicle to us by the agreed time and date.
BULLET Keeping the vehicle locked at all times whilst not in use.
BULLET Protecting the vehicle keys: they must never be left unattended inside the vehicle.
BULLET Reporting any issues to us immediately and following our advice.
BULLET Following any reasonable instructions given by us relating to the safe keeping of the vehicle.
5.3 Prohibited uses
During your hire you must NOT:
BULLET Use the vehicle for any illegal purposes.
BULLET Drive whilst under the influence of alcohol/drugs.
BULLET Exceed the vehicle weight limits (overall, or on either axle).
BULLET Carry more passengers than there are seats.
BULLET Use the vehicle in motor races.
BULLET Use the vehicle for driving instruction.
BULLET Alter the vehicle or its contents in any way.
6. Accidents, damage, theft and breakdowns
6.1 Reporting requirements
BULLET Report any accident, incident, breakdown or theft to us, however minor and however occurred, as soon as possible, and ideally within 24 hours.
BULLET If you require the involvement of the police then you must pass on any such communication to us, including crime or incident numbers, within 24 hours.
BULLET Gather details of all parties involved, ideally including photographs.
BULLET Do NOT admit liability.
BULLET Do NOT pay any money at the scene.
BULLET Complete any paperwork reasonably required by us or our insurers related to the incident(s) in a timely manner.
BULLET If the vehicle is stolen, and you still have the key, we will provide you with another, comparable vehicle to be collected from our office. However, if we do not have a vehicle available then no refund will be due for your remaining hire period.
6.2 Damage and repairs
If our vehicle is damaged:
BULLET We will usually only evaluate damage on return of the vehicle to our East Street address.
BULLET We will compare the vehicle to the photographs taken on book-out (see section 5.1) and document the new area(s) of damage(s) and provide you with photographs for your reference.
BULLET We will provide you with estimates for the repair(s) from two reputable sources within a reasonable timeframe. To the quoted repair cost we will add:
SUBBULLET An admin fee of GBP35+VAT
SUBBULLET Our transport costs to/from the repairer (which may be for both quoting and/or the actual repair)
SUBBULLET Our loss of revenue whilst the vehicle is off the road (calculated by the repairer's estimated time to complete the work)
BULLET This applies to interior fittings (including seats and upholstered items) as well as to exterior bodywork.
BULLET You are responsible for the cost and procurement of a new tyre if a replacement is needed. You must replace the tyre with a comparable type, and we may charge for an unsuitable replacement, which will also incur an admin fee of GBP35+VAT.
6.3 Breakdowns
BULLET We keep our vehicles regularly serviced and maintained to an excellent standard. However, we cannot be held responsible for any loss or liability, financial or otherwise, due to failure of the vehicle or any of its parts, however caused.
BULLET Any entertainment or WiFi systems provided with the vehicle are provided as a courtesy and we accept no responsibility or liability in case of their failure.
BULLET Our vehicles are covered for breakdown within the UK and EU.
BULLET In the event of a breakdown, malfunction or instance of non-ordinary operation you must:
SUBBULLET Contact us or our authorised representative first, and not authorise any repairs without our permission
SUBBULLET Stop driving the vehicle as soon as it is safe to do so until advised otherwise by us or our authorised representative
SUBBULLET Not authorise or undertake any repairs without our express permission
SUBBULLET Pass to us as soon as possible any paperwork, receipts etc received during assessments or repairs
BULLET If the vehicle breaks down and cannot be repaired in a reasonable timeframe we will provide you with another, comparable vehicle and if we are unable to do so we will refund you the cost of the remaining period of hire.
7. Timings
7.1 The rental period
BULLET The rental period starts at 9am on the first date of hire and concludes at 9am the morning after the final hired day, regardless of the time the hire began.
BULLET The vehicle must be returned to our East Street address by 9am on this date.
BULLET Any delivery or collection of the vehicle to an agreed other location (which, by prior arrangement, we are usually happy to quote for) will factor in the above requirement in its costing.
BULLET Late return without prior notification and consent, or to a different location than that agreed, will incur:
SUBBULLET A full day's hire charge for each additional 24 hours, or part thereof.
SUBBULLET A late return fee of GBP150+VAT.
SUBBULLET Any reasonably incurred costs for us to bring the vehicle to the agreed location.
7.2 Out of hours returns
BULLET When returning your vehicle overnight or "out of hours", you remain legally responsible for the vehicle until we open for business the following day.
BULLET This means:
SUBBULLET The vehicle must be parked legally and safely
SUBBULLET Until we open for business and have the keys for the vehicle returned from you, you remain responsible for the vehicle, including any damage or fines incurred while parked
BULLET The 'out of hours' return facility is offered as a courtesy and is only offered by agreed pre-arrangement. Failure to adhere to the instructions given may result in this not being offered on future hires.
8. Cancellations, extensions and early returns
8.1 Cancellations:
BULLET With more than 7 days notice: 10% of hire fee OR GBP50+VAT charged, whichever is the greater amount.
BULLET Within 7 days of first day of hire: 25% of hire fee charged (ie deposit retained).
BULLET Within 2 days of first day of hire: 100% of hire charge OR one full week plus the sliding refund per 8.3 below, whichever is the lesser amount.
BULLET Any agreed costs or fees for delivery and/or collection of the vehicle may be chargeable in addition to the above amounts.
BULLET Refunds to you (if applicable) will be processed within ten days.
BULLET Balances owed to us following a cancellation will be due on demand.
8.2 Extensions
BULLET Please let us know as soon as possible if you need to extend your booking.
BULLET We will always endeavour to honour such requests but cannot guarantee availability of your vehicle beyond your originally booked dates
BULLET Any additional charges will be payable immediately to secure an extension.
8.3 Early returns
BULLET Once a hire has started, please let us know as soon as possible if you need to bring your vehicle back before the agreed finish date.
BULLET The following charges will apply:
SUBBULLET Minimum 7-day charge after the period already used
SUBBULLET Partial refunds for remaining days after the minimum 7 days:
SUBSUB Days 8-15: 50% refund
SUBSUB Days 16-30: 75% refund
SUBSUB Days 31+: 90% refund
BULLET Refunds will usually be processed within ten days.
9. Enforcement of terms and recovery of costs
9.1 Legal enforcement
In the event of a breach of these terms, Ooosh! Tours Ltd reserves the right to:
BULLET Terminate the hire agreement immediately without recourse to you.
BULLET Recover all outstanding costs (including retaining any already held funds).
BULLET Pursue legal action to enforce contractual obligations.
BULLET Refuse future hires and/or cancel upcoming ones.
BULLET Share information about outstanding debts, including to relevant industry bodies.
9.2 Recovery of costs
We are entitled to recover:
BULLET All direct costs incurred.
BULLET Reasonable legal expenses.
BULLET Reasonable administrative costs.
BULLET Any outstanding charges.
9.3 Debt recovery process
If payments are not received in an agreed timeframe, we may:
BULLET Issue formal demand notices.
BULLET Engage debt collection agencies and/or pursue county court judgments.
BULLET Initiate legal proceedings.
In all cases we will:
BULLET Provide explanations, evidence, and proformas or invoices for any claimed money.
BULLET Offer you an opportunity to dispute claims.
BULLET Seek cost-effective and reasonable resolutions.
BULLET Act in good faith at all times.
9.4 Legal jurisdiction and acknowledgment
BULLET All disputes will be subject to UK law, and any proceedings will be brought in the courts of England and Wales.
BULLET By agreeing to these terms, you acknowledge our right to pursue all legal remedies for breach of contract, including recovery of all reasonable costs associated with enforcement.
BULLET If we choose not to enforce any part of this agreement at any time, it doesn't mean we've given up our right to enforce that or any other part of the agreement in the future.
BULLET This clause is designed to protect both parties and ensure fair resolution of any disputes.
10. Miscellaneous
10.1 Data protection
BULLET In order to comply with our legal obligations (including provision of self-drive insurance) and to provide good customer service to you we (and our insurers) will need to gather personal details and documents from you such as your full name, email address, date of birth, proofs of address, driving licence & history, etc.
BULLET We gather only what we need to meet these legal requirements and/or business operations and we may retain details and/or copies of these submitted personal details and documents for up to two years. All such data will be securely held and access to such data is strictly controlled.
BULLET We may use machine-assistance (ie Artificial Intelligence (AI)) in some of our processes or decision making.
BULLET Your vehicle may have a telematics tracking device fitted to it. Data collected from such a device will only be used by us for our normal business purposes. You consent to us storing your information for the purpose of this hire.
BULLET We and the insurers pass information to the Claims and Underwriting Exchange Register, run by Insurance Database Services Ltd (IDS Ltd) and the Motor AntiFraud and Theft Register, run by the Association of British Insurers (ABI).
BULLET We may need to share your details with law enforcement, connected agencies, contractors or companies, but will only ever do so for the above reasons, and will never sell or market your details, unless we have your explicit consent to do so.
BULLET If you would like to find out how we store your information or would like to request the status of your information held at any point you can request this by contacting us.
10.2 Force Majeure
BULLET Our performance under this agreement will be excused if we are unable to perform due to any cause beyond our reasonable control (including but not limited to, any labour dispute, act of God, war, act of terrorism, riot, civil unrest, fire, flood, storm, or any computer or internet-related failure, error or delay).
10.3 Disputes
BULLET We aim to resolve any disputes fairly.
BULLET A copy of our complaints process is available on request or on our website.
BULLET In case of any inability to reach a solution we will refer to an independent mediator, usually the BVRLA.
BULLET In case of dispute over damage or theft liability, you agree that liability will be decided at the sole discretion of our insurer.
10.4 Changes to terms
BULLET We may update terms periodically.
BULLET Any changes mid-hire will be notified to you as soon as practically possible.
BULLET The most current version is always available on request or on our website.`;

// ── Font Handling ────────────────────────────────────────────────────────

let cachedFonts: { regular: Buffer; bold: Buffer } | null = null;

function loadFontFiles(): { regular: Buffer; bold: Buffer } | null {
  if (cachedFonts) return cachedFonts;

  const fontsDir = join(__dirname, 'fonts');
  const regularPath = join(fontsDir, 'Roboto-Regular.ttf');
  const boldPath = join(fontsDir, 'Roboto-Bold.ttf');

  if (existsSync(regularPath) && existsSync(boldPath)) {
    cachedFonts = {
      regular: readFileSync(regularPath),
      bold: readFileSync(boldPath),
    };
    return cachedFonts;
  }
  return null;
}

// ── Logo Handling ────────────────────────────────────────────────────────

let cachedLogo: Buffer | null = null;
const LOGO_R2_KEY = 'assets/ooosh-logo.png';

/**
 * Fetch the Ooosh logo from R2 (cached in memory after first load).
 * Returns null if not available.
 */
export async function fetchLogo(): Promise<Buffer | null> {
  if (cachedLogo) return cachedLogo;

  try {
    const response = await getFromR2(LOGO_R2_KEY);
    if (response.Body) {
      const chunks: Buffer[] = [];
      const stream = response.Body as NodeJS.ReadableStream;
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      cachedLogo = Buffer.concat(chunks);
      console.log(`[hire-form-pdf] Logo loaded from R2: ${cachedLogo.length} bytes`);
      return cachedLogo;
    }
  } catch (e) {
    console.log('[hire-form-pdf] Logo not found in R2, will generate PDF without logo');
  }
  return null;
}

/**
 * Upload the Ooosh logo to R2 (one-time setup).
 */
export async function uploadLogo(imageBuffer: Buffer): Promise<string> {
  await uploadToR2(LOGO_R2_KEY, imageBuffer, 'image/png');
  cachedLogo = imageBuffer;
  return LOGO_R2_KEY;
}

// ── Helper Functions ─────────────────────────────────────────────────────

function formatDate(dateString?: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return dateString;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function formatTime(hourValue?: string | null): string {
  if (!hourValue) return '09:00 AM';
  // Handle "HH:mm" format
  if (hourValue.includes(':')) {
    const [h] = hourValue.split(':').map(Number);
    if (isNaN(h!)) return '09:00 AM';
    const ampm = h! >= 12 ? 'PM' : 'AM';
    const hour12 = h! % 12 || 12;
    const mins = hourValue.split(':')[1] || '00';
    return `${String(hour12).padStart(2, '0')}:${mins} ${ampm}`;
  }
  // Handle bare hour number
  const hour = parseInt(hourValue, 10);
  if (isNaN(hour)) return '09:00 AM';
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:00 ${ampm}`;
}

function drawHorizontalLine(page: PDFPage, y: number, margin: number, pageWidth: number) {
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
}

function drawBullet(page: PDFPage, x: number, y: number, radius = 2) {
  page.drawCircle({ x, y: y + 3, size: radius, color: rgb(0.2, 0.2, 0.2) });
}

function drawOpenBullet(page: PDFPage, x: number, y: number, radius = 2) {
  page.drawCircle({
    x, y: y + 3, size: radius,
    borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.5, color: rgb(1, 1, 1),
  });
}

function drawSquareBullet(page: PDFPage, x: number, y: number, size = 3) {
  page.drawRectangle({
    x: x - size / 2, y: y + 1, width: size, height: size, color: rgb(0.3, 0.3, 0.3),
  });
}

async function embedImage(pdfDoc: PDFDocument, imageBuffer: Buffer) {
  try {
    return await pdfDoc.embedPng(imageBuffer);
  } catch {
    return await pdfDoc.embedJpg(imageBuffer);
  }
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}

// ── Main PDF Generation ──────────────────────────────────────────────────

export async function generateHireFormPdf(data: HireFormData): Promise<GeneratePdfResult> {
  const pdfDoc = await PDFDocument.create();

  // Load fonts (custom Roboto with fallback to standard)
  const fontFiles = loadFontFiles();
  let mainFont: PDFFont;
  let boldFont: PDFFont;

  if (fontFiles) {
    pdfDoc.registerFontkit(fontkit);
    mainFont = await pdfDoc.embedFont(fontFiles.regular);
    boldFont = await pdfDoc.embedFont(fontFiles.bold);
    console.log('[hire-form-pdf] Custom fonts loaded (Roboto)');
  } else {
    const { StandardFonts } = await import('pdf-lib');
    mainFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    console.log('[hire-form-pdf] Using fallback StandardFonts');
  }

  // Extract and format data
  const driverName = data.driverName || '';
  const email = data.email || '';
  const phone = data.phoneCountry && data.phoneNumber
    ? `${data.phoneCountry}${data.phoneNumber}`
    : (data.phoneNumber || '');
  const dob = formatDate(data.dateOfBirth);
  const homeAddress = data.homeAddress || '';
  const licenceAddress = data.licenceAddress || homeAddress;
  const licenceNumber = data.licenceNumber || '';
  const licenceIssuedBy = data.licenceIssuedBy || '';
  const licenceValidTo = formatDate(data.licenceValidTo);
  const datePassedTest = formatDate(data.datePassedTest);
  const vehicleReg = data.vehicleReg || '';
  const vehicleModel = data.vehicleModel || '';
  const hireStartDate = formatDate(data.hireStartDate);
  const hireStartTime = formatTime(data.hireStartTime);
  const hireEndDate = formatDate(data.hireEndDate);
  const hireEndTime = formatTime(data.hireEndTime);
  const rawExcess = data.insuranceExcess || '\u00A31,200';
  const excess = rawExcess.replace(/GBP/gi, '\u00A3');
  const hireFormNumber = data.hireFormNumber;
  const contractNumber = data.contractNumber || '';
  const signatureDate = formatDate(data.signatureDate);

  // ============ PAGE 1: Main Form ============
  const page1 = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // === HEADER SECTION (3 columns) ===
  const headerTopY = PAGE_HEIGHT - MARGIN;
  const smallTextOffset = 4;

  // Left column: Title and contact
  page1.drawText('HIRE AGREEMENT &', { x: MARGIN, y: headerTopY, size: 14, font: boldFont, color: rgb(0.2, 0.2, 0.2) });
  page1.drawText('INSURANCE FORM', { x: MARGIN, y: headerTopY - 16, size: 14, font: boldFont, color: rgb(0.2, 0.2, 0.2) });
  page1.drawText('+44 (0) 1273 911382', { x: MARGIN, y: headerTopY - 30, size: 9, font: mainFont, color: rgb(0.3, 0.3, 0.3) });
  page1.drawText('info@oooshtours.co.uk', { x: MARGIN, y: headerTopY - 41, size: 9, font: mainFont, color: rgb(0.3, 0.3, 0.3) });

  // Middle column: Form numbers
  const middleX = 200;
  const middleY = headerTopY + smallTextOffset;
  page1.drawText('Hire form number', { x: middleX, y: middleY, size: 9, font: boldFont });
  page1.drawText(hireFormNumber, { x: middleX, y: middleY - 12, size: 10, font: mainFont });
  page1.drawText('Contract number', { x: middleX, y: middleY - 30, size: 9, font: boldFont });
  page1.drawText(contractNumber, { x: middleX, y: middleY - 42, size: 10, font: mainFont });

  // Right column: Logo + Company address
  const addressX = 420;
  const addressY = headerTopY + smallTextOffset;

  if (data.logoImage) {
    try {
      const logo = await embedImage(pdfDoc, data.logoImage);
      const logoDims = logo.scale(1);
      const maxLogoHeight = 42;
      const scale = maxLogoHeight / logoDims.height;
      const logoWidth = logoDims.width * scale;
      const logoY = addressY + 6 - maxLogoHeight;

      page1.drawImage(logo, { x: PAGE_WIDTH - MARGIN - logoWidth, y: logoY, width: logoWidth, height: maxLogoHeight });
    } catch (e) {
      console.log('[hire-form-pdf] Could not embed logo:', e instanceof Error ? e.message : e);
    }
  }

  const addressLines = ['Ooosh! Tours Ltd', 'Compass House', '7 East Street', 'Portslade', 'BN41 1DL'];
  addressLines.forEach((line, idx) => {
    page1.drawText(line, { x: addressX, y: addressY - (idx * 11), size: 9, font: mainFont, color: rgb(0.3, 0.3, 0.3) });
  });

  y = headerTopY - 52;

  // Registration line - CENTERED
  y -= 14;
  drawHorizontalLine(page1, y, MARGIN, PAGE_WIDTH);
  y -= 12;
  const regText = 'REGISTERED IN ENGLAND & WALES, COMPANY NUMBER 07590921 | VAT REGISTRATION NUMBER 114087243';
  const regTextWidth = mainFont.widthOfTextAtSize(regText, 7);
  const regTextX = (PAGE_WIDTH - regTextWidth) / 2;
  page1.drawText(regText, { x: regTextX, y, size: 7, font: mainFont, color: rgb(0.5, 0.5, 0.5) });
  y -= 8;
  drawHorizontalLine(page1, y, MARGIN, PAGE_WIDTH);
  y -= 20;

  // === DRIVER DETAILS SECTION (2 columns) ===
  const leftColX = MARGIN;
  const rightColX = 300;
  const labelColor = rgb(0.2, 0.2, 0.2);

  // Row 1: Name / Contacts
  page1.drawText('Name', { x: leftColX, y, size: 9, font: boldFont, color: labelColor });
  page1.drawText('Contacts', { x: rightColX, y, size: 9, font: boldFont, color: labelColor });
  y -= 12;
  page1.drawText(driverName, { x: leftColX, y, size: 10, font: mainFont });
  page1.drawText(email, { x: rightColX, y, size: 10, font: mainFont });
  y -= 18;

  // Row 2: DOB / Phone
  page1.drawText('Date of birth', { x: leftColX, y, size: 9, font: boldFont, color: labelColor });
  y -= 12;
  page1.drawText(dob, { x: leftColX, y, size: 10, font: mainFont });
  page1.drawText(phone, { x: rightColX, y, size: 10, font: mainFont });
  y -= 18;

  // Row 3: Home address / Licence address (word-wrapped)
  page1.drawText('Home address', { x: leftColX, y, size: 9, font: boldFont, color: labelColor });
  page1.drawText('Licence address (if different to home)', { x: rightColX, y, size: 9, font: boldFont, color: labelColor });
  y -= 12;

  const leftColMaxWidth = rightColX - leftColX - 15;
  const rightColMaxWidth = PAGE_WIDTH - MARGIN - rightColX - 5;
  const addressFontSize = 9;

  const homeLines = wrapText(homeAddress, mainFont, addressFontSize, leftColMaxWidth);
  const licenceLines = wrapText(licenceAddress, mainFont, addressFontSize, rightColMaxWidth);
  const maxLines = Math.max(homeLines.length, licenceLines.length, 1);
  const linesToDraw = Math.min(maxLines, 3);

  for (let i = 0; i < linesToDraw; i++) {
    if (homeLines[i]) page1.drawText(homeLines[i], { x: leftColX, y, size: addressFontSize, font: mainFont });
    if (licenceLines[i]) page1.drawText(licenceLines[i], { x: rightColX, y, size: addressFontSize, font: mainFont });
    if (i < linesToDraw - 1) y -= 11;
  }
  y -= 18;

  // Row 4: Licence number / Licence valid til
  page1.drawText('Licence number', { x: leftColX, y, size: 9, font: boldFont, color: labelColor });
  page1.drawText('Licence valid til', { x: rightColX, y, size: 9, font: boldFont, color: labelColor });
  y -= 12;
  page1.drawText(licenceNumber, { x: leftColX, y, size: 10, font: mainFont });
  page1.drawText(licenceValidTo, { x: rightColX, y, size: 10, font: mainFont });
  y -= 18;

  // Row 5: Licence issued by / Date passed test
  page1.drawText('Licence issued by', { x: leftColX, y, size: 9, font: boldFont, color: labelColor });
  page1.drawText('Date passed test', { x: rightColX, y, size: 9, font: boldFont, color: labelColor });
  y -= 12;
  page1.drawText(licenceIssuedBy, { x: leftColX, y, size: 10, font: mainFont });
  page1.drawText(datePassedTest, { x: rightColX, y, size: 10, font: mainFont });
  y -= 15;

  drawHorizontalLine(page1, y, MARGIN, PAGE_WIDTH);
  y -= 20;

  // === VEHICLE AND HIRE DETAILS ===
  const vehicleDisplay = vehicleReg && vehicleModel ? `${vehicleReg} - ${vehicleModel}` : (vehicleReg || vehicleModel || 'TBC');

  page1.drawText('Vehicle registration and model:', { x: leftColX, y, size: 10, font: boldFont });
  page1.drawText(vehicleDisplay, { x: 200, y, size: 10, font: mainFont });
  y -= 18;

  page1.drawText('Hire starts:', { x: leftColX, y, size: 10, font: boldFont });
  page1.drawText(`${hireStartDate} ${hireStartTime}`, { x: 200, y, size: 10, font: mainFont });
  y -= 18;

  page1.drawText('Hire ends:', { x: leftColX, y, size: 10, font: boldFont });
  page1.drawText(`${hireEndDate} ${hireEndTime}`, { x: 200, y, size: 10, font: mainFont });
  y -= 18;

  page1.drawText('Insurance excess liable for:', { x: leftColX, y, size: 10, font: boldFont });
  page1.drawText(excess, { x: 200, y, size: 10, font: mainFont });
  y -= 25;

  // === DECLARATION TEXT ===
  const declarationFontSize = 8;
  const lineHeight = 11;
  const maxTextWidth = PAGE_WIDTH - MARGIN * 2;

  for (const para of DECLARATION_TEXT) {
    const words = para.split(' ');
    let line = '';

    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = mainFont.widthOfTextAtSize(testLine, declarationFontSize);
      if (textWidth > maxTextWidth) {
        page1.drawText(line, { x: MARGIN, y, size: declarationFontSize, font: mainFont, color: rgb(0.2, 0.2, 0.2) });
        y -= lineHeight;
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) {
      page1.drawText(line, { x: MARGIN, y, size: declarationFontSize, font: mainFont, color: rgb(0.2, 0.2, 0.2) });
      y -= lineHeight + 4;
    }
  }

  // === SIGNATURE SECTION ===
  y -= 15;

  if (data.signatureImage) {
    try {
      const image = await embedImage(pdfDoc, data.signatureImage);
      const imgDims = image.scale(1);
      const maxSigWidth = 180;
      const maxSigHeight = 70;
      const scale = Math.min(maxSigWidth / imgDims.width, maxSigHeight / imgDims.height, 1);

      page1.drawImage(image, {
        x: MARGIN,
        y: y - imgDims.height * scale,
        width: imgDims.width * scale,
        height: imgDims.height * scale,
      });
      y -= (imgDims.height * scale) + 15;
    } catch (e) {
      console.log('[hire-form-pdf] Could not embed signature:', e instanceof Error ? e.message : e);
      y -= 50;
    }
  } else {
    y -= 50;
  }

  page1.drawText(`${driverName}    ${signatureDate}`, { x: MARGIN, y, size: 10, font: mainFont });

  // ============ PAGES 2+: Terms & Conditions ============
  const tcLines = TERMS_AND_CONDITIONS.split('\n');
  let tcPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  y = PAGE_HEIGHT - MARGIN;
  const tcFontSize = 9;
  const tcLineHeight = 12;

  for (const line of tcLines) {
    if (y < MARGIN + 40) {
      tcPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    if (line.trim() === '') {
      y -= 6;
      continue;
    }

    const isMainHeader = /^[0-9]+\.\s/.test(line.trim()) && !line.startsWith('BULLET');
    const isSubHeader = /^[0-9]+\.[0-9]+\s/.test(line.trim());
    const isBullet = line.startsWith('BULLET ');
    const isSubBullet = line.startsWith('SUBBULLET ');
    const isSubSubBullet = line.startsWith('SUBSUB ');

    let displayLine = line;
    if (isBullet) displayLine = line.substring(7);
    if (isSubBullet) displayLine = line.substring(10);
    if (isSubSubBullet) displayLine = line.substring(7);

    const font = (isMainHeader || isSubHeader) ? boldFont : mainFont;
    const size = isMainHeader ? 11 : tcFontSize;
    let indent = 0;
    let bulletIndent = 0;

    if (isBullet) { indent = 20; bulletIndent = 15; }
    if (isSubBullet) { indent = 35; bulletIndent = 30; }
    if (isSubSubBullet) { indent = 50; bulletIndent = 45; }

    if (isBullet) drawBullet(tcPage, MARGIN + bulletIndent - 5, y);
    else if (isSubBullet) drawOpenBullet(tcPage, MARGIN + bulletIndent - 5, y);
    else if (isSubSubBullet) drawSquareBullet(tcPage, MARGIN + bulletIndent - 5, y);

    // Word wrap
    const words = displayLine.split(' ');
    let currentLine = '';
    const lineMaxWidth = PAGE_WIDTH - MARGIN * 2 - indent;

    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, size);

      if (textWidth > lineMaxWidth) {
        tcPage.drawText(currentLine, { x: MARGIN + indent, y, size, font });
        y -= tcLineHeight;
        currentLine = word;

        if (y < MARGIN + 40) {
          tcPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          y = PAGE_HEIGHT - MARGIN;
        }
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      tcPage.drawText(currentLine, { x: MARGIN + indent, y, size, font });
      y -= tcLineHeight;
    }

    if (isMainHeader) y -= 4;
  }

  const pdfBytes = await pdfDoc.save();

  // Generate filename
  const safeDriverName = driverName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  const safeVehicleReg = vehicleReg ? vehicleReg.replace(/[^a-zA-Z0-9]/g, '') : 'TBC';
  const filename = `${safeDriverName}-${hireFormNumber}-${safeVehicleReg}.pdf`;

  console.log(`[hire-form-pdf] Generated PDF: ${filename} (${pdfBytes.length} bytes)`);

  return { pdfBytes, filename };
}
