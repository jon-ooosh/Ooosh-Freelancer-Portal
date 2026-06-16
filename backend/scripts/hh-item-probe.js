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

// ── Item-master probe (find where the front-panel photo lives) ─────────
async function probeItemMaster(listId) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  HireHop Stock-Item Master probe — LIST_ID ${listId}`);
  console.log(`  (Hunting for the image/photo field — not present on the job pull)`);
  console.log(`${'='.repeat(70)}\n`);

  // The job pull has no image field, and the public hirehop.info URL uses an
  // internal asset id (e.g. 2346_592) that is NOT the LIST_ID. So the photo
  // filename must live on the stock-item master record. We don't know the
  // endpoint, so try several and dump whatever returns.
  const candidates = [
    ['/api/item_data.php', { item: listId }],
    ['/php_functions/item_data.php', { item: listId }],
    ['/php_functions/item_refresh.php', { item: listId }],
    ['/php_functions/stock_item.php', { id: listId }],
    ['/frames/item_data.php', { item: listId }],
    ['/api/stock.php', { id: listId }],
  ];

  for (const [endpoint, params] of candidates) {
    try {
      const data = await hhGet(endpoint, params);
      const ok = data && typeof data === 'object' && !data.error &&
                 Object.keys(data).length > 0;
      console.log(`  ${ok ? '✓' : '✗'} ${endpoint} → ${
        typeof data === 'string' ? data.slice(0, 80)
          : JSON.stringify(Object.keys(data || {})).slice(0, 200)}`);
      if (ok) {
        // Dump any field that smells like an image/asset reference
        for (const [k, v] of Object.entries(data)) {
          const lk = k.toLowerCase();
          if (lk.includes('img') || lk.includes('image') || lk.includes('photo') ||
              lk.includes('upload') || lk.includes('asset') || lk.includes('file') ||
              lk.includes('pic') || lk.includes('thumb') ||
              (typeof v === 'string' && /\.(png|jpe?g|webp)/i.test(v))) {
            console.log(`      ⮑ ${k}: ${JSON.stringify(v).slice(0, 160)}`);
          }
        }
      }
    } catch (e) {
      console.log(`  ✗ ${endpoint} → error: ${e.message}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (ARG === '--categories') {
    return listCategories();
  }
  if (ARG === '--item') {
    const listId = process.argv[3];
    if (!listId) { console.error('Usage: node hh-item-probe.js --item <LIST_ID>'); process.exit(1); }
    return probeItemMaster(listId);
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

  // ── 1b. RACK PLANNER analysis (LFT/RGT tree + classification) ──
  rackAnalysis(items);

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

// ── Rack Planner analysis ──────────────────────────────────────────────
// Answers the three §5 open questions in one pass:
//   Q1 — do autopulled accessories (looms/IEC/Cat5) surface as their own lines?
//   Q2 — does the job pull group package components under a parent (LFT/RGT)?
//   Q3 — are all pre-built packages VIRTUAL (no non-virtual packages)?
function rackAnalysis(items) {
  console.log('\n\n━━━ RACK PLANNER ANALYSIS ━━━\n');

  const getField = (item, ...names) => {
    for (const n of names) if (item[n] !== undefined && item[n] !== null) return item[n];
    return undefined;
  };
  const isVirtual = (item) => {
    const v = getField(item, 'VIRTUAL', 'virtual');
    return v === '1' || v === 1 || v === true || v === 'Yes' || v === 'yes';
  };
  // rackheight can be a flat value or a {type,value} shape (like preptimemins)
  const rackHeight = (item) => {
    const cf = getField(item, 'TYPE_CUSTOM_FIELDS', 'CUSTOM_FIELDS') || {};
    let rh = cf.rackheight;
    if (rh && typeof rh === 'object') rh = rh.value;
    return rh !== undefined && rh !== null && rh !== '' ? Number(rh) : null;
  };
  // halfwidth: a HireHop checkbox custom field — truthy = occupies half a 19" bay
  const halfWidth = (item) => {
    const cf = getField(item, 'TYPE_CUSTOM_FIELDS', 'CUSTOM_FIELDS') || {};
    let hw = cf.halfwidth;
    if (hw && typeof hw === 'object') hw = hw.value;
    return hw === 1 || hw === '1' || hw === true || hw === 'true' || hw === 'yes' || hw === 'Yes';
  };
  // Hunt for any field that might carry the front-panel photo path/filename
  const imageFields = (item) => {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      const lk = k.toLowerCase();
      if (lk.includes('img') || lk.includes('image') || lk.includes('photo') ||
          lk.includes('upload') || lk.includes('pic') || lk.includes('thumb') ||
          (typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v))) {
        out[k] = v;
      }
    }
    return out;
  };

  // Classify each item the way the picker would
  function classify(item) {
    const kind = Number(getField(item, 'kind') ?? 2);
    if (kind === 0) return 'header';
    if (kind === 4) return 'service/crew';
    if (isVirtual(item)) return 'PRE-BUILT (virtual)';
    if (rackHeight(item) > 0) return 'U-ITEM (rackable)';
    return 'loose / autopull?';
  }

  // Build LFT/RGT containment tree — a child sits inside parent's [LFT, RGT]
  const enriched = items.map((item, idx) => ({
    idx,
    item,
    name: getField(item, 'title', 'NAME', 'name', 'DESCRIPTION') || '(no name)',
    kind: Number(getField(item, 'kind') ?? 2),
    lft: Number(getField(item, 'LFT', 'lft') ?? 0),
    rgt: Number(getField(item, 'RGT', 'rgt') ?? 0),
    virtual: isVirtual(item),
    rh: rackHeight(item),
    hw: halfWidth(item),
    listId: getField(item, 'LIST_ID', 'ITEM_ID', 'ID'),
    autopull: getField(item, 'AUTOPULL'),
    cat: getField(item, 'CATEGORY_ID', 'ACC_CATEGORY'),
    cls: classify(item),
    imgs: imageFields(item),
  }));

  // Flat table
  console.log('All lines (in returned order):');
  console.log('  ' + ['#', 'kind', 'LFT', 'RGT', 'virt', 'rackH', 'halfW', 'cat', 'LIST_ID', 'class', 'name'].join('\t'));
  for (const e of enriched) {
    console.log('  ' + [
      e.idx + 1, e.kind, e.lft, e.rgt, e.virtual ? 'Y' : '-',
      e.rh ?? '-', e.hw ? '½' : '-', e.cat ?? '-', e.listId ?? '-', e.cls, e.name,
    ].join('\t'));
  }

  // Nested-set tree: for each item, its parent is the narrowest enclosing range
  console.log('\nLFT/RGT containment tree (indent = nested inside):');
  const hasNesting = enriched.some((e) => e.rgt > e.lft + 1);
  if (!hasNesting) {
    console.log('  ⚠ No nesting detected (all RGT == LFT+1). Package grouping is NOT');
    console.log('    expressed via LFT/RGT on this job — Q2 needs a fallback rule.');
  }
  for (const e of enriched) {
    // Count how many other items strictly enclose this one
    const depth = enriched.filter((p) =>
      p !== e && p.lft < e.lft && p.rgt > e.rgt && p.lft > 0).length;
    const indent = '  ' + '    '.repeat(depth);
    const tag = e.virtual ? '[PRE-BUILT]' : (e.rh > 0 ? `[U-ITEM ${e.rh}U${e.hw ? ' ½w' : ''}]` : '[loose]');
    console.log(`${indent}${tag} ${e.name}  (LFT ${e.lft}–${e.rgt})`);
  }

  // Image-field report (does the job pull carry a derivable photo path?)
  console.log('\nImage/photo-related fields seen on items:');
  const withImgs = enriched.filter((e) => Object.keys(e.imgs).length > 0);
  if (withImgs.length === 0) {
    console.log('  ⚠ None. Photo path is NOT in the job pull — must derive from the');
    console.log('    item master / construct the hirehop.info URL from name + ID.');
  } else {
    for (const e of withImgs) {
      console.log(`  "${e.name}": ${JSON.stringify(e.imgs)}`);
    }
  }

  // Answers summary
  const autopullCandidates = enriched.filter((e) =>
    !e.virtual && e.rh === null && e.kind === 2);
  console.log('\n── §5 answers from this job ──');
  console.log(`  Q1 (autopulls as lines): ${autopullCandidates.length} non-virtual, non-rackable kind:2 lines`);
  console.log('       (looms/IEC/Cat5 should be in here if they surface — eyeball the names above)');
  console.log(`  Q2 (grouping): ${hasNesting ? 'LFT/RGT nesting PRESENT — collapse packages by containment' : 'NO nesting — needs fallback rule'}`);
  const nonVirtPackages = enriched.filter((e) => !e.virtual && e.rgt > e.lft + 1);
  console.log(`  Q3 (non-virtual packages): ${nonVirtPackages.length} non-virtual items that enclose children`);
  console.log(`       ${nonVirtPackages.length === 0 ? '✓ none — VIRTUAL rule holds' : '⚠ found some — VIRTUAL rule has a gap, inspect above'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
