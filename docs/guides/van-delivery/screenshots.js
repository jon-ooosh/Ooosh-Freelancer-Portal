/**
 * Screenshots for the "Delivering a hire van" freelancer guide (docs/guides/README.md).
 *
 * Renders the REAL screens on a phone-sized screen with made-up data: the
 * portal's "What are you delivering?" page, then the van book-out, which runs in
 * the staff app in its freelancer look. Every /api call is answered here.
 * Nothing touches OP, R2 or email. The camera is fed the placeholder photos in
 * ../shared/sample-photos/.
 *
 * 1. Run both apps locally:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100   (repo root: the portal)
 *      cd frontend && npm run build && npx vite preview --port 4173                    (the staff app)
 * 2. From the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/van-delivery/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js van-delivery
 */

const path = require('path')
const fs = require('fs')
const { phone, ukToday, ring, clearRings, snap, samplePhotos, drawSignature, hideFixed } = require('../shared/shots')

const PORTAL = process.env.PORTAL_URL || 'http://localhost:3100'
const STAFF = process.env.STAFF_URL || 'http://localhost:4173'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET
if (!SECRET) { console.error('Set SESSION_SECRET (the same one the portal was started with).'); process.exit(1) }

// ── Sample data (a made-up band, van and driver) ─────────────────────────────

const TODAY = ukToday()
const JOB = {
  id: 'q-van-1', name: 'The Lantern Thieves', type: 'delivery', whatIsIt: 'vehicle', date: TODAY, time: '10:00',
  venueName: 'Roundhouse', venueId: 'v1', status: 'confirmed', hhRef: '16840', driverPay: 60,
}
const ASSIGNMENT = {
  id: 'a1', vehicleId: 'veh1', registration: 'RX24KHV', makeModel: 'Ford Transit Custom', vehicleType: 'PREMIUM LWB (A)',
  status: 'confirmed', customerDriver: { name: 'Jamie Cole', email: 'jamie@example.com' },
}
const RESOLVE = {
  success: true, sessionToken: 'sample', assignment: ASSIGNMENT,
  job: { id: 'job1', hhJobNumber: 16840, venueName: 'Roundhouse' },
  driver: { name: 'Alex Morgan', email: 'alex@example.com' },
}
const FLEET = { data: [{ id: 'veh1', reg: 'RX24KHV', vehicleType: 'PREMIUM LWB (A)', simpleType: 'Premium', gearbox: 'auto', seats: 9,
  make: 'Ford', model: 'Transit Custom', colour: 'Grey', isOldSold: false, currentMileage: 23410, needsExternalWash: false }] }

function vanApi({ resolve = RESOLVE } = {}) {
  return async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (b, s = 200) => route.fulfill({ status: s, json: b })
    if (p.endsWith('/freelancer-bookout/resolve')) return resolve.status ? json(resolve.body, resolve.status) : json(resolve)
    if (p.endsWith('/fleet')) return json(FLEET)
    if (/\/jobs\/16840$/.test(p)) return json({ id: 16840, company: 'The Lantern Thieves', contactEmail: 'jamie@example.com', jobName: 'UK tour', status: 2 })
    if (p.endsWith('/get-checklist-settings')) return json({ briefingItems: {}, prepItems: {} })
    if (p.endsWith('/get-events')) return json({ events: [{ id: 'e0', eventType: 'Check In', eventDate: '2026-10-10', mileage: 23410, fuelLevel: '8/8', hireHopJob: '16700' }] })
    if (p.endsWith('/upload-photo')) return json({ url: 'https://example.com/p.jpg', key: 'k', bucket: 'b' })
    if (p.endsWith('/send-condition-report')) return json({ results: [{ driverName: 'Jamie Cole', success: true, emailedTo: 'jamie@example.com', filename: 'report.pdf', size: 1000 }] })
    return json({})
  }
}

const bookOutUrl = (vanOnly = true) => `${STAFF}/vehicles/book-out?freelancerToken=sample`
  + `&returnUrl=${encodeURIComponent(`${PORTAL}/job/${JOB.id}/complete${vanOnly ? '?vanOnly=true' : ''}`)}`
  + `&startUrl=${encodeURIComponent(`${PORTAL}/job/${JOB.id}/start`)}`

const stepHeader = (page) => page.locator('header').first()
const footer = (page) => page.getByRole('button', { name: 'Back' }).last()

async function fillFuelAndMileage(page, miles) {
  await page.locator('#fl-mileage').fill(String(miles))
  await page.getByRole('button', { name: '6/8', exact: true }).click()
}

async function takePhotos(page, count) {
  const files = samplePhotos()
  for (let i = 0; i < count; i++) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: /Take photo/ }).first().click(),
    ])
    await chooser.setFiles(files[i])
    await page.waitForTimeout(350)
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 01: the portal's "What are you delivering today?"
  {
    const { browser, context } = await phone({ base: PORTAL, secret: SECRET })
    const page = await context.newPage()
    await page.route('**/api/**', (r) => r.fulfill({ json: { success: true, boardType: 'dc', job: JOB, venue: null } }))
    await page.goto(`${PORTAL}/job/${JOB.id}/start`, { waitUntil: 'networkidle' })
    const vanOnly = page.getByRole('button', { name: /Van only/ })
    await vanOnly.waitFor()
    await ring(vanOnly)
    await snap(page, OUT, '01-what-delivering', [page.getByText(/What are you delivering/), page.getByText('Cancel', { exact: true })])
    await browser.close()
  }

  // 02 to 08: the book-out, start to finish
  {
    const { browser, context } = await phone({ base: STAFF })
    const page = await context.newPage()
    await page.route('**/api/**', vanApi())
    await page.goto(bookOutUrl(), { waitUntil: 'networkidle' })
    const yes = page.getByRole('button', { name: "Yes, that's the van" })
    await yes.waitFor()
    await snap(page, OUT, '02-is-this-the-van', [page.getByText(/Van delivery/), page.getByRole('link', { name: /No, call the office/ }).or(page.getByRole('button', { name: /No, call the office/ }))])
    await yes.click()

    // 03: mileage lower than the record: the red line
    await page.locator('#fl-mileage').fill('23400')
    await page.getByText(/below the recorded mileage/).waitFor()
    await snap(page, OUT, '03-mileage-low', [page.locator('#fl-mileage'), page.getByText(/below the recorded mileage/)], { padTop: 60 })

    // 04: fuel and mileage, filled
    await fillFuelAndMileage(page, 23486)
    await hideFixed(page, true)
    await snap(page, OUT, '04-fuel-mileage', [page.getByText('Fuel & mileage', { exact: true }), page.getByText('Eighths, as on the gauge')])
    await hideFixed(page, false)
    await page.getByRole('button', { name: /Next: photos/ }).click()

    // 05: the photo card
    await page.getByRole('button', { name: /Take photo/ }).waitFor()
    await snap(page, OUT, '05-photo-card', [page.getByText('Photos', { exact: true }), page.getByRole('button', { name: /Take photo/ })])

    // 06: all 18 taken
    await takePhotos(page, 18)
    await page.getByText(/All 18 photos taken/).waitFor()
    const next = page.getByRole('button', { name: /Next: briefing/ })
    await ring(next)
    await page.screenshot({ path: path.join(OUT, '06-photos-done.png') })
    console.log('  ✓ 06-photos-done')
    await clearRings(page)
    await next.click()

    // 07: show the driver, all ticked
    const items = page.getByText(/^I've shown/)
    await items.first().waitFor()
    for (let i = 0; i < await items.count(); i++) await items.nth(i).click()
    await hideFixed(page, true)
    await snap(page, OUT, '07-show-the-driver', [page.getByText('Show the driver', { exact: true }), items.last()])
    await hideFixed(page, false)
    await page.getByRole('button', { name: /Next: sign/ }).click()

    // 08: check and sign
    await drawSignature(page, page.locator('canvas').first())
    const bookOut = page.getByRole('button', { name: /Book out van/ })
    await ring(bookOut)
    await page.screenshot({ path: path.join(OUT, '08-check-and-sign.png') })
    console.log('  ✓ 08-check-and-sign')
    await clearRings(page)

    // 09: done (it goes back to the portal by itself after 3 seconds)
    await bookOut.click()
    await page.getByText('Van booked out').waitFor()
    await snap(page, OUT, '09-done', [page.getByText('Van booked out'), page.getByRole('link', { name: /Back to the portal/ }).or(page.getByRole('button', { name: /Back to the portal/ }))], { padTop: 130 })
    await browser.close()
  }

  // 10: stopped part-way: Resume
  {
    const { browser, context } = await phone({ base: STAFF })
    const page = await context.newPage()
    await page.route('**/api/**', vanApi())
    await page.goto(bookOutUrl(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: "Yes, that's the van" }).click()
    await fillFuelAndMileage(page, 23486)
    await page.getByRole('button', { name: /Next: photos/ }).click()
    await takePhotos(page, 7)
    await page.waitForTimeout(2500)   // let the draft save
    await page.goto(bookOutUrl(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: "Yes, that's the van" }).click()
    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    await resume.waitFor()
    await ring(resume)
    await snap(page, OUT, '10-resume', [page.getByText(/Resume where you left off/), page.getByRole('button', { name: /Throw it away/ })], { padTop: 30 })
    await browser.close()
  }

  // 11: the hire form hasn't come in
  {
    const { browser, context } = await phone({ base: STAFF })
    const page = await context.newPage()
    await page.route('**/api/**', vanApi({ resolve: { status: 409, body: {
      error: 'Customer hire form not received yet. The customer must complete and sign their hire form before this van can be booked out. Please contact the Ooosh office.',
      code: 'no_hire_form' } } }))
    await page.goto(bookOutUrl(), { waitUntil: 'networkidle' })
    await page.getByText(/hire form not received/).waitFor()
    await snap(page, OUT, '11-no-hire-form', [page.getByRole('heading').first(), page.getByText('Call the office', { exact: true })], { padTop: 120, padBottom: 70 })
    await browser.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
