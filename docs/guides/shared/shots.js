/**
 * Helpers for the guides' screenshot scripts (docs/guides/README.md).
 *
 * Each guide's screenshots.js renders the REAL portal pages on a phone-sized
 * screen, with every /api call answered from made-up data. Nothing touches OP,
 * HireHop, Stripe or Xero.
 */

const path = require('path')

function loadPlaywright() {
  try { return require('playwright') } catch { /* fall back to a global install */ }
  const root = require('child_process').execSync('npm root -g').toString().trim()
  return require(path.join(root, 'playwright'))
}

/** Today in UK time, as YYYY-MM-DD (so "Today" on the dashboard is today). */
function ukToday(offsetDays = 0) {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
  const [y, m, d] = t.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10)
}

/**
 * A phone-sized browser. With `secret` (the portal's SESSION_SECRET), it also
 * carries a fake login cookie so the signed-in pages open.
 */
async function phone({ base, secret, user = { id: 'u1', email: 'alex@example.com', name: 'Alex Morgan' } }) {
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    timezoneId: 'Europe/London', locale: 'en-GB',
  })
  if (secret) {
    const { SignJWT } = require('jose')
    const token = await new SignJWT(user)
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret))
    await context.addCookies([{ name: 'session', value: token, url: base }])
  }
  return { browser, context }
}

const RING = '#f97316'   // orange: nothing in the portal is this colour

/** Draw an orange ring round what the reader should tap. `inset` for rows in a clipped list. */
async function ring(locator, { inset = false } = {}) {
  await locator.evaluate((el, [c, off]) => { el.style.outline = `3px solid ${c}`; el.style.outlineOffset = off }, [RING, inset ? '-3px' : '3px'])
}
async function clearRings(page) {
  await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { el.style.outline = ''; el.style.outlineOffset = '' }))
}

/** Screenshot the full phone width, from the top of the first locator to the bottom of the last. */
async function snap(page, outDir, name, locators, { padTop = 14, padBottom = 14 } = {}) {
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
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true, clip: { x: 0, y: top, width, height: bottom - top } })
  console.log('  ✓', name)
}

/** The visible screen, as a phone shows it (the bottom menu included). */
async function screen(page, outDir, name) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log('  ✓', name)
}

module.exports = { loadPlaywright, ukToday, phone, ring, clearRings, snap, screen }

/** The placeholder van photos fed to the camera, in the order the app asks for them (18). */
function samplePhotos() {
  const dir = path.join(__dirname, 'sample-photos')
  return require('fs').readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f))
}

/** Sign a signature pad with a handwriting-like loop, as a finger would. */
async function drawSignature(page, canvas) {
  // Centre it: at the bottom of the screen a fixed button bar can sit on top of it.
  await canvas.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(250)
  const b = await canvas.boundingBox()
  if (!b) throw new Error('No signature pad on screen')
  const x0 = b.x + b.width * 0.12, y0 = b.y + b.height * 0.58
  const w = b.width * 0.72, h = b.height * 0.22
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  // A prolate cycloid: a run of joined loops, like joined-up writing.
  for (let t = 0; t <= 6 * Math.PI; t += 0.18) {
    const x = x0 + (t - 1.7 * Math.sin(t)) / (6 * Math.PI) * w
    const y = y0 - (1 - 1.7 * Math.cos(t)) / 2.7 * h + Math.sin(t / 3) * h * 0.25
    await page.mouse.move(x, y)
  }
  await page.mouse.up()
}

/** Fixed bars (a bottom menu, a sticky button) would land on top of a clipped shot: hide them for it. */
async function hideFixed(page, hide) {
  await page.evaluate((h) => {
    document.querySelectorAll('body *').forEach((el) => {
      const pos = getComputedStyle(el).position
      if (h && (pos === 'fixed' || pos === 'sticky')) { el.dataset.guideHidden = '1'; el.style.visibility = 'hidden' }
      if (!h && el.dataset.guideHidden) { el.style.visibility = ''; delete el.dataset.guideHidden }
    })
  }, hide)
}

Object.assign(module.exports, { samplePhotos, drawSignature, hideFixed })
