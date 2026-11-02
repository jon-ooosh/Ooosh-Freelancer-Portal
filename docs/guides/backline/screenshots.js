/**
 * Screenshots for the "Delivering and collecting backline" freelancer guide
 * (docs/guides/README.md).
 *
 * Renders the REAL portal pages on a phone-sized screen with made-up data: the
 * "What are you delivering?" page and the equipment checklist and sign-off.
 * Every /api call is answered here. Nothing touches OP, HireHop or email.
 *
 * 1. Run the portal locally (repo root):
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100
 * 2. In another terminal, from the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/backline/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js backline
 */

const path = require('path')
const fs = require('fs')
const { phone, ukToday, ring, clearRings, snap, drawSignature, hideFixed } = require('../shared/shots')

const PORTAL = process.env.PORTAL_URL || 'http://localhost:3100'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET
if (!SECRET) { console.error('Set SESSION_SECRET (the same one the portal was started with).'); process.exit(1) }

// ── Sample data (a made-up band and their backline) ─────────────────────────

const JOB = {
  id: 'q-bl-1', name: 'Paper Satellites', type: 'delivery', whatIsIt: 'equipment', date: ukToday(), time: '14:00',
  venueName: 'Electric Ballroom', venueId: 'v3', status: 'confirmed', hhRef: '16852', driverPay: 70, completedAtDate: null,
  clientContacts: [
    { personId: 'p1', name: 'Sam Hart', email: 'sam@example.com', role: 'Tour manager', isPrimary: true },
    { personId: 'p2', name: 'Riley Shaw', email: 'riley@example.com', role: 'Production manager', isPrimary: false },
  ],
  clientEmail: 'sam@example.com',
}
const ITEMS = [
  { id: 'i1', name: 'Fender Twin Reverb guitar amp', quantity: 1, category: 'Guitar amps' },
  { id: 'i2', name: 'Ampeg SVT Classic bass head', quantity: 1, category: 'Bass amps' },
  { id: 'i3', name: 'Ampeg 8x10 bass cab', quantity: 1, category: 'Bass amps' },
  { id: 'i4', name: 'DW Collector\'s drum kit (5 piece)', quantity: 1, category: 'Drums' },
  { id: 'i5', name: 'Cymbal stand', quantity: 4, category: 'Drums' },
  { id: 'i6', name: 'Roland RD-2000 stage piano', quantity: 1, category: 'Keyboards' },
  { id: 'i7', name: 'Keyboard stand (X frame)', quantity: 1, category: 'Keyboards' },
  { id: 'i8', name: 'Guitar stand', quantity: 3, category: 'Stands' },
]

async function api(route) {
  const p = new URL(route.request().url()).pathname
  const json = (b, s = 200) => route.fulfill({ status: s, json: b })
  if (p === `/api/jobs/${JOB.id}`) return json({ success: true, boardType: 'dc', job: JOB, venue: null, userEmail: 'alex@example.com' })
  if (p.startsWith('/api/hirehop/items/')) return json({ success: true, items: ITEMS })
  if (p === '/api/settings/notifications') return json({ success: true, notifications: { mutedJobIds: [] } })
  return json({ success: true })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { browser, context } = await phone({ base: PORTAL, secret: SECRET })
  const page = await context.newPage()
  await page.route('**/api/**', api)

  // 01: "What are you delivering today?"
  await page.goto(`${PORTAL}/job/${JOB.id}/start`, { waitUntil: 'networkidle' })
  const backline = page.getByRole('button', { name: /Backline only/ })
  await backline.waitFor()
  await ring(backline)
  await snap(page, OUT, '01-what-delivering', [page.getByText(/What are you delivering/), page.getByText('Cancel', { exact: true })])

  // 02: the checklist, part ticked
  await page.goto(`${PORTAL}/job/${JOB.id}/complete`, { waitUntil: 'networkidle' })
  await page.getByText('Equipment checklist').first().waitFor()
  for (const it of ITEMS.slice(0, 3)) await page.getByRole('button', { name: `Tick ${it.name}`, exact: true }).click()
  await page.getByRole('button', { name: `One more ${ITEMS[4].name}`, exact: true }).click()
  await page.getByRole('button', { name: `One more ${ITEMS[4].name}`, exact: true }).click()
  await hideFixed(page, true)
  await ring(page.getByRole('button', { name: `One more ${ITEMS[4].name}`, exact: true }))
  await snap(page, OUT, '02-checklist', [page.getByText('Equipment checklist').first(), page.getByText(ITEMS[ITEMS.length - 1].name)])
  await clearRings(page)
  await hideFixed(page, false)

  // 03: everything ticked
  for (const it of ITEMS) {
    const tick = page.getByRole('button', { name: `Tick ${it.name}`, exact: true })
    if (await tick.count()) await tick.click()
    const more = page.getByRole('button', { name: `One more ${it.name}`, exact: true })
    while (await more.count() && await more.isEnabled()) await more.click()
  }
  await hideFixed(page, true)
  await snap(page, OUT, '03-all-ticked', [page.getByText(ITEMS[5].name), page.getByText(/All \d+ items ticked off/)], { padTop: 20, padBottom: 24 })
  await hideFixed(page, false)

  // 04: the signature
  await drawSignature(page, page.locator('canvas').first())
  await hideFixed(page, true)
  await snap(page, OUT, '04-signature', [page.getByText(/Ask the client to sign/), page.locator('canvas').first()], { padBottom: 30 })
  await hideFixed(page, false)

  // 05: customer not here: a photo of where you left it
  await page.getByText('Customer not here', { exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles(path.join(__dirname, '..', 'shared', 'sample-photos', 'other', 'kit-left-at-door.jpg'))
  await page.waitForTimeout(800)
  await hideFixed(page, true)
  await snap(page, OUT, '05-customer-not-here', [page.getByText('Customer not here', { exact: true }), page.getByText(/Add another photo/)], { padBottom: 20 })
  await hideFixed(page, false)

  // 06: who gets the delivery note, and notes
  await page.getByText('Customer not here', { exact: true }).click()   // back to a signature for the rest
  await page.locator('textarea').last().fill('Stage door was locked; left everything with the venue manager, Chris.')
  await hideFixed(page, true)
  await snap(page, OUT, '06-delivery-note-and-notes', [page.getByText('Send the delivery note to'), page.locator('textarea').last()])
  await hideFixed(page, false)

  // 07: the Complete button, as the phone shows it
  await drawSignature(page, page.locator('canvas').first())
  await page.locator('textarea').last().scrollIntoViewIfNeeded()
  const complete = page.getByRole('button', { name: /Complete delivery/ })
  await ring(complete)
  await page.screenshot({ path: path.join(OUT, '07-complete.png') })
  console.log('  ✓ 07-complete')
  await clearRings(page)

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
