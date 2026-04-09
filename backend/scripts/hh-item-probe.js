#!/usr/bin/env node
/**
 * HireHop Item Probe — diagnostic script
 *
 * Fetches RAW item data from HireHop for a specific job number,
 * with zero filtering. Shows every field HH returns, including
 * prompt items, virtual items, children, etc.
 *
 * Usage:
 *   cd /var/www/ooosh-portal/backend
 *   node scripts/hh-item-probe.js <JOB_NUMBER>
 *
 * Example:
 *   node scripts/hh-item-probe.js 15564
 *
 * Reads HIREHOP_DOMAIN and HIREHOP_API_TOKEN from ../.env or ../backend/.env
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Load env vars ──────────────────────────────────────────────────────
function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '..', 'backend', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      }
      console.log(`[env] Loaded from ${p}`);
      return;
    }
  }
  console.error('No .env file found');
}

loadEnv();

const DOMAIN = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
const TOKEN = process.env.HIREHOP_API_TOKEN;
const ARG = process.argv[2];

if (!ARG) {
  console.error('Usage:');
  console.error('  node hh-item-probe.js <JOB_NUMBER>     — probe items on a specific job');
  console.error('  node hh-item-probe.js --categories      — list all HH stock categories');
  process.exit(1);
}
const JOB = ARG === '--categories' ? null : ARG;
if (!TOKEN) {
  console.error('HIREHOP_API_TOKEN not found in .env');
  process.exit(1);
}

// ── Fetch helper ───────────────────────────────────────────────────────
function hhGet(endpoint, params) {
  const qs = new URLSearchParams({ ...params, token: TOKEN }).toString();
  const url = `https://${DOMAIN}${endpoint}?${qs}`;
  console.log(`\n[GET] ${url.replace(TOKEN, '***')}\n`);

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

// ── Categories mode ────────────────────────────────────────────────────
async function listCategories() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  HireHop Categories List`);
  console.log(`  Domain: ${DOMAIN}`);
  console.log(`${'='.repeat(70)}\n`);

  const data = await hhGet('/php_functions/categories_list.php', { doc_type: 0 });
  const rows = data.rows || data;

  function printCategory(cat, depth = 0) {
    const indent = '  '.repeat(depth);
    const flags = [];
    if (cat.IS_STOCK === '1' || cat.IS_STOCK === 1) flags.push('RENTAL');
    if (cat.IS_CONSUMABLE === '1' || cat.IS_CONSUMABLE === 1) flags.push('SALES');
    if (cat.IS_LABOUR === '1' || cat.IS_LABOUR === 1) flags.push('LABOUR');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    console.log(`${indent}${cat.ID}: ${cat.NAME}${flagStr}`);
    if (cat.children && cat.children.length > 0) {
      for (const child of cat.children) {
        printCategory(child, depth + 1);
      }
    }
  }

  if (Array.isArray(rows)) {
    for (const cat of rows) {
      printCategory(cat);
    }
  } else {
    console.log('Unexpected response format:', JSON.stringify(data).substring(0, 500));
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (ARG === '--categories') {
    return listCategories();
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  HireHop Item Probe — Job #${JOB}`);
  console.log(`  Domain: ${DOMAIN}`);
  console.log(`${'='.repeat(70)}`);

  // ── 1. items_to_supply_list.php (what our sync uses) ──
  console.log('\n\n━━━ ENDPOINT 1: items_to_supply_list.php ━━━');
  console.log('(This is what our 30-min sync fetches)\n');
  const supplyItems = await hhGet('/frames/items_to_supply_list.php', { job: JOB });

  const items = Array.isArray(supplyItems) ? supplyItems : (supplyItems?.items || supplyItems?.rows || [supplyItems]);

  console.log(`Total items returned: ${items.length}\n`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`\n─── Item ${i + 1} ───`);

    // Print key fields prominently
    const name = item.title || item.NAME || item.name || item.DESCRIPTION || '(no name)';
    const kind = item.kind;
    const qty = item.QTY || item.qty || item.QUANTITY;
    const catName = item.ACC_CATEGORY_NAME || item.CATEGORY || item.category || '';
    const catId = item.CATEGORY_ID || item.ACC_CATEGORY;
    const virtual = item.VIRTUAL;
    const listId = item.LIST_ID || item.ITEM_ID || item.ID;
    const parentId = item.PARENT_ID || item.parent_id || item.PARENT;

    console.log(`  Name:     ${name}`);
    console.log(`  Kind:     ${kind} (0=header, 2=item, 3=note, 4=service/crew)`);
    console.log(`  Qty:      ${qty}`);
    console.log(`  Category: ${catName} (ID: ${catId})`);
    console.log(`  Virtual:  ${virtual}`);
    console.log(`  ID:       ${listId}`);
    if (parentId) console.log(`  PARENT:   ${parentId}`);

    // Check for prompt/selection related fields
    const promptFields = {};
    for (const [key, val] of Object.entries(item)) {
      const lk = key.toLowerCase();
      if (lk.includes('prompt') || lk.includes('select') || lk.includes('chosen') ||
          lk.includes('option') || lk.includes('parent') || lk.includes('child') ||
          lk.includes('sub') || lk.includes('text') || lk.includes('memo') ||
          lk.includes('flag') || lk.includes('type') || lk.includes('note') ||
          lk.includes('desc')) {
        promptFields[key] = val;
      }
    }

    if (Object.keys(promptFields).length > 0) {
      console.log(`  *** Prompt/selection/type fields: ***`);
      for (const [k, v] of Object.entries(promptFields)) {
        const val = typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v;
        console.log(`    ${k}: ${JSON.stringify(val)}`);
      }
    }

    // If item name contains "seat" or "rear" — dump ALL fields
    if (name.toLowerCase().includes('seat') || name.toLowerCase().includes('rear')) {
      console.log(`\n  *** SEAT-RELATED ITEM — FULL DUMP: ***`);
      for (const [k, v] of Object.entries(item)) {
        const val = typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v;
        console.log(`    ${k}: ${JSON.stringify(val)}`);
      }
    }
  }

  // ── 2. job_data.php (alternative endpoint with embedded items) ──
  console.log('\n\n━━━ ENDPOINT 2: job_data.php ━━━');
  console.log('(Alternative — returns job data with embedded items array)\n');
  const jobData = await hhGet('/api/job_data.php', { job: JOB });

  if (jobData && typeof jobData === 'object') {
    // Print job-level custom fields
    if (jobData.CUSTOM_FIELDS) {
      console.log('Job CUSTOM_FIELDS:', jobData.CUSTOM_FIELDS);
    }

    const jobItems = jobData.items || [];
    console.log(`\nEmbedded items count: ${jobItems.length}`);

    for (let i = 0; i < jobItems.length; i++) {
      const item = jobItems[i];
      const name = item.DESCRIPTION || item.NAME || item.title || '(no name)';

      // Only dump seat-related or interesting items to keep output manageable
      if (name.toLowerCase().includes('seat') || name.toLowerCase().includes('rear') ||
          name.toLowerCase().includes('van') || name.toLowerCase().includes('premium')) {
        console.log(`\n─── Job Item ${i + 1}: "${name}" ───`);
        for (const [k, v] of Object.entries(item)) {
          const val = typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v;
          console.log(`  ${k}: ${JSON.stringify(val)}`);
        }
      }
    }
  }

  // ── 3. Summary ──
  console.log('\n\n━━━ SUMMARY ━━━');
  console.log('Key things to look for in the output above:');
  console.log('  1. Do "Rear seats arranged around a table" / "forward-facing" appear as separate items?');
  console.log('  2. Is there a PARENT_ID linking them to the "Rear seats:" item?');
  console.log('  3. Is there any "selected"/"prompt" field indicating which option is chosen?');
  console.log('  4. Do they only appear if selected, or do all prompts appear?');
  console.log('  5. What "kind" value do prompt items have?');

  // Also dump ALL field names across all items (unique set)
  const allFields = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) allFields.add(key);
  }
  console.log(`\nAll field names seen across items_to_supply_list response:`);
  console.log(`  ${[...allFields].sort().join(', ')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
