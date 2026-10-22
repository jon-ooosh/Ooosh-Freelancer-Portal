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
