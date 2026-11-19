// Shared pieces for the guide screenshot scripts (help/README.md).
//
// A script drives the REAL app in a headless browser against a local database holding
// made-up data, and saves cropped pictures straight into a guide's folder. HireHop is not
// reachable from a dev machine, so the two reads that need it (a job's money summary and
// its close-out plan) are answered with fixtures; everything else is the app's own code.
//
// Never point one of these at production, and never use a real client's name or job number.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');

const APP = process.env.HELP_SHOTS_APP || 'http://localhost:5173';
const API = process.env.HELP_SHOTS_API || 'http://localhost:3001';
const PSQL = process.env.HELP_SHOTS_PSQL || 'PGPASSWORD=ooosh_dev psql -h localhost -U ooosh ooosh_operations';
const GUIDES = path.resolve(__dirname, '..', 'guides');

/** Run SQL against the LOCAL database; returns the first column of each row. */
const sql = (q) => execSync(`${PSQL} -qAt`, { input: q }).toString().trim().split('\n').filter(Boolean);

async function open({ role = 'manager', width = 1180, height = 900 } = {}) {
  sql(`UPDATE users SET role = '${role}' WHERE email = 'admin@oooshtours.co.uk'`);
  const login = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@oooshtours.co.uk', password: 'admin12345' }),
  })).json();
  if (!login.accessToken) throw new Error(`Could not log in to the local app: ${JSON.stringify(login).slice(0, 200)}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await ctx.addInitScript(([u, a, r]) => {
    localStorage.setItem('ooosh_user', JSON.stringify(u));
    localStorage.setItem('ooosh_access_token', a);
    localStorage.setItem('ooosh_refresh_token', r);
  }, [login.user, login.accessToken, login.refreshToken]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { browser, page, errors };
}

/** The white card a heading sits in. */
const card = (page, heading) =>
  page.getByRole('heading', { name: heading }).first().locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');

/**
 * Save a picture of one or more parts of the page (cropped to them, with a margin) into a
 * guide's folder. `ring` draws a red outline round the thing the step is about.
 */
async function shot(page, slug, file, parts, { ring, pad = 14 } = {}) {
  const list = Array.isArray(parts) ? parts : [parts];
  await list[0].scrollIntoViewIfNeeded();
  if (ring) await ring.evaluate((el) => { el.style.outline = '3px solid #e11d48'; el.style.outlineOffset = '3px'; el.style.borderRadius = '8px'; });
  await page.waitForTimeout(250);
  const boxes = [];
  for (const p of list) { const b = await p.boundingBox(); if (b) boxes.push(b); }
  if (!boxes.length) throw new Error(`Nothing on screen to picture for ${slug}/${file}`);
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  // Boxes are measured from the top of the window; a full-page picture is measured from the
  // top of the PAGE, so something taller than the window is never cut off.
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const vp = page.viewportSize();
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  const clip = {
    x: left + scroll.x, y: top + scroll.y,
    width: Math.min(vp.width, x1 + pad) - left,
    height: (y1 + pad) - top,
  };
  await page.screenshot({ path: path.join(GUIDES, slug, file), clip, fullPage: true });
  if (ring) await ring.evaluate((el) => { el.style.outline = ''; el.style.outlineOffset = ''; });
  console.log(`  ${slug}/${file}`);
}

module.exports = { APP, API, sql, open, card, shot };
