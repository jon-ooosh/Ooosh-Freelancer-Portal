/**
 * Copies the barcode reader's engine (zxing_reader.wasm) from the installed
 * `zxing-wasm` package into public/zxing/, so the sitter till's camera scanner
 * (src/components/CameraBarcodeScanner.tsx) loads it from the portal itself
 * rather than a third-party CDN. Runs before `next dev` and `next build`
 * (package.json predev / prebuild), so the file always matches the installed
 * version. public/zxing/ is git-ignored for the same reason.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const src = path.join(root, 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm')
const destDir = path.join(root, 'public', 'zxing')

if (!fs.existsSync(src)) {
  console.error(`[copy-zxing-wasm] ${src} not found. Run npm install first.`)
  process.exit(1)
}
fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, path.join(destDir, 'zxing_reader.wasm'))
console.log('[copy-zxing-wasm] public/zxing/zxing_reader.wasm ready')
