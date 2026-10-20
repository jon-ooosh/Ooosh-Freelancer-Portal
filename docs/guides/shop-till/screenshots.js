/**
 * Screenshots for the studio sitters' shop till guide (docs/guides/shop-till/).
 *
 * Renders the REAL portal pages (dashboard, shift, till, lock-up) on a phone-sized
 * screen, with every /api call answered from the made-up data below. Nothing
 * touches OP, HireHop or Stripe, and no sale is recorded anywhere.
 *
 * 1. Run the portal locally (any secret of 32+ characters; it only signs the
 *    fake login cookie the dashboard needs):
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100
 * 2. In another terminal, from the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/shop-till/screenshots.js
 * 3. Then build the PDF: node docs/guides/shop-till/build-pdf.js
 *
 * Needs Playwright (npm i -D playwright, or a global install) and Chromium.
 */

const path = require('path')
const fs = require('fs')

function loadPlaywright() {
  try { return require('playwright') } catch { /* fall back to a global install */ }
  const root = require('child_process').execSync('npm root -g').toString().trim()
  return require(path.join(root, 'playwright'))
}
const { chromium } = loadPlaywright()

const BASE = process.env.PORTAL_URL || 'http://localhost:3100'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET

// Today in UK time, so the dashboard shows the shift as "Tonight".
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())

// ── Sample data (real shop items, made-up bands and people) ────────────────────

const COKE = { hhStockId: 101, title: 'Can of Coke', categoryPath: null, priceIncVat: 1.5, priceExVat: 1.25, vatRatePct: 20, quantity: 24 }
const GAFFA = { hhStockId: 102, title: '2" (50mm x 50m) ProGaff matt white gaffa tape', categoryPath: null, priceIncVat: 15, priceExVat: 12.5, vatRatePct: 20, quantity: 6 }
const ITEMS = [COKE, GAFFA]

const BAND_1 = { job_id: 'job-1', hh_job_number: 16801, label: 'The Lantern Thieves', rooms: ['Room 1 · Evening'] }
const BAND_2 = { job_id: 'job-2', hh_job_number: 16802, label: 'Paper Satellites', rooms: ['Room 2 · Lockout'] }

const TENDERS = [
  { key: 'card_reader', label: 'Card reader' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'invoice_later', label: 'Put it on their bill', needsJob: true },
]

function tillContext(over = {}) {
  return {
    success: true, date: DATE, open: true, locked_up: false,
    jobs: [BAND_1, BAND_2], tenders: TENDERS,
    card_reader: { enabled: true, mode: 'live' },
    stock_as_of: new Date().toISOString(),
    ...over,
  }
}

const at = (hhmm) => `${DATE}T${hhmm}:00Z`   // shown as typed: the browser runs in UTC
const SALES = [
  { id: 's4', sale_ref: 'OT-SHOP-00204', status: 'queued', tender: 'till_cash', gross: 1.5, created_at: at('21:30'),
    push_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(), mine: true, sold_to_hh_job_number: null,
    last_receipt_to: null, lines: [{ name: COKE.title, qty: 1 }] },
  { id: 's3', sale_ref: 'OT-SHOP-00203', status: 'pushed', tender: 'card_reader', gross: 18, created_at: at('21:03'),
    push_after: at('21:05'), mine: true, sold_to_hh_job_number: 16802,
    last_receipt_to: 'sam@example.com', lines: [{ name: COKE.title, qty: 2 }, { name: GAFFA.title, qty: 1 }] },
  { id: 's2', sale_ref: 'OT-SHOP-00202', status: 'pushed', tender: 'invoice_later', gross: 15, created_at: at('20:15'),
    push_after: at('20:17'), mine: true, sold_to_hh_job_number: 16801,
    last_receipt_to: null, lines: [{ name: GAFFA.title, qty: 1 }] },
  { id: 's1', sale_ref: 'OT-SHOP-00201', status: 'pushed', tender: 'till_cash', gross: 3, created_at: at('19:42'),
    push_after: at('19:44'), mine: true, sold_to_hh_job_number: null,
    last_receipt_to: null, lines: [{ name: COKE.title, qty: 2 }] },
]
const SUMMARY = {
  sales: 4, taken: 22.5,
  byTender: [{ tender: 'till_cash', label: 'Cash', amount: 4.5 }, { tender: 'card_reader', label: 'Card reader', amount: 18 }],
  onTheirBill: 15,
}

function readerSession(status, over = {}) {
  return {
    id: 'trs-1', status, amount: '18.00', reader_label: null, failure_code: null, failure_message: null,
    livemode: true, shop_sale_id: status === 'succeeded' ? 'sale-9' : null, warning: null, ...over,
  }
}

// ── Mock API: every shot sets S, the handler answers from it ──────────────────

const S = {}
function resetState() {
  Object.assign(S, {
    ctx: tillContext(), sales: [], summary: null, contacts: [], reader: null,
  })
}

async function answer(route) {
  const req = route.request()
  const p = new URL(req.url()).pathname
  const json = (body, status = 200) => route.fulfill({ status, json: body })

  if (p === '/api/jobs') return json({ success: true, user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' }, today: [], upcoming: [], completed: [], cancelled: [] })
  if (p === '/api/day-bookings') return json({ success: true, upcoming: [], past: [] })
  if (p === '/api/studio-sitter/shifts') {
    return json({ success: true, shifts: [{ date: DATE, planned_start: '18:00:00', planned_end: '23:00:00', status: 'scheduled',
      assignment_status: 'confirmed', fee: null, report_submitted_at: null, jobs: [BAND_1, BAND_2] }] })
  }
  const base = `/api/studio-sitter/shifts/${DATE}`
  if (p === base) {
    return json({ success: true, date: DATE, planned_start: '18:00:00', planned_end: '23:00:00', status: 'scheduled',
      fee: null, assignment_status: 'confirmed', jobs: [BAND_1, BAND_2], tasks: [] })
  }
  if (p === `${base}/thread`) return json({ success: true, messages: [] })
  if (p === `${base}/recent-handover`) return json({ success: true, nights: [] })
  if (p === `${base}/lockup`) {
    return json({ success: true, date: DATE, template: { version: 1, items: [] }, continuing_tomorrow: false,
      continuing_derived: false, submitted: null, has_shift: true, shop: SUMMARY })
  }
  if (p === `${base}/till/context`) return json(S.ctx)
  if (p === `${base}/till/search`) {
    const q = (new URL(req.url()).searchParams.get('q') || '').toLowerCase()
    return json({ success: true, items: ITEMS.filter((i) => i.title.toLowerCase().includes(q)) })
  }
  if (p === `${base}/till/sales` && req.method() === 'GET') return json({ success: true, sales: S.sales, summary: S.summary })
  if (p === `${base}/till/sales` && req.method() === 'POST') return json({ success: true, id: 'sale-1' }, 201)
  if (/\/till\/sales\/[^/]+\/receipt$/.test(p)) return json({ success: true, sent: true })
  if (/\/till\/jobs\/[^/]+\/receipt-contacts$/.test(p)) return json({ success: true, contacts: S.contacts })
  if (p === `${base}/till/reader/readers`) return json({ readers: [{ id: 'tmr_1', label: 'Front desk', status: 'online' }] })
  if (p.startsWith(`${base}/till/reader/`)) return json({ session: S.reader })
  return json({ error: `not mocked: ${p}` }, 404)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RING = '#f97316'   // orange: nothing on the till is this colour

/** `inset` draws the ring inside the element, for rows in a list that clips its edges. */
async function ring(locator, { inset = false } = {}) {
  await locator.evaluate((el, [c, off]) => { el.style.outline = `3px solid ${c}`; el.style.outlineOffset = off }, [RING, inset ? '-3px' : '3px'])
}
async function clearRings(page) {
  await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { el.style.outline = ''; el.style.outlineOffset = '' }))
}

/** Screenshot the full phone width, from the top of the first locator to the bottom of the last. */
async function snap(page, name, locators, { padTop = 14, padBottom = 14 } = {}) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.waitForTimeout(250)
  const boxes = []
  for (const l of locators) {
    boxes.push(await l.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY }
    }))
  }
  const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - padTop)
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + padBottom
  const width = page.viewportSize().width
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, clip: { x: 0, y: top, width, height: bottom - top } })
  console.log('  ✓', name)
}

async function openTill(page, over) {
  resetState()
  if (over) Object.assign(S, over)
  await page.goto(`${BASE}/shift/${DATE}/till`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Shop till')
}

async function addItem(page, term, title) {
  await page.fill('input[inputmode="search"]', term)
  const row = page.locator('ul li button', { hasText: title })
  await row.waitFor()
  await row.click()
}

/** Coke ×2 + gaffa ×1 = £18.00 */
async function fillBasket(page) {
  await addItem(page, 'coke', COKE.title)
  await page.getByRole('button', { name: 'One more' }).first().click()
  await addItem(page, 'gaffa', GAFFA.title)
}

const checkout = (page) => page.locator('section', { hasText: 'Total' }).last()
const header = (page) => page.locator('header')

// ── The shots ────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    timezoneId: 'UTC', locale: 'en-GB',
  })
  if (SECRET) {
    const { SignJWT } = require('jose')
    const token = await new SignJWT({ id: 'u1', email: 'alex@example.com', name: 'Alex Morgan' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET))
    await context.addCookies([{ name: 'session', value: token, url: BASE }])
  }
  const page = await context.newPage()
  await page.route('**/api/**', answer)
  page.on('dialog', (d) => d.accept())

  // 01: the dashboard's shift card
  if (SECRET) {
    resetState()
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    const card = page.locator('div.rounded-xl', { hasText: 'Studio Sitter' }).last()
    await card.waitFor()
    await ring(card.getByText('View details'))
    await snap(page, '01-dashboard', [card])
    await clearRings(page)
  } else {
    console.log('  - 01-dashboard skipped (no SESSION_SECRET)')
  }

  // 02: the shift page's Shop till button
  resetState()
  await page.goto(`${BASE}/shift/${DATE}`, { waitUntil: 'networkidle' })
  const tillLink = page.locator('a', { hasText: 'Shop till' })
  await tillLink.waitFor()
  await ring(tillLink)
  await snap(page, '02-shift-page', [header(page), tillLink])
  await clearRings(page)

  // 03: price lookup before the shift (till not open yet)
  await openTill(page, { ctx: tillContext({ open: false }) })
  await page.fill('input[inputmode="search"]', 'gaffa')
  await page.locator('ul li button', { hasText: 'ProGaff' }).waitFor()
  await ring(page.locator('ul li button', { hasText: 'ProGaff' }).locator('span.shrink-0'))
  await snap(page, '03-price-lookup', [header(page), page.locator('ul').first()])
  await clearRings(page)

  // 04: searching on the night: tap to add
  await openTill(page)
  await page.fill('input[inputmode="search"]', 'coke')
  const cokeRow = page.locator('ul li button', { hasText: 'Can of Coke' })
  await cokeRow.waitFor()
  await ring(cokeRow, { inset: true })
  await snap(page, '04-search', [header(page), page.locator('ul').first()])
  await clearRings(page)

  // 05: the basket
  await page.fill('input[inputmode="search"]', '')
  await fillBasket(page)
  const basket = page.locator('section.divide-y').first()
  await ring(page.getByRole('button', { name: 'One more' }).first())
  await snap(page, '05-basket', [basket])
  await clearRings(page)

  // 06: who's it for: two bands in, nobody picked yet
  await snap(page, '06-whos-it-for', [checkout(page)])

  // 07: how did they pay (a band picked: all three show)
  await page.locator('button', { hasText: BAND_1.label }).click()
  const payBlock = page.locator('div', { has: page.getByText('How did they pay?', { exact: true }) }).last()
  await snap(page, '07-how-paid', [page.getByText("Who's it for?", { exact: true }), payBlock])

  // 08: cash: pick Cash, tap what they gave you, the till shows the change
  await page.locator('button', { hasText: /^Cash$/ }).click()
  await page.locator('div.grid-cols-3 button', { hasText: '£20' }).click()
  const changeBox = page.getByText('Change to give').locator('..')
  await ring(page.locator('div.grid-cols-3 button', { hasText: '£20' }))
  await snap(page, '08-cash-change', [payBlock, changeBox])
  await clearRings(page)
  const takeBtn = page.locator('button', { hasText: 'Take £18.00' })

  // 09: cash: done
  S.sales = [{ ...SALES[3], id: 'sale-1', created_at: at('19:42'), gross: 18, status: 'queued',
    push_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    lines: [{ name: COKE.title, qty: 2 }, { name: GAFFA.title, qty: 1 }] }]
  S.summary = { sales: 1, taken: 18, byTender: [{ tender: 'till_cash', label: 'Cash', amount: 18 }], onTheirBill: 0 }
  await takeBtn.click()
  const doneBanner = page.locator('div.bg-green-50')
  await doneBanner.waitFor()
  await snap(page, '09-cash-done', [header(page), doneBanner])

  // 10: their bill
  await openTill(page)
  await fillBasket(page)
  await page.locator('button', { hasText: BAND_2.label }).click()
  await page.locator('button', { hasText: 'Put it on their bill' }).click()
  const billBtn = page.locator('button', { hasText: 'Put £18.00 on their bill' })
  await ring(billBtn)
  await snap(page, '10-their-bill', [page.getByText("Who's it for?", { exact: true }), billBtn])
  await clearRings(page)

  // 11: receipt box with the band's contacts
  await openTill(page, { contacts: [{ email: 'sam@example.com', label: 'Sam Hart' }] })
  await fillBasket(page)
  await page.locator('button', { hasText: BAND_2.label }).click()
  await page.locator('button', { hasText: /^(✓ )?Card reader$/ }).click()   // already the default
  await page.locator('button', { hasText: 'Sam Hart' }).click()
  const receiptBlock = page.locator('div', { has: page.getByText('Email a receipt?') }).last()
  await snap(page, '11-receipt', [receiptBlock, page.locator('button', { hasText: 'on card reader' })])

  // 12: card reader: waiting for the card
  S.reader = readerSession('pending')
  await page.locator('button', { hasText: 'Take £18.00 on card reader' }).click()
  const readerPanel = page.locator('div.rounded-xl', { hasText: 'Waiting for card' }).last()
  await readerPanel.waitFor()
  await snap(page, '12-reader-waiting', [readerPanel])

  // 13: card reader: declined
  S.reader = readerSession('failed', { failure_message: 'Your card was declined.' })
  const notTaken = page.locator('div.rounded-xl', { hasText: 'Not taken' }).last()
  await notTaken.waitFor({ timeout: 15000 })
  await snap(page, '13-reader-declined', [notTaken])

  // 14: card reader: approved (the till's own 2-second check picks it up)
  S.sales = SALES
  S.summary = SUMMARY
  S.reader = readerSession('succeeded')
  const paid = page.locator('div.bg-green-50', { hasText: 'Paid on the card reader' })
  await paid.waitFor({ timeout: 15000 })
  await snap(page, '14-reader-approved', [header(page), paid])

  // 15: tonight's list, with one sale still cancellable
  const tonight = page.locator('section', { has: page.getByText('Tonight', { exact: true }) })
  await tonight.scrollIntoViewIfNeeded()
  await ring(tonight.locator('button', { hasText: 'Cancel' }))
  await snap(page, '15-tonight', [tonight])
  await clearRings(page)

  // 16: after lock-up: the till is closed
  await openTill(page, { ctx: tillContext({ open: false, locked_up: true }) })
  await snap(page, '16-till-closed', [header(page), page.locator('div.bg-amber-50')])

  // 17: the lock-up page's till summary
  resetState()
  await page.goto(`${BASE}/shift/${DATE}/lockup`, { waitUntil: 'networkidle' })
  const shopCard = page.locator('section', { hasText: 'Shop till tonight' })
  await shopCard.waitFor()
  await snap(page, '17-lockup-summary', [shopCard])

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
