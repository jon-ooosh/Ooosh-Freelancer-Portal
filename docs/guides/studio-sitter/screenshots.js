/**
 * Screenshots for the "Studio sitting" freelancer guide (docs/guides/README.md).
 *
 * Renders the REAL portal pages on a phone-sized screen, with every /api call
 * answered from the made-up data below. Nothing touches OP.
 *
 * 1. Run the portal locally (any secret of 32+ characters; it only signs the
 *    fake login cookie):
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100
 * 2. In another terminal, from the repo root, with the SAME secret:
 *      SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/studio-sitter/screenshots.js
 * 3. Then: node docs/guides/shared/build-pdf.js studio-sitter
 *
 * The lock-up checklist is the built-in one (DEFAULT_TEMPLATE in
 * backend/src/services/studio-sitter-lockup.ts), read straight from that file,
 * so the guide shows the real questions. The live checklist is whatever is in
 * Settings, which starts as the same list.
 */

const path = require('path')
const fs = require('fs')
const { phone, ukToday, ring, clearRings, snap, screen, hideFixed } = require('../shared/shots')

const BASE = process.env.PORTAL_URL || 'http://localhost:3100'
const OUT = path.join(__dirname, 'img')
const SECRET = process.env.SESSION_SECRET
if (!SECRET) { console.error('Set SESSION_SECRET (the same one the portal was started with).'); process.exit(1) }

// ── The real lock-up checklist ───────────────────────────────────────────────

function defaultLockupTemplate() {
  const src = fs.readFileSync(path.join(__dirname, '../../../backend/src/services/studio-sitter-lockup.ts'), 'utf8')
  const start = src.indexOf('export const DEFAULT_TEMPLATE: LockupTemplate = ')
  const end = src.indexOf('\n};', start)
  if (start < 0 || end < 0) throw new Error('Could not find DEFAULT_TEMPLATE in studio-sitter-lockup.ts')
  const literal = src.slice(src.indexOf('{', start), end + 2)
  // The reference photos are on Jotform; the guide only shows the link to them.
  // eslint-disable-next-line no-new-func
  return new Function('REF_ROOM_1', 'REF_ROOM_2', 'REF_ROOM_3', `return (${literal})`)('', '', '')
}

// ── Sample data (made-up bands) ──────────────────────────────────────────────

const TODAY = ukToday()
const at = (hhmm) => `${TODAY}T${hhmm}:00+00:00`

const JOBS_TONIGHT = [
  { job_id: 'j1', hh_job_number: 16850, label: 'Paper Satellites', rooms: ['Room 1'],
    files: [{ name: 'Paper Satellites stage plot.pdf', url: 'https://example.com/plot.pdf', fileType: 'application/pdf' }] },
  { job_id: 'j2', hh_job_number: 16852, label: 'The Lantern Thieves', rooms: ['Room 2'], files: [] },
]
const SHIFT = {
  success: true, date: TODAY, planned_start: '16:45:00', planned_end: '22:30:00', status: 'scheduled',
  fee: null, assignment_status: 'confirmed', jobs: JOBS_TONIGHT, tasks: [],
}
const SHIFTS = { success: true, shifts: [{ ...SHIFT, report_submitted_at: null }] }
const THREAD = { success: true, messages: [
  { id: 'm1', content: 'Paper Satellites are hiring a spare snare tonight: it’s on the shelf in the Room 1 kitchen. Room 3 is empty.',
    created_at: at('15:20'), author: 'Jon', from_staff: true, mine: false, files: [] },
] }
const RECENT = { success: true, nights: [
  { date: ukToday(-1), entries: [
    { id: 'r1', content: 'All quiet. Room 2 asked about booking again next week: said someone would call them.',
      created_at: `${ukToday(-1)}T21:58:00+00:00`, author: 'Sam Lee', from_staff: false, mine: false, files: [] },
  ] },
] }
const LOCKUP = {
  success: true, date: TODAY, template: defaultLockupTemplate(),
  continuing_tomorrow: false, continuing_derived: false, submitted: null, has_shift: true,
  shop: { sales: 2, taken: 18.5, byTender: [{ tender: 'card_reader', label: 'Card', amount: 12.5 }, { tender: 'cash', label: 'Cash', amount: 6 }], onTheirBill: 0 },
}

async function answer(route) {
  const req = route.request()
  const p = new URL(req.url()).pathname
  const json = (body, status = 200) => route.fulfill({ status, json: body })
  if (p === '/api/jobs') return json({ success: true, user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' }, today: [], upcoming: [], completed: [], cancelled: [] })
  if (p === '/api/day-bookings') return json({ success: true, awaitingReply: 0, past: [], done: [], upcoming: [] })
  if (p === '/api/studio-sitter/shifts') return json(SHIFTS)
  if (p === `/api/studio-sitter/shifts/${TODAY}`) return json(SHIFT)
  if (p === `/api/studio-sitter/shifts/${TODAY}/thread`) return json(THREAD)
  if (p === `/api/studio-sitter/shifts/${TODAY}/recent-handover`) return json(RECENT)
  if (p === `/api/studio-sitter/shifts/${TODAY}/lockup` && req.method() === 'POST') return json({ success: true, exceptions: [{ id: 'clients_out_on_time' }] })
  if (p === `/api/studio-sitter/shifts/${TODAY}/lockup`) return json(LOCKUP)
  if (p === '/api/settings/notifications') return json({ success: true, notifications: { globalMuteActive: false, globalMuteUntil: null, mutedJobIds: [], mutedJobCount: 0 } })
  return json({ error: `not mocked: ${p}` }, 404)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { browser, context } = await phone({ base: BASE, secret: SECRET })
  const page = await context.newPage()
  await page.route('**/api/**', answer)

  // 01: tonight's evening on the Jobs page
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  const card = page.locator('div.rounded-2xl', { has: page.locator(`a[href="/shift/${TODAY}"]`) }).first()
  await card.waitFor()
  await hideFixed(page, true)
  await snap(page, OUT, '01-tonight-card', [card], { padTop: 40, padBottom: 20 })
  await hideFixed(page, false)

  // 02: the shift page: the evening, and the shop till
  await page.goto(`${BASE}/shift/${TODAY}`, { waitUntil: 'networkidle' })
  await page.getByText('Who’s in tonight').or(page.getByText("Who's in tonight")).first().waitFor()
  await hideFixed(page, true)
  await snap(page, OUT, '02-shift-top', [page.getByText('Studio sitter').first(), page.locator(`a[href="/shift/${TODAY}/till"]`).first()], { padTop: 60, padBottom: 20 })

  // 03: who's in tonight, and the recent handover
  await page.getByText('Recent handover').click()
  await snap(page, OUT, '03-whos-in', [page.getByText(/s in tonight/).first(), page.getByText(/Room 2 asked about booking/)], { padBottom: 22 })

  // 04: handover notes
  await page.getByText('Recent handover').click()
  await snap(page, OUT, '04-handover', [page.getByText('Handover notes', { exact: true }), page.getByRole('button', { name: 'Post note' })], { padBottom: 22 })
  await hideFixed(page, false)

  // 05: the Finish for the night button, as the phone shows it
  const finish = page.getByRole('link', { name: /Finish for the night/ })
  await ring(finish)
  await page.screenshot({ path: path.join(OUT, '05-finish-button.png'), clip: { x: 0, y: 844 - 150, width: 390, height: 150 } })
  console.log('  ✓ 05-finish-button')
  await clearRings(page)

  // 06: the lock-up checklist, the top
  await page.goto(`${BASE}/shift/${TODAY}/lockup`, { waitUntil: 'networkidle' })
  await page.getByText('Upstairs', { exact: true }).waitFor()
  await hideFixed(page, true)
  await snap(page, OUT, '06-lockup-top', [page.getByText('Finish for the night', { exact: true }), page.getByText(/studio in use again tomorrow/).locator('xpath=ancestor::section[1]')], { padTop: 60 })

  // 07: answering: a No asks why; the money question always has a note box
  const item = (id, label) => page.locator('div.rounded-2xl', { has: page.getByText(label, { exact: false }) }).first()
  const outOnTime = item('clients_out_on_time', 'Were the clients out on time?')
  await outOnTime.getByRole('button', { name: 'No', exact: true }).click()
  await outOnTime.locator('textarea').fill('Room 1 left at 10:20. Told them we’d be in touch about the extra time.')
  const money = item('money_outstanding', 'Any money outstanding?')
  await money.getByRole('button', { name: 'No', exact: true }).click()
  await item('pas', 'PAs, amps').getByRole('button', { name: 'Yes', exact: true }).click()
  await ring(outOnTime.getByRole('button', { name: 'No', exact: true }))
  await snap(page, OUT, '07-lockup-answers', [page.getByText('Upstairs', { exact: true }), item('pas', 'PAs, amps')])
  await clearRings(page)

  // 08: "What it should look like"
  const stored = item('backline_stored', 'Ooosh backline packed away')
  await ring(stored.getByRole('button', { name: /What it should look like/ }))
  await snap(page, OUT, '08-lockup-reference', [stored])
  await clearRings(page)

  // 09: the end: lost property, notes, and Submit
  await hideFixed(page, false)
  await page.locator('textarea').last().fill('Phone message, 7:40pm: Chris Patel (07700 900789) wants to book Room 3 for two days in March. Please call back.')
  await page.getByText('Lost property', { exact: true }).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await ring(page.getByRole('button', { name: /Submit/ }))
  await screen(page, OUT, '09-lockup-end')
  await clearRings(page)

  // 10: done
  await page.getByRole('button', { name: /Submit/ }).click()
  await page.getByRole('button', { name: /Submit anyway/ }).click()
  await page.getByText('Locked up. Thanks!').waitFor()
  await snap(page, OUT, '10-lockup-done', [page.getByText('Locked up. Thanks!').locator('xpath=ancestor::div[contains(@class,"rounded")][1]')], { padTop: 20, padBottom: 20 })

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
