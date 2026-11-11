/**
 * Screenshots for the studio sitters' shop till guide (docs/guides/README.md).
 *
 * Renders the REAL portal pages (Jobs, shift, till, lock-up) on a phone-sized
 * screen, with every /api call answered from the made-up data below. Nothing
 * touches OP, HireHop or Stripe, and no sale is recorded anywhere.
 *
 * 1. Run the portal locally (any secret of 32+ characters; it only signs the
 *    fake login cookie):
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100
 * 2. In another terminal, from the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/shop-till/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js shop-till
 *
 * Sample data: real shop items and prices (Can of Coke £1.50; 2" ProGaff matt
 * white gaffa tape £15), made-up bands and a made-up contact (sam@example.com).
 */

const path = require('path')
const fs = require('fs')
const { phone, ukToday, ring, clearRings, snap, hideFixed } = require('../shared/shots')

const BASE = process.env.PORTAL_URL || 'http://localhost:3100'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET
if (!SECRET) { console.error('Set SESSION_SECRET (the same one the portal was started with).'); process.exit(1) }

// ── Sample data (real shop items, made-up bands and people) ──────────────────

const TODAY = ukToday()
const at = (hhmm) => `${TODAY}T${hhmm}:00+00:00`   // shown as typed in winter (UK time = UTC)

const COKE = { hhStockId: 101, title: 'Can of Coke', categoryPath: null, priceIncVat: 1.5, priceExVat: 1.25, vatRatePct: 20, quantity: 24 }
const GAFFA = { hhStockId: 102, title: '2" (50mm x 50m) ProGaff matt white gaffa tape', categoryPath: null, priceIncVat: 15, priceExVat: 12.5, vatRatePct: 20, quantity: 6 }
const ITEMS = [COKE, GAFFA]

const BAND_1 = { job_id: 'job-1', hh_job_number: 16801, label: 'The Lantern Thieves', rooms: ['Room 1 · Evening'], files: [] }
const BAND_2 = { job_id: 'job-2', hh_job_number: 16802, label: 'Paper Satellites', rooms: ['Room 2 · Lockout'], files: [] }

const TENDERS = [
  { key: 'card_reader', label: 'Card reader' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'invoice_later', label: 'Put it on their bill', needsJob: true },
]

function tillContext(over = {}) {
  return {
    success: true, date: TODAY, open: true, locked_up: false,
    jobs: [BAND_1, BAND_2], tenders: TENDERS,
    card_reader: { enabled: true, mode: 'live' },
    stock_as_of: new Date().toISOString(),
    ...over,
  }
}

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

const SHIFT = {
  success: true, date: TODAY, planned_start: '16:30:00', planned_end: '22:30:00', status: 'scheduled',
  fee: null, assignment_status: 'confirmed', jobs: [BAND_1, BAND_2], tasks: [], codes: null,
}

// ── Mock API: every shot sets S, the handler answers from it ─────────────────

const S = {}
function resetState() {
  Object.assign(S, { ctx: tillContext(), sales: [], summary: null, contacts: [], reader: null })
}

async function answer(route) {
  const req = route.request()
  const p = new URL(req.url()).pathname
  const json = (body, status = 200) => route.fulfill({ status, json: body })

  if (p === '/api/jobs') return json({ success: true, user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' }, today: [], upcoming: [], completed: [], cancelled: [] })
  if (p === '/api/day-bookings') return json({ success: true, awaitingReply: 0, past: [], done: [], upcoming: [] })
  if (p === '/api/resources/unread') return json({ success: true, documents: [] })
  if (p === '/api/settings/notifications') return json({ success: true, notifications: { globalMuteActive: false, globalMuteUntil: null, mutedJobIds: [], mutedJobCount: 0 } })
  if (p === '/api/studio-sitter/shifts') return json({ success: true, shifts: [{ ...SHIFT, report_submitted_at: null }] })
  const base = `/api/studio-sitter/shifts/${TODAY}`
  if (p === base) return json(SHIFT)
  if (p === `${base}/thread`) return json({ success: true, messages: [] })
  if (p === `${base}/recent-handover`) return json({ success: true, nights: [] })
  if (p === `${base}/lockup`) {
    return json({ success: true, date: TODAY, template: { version: 1, items: [] }, continuing_tomorrow: false,
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

const header = (page) => page.locator('header').first()
// main's sections: the search, the basket, the checkout, then Tonight
const basketSection = (page) => page.locator('main > section').nth(1)
const checkoutSection = (page) => page.locator('main > section').nth(2)
const searchBox = (page) => page.locator('input[inputmode="search"]')
const resultRow = (page, text) => page.locator('ul li button', { hasText: text })

async function openTill(page, over) {
  resetState()
  if (over) Object.assign(S, over)
  await page.goto(`${BASE}/shift/${TODAY}/till`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Shop till' }).waitFor()
}

async function addItem(page, term, title) {
  await searchBox(page).fill(term)
  const row = resultRow(page, title)
  await row.waitFor()
  await row.click()
}

/** Coke ×2 + gaffa ×1 = £18.00 */
async function fillBasket(page) {
  await addItem(page, 'coke', COKE.title)
  await page.getByRole('button', { name: 'One more' }).first().click()
  await addItem(page, 'gaffa', GAFFA.title)
  await searchBox(page).fill('')
}

const band = (page, b) => page.locator('button[aria-pressed]', { hasText: b.label })
const tender = (page, label) => page.locator('button[aria-pressed]', { hasText: new RegExp(`^${label}`) })

// ── The shots ────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { browser, context } = await phone({ base: BASE, secret: SECRET })
  const page = await context.newPage()
  await page.route('**/api/**', answer)
  page.on('dialog', (d) => d.accept())

  // 01: tonight's evening on the Jobs page (the whole card opens the shift)
  resetState()
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  const card = page.locator('div.rounded-2xl', { has: page.locator(`a[href="/shift/${TODAY}"]`) }).first()
  await card.waitFor()
  await hideFixed(page, true)
  await ring(card)
  await snap(page, OUT, '01-dashboard', [card], { padTop: 40, padBottom: 20 })
  await clearRings(page)
  await hideFixed(page, false)

  // 02: the shift page's Shop till button
  await page.goto(`${BASE}/shift/${TODAY}`, { waitUntil: 'networkidle' })
  const tillLink = page.locator(`a[href="/shift/${TODAY}/till"]`).first()
  await tillLink.waitFor()
  await hideFixed(page, true)
  await ring(tillLink)
  await snap(page, OUT, '02-shift-page', [page.locator('h1').first().locator('xpath=ancestor::section[1]'), tillLink], { padTop: 16, padBottom: 16 })
  await clearRings(page)
  await hideFixed(page, false)

  // 03: price lookup before the shift (the till isn't open yet)
  await openTill(page, { ctx: tillContext({ open: false }) })
  await searchBox(page).fill('gaffa')
  await resultRow(page, 'ProGaff').waitFor()
  await ring(resultRow(page, 'ProGaff').locator('span.shrink-0'))
  await snap(page, OUT, '03-price-lookup', [header(page), page.locator('main ul').first()])
  await clearRings(page)

  // 04: searching on the night: tap to add
  await openTill(page)
  await searchBox(page).fill('coke')
  await resultRow(page, 'Can of Coke').waitFor()
  await ring(resultRow(page, 'Can of Coke'), { inset: true })
  await snap(page, OUT, '04-search', [header(page), page.locator('main ul').first()])
  await clearRings(page)

  // 05: the basket
  await searchBox(page).fill('')
  await fillBasket(page)
  await ring(page.getByRole('button', { name: 'One more' }).first())
  await snap(page, OUT, '05-basket', [basketSection(page)])
  await clearRings(page)

  // 06: who's it for: two bands in, nobody picked yet (the total and the choices)
  const whoBlock = page.getByText('Who\'s it for?', { exact: true }).locator('..')
  await snap(page, OUT, '06-whos-it-for', [checkoutSection(page).locator('div').first(), whoBlock])

  // 07: how did they pay (a band picked: all three show)
  await band(page, BAND_1).click()
  const payBlock = page.getByText('How did they pay?', { exact: true }).locator('..')
  await snap(page, OUT, '07-how-paid', [page.getByText('Who\'s it for?', { exact: true }), payBlock])

  // 08: cash: pick Cash, tap what they gave you, the till shows the change
  await tender(page, 'Cash').click()
  const twenty = page.locator('div.grid-cols-3 button', { hasText: '£20' })
  await twenty.click()
  await ring(twenty)
  const changeBox = page.getByText('Change to give').locator('..')
  await snap(page, OUT, '08-cash-change', [payBlock, changeBox])
  await clearRings(page)

  // 09: cash: done
  S.sales = [{ ...SALES[3], id: 'sale-1', created_at: at('19:42'), gross: 18, status: 'queued',
    push_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    lines: [{ name: COKE.title, qty: 2 }, { name: GAFFA.title, qty: 1 }] }]
  S.summary = { sales: 1, taken: 18, byTender: [{ tender: 'till_cash', label: 'Cash', amount: 18 }], onTheirBill: 0 }
  await page.locator('button', { hasText: 'Take £18.00' }).click()
  const done = page.locator('div[role="status"]')
  await done.waitFor()
  await snap(page, OUT, '09-cash-done', [header(page), done])

  // 10: their bill
  await openTill(page)
  await fillBasket(page)
  await band(page, BAND_2).click()
  await tender(page, 'Put it on their bill').click()
  const billBtn = page.locator('button', { hasText: 'Put £18.00 on their bill' })
  await ring(billBtn)
  await snap(page, OUT, '10-their-bill', [page.getByText('Who\'s it for?', { exact: true }), billBtn])
  await clearRings(page)

  // 11: the receipt box, with the band's contacts
  await openTill(page, { contacts: [{ email: 'sam@example.com', label: 'Sam Hart' }] })
  await fillBasket(page)
  await band(page, BAND_2).click()
  await page.locator('button', { hasText: 'Sam Hart' }).click()
  const receiptBlock = page.getByText('Email a receipt?').locator('..')
  const cardBtn = page.locator('button', { hasText: 'Take £18.00 on card reader' })
  await snap(page, OUT, '11-receipt', [receiptBlock, cardBtn])

  // 12: card reader: waiting for the card
  S.reader = readerSession('pending')
  await cardBtn.click()
  const waiting = page.locator('div.rounded-2xl', { hasText: 'Waiting for card' }).last()
  await waiting.waitFor()
  await snap(page, OUT, '12-reader-waiting', [waiting])

  // 13: card reader: declined (the till's own 2-second check picks it up)
  S.reader = readerSession('failed', { failure_message: 'Your card was declined.' })
  const notTaken = page.locator('div.rounded-2xl', { hasText: 'Not taken' }).last()
  await notTaken.waitFor({ timeout: 15000 })
  await snap(page, OUT, '13-reader-declined', [notTaken])

  // 14: card reader: approved
  S.sales = SALES
  S.summary = SUMMARY
  S.reader = readerSession('succeeded')
  const paid = page.locator('div[role="status"]', { hasText: 'Paid on the card reader' })
  await paid.waitFor({ timeout: 15000 })
  await snap(page, OUT, '14-reader-approved', [header(page), paid])

  // 15: tonight's list, with one sale still cancellable
  const tonight = page.locator('main > section', { has: page.getByText('Tonight', { exact: true }) })
  await tonight.scrollIntoViewIfNeeded()
  await ring(tonight.locator('button', { hasText: 'Cancel' }))
  await snap(page, OUT, '15-tonight', [tonight])
  await clearRings(page)

  // 16: after lock-up: the till is closed
  await openTill(page, { ctx: tillContext({ open: false, locked_up: true }) })
  await snap(page, OUT, '16-till-closed', [header(page), page.getByText(/so the till has closed/)])

  // 17: the lock-up page's till summary
  resetState()
  await page.goto(`${BASE}/shift/${TODAY}/lockup`, { waitUntil: 'networkidle' })
  const shopCard = page.locator('section', { hasText: 'Shop till tonight' }).first()
  await shopCard.waitFor()
  await hideFixed(page, true)
  await snap(page, OUT, '17-lockup-summary', [shopCard])

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
