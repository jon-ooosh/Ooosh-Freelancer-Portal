/**
 * Screenshots for the "Collecting a hire van" freelancer guide (docs/guides/README.md).
 *
 * Renders the REAL screens on a phone-sized screen with made-up data: the
 * portal's "What are you collecting?" page, then the van collection, which runs
 * in the staff app in its freelancer look. Every /api call is answered here.
 * Nothing touches OP, R2 or email. The camera is fed ../shared/sample-photos/.
 *
 * 1. Run both apps locally:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100   (repo root: the portal)
 *      cd frontend && npm run build && npx vite preview --port 4173                    (the staff app)
 * 2. From the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/van-collection/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js van-collection
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
  id: 'q-van-2', name: 'The Lantern Thieves', type: 'collection', whatIsIt: 'vehicle', date: TODAY, time: '11:00',
  venueName: 'Roundhouse', venueId: 'v1', status: 'confirmed', hhRef: '16840', driverPay: 60,
}
const RESOLVE = {
  success: true, sessionToken: 'sample',
  assignment: { id: 'a1', vehicleId: 'veh1', registration: 'RX24KHV', makeModel: 'Ford Transit Custom', vehicleType: 'PREMIUM LWB (A)',
    status: 'booked_out', customerDriver: { name: 'Jamie Cole', email: 'jamie@example.com' } },
  job: { id: 'job1', hhJobNumber: 16840, venueName: 'Roundhouse' },
  driver: { name: 'Alex Morgan', email: 'alex@example.com' },
}
const FLEET = { data: [{ id: 'veh1', reg: 'RX24KHV', vehicleType: 'PREMIUM LWB (A)', simpleType: 'Premium', gearbox: 'auto', seats: 9,
  make: 'Ford', model: 'Transit Custom', colour: 'Grey', isOldSold: false, currentMileage: 23486, needsExternalWash: false }] }
const BOOK_OUT = { id: 'e1', eventType: 'Book Out', eventDate: ukToday(-4), mileage: 23486, fuelLevel: '6/8', hireHopJob: '16840' }

async function vanApi(route) {
  const u = new URL(route.request().url())
  const p = u.pathname
  const json = (b, s = 200) => route.fulfill({ status: s, json: b })
  if (p.endsWith('/freelancer-checkin/resolve')) return json(RESOLVE)
  if (p.endsWith('/fleet')) return json(FLEET)
  if (/\/jobs\/16840$/.test(p)) return json({ id: 16840, company: 'The Lantern Thieves', contactEmail: 'jamie@example.com', jobName: 'UK tour', status: 5 })
  if (p.endsWith('/get-checklist-settings')) return json({ briefingItems: {}, prepItems: {} })
  if (p.endsWith('/get-events')) {
    if (u.searchParams.get('eventId')) return json({ event: { ...BOOK_OUT, details: {}, clientEmail: 'jamie@example.com', photoMeta: [] } })
    return json({ events: [BOOK_OUT] })
  }
  if (p.endsWith('/upload-photo')) return json({ url: 'https://example.com/p.jpg', key: 'k', bucket: 'b' })
  if (p.endsWith('/send-condition-report')) return json({ results: [{ driverName: 'Jamie Cole', success: true, emailedTo: 'jamie@example.com', filename: 'report.pdf', size: 1000 }] })
  return json({})
}

const collectUrl = () => `${STAFF}/vehicles/check-in?freelancerToken=sample`
  + `&returnUrl=${encodeURIComponent(`${PORTAL}/job/${JOB.id}/complete?vanOnly=true`)}`
  + `&startUrl=${encodeURIComponent(`${PORTAL}/job/${JOB.id}/start`)}`

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

const nextBtn = (page) => page.locator('button').filter({ hasText: /^Next/ }).last()

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 01: the portal's "What are you collecting today?"
  {
    const { browser, context } = await phone({ base: PORTAL, secret: SECRET })
    const page = await context.newPage()
    await page.route('**/api/**', (r) => r.fulfill({ json: { success: true, boardType: 'dc', job: JOB, venue: null } }))
    await page.goto(`${PORTAL}/job/${JOB.id}/start`, { waitUntil: 'networkidle' })
    const vanOnly = page.getByRole('button', { name: /Van only/ })
    await vanOnly.waitFor()
    await ring(vanOnly)
    await snap(page, OUT, '01-what-collecting', [page.getByText(/What are you collecting/), page.getByText('Cancel', { exact: true })])
    await browser.close()
  }

  // 02 to 07: the collection, start to finish
  {
    const { browser, context } = await phone({ base: STAFF })
    const page = await context.newPage()
    await page.route('**/api/**', vanApi)
    await page.goto(collectUrl(), { waitUntil: 'networkidle' })
    const yes = page.getByRole('button', { name: "Yes, that's the van" })
    await yes.waitFor()
    await snap(page, OUT, '02-is-this-the-van', [page.getByText(/Van collection/), page.getByText(/No, call the office/)])
    await yes.click()

    // 03: fuel and mileage, with what it went out on
    await page.locator('#fl-mileage').fill('24312')
    await page.getByRole('button', { name: '3/8', exact: true }).click()
    await hideFixed(page, true)
    await snap(page, OUT, '03-fuel-mileage', [page.getByText('Fuel & mileage', { exact: true }), page.getByText('Eighths, as on the gauge')])
    await hideFixed(page, false)
    await nextBtn(page).click()

    // 04: photos, as you find it
    await page.getByRole('button', { name: /Take photo/ }).waitFor()
    await snap(page, OUT, '04-photos', [page.getByText('Photos', { exact: true }), page.getByRole('button', { name: /Take photo/ })])
    await takePhotos(page, 18)
    await nextBtn(page).click()

    // 05: notes and the customer's signature
    await page.locator('#fl-damage').fill('Customer mentioned a scrape on the rear bumper.')
    await drawSignature(page, page.locator('canvas').first())
    await hideFixed(page, true)
    await snap(page, OUT, '05-notes-and-sign', [page.getByText('Any damage or problems?'), page.locator('canvas').first()], { padTop: 24 })
    await hideFixed(page, false)

    // 06: the customer isn't there: a note instead
    await page.getByText('Customer not here', { exact: true }).click()
    await page.locator('textarea').last().fill('Keys left with the stage door at the Roundhouse. Van in bay 4.')
    const collected = page.getByRole('button', { name: /Van collected/ })
    await ring(collected)
    await page.screenshot({ path: path.join(OUT, '06-customer-not-here.png') })
    console.log('  ✓ 06-customer-not-here')
    await clearRings(page)

    // 07: done
    await collected.click()
    await page.getByText(/is collected and its condition recorded/).waitFor()
    await snap(page, OUT, '07-done', [page.getByText('Van collected').first(), page.getByText(/is collected and its condition recorded/)], { padTop: 130, padBottom: 90 })
    await browser.close()
  }

  // 08: stopped part-way: Resume (asked first on a collection)
  {
    const { browser, context } = await phone({ base: STAFF })
    const page = await context.newPage()
    await page.route('**/api/**', vanApi)
    await page.goto(collectUrl(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: "Yes, that's the van" }).click()
    await page.locator('#fl-mileage').fill('24312')
    await page.getByRole('button', { name: '3/8', exact: true }).click()
    await nextBtn(page).click()
    await takePhotos(page, 5)
    await page.waitForTimeout(2500)   // let the draft save
    await page.goto(collectUrl(), { waitUntil: 'networkidle' })
    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    await resume.waitFor()
    await ring(resume)
    await snap(page, OUT, '08-resume', [page.getByText(/Resume where you left off/), page.getByRole('button', { name: /Throw it away/ })], { padTop: 30 })
    await browser.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
