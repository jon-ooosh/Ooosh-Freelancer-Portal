/**
 * Staging stock fetch + parse.
 *
 * Ported from ooosh-utilities `netlify/functions/staging-stock.js` (Jun 2026) when
 * the Staging Calculator moved into OP. Pulls staging equipment from HireHop's
 * bulk stock export endpoint and parses item names into the structured shape the
 * calculator front-end expects.
 *
 * Uses the EXPORT credentials (HIREHOP_EXPORT_ID + HIREHOP_EXPORT_KEY), NOT the
 * API token — the export endpoint is a separate auth scheme, the same one the
 * backline matcher uses. Not routed through the broker (different auth, one bulk
 * call, not part of the rate-limited /api surface).
 *
 * Staging category IDs: 445 Decks · 446 Legs & Hardware · 447 Screwjacks · 448 Accessories
 */

const HIREHOP_EXPORT_URL = 'https://myhirehop.com/modules/stock/export_data.php';

// "STAGING" parent category — the export returns this category AND all its
// descendants (445 Decks / 446 Legs & Hardware / 447 Screwjacks / 448 Accessories)
// in one call. We fetch the parent rather than no-cat-at-all: a no-cat fetch on
// some export configs returns a truncated/partial list (legs came through but
// screwjacks/steps/handrails/decks didn't — the bug this fixes, Jun 2026).
const CATEGORY_STAGING_PARENT = 444;

const CATEGORY_DECKS = 445;
const CATEGORY_HARDWARE = 446;
const CATEGORY_SCREWJACKS = 447;
const CATEGORY_ACCESSORIES = 448;

const COMBINER_HEIGHT_OFFSET = 6;

const LEG_COLOURS: Record<number, string> = {
  12: 'White end',
  24: 'Green end',
  30: 'Orange end',
  38: 'Blue end',
  48: 'Plain silver',
};

const WHEEL_FINISHED_HEIGHTS: Record<string, number> = {
  '4"': 12,
  '6"': 6,
  '8"': 8,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawItem = Record<string, any>;

export interface StagingStock {
  decks: any[];
  legs: any[];
  combiners: any;
  screwjacks: any[];
  wheels: any[];
  handrails: any[];
  steps: any[];
  skirts: any[];
}

export async function fetchStagingStock(): Promise<{ stock: StagingStock; rawCounts: Record<string, number> }> {
  const exportId = process.env.HIREHOP_EXPORT_ID;
  const exportKey = process.env.HIREHOP_EXPORT_KEY;

  if (!exportId || !exportKey) {
    throw new Error('Missing HireHop export credentials. Set HIREHOP_EXPORT_ID and HIREHOP_EXPORT_KEY env vars.');
  }

  // Fetch the whole staging subtree in one call (parent 444 → returns all children),
  // then split by category in JS.
  const allRaw = await fetchCategory(exportId, exportKey, CATEGORY_STAGING_PARENT);
  console.log(`[Staging] export returned ${allRaw.length} items; sample CATEGORY_IDs:`,
    allRaw.slice(0, 5).map((i) => i.CATEGORY_ID));

  // Coerce CATEGORY_ID to Number — the export can return it as a string or number
  // depending on params, and a string would silently fail a `===` number compare.
  const catId = (i: RawItem) => Number(i.CATEGORY_ID);
  const decksRaw = allRaw.filter((i) => catId(i) === CATEGORY_DECKS);
  const hardwareRaw = allRaw.filter((i) => catId(i) === CATEGORY_HARDWARE);
  const screwjacksRaw = allRaw.filter((i) => catId(i) === CATEGORY_SCREWJACKS);
  const accessoriesRaw = allRaw.filter((i) => catId(i) === CATEGORY_ACCESSORIES);

  // Handrails and steps can live in either hardware (446) or accessories (448)
  const allHardwareAndAccessories = [...hardwareRaw, ...accessoriesRaw];

  const stock: StagingStock = {
    decks: parseDecks(decksRaw),
    legs: parseLegs(hardwareRaw),
    combiners: parseCombiners(hardwareRaw),
    screwjacks: parseScrewjacks(screwjacksRaw),
    wheels: parseWheels(hardwareRaw),
    handrails: parseHandrails(allHardwareAndAccessories),
    steps: parseSteps(allHardwareAndAccessories),
    skirts: parseSkirts(accessoriesRaw),
  };

  return {
    stock,
    rawCounts: {
      decks: decksRaw.length,
      hardware: hardwareRaw.length,
      screwjacks: screwjacksRaw.length,
      accessories: accessoriesRaw.length,
    },
  };
}

async function fetchCategory(exportId: string, exportKey: string, categoryId: number | null): Promise<RawItem[]> {
  // depot=1 (Main Stock) matches the working manual export URL — the category-scoped
  // export returns nothing without it.
  const params = new URLSearchParams({ id: exportId, key: exportKey, depot: '1', sidx: 'TITLE', sord: 'asc' });
  if (categoryId !== null) params.set('cat', String(categoryId));

  const url = `${HIREHOP_EXPORT_URL}?${params.toString()}`;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url);

    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Staging] HireHop rate limit (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`HireHop rate limit (429) — all ${MAX_RETRIES} attempts failed`);
    }

    if (!response.ok) throw new Error(`HireHop export returned ${response.status}`);

    const text = await response.text();
    if (text.trim().startsWith('<')) throw new Error('HireHop returned HTML — likely auth error (check export credentials)');

    const data = JSON.parse(text);
    // The export may return a bare array or wrap it (items/rows/data) — handle all.
    if (Array.isArray(data)) return data;
    return data.items || data.rows || data.data || [];
  }
  return [];
}

// ── Parsers (verbatim port; extract structured data from HireHop item names) ──

function parseDecks(rawItems: RawItem[]): any[] {
  const decks: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    const match = name.match(/(\d+)'\s*x\s*(\d+)'\s*(litedeck|steeldeck|deck)/i);
    if (match) {
      const lengthFt = parseInt(match[1]);
      const widthFt = parseInt(match[2]);
      const type = match[3].toLowerCase();
      decks.push({
        name,
        lengthIn: lengthFt * 12,
        widthIn: widthFt * 12,
        qty,
        type: type === 'steeldeck' ? 'steeldeck' : 'litedeck',
        hirehopId: item.ID || null,
      });
    }
  }
  return decks;
}

function parseLegs(rawItems: RawItem[]): any[] {
  const legs: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (!name.match(/\bleg\b/i) || name.match(/combiner|screwjack|wheel|handrail|step/i)) continue;
    const inchMatch = name.match(/(\d+\.?\d*)\s*["″]/);
    if (inchMatch) {
      const heightIn = parseFloat(inchMatch[1]);
      legs.push({ name, heightIn, qty, colour: LEG_COLOURS[heightIn] || '', hirehopId: item.ID || null });
    }
  }
  return legs;
}

function parseCombiners(rawItems: RawItem[]): any {
  const result: any = {
    twoInOne: { name: '2-in-1 leg combiner', qty: 0, heightOffsetIn: COMBINER_HEIGHT_OFFSET },
    fourInOne: { name: '4-in-1 leg combiner', qty: 0, heightOffsetIn: COMBINER_HEIGHT_OFFSET },
  };
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (name.match(/2-in-1/i) && name.match(/combiner/i)) {
      result.twoInOne.name = name;
      result.twoInOne.qty = qty;
      result.twoInOne.hirehopId = item.ID || null;
    } else if (name.match(/4-in-1/i) && name.match(/combiner/i)) {
      result.fourInOne.name = name;
      result.fourInOne.qty = qty;
      result.fourInOne.hirehopId = item.ID || null;
    }
  }
  return result;
}

function parseScrewjacks(rawItems: RawItem[]): any[] {
  const screwjacks: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (qty <= 0) continue;
    const inchMatch = name.match(/(\d+\.?\d*)\s*["″]/);
    if (inchMatch) {
      screwjacks.push({ name, heightIn: parseFloat(inchMatch[1]), qty, hirehopId: item.ID || null });
    } else {
      const cmMatch = name.match(/(\d+)\s*cm/i);
      if (cmMatch) {
        screwjacks.push({ name, heightIn: parseInt(cmMatch[1]) / 2.54, qty, hirehopId: item.ID || null });
      }
    }
  }
  return screwjacks;
}

function parseWheels(rawItems: RawItem[]): any[] {
  const wheels: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (!name.match(/wheel/i)) continue;
    const inchMatch = name.match(/(\d+)\s*["″]/);
    if (inchMatch) {
      const wheelSize = `${inchMatch[1]}"`;
      const finishedHeight = WHEEL_FINISHED_HEIGHTS[wheelSize] || parseInt(inchMatch[1]);
      wheels.push({
        name,
        heightIn: finishedHeight,
        qty,
        note: finishedHeight !== parseInt(inchMatch[1]) ? `${finishedHeight / 12}ft finished height` : '',
        hirehopId: item.ID || null,
      });
    }
  }
  return wheels;
}

function parseHandrails(rawItems: RawItem[]): any[] {
  const handrails: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (!name.match(/handrail/i)) continue;
    let ftMatch = name.match(/(\d+)\s*ft/i);
    if (!ftMatch) ftMatch = name.match(/(\d+)'\s*/);
    if (ftMatch) {
      handrails.push({ name, lengthIn: parseInt(ftMatch[1]) * 12, qty, hirehopId: item.ID || null });
    }
  }
  return handrails;
}

function parseSteps(rawItems: RawItem[]): any[] {
  const steps: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (!name.match(/\bsteps?\b/i) && !name.match(/\btread\b/i)) continue;
    if (name.match(/switch|wheel|riser/i)) continue;
    let ftMatch = name.match(/(\d+)\s*ft/i);
    if (!ftMatch) ftMatch = name.match(/(\d+)'\s*/);
    if (ftMatch) {
      steps.push({ name, heightIn: parseInt(ftMatch[1]) * 12, qty, hirehopId: item.ID || null });
    }
  }
  return steps;
}

function parseSkirts(rawItems: RawItem[]): any[] {
  const skirts: any[] = [];
  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);
    if (!name.match(/\bSKIRT\b/i)) continue;

    let heightIn: number | null = null;
    const ftInMatch = name.match(/(\d+)ft\s+(\d+)["″]\s*drop/i);
    if (ftInMatch) {
      heightIn = parseInt(ftInMatch[1]) * 12 + parseInt(ftInMatch[2]);
    } else {
      const ftMatch = name.match(/(\d+)ft\s+drop/i);
      if (ftMatch) heightIn = parseInt(ftMatch[1]) * 12;
    }
    if (heightIn === null) continue;

    const lenMatch = name.match(/(\d+)ft\s+length/i);
    if (!lenMatch) continue;
    const lengthIn = parseInt(lenMatch[1]) * 12;

    skirts.push({ name, heightIn, lengthIn, qty, hirehopId: item.ID || null });
  }
  skirts.sort((a, b) => a.heightIn - b.heightIn || b.lengthIn - a.lengthIn);
  return skirts;
}
