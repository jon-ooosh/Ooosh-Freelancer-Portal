/**
 * Screenshots for the "Getting started" freelancer guide (docs/guides/README.md).
 *
 * Renders the REAL portal pages on a phone-sized screen, with every /api call
 * answered from the made-up data below. Nothing touches OP.
 *
 * 1. Run the portal locally (any secret of 32+ characters; it only signs the
 *    fake login cookie):
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100
 * 2. In another terminal, from the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/getting-started/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js getting-started
 */

const path = require('path')
const fs = require('fs')
const { phone, ukToday, ring, clearRings, snap, hideFixed } = require('../shared/shots')

const BASE = process.env.PORTAL_URL || 'http://localhost:3100'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET
if (!SECRET) { console.error('Set SESSION_SECRET (the same one the portal was started with).'); process.exit(1) }

// ── Sample data (made-up bands, venues and people) ───────────────────────────

const TODAY = ukToday()
const day = (n) => ukToday(n)

const DELIVERY = {
  id: 'q-del-1', name: 'The Lantern Thieves', board: 'dc', type: 'delivery', date: TODAY, time: '10:30',
  venueName: 'Roundhouse', driverPay: 85, hhRef: '16840',
}
const CREW = {
  id: 'q-crew-1', name: 'Paper Satellites', board: 'crew', type: 'delivery', date: day(2), time: '09:00',
  venueName: 'Victoria Park', driverPay: 250, freelancerFee: 250, hhRef: '16841',
  workType: 'Backline Tech', workDurationHours: 10, numberOfDays: 1, jobType: 'Crew Only',
}
const COLLECTION = {
  id: 'q-col-1', name: 'The Lantern Thieves', board: 'dc', type: 'collection', date: day(5), time: '23:30',
  venueName: 'Roundhouse', driverPay: 85, hhRef: '16840',
}
const JOBS = {
  success: true,
  user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  today: [DELIVERY], upcoming: [CREW, COLLECTION],
  completed: [{ id: 'q-old-1', name: 'Velvet Static', board: 'dc', type: 'delivery', date: day(-3), time: '14:00', venueName: 'Electric Ballroom', driverPay: 70, hhRef: '16820', completedAtDate: day(-3) }],
  cancelled: [],
}
const DAYS = {
  success: true, awaitingReply: 1, past: [], done: [],
  upcoming: [{ id: 'd1', date: day(3), startTime: '09:00', endTime: '17:00', durationType: 'full_day', rateType: 'day',
    agreedRate: 140, notes: 'Warehouse: prepping backline for a tour', status: 'offered', invoiceReceived: false, tasks: [] }],
}
const SHIFTS = { success: true, shifts: [
  { date: day(4), planned_start: '18:00:00', planned_end: '23:00:00', status: 'scheduled', assignment_status: 'confirmed',
    fee: 90, report_submitted_at: null, jobs: [] },
] }

const VENUE = {
  id: 'v1', name: 'Roundhouse', address: 'Chalk Farm Road, London NW1 8EH', loadInAddress: null,
  whatThreeWords: 'index.home.raft', phone: '020 7946 0000',
  accessNotes: 'Stage door is on the left of the main entrance. 20 minutes to unload.',
}
const DELIVERY_DETAIL = {
  success: true, boardType: 'dc', contactsVisible: true, venue: VENUE,
  job: { ...DELIVERY, whatIsIt: 'equipment', venueId: 'v1', status: 'confirmed',
    keyNotes: 'Load in via the stage door on Chalk Farm Road. Ask for Priya.',
    contacts: [{ name: 'Priya Shah', label: 'Tour manager', phone: '07700 900123', email: 'priya@example.com' }] },
}
const CREW_DETAIL = {
  success: true, boardType: 'crew', contactsVisible: true,
  venue: { id: 'v2', name: 'Victoria Park', address: 'Grove Road, London E3 5TB', phone: null },
  job: { ...CREW, date: TODAY, completeFrom: TODAY, venueId: 'v2', status: 'confirmed', board: 'crew',
    destination: 'Victoria Park', workDescription: 'Line-check and change-overs on the second stage.',
    contacts: [{ name: 'Sam Hart', label: 'Production manager', phone: '07700 900456', email: null }] },
}
const NOTIF = { success: true, notifications: { globalMuteActive: false, globalMuteUntil: null, mutedJobIds: [], mutedJobCount: 0 } }
const RESOURCES = { resources: [
  { id: 'r1', title: 'Getting started with the portal', category: 'training', kind: 'file', fileName: 'getting-started-guide.pdf', fileType: 'PDF', url: 'https://example.com/1.pdf' },
  { id: 'r2', title: 'Delivering a hire van', category: 'training', kind: 'file', fileName: 'van-delivery-guide.pdf', fileType: 'PDF', url: 'https://example.com/2.pdf' },
  { id: 'r3', title: 'How to invoice Ooosh Tours Ltd', category: 'policy', kind: 'file', fileName: 'how-to-invoice.pdf', fileType: 'PDF', url: 'https://example.com/3.pdf' },
] }

// Earnings: one paid, one approved, one with a question, one job still to invoice.
const [y, m] = TODAY.split('-').map(Number)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const lm = m === 1 ? 12 : m - 1
const fridayAfter = (n) => { const d = new Date(`${day(n)}T12:00:00Z`); while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
const EARNINGS = {
  success: true, shared: false,
  period: { key: 'this_month', label: MONTHS[m - 1], tab: MONTHS[m - 1], from: `${y}-${String(m).padStart(2, '0')}-01`, to: TODAY },
  periods: [
    { key: 'last_month', label: MONTHS[lm - 1], tab: MONTHS[lm - 1], from: '', to: '' },
    { key: 'this_month', label: MONTHS[m - 1], tab: MONTHS[m - 1], from: '', to: '' },
    { key: 'tax_year', label: 'Tax year', tab: 'Tax year', from: '', to: '' },
  ],
  labelsFrom: '2026-10-22',
  totals: { paid: 155, invoiced: 250, toInvoice: 85, total: 490 },
  counts: { paid: 1, waiting: 1 },
  toInvoiceCount: 1,
  nextPayment: { date: fridayAfter(1), amount: 250 },
  invoices: [
    { id: 'i2', invoiceNumber: 'AM-024', date: day(-2), amount: 250, status: 'approved', statusDate: fridayAfter(1), queryNote: null,
      work: [{ date: day(-4), title: 'Crew - Victoria Park', jobNumber: 16841 }] },
    { id: 'i1', invoiceNumber: 'AM-023', date: day(-9), amount: 155, status: 'paid', statusDate: day(-1), queryNote: null,
      work: [{ date: day(-12), title: 'Delivery - Electric Ballroom', jobNumber: 16820 }, { date: day(-11), title: 'Collection - Electric Ballroom', jobNumber: 16820 }] },
  ],
  earlierWaiting: [],
  work: [
    { key: 'w1', kind: 'booking', date: TODAY, title: 'Delivery - Roundhouse', detail: null, jobNumber: 16840, fee: 85, label: 'to_invoice', paidDate: null },
    { key: 'w2', kind: 'booking', date: day(-4), title: 'Crew - Victoria Park', detail: null, jobNumber: 16841, fee: 250, label: 'invoiced', paidDate: null },
  ],
}

async function answer(route) {
  const p = new URL(route.request().url()).pathname
  const json = (body, status = 200) => route.fulfill({ status, json: body })
  if (p === '/api/jobs') return json(JOBS)
  if (p === '/api/day-bookings') return json(DAYS)
  if (p === '/api/studio-sitter/shifts') return json(SHIFTS)
  if (p === '/api/jobs/q-crew-1') return json(CREW_DETAIL)
  if (p.startsWith('/api/jobs/q-')) return json(DELIVERY_DETAIL)
  if (p === '/api/settings/notifications') return json(NOTIF)
  if (p === '/api/resources') return json(RESOURCES)
  if (p === '/api/earnings') return json(EARNINGS)
  if (p.startsWith('/api/hirehop/items')) return json({ success: true, items: [] })
  return json({ error: `not mocked: ${p}` }, 404)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 01: the sign-in page (signed out)
  {
    const { browser, context } = await phone({ base: BASE })
    const page = await context.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await snap(page, OUT, '01-sign-in', [page.locator('img').first(), page.getByRole('button', { name: 'Sign in' })], { padTop: 20, padBottom: 28 })

    // 01b: the emailed sign-in code (on a phone it doesn't know yet)
    await page.route('**/api/auth/login', (r) => r.fulfill({ json: {
      success: true, needsCode: true, pending: 'sample', emailHint: 'a***@example.com', codeSent: true } }))
    await page.fill('input[type="email"]', 'alex@example.com')
    await page.fill('input[type="password"]', 'sample-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Check your email').waitFor()
    await snap(page, OUT, '01b-sign-in-code', [page.getByText('Check your email'), page.getByText(/Remember this phone/).last()], { padTop: 24, padBottom: 40 })
    await browser.close()
  }

  const { browser, context } = await phone({ base: BASE, secret: SECRET })
  const page = await context.newPage()
  await page.route('**/api/**', answer)

  // 02: the dashboard: header, a yard-day offer, today's job
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.getByText('Today', { exact: true }).waitFor()
  await hideFixed(page, true)
  const todayCard = page.locator('div.rounded-2xl', { hasText: 'Start delivery' }).last()
  await snap(page, OUT, '02-dashboard', [page.locator('header').first(), todayCard])

  // 03: answering an offer
  const offer = page.locator('div', { has: page.getByRole('button', { name: 'Yes, I can do it' }) }).last()
  const offerCard = page.locator('div.rounded-2xl', { has: page.getByRole('button', { name: 'Yes, I can do it' }) }).last()
  await ring(offer)
  await snap(page, OUT, '03-offer', [offerCard])
  await clearRings(page)

  // 04: later jobs and the Completed / Cancelled rows
  const later = page.getByText('Later', { exact: true })
  const rows = page.locator('a', { hasText: 'Cancelled' }).last()
  await snap(page, OUT, '04-later', [later, rows])
  await hideFixed(page, false)

  // 05: a job's page, the top: the HH number and key notes
  await page.goto(`${BASE}/job/q-del-1`, { waitUntil: 'networkidle' })
  await page.getByText('Key notes', { exact: false }).first().waitFor()
  await hideFixed(page, true)
  const hh = page.getByText(/HH 16840/).first()
  await ring(hh)
  const addressCard = page.locator('div.rounded-2xl', { hasText: 'Directions' }).first()
  await snap(page, OUT, '05-job-top', [page.getByText('Jobs').first(), addressCard])
  await clearRings(page)

  // 06: who to contact, and your fee
  const contact = page.locator('div.rounded-2xl', { hasText: 'Who to contact' }).first()
  const fee = page.locator('div.rounded-2xl', { hasText: 'Your fee' }).first()
  await ring(fee.getByText('Your fee'))
  await snap(page, OUT, '06-job-contact-fee', [contact, fee])
  await clearRings(page)

  // 07: this job's emails, and adding it to your calendar
  const emails = page.locator('div.rounded-2xl', { hasText: 'Emails about this job' }).first()
  const cal = page.getByText('Add to Calendar').first()
  await snap(page, OUT, '07-job-emails', [emails, cal])
  await hideFixed(page, false)

  // 08: the Start button at the bottom of the job page (as the phone shows it)
  const start = page.getByRole('link', { name: /Start delivery/ }).or(page.getByRole('button', { name: /Start delivery/ })).last()
  await ring(start)
  await page.screenshot({ path: path.join(OUT, '08-job-start.png'), clip: { x: 0, y: 844 - 260, width: 390, height: 260 } })
  console.log('  ✓ 08-job-start')
  await clearRings(page)

  // 09: a crew job's Complete button, on its last day
  await page.goto(`${BASE}/job/q-crew-1?board=crew`, { waitUntil: 'networkidle' })
  const complete = page.getByRole('link', { name: /Complete job/ }).or(page.getByRole('button', { name: /Complete job/ })).first()
  await complete.waitFor()
  await hideFixed(page, true)
  await ring(complete)
  await snap(page, OUT, '09-crew-complete', [page.getByText(/Your fee/).first(), complete])
  await clearRings(page)
  await hideFixed(page, false)

  // 10: Settings: pausing job emails
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.getByText('Job emails', { exact: true }).waitFor()
  await hideFixed(page, true)
  const emailsCard = page.locator('section.rounded-2xl', { hasText: 'Pause job emails' }).first()
  await snap(page, OUT, '10-settings', [emailsCard])
  await hideFixed(page, false)

  // 11: Resources
  await page.goto(`${BASE}/resources`, { waitUntil: 'networkidle' })
  await page.getByText('How to invoice Ooosh Tours Ltd').waitFor()
  await hideFixed(page, true)
  await snap(page, OUT, '11-resources', [page.locator('header').first(), page.getByText('How to invoice Ooosh Tours Ltd')], { padBottom: 30 })
  await hideFixed(page, false)

  // 12: Earnings, the summary card
  await page.goto(`${BASE}/earnings`, { waitUntil: 'networkidle' })
  await page.getByText('Your invoices').waitFor()
  await hideFixed(page, true)
  const summary = page.locator('section').first()
  await snap(page, OUT, '12-earnings-summary', [page.getByRole('tablist'), summary])

  // 13: Earnings, the invoices
  const invoices = page.locator('section', { has: page.getByText('Your invoices') })
  await snap(page, OUT, '13-earnings-invoices', [invoices])
  await hideFixed(page, false)

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
