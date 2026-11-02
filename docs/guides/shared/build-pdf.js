/**
 * Builds one freelancer guide's PDF from its guide.html (docs/guides/README.md).
 *
 *   node docs/guides/shared/build-pdf.js getting-started
 *
 * Writes docs/guides/<name>/<name>-guide.pdf. Refuses to write it if:
 *   - an image is missing,
 *   - the text has an em or en dash (house rule for anything freelancers read),
 *   - any page's content runs into its footer (each page is a fixed size, so
 *     anything past the bottom would simply be cut off).
 */

const path = require('path')
const fs = require('fs')

function loadPlaywright() {
  try { return require('playwright') } catch { /* fall back to a global install */ }
  const root = require('child_process').execSync('npm root -g').toString().trim()
  return require(path.join(root, 'playwright'))
}
const { chromium } = loadPlaywright()

const name = process.argv[2]
if (!name || !fs.existsSync(path.join(__dirname, '..', name, 'guide.html'))) {
  console.error('Usage: node docs/guides/shared/build-pdf.js <guide folder>, e.g. getting-started')
  process.exit(1)
}
const SRC = path.join(__dirname, '..', name, 'guide.html')
const OUT = path.join(__dirname, '..', name, `${name}-guide.pdf`)

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('file://' + SRC, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)

  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')))
  if (broken.length) throw new Error(`Missing images: ${broken.join(', ')}`)

  const dashes = await page.evaluate(() => (document.body.innerText.match(/.{0,30}[–—].{0,30}/g) || []))
  if (dashes.length) throw new Error(`Em or en dash in the guide text:\n  ${dashes.join('\n  ')}`)

  // The footer sits in the bottom 34px of each page; content must stop above it.
  const overflows = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p, i) => {
    const limit = p.getBoundingClientRect().bottom - 34
    const bottom = Math.max(...[...p.children].map((c) => c.getBoundingClientRect().bottom))
    return { page: i + 1, over: Math.round(bottom - limit) }
  }).filter((r) => r.over > 0))
  if (overflows.length) {
    throw new Error('Content runs past the bottom of: ' + overflows.map((o) => `page ${o.page} (by ${o.over}px)`).join(', '))
  }

  await page.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true })
  const pages = await page.evaluate(() => document.querySelectorAll('.page').length)
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${pages} pages, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`)
  await browser.close()
}

main().catch((e) => { console.error(e.message || e); process.exit(1) })
