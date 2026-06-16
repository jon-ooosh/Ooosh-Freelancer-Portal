/**
 * OOOSH Staging Calculator
 * 
 * Calculates staging/deck requirements from desired dimensions.
 * Handles unit conversion, deck tiling, leg/combiner assignment,
 * and parts list generation.
 * 
 * v2.0 - Live HireHop stock (no hardcoded data), orientation
 *         optimization, unit toggle pill, ft/in split fields
 * v2.5 - Fix: action/push buttons moved to static HTML containers so
 *         accessories re-renders can never wipe them.
 *       - Fix: availability is cached per date range; no redundant
 *         API calls when re-calculating with the same dates.
 */

// ============================================================================
// STOCK — populated from HireHop API on page load (no hardcoded data)
// ============================================================================

let STOCK = null;          // Set by fetchStock()
let LEG_HEIGHTS = [];      // Rebuilt after stock loads
let AVAILABILITY = null;   // Set by fetchAvailability() — date-specific availability data
let stageRotated = false;  // Whether the 2D/3D layout is shown rotated 90° (swaps length and width axes)
let wantsGafferTape = false; // D — whether the optional white gaffer tape roll has been selected

// ── Availability caching ──
// Tracks the last date range we fetched availability for.
// If the user clicks Calculate again with the same dates, we reuse AVAILABILITY
// instead of hitting the HireHop API again (prevents rate-limit issues).
let lastAvailabilityFetch = null;  // { startDate, endDate } or null

// Combiner height offset in inches (physical constant — the combiner plate is 6" tall)
const COMBINER_HEIGHT_OFFSET = 6;


// ============================================================================
// UNIT CONVERSION HELPERS
// ============================================================================

/** Convert meters to inches */
function metersToInches(m) {
  return m * 39.3701;
}

/** Convert feet to inches */
function feetToInches(ft) {
  return ft * 12;
}

/** Convert inches to feet and inches string, e.g. "2' 6\"" */
function inchesToFeetStr(inches) {
  let ft = Math.floor(inches / 12);
  let remainIn = Math.round(inches % 12);
  // Handle rounding up: if remainIn rounds to 12, carry to next foot
  if (remainIn >= 12) {
    ft += 1;
    remainIn = 0;
  }
  if (remainIn === 0) return `${ft}'`;
  if (ft === 0) return `${remainIn}"`;
  return `${ft}' ${remainIn}"`;
}

/** Convert inches to a friendly metric string */
function inchesToMetricStr(inches) {
  const cm = inches * 2.54;
  if (cm >= 100) return `${(cm / 100).toFixed(2)}m`;
  return `${Math.round(cm)}cm`;
}

/** Format inches in both imperial and metric */
function formatDimension(inches) {
  return `${inchesToFeetStr(inches)} (${inchesToMetricStr(inches)})`;
}

/** Format inches for the currently selected unit (primary display) */
function formatDimensionForUnit(inches, unit) {
  if (unit === 'm') {
    return inchesToMetricStr(inches);
  }
  return inchesToFeetStr(inches);
}

/** Format inches with primary unit first and secondary in brackets */
function formatDimensionPrimary(inches, unit) {
  if (unit === 'm') {
    return `${inchesToMetricStr(inches)} (${inchesToFeetStr(inches)})`;
  }
  return `${inchesToFeetStr(inches)} (${inchesToMetricStr(inches)})`;
}


// ============================================================================
// TILING ALGORITHM
// Tiles a rectangular area with available deck sizes.
// Strategy: greedy fill — largest decks first, row by row.
// ============================================================================

/**
 * Tile a rectangular area (lengthIn x widthIn) with available deck sizes.
 * Returns an array of placed decks with positions, or null if impossible.
 * 
 * @param {number} targetLengthIn - Target length in inches
 * @param {number} targetWidthIn - Target width in inches
 * @param {boolean} inStockOnly - If true, only use decks with qty > 0
 * @returns {Array|null} Placed decks or null if impossible
 */
function tileRectangle(targetLengthIn, targetWidthIn, inStockOnly) {
  // Get available deck sizes
  const availableDecks = inStockOnly
    ? STOCK.decks.filter(d => d.lengthIn > 0 && d.qty > 0)
    : STOCK.decks.filter(d => d.lengthIn > 0);

  if (availableDecks.length === 0) return null;

  // Generate all possible orientations (each deck can be rotated 90°)
  const orientations = [];
  for (const deck of availableDecks) {
    orientations.push({ deck, l: deck.lengthIn, w: deck.widthIn });
    if (deck.lengthIn !== deck.widthIn) {
      orientations.push({ deck, l: deck.widthIn, w: deck.lengthIn });
    }
  }

  // Get unique row depths we can use, sorted largest first
  const possibleRowDepths = [...new Set(orientations.map(o => o.w))].sort((a, b) => b - a);

  // Try to fill the width with rows of these depths
  const rowCombos = findRowCombinations(targetWidthIn, possibleRowDepths);
  if (rowCombos.length === 0) return null;

  // Try each row combination and pick the one using fewest total decks
  let bestLayout = null;
  let bestDeckCount = Infinity;

  for (const rowDepths of rowCombos) {
    const layout = [];
    let currentY = 0;
    let valid = true;

    for (const rowDepth of rowDepths) {
      const fittingOrientations = orientations.filter(o => o.w === rowDepth);
      const rowDecks = fillRow(targetLengthIn, fittingOrientations);

      if (!rowDecks) {
        valid = false;
        break;
      }

      let currentX = 0;
      for (const placed of rowDecks) {
        layout.push({
          deck: placed.deck,
          x: currentX,
          y: currentY,
          orientedLength: placed.l,
          orientedWidth: placed.w,
        });
        currentX += placed.l;
      }
      currentY += rowDepth;
    }

    if (valid && layout.length < bestDeckCount) {
      bestLayout = layout;
      bestDeckCount = layout.length;
    }
  }

  return bestLayout;
}

/**
 * Find combinations of row depths that sum to the target width.
 * Returns array of arrays, e.g. [[48, 48, 24], [48, 24, 24, 24]]
 */
function findRowCombinations(targetWidth, depths) {
  const results = [];

  function recurse(remaining, combo, minDepth) {
    if (remaining === 0) {
      results.push([...combo]);
      return;
    }
    if (remaining < 0 || combo.length > 20) return;

    for (const d of depths) {
      if (d > remaining) continue;
      if (d < minDepth) continue;
      combo.push(d);
      recurse(remaining - d, combo, d);
      combo.pop();
    }
  }

  recurse(targetWidth, [], 0);
  return results;
}

/**
 * Fill a single row of given length using deck orientations of matching depth.
 * Greedy: largest decks first.
 */
function fillRow(targetLength, orientations) {
  const sorted = [...orientations].sort((a, b) => b.l - a.l);
  const result = [];
  let remaining = targetLength;

  for (const ori of sorted) {
    while (remaining >= ori.l) {
      result.push(ori);
      remaining -= ori.l;
    }
  }

  return remaining === 0 ? result : null;
}


// ============================================================================
// SNAP TO ACHIEVABLE DIMENSIONS
// ============================================================================

/**
 * Given a target dimension in inches, find the nearest achievable dimension
 * that can be built from our deck sizes. Returns sorted by proximity.
 */
function findNearestAchievable(targetIn, inStockOnly) {
  const decksToUse = inStockOnly
    ? STOCK.decks.filter(d => d.qty > 0)
    : STOCK.decks;

  const deckLengths = [...new Set(
    decksToUse.flatMap(d => [d.lengthIn, d.widthIn])
  )].filter(l => l > 0).sort((a, b) => a - b);

  if (deckLengths.length === 0) return [];

  const maxLen = Math.max(targetIn * 1.5, 240);
  const achievable = new Set();

  for (const l of deckLengths) {
    achievable.add(l);
  }

  let lastRound = [...achievable];
  for (let round = 0; round < 10; round++) {
    const newLengths = [];
    for (const existing of lastRound) {
      for (const l of deckLengths) {
        const sum = existing + l;
        if (sum <= maxLen && !achievable.has(sum)) {
          achievable.add(sum);
          newLengths.push(sum);
        }
      }
    }
    if (newLengths.length === 0) break;
    lastRound = newLengths;
  }

  return [...achievable].sort((a, b) =>
    Math.abs(a - targetIn) - Math.abs(b - targetIn)
  );
}


// ============================================================================
// JUNCTION MAPPING
// ============================================================================

/**
 * Map all junction points from a deck layout.
 * Returns array of { x, y, deckCount, type }
 */
function mapJunctions(layout) {
  const cornerMap = new Map();

  for (const placed of layout) {
    const corners = [
      [placed.x, placed.y],
      [placed.x + placed.orientedLength, placed.y],
      [placed.x, placed.y + placed.orientedWidth],
      [placed.x + placed.orientedLength, placed.y + placed.orientedWidth],
    ];

    for (const [cx, cy] of corners) {
      const key = `${cx},${cy}`;
      cornerMap.set(key, (cornerMap.get(key) || 0) + 1);
    }
  }

  const junctions = [];
  for (const [key, count] of cornerMap) {
    const [x, y] = key.split(',').map(Number);
    let type;
    if (count === 1) type = 'solo';
    else if (count === 2) type = 'edge';
    else type = 'interior';
    junctions.push({ x, y, deckCount: count, type });
  }

  return junctions;
}


// ============================================================================
// LEG & COMBINER ASSIGNMENT
// ============================================================================

/**
 * Assign legs and combiners to junctions.
 */
function assignHardware(junctions, finishedHeightIn, combinerMode) {
  const assignments = [];
  const legNeeds = {};
  const combinerNeeds = { twoInOne: 0, fourInOne: 0 };
  const warnings = [];

  const combinerLegHeight = finishedHeightIn - COMBINER_HEIGHT_OFFSET;

  for (const junc of junctions) {
    const assignment = { ...junc, hardware: [] };

    let useCombiner = false;
    let combinerType = null;

    if (combinerMode === 'all' && junc.type !== 'solo') {
      useCombiner = true;
      combinerType = junc.type === 'interior' ? 'fourInOne' : 'twoInOne';
    } else if (combinerMode === 'interior-only' && junc.type === 'interior') {
      useCombiner = true;
      combinerType = 'fourInOne';
    }

    if (useCombiner) {
      combinerNeeds[combinerType]++;
      assignment.hardware.push({
        item: combinerType === 'fourInOne' ? '4-in-1 combiner' : '2-in-1 combiner',
        type: 'combiner'
      });

      const legH = combinerLegHeight;
      if (legH <= 0) {
        warnings.push(`Combiner at (${junc.x}", ${junc.y}"): finished height ${finishedHeightIn}" is too low for a combiner (need > ${COMBINER_HEIGHT_OFFSET}")`);
      } else {
        legNeeds[legH] = (legNeeds[legH] || 0) + 1;
        assignment.hardware.push({ item: `${legH}" leg`, type: 'leg', heightIn: legH });
      }
    } else {
      const legCount = junc.deckCount;
      legNeeds[finishedHeightIn] = (legNeeds[finishedHeightIn] || 0) + legCount;
      for (let i = 0; i < legCount; i++) {
        assignment.hardware.push({ item: `${finishedHeightIn}" leg`, type: 'leg', heightIn: finishedHeightIn });
      }
    }

    assignments.push(assignment);
  }

  return { assignments, legNeeds, combinerNeeds, warnings };
}


// ============================================================================
// LEG MATCHING
// ============================================================================

/**
 * Match required leg heights to available stock.
 */
/**
 * Get the physical height of a screwjack in inches.
 * The netlify function should provide heightIn directly, but we also parse from the name
 * as a fallback (e.g. 'Screwjack - 19.5" / 50cm (48mm)').
 */
function getScrewjackHeightIn(sj) {
  if (sj.heightIn) return sj.heightIn;
  const match = (sj.name || '').match(/(\d+(?:\.\d+)?)"/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Pick the smallest screwjack whose useable range covers the required extension.
 * Useable maximum = 70% of physical height.
 * Returns the screwjack object from STOCK, or null if none are big enough.
 */
function selectScrewjack(extensionNeededIn) {
  if (!STOCK.screwjacks || STOCK.screwjacks.length === 0) return null;

  // Sort smallest first so we use the minimum size that works
  const sorted = [...STOCK.screwjacks].sort((a, b) => {
    return (getScrewjackHeightIn(a) || 0) - (getScrewjackHeightIn(b) || 0);
  });

  for (const sj of sorted) {
    const physicalHeight = getScrewjackHeightIn(sj);
    if (!physicalHeight) continue;
    const maxExtension = physicalHeight * 0.70;
    if (extensionNeededIn <= maxExtension) return sj;
  }

  return null; // No screwjack is tall enough
}

/**
 * Match required leg heights against available stock.
 *
 * For exact matches, uses a standard leg directly.
 *
 * When useScrewjacks=true, uses a RANGE-BASED approach:
 *   For each available (leg, screwjack) combo, the achievable height range is:
 *     min = leg.heightIn + SJ_BODY_HEIGHT            (screwjack at zero extension)
 *     max = leg.heightIn + SJ_BODY_HEIGHT + jack.physicalHeight * 0.70
 *   We pick the tallest leg whose range covers the target (minimises extension needed).
 *
 * When useScrewjacks=false, non-standard heights are flagged as needing manual action.
 */
function matchLegs(legNeeds, useScrewjacks = true) {
  const SJ_BODY_HEIGHT = 2; // inches — leg sits this far above ground on the screwjack body

  const matched = [];           // Standard legs (exact match)
  const screwjackCombos = [];   // { leg, jack, qtyNeeded, extensionIn } — leg + screwjack pairs
  const unavailable = [];       // Heights that cannot be achieved with available stock

  // Debug: log what legs we're working with so misconfigured stock is immediately visible
  console.log('matchLegs — available leg heights (heightIn):',
    STOCK.legs.map(l => `${l.heightIn}" (${l.name})`).join(', '));
  console.log('matchLegs — available screwjacks:',
    STOCK.screwjacks.map(sj => {
      const h = getScrewjackHeightIn(sj);
      return `${sj.name}: physical=${h}", max extension=${h ? (h * 0.70).toFixed(1) : '?'}"`;
    }).join('; ') || 'none');

  for (const [heightStr, qty] of Object.entries(legNeeds)) {
    const targetHeightIn = parseFloat(heightStr);
    const exactLeg = STOCK.legs.find(l => l.heightIn === targetHeightIn);

    if (exactLeg) {
      // Perfect match — standard leg, no screwjack needed
      matched.push({
        leg: exactLeg,
        qtyNeeded: qty,
        shortfall: Math.max(0, qty - exactLeg.qty),
      });
      continue;
    }

    if (!useScrewjacks) {
      unavailable.push({ heightIn: targetHeightIn, qty, reason: 'disabled' });
      continue;
    }

    // ── Range-based screwjack matching ──
    // For each (leg, jack) pair, check if [leg + 2", leg + 2" + jack.max] covers the target.
    // We sort legs tallest-first so we prefer the combination requiring least extension.
    const legsSorted = [...STOCK.legs].sort((a, b) => b.heightIn - a.heightIn);
    const jacksSorted = [...STOCK.screwjacks].sort((a, b) => {
      return (getScrewjackHeightIn(a) || 0) - (getScrewjackHeightIn(b) || 0);
    });

    let bestCombo = null;

    outerLoop:
    for (const leg of legsSorted) {
      const minAchievable = leg.heightIn + SJ_BODY_HEIGHT;
      if (minAchievable > targetHeightIn) continue; // leg too tall even at min winding

      for (const jack of jacksSorted) {
        const physH = getScrewjackHeightIn(jack);
        if (!physH) continue;
        const maxExtension = physH * 0.70;
        const maxAchievable = leg.heightIn + SJ_BODY_HEIGHT + maxExtension;

        if (targetHeightIn >= minAchievable && targetHeightIn <= maxAchievable) {
          const extensionIn = targetHeightIn - leg.heightIn - SJ_BODY_HEIGHT;
          bestCombo = { leg, jack, qtyNeeded: qty, extensionIn, targetHeightIn };
          break outerLoop; // tallest leg already (sorted desc), smallest jack that fits
        }
      }
    }

    if (bestCombo) {
      screwjackCombos.push(bestCombo);
      console.log(`matchLegs — screwjack combo for ${targetHeightIn}":`,
        `${bestCombo.leg.name} + ${bestCombo.jack.name}`,
        `(extension: ${bestCombo.extensionIn.toFixed(1)}")`);
    } else {
      console.warn(`matchLegs — NO combo found for ${targetHeightIn}". Legs tried:`,
        legsSorted.map(l => {
          const maxH = l.heightIn + SJ_BODY_HEIGHT + Math.max(...jacksSorted.map(j => (getScrewjackHeightIn(j) || 0) * 0.70), 0);
          return `${l.heightIn}" → range [${l.heightIn + SJ_BODY_HEIGHT}", ${maxH.toFixed(1)}"]`;
        }).join(', '));
      unavailable.push({ heightIn: targetHeightIn, qty, reason: 'screwjack' });
    }
  }

  return { matched, screwjackCombos, unavailable };
}


// ============================================================================
// NEAREST STOCK HEIGHT SUGGESTIONS
// ============================================================================

/**
 * Find alternative standard stage heights that would use in-stock legs.
 */
function findAlternativeHeights(requestedHeightIn, combinerMode, junctions) {
  const alternatives = [];
  const hasCombinerJunctions = junctions.some(j => j.type !== 'solo');

  for (const leg of STOCK.legs) {
    if (leg.qty === 0) continue;

    const directStageHeight = leg.heightIn;
    const combinerStageHeight = leg.heightIn + COMBINER_HEIGHT_OFFSET;

    if (combinerMode === 'none') {
      if (directStageHeight !== requestedHeightIn) {
        alternatives.push({
          stageHeightIn: directStageHeight,
          legHeightIn: leg.heightIn,
          legName: leg.name,
          legColour: leg.colour,
          direction: directStageHeight < requestedHeightIn ? 'lower' : 'higher',
          delta: Math.abs(directStageHeight - requestedHeightIn),
        });
      }
    } else {
      if (combinerStageHeight !== requestedHeightIn) {
        const soloLeg = STOCK.legs.find(l => l.heightIn === combinerStageHeight);
        const soloAvailable = soloLeg && soloLeg.qty > 0;

        alternatives.push({
          stageHeightIn: combinerStageHeight,
          legHeightIn: leg.heightIn,
          legName: leg.name,
          legColour: leg.colour,
          combinerLeg: true,
          soloLegAvailable: soloAvailable,
          soloLegName: soloLeg ? soloLeg.name : null,
          direction: combinerStageHeight < requestedHeightIn ? 'lower' : 'higher',
          delta: Math.abs(combinerStageHeight - requestedHeightIn),
        });
      }
    }
  }

  alternatives.sort((a, b) => a.delta - b.delta);

  const seen = new Set();
  const unique = [];
  for (const alt of alternatives) {
    if (!seen.has(alt.stageHeightIn)) {
      seen.add(alt.stageHeightIn);
      unique.push(alt);
    }
  }

  const lower = unique.filter(a => a.direction === 'lower').slice(0, 2);
  const higher = unique.filter(a => a.direction === 'higher').slice(0, 2);
  return [...lower, ...higher].sort((a, b) => a.stageHeightIn - b.stageHeightIn);
}


// ============================================================================
// COMPILE PARTS LIST
// ============================================================================

function compilePartsList(layout, hardware, legMatch) {
  const parts = [];

  // Decks
  const deckCounts = {};
  for (const placed of layout) {
    deckCounts[placed.deck.name] = (deckCounts[placed.deck.name] || 0) + 1;
  }
  for (const deck of STOCK.decks) {
    const needed = deckCounts[deck.name] || 0;
    if (needed > 0) {
      parts.push({
        category: 'Decks', name: deck.name,
        qtyNeeded: needed, qtyOwned: deck.qty,
        shortfall: Math.max(0, needed - deck.qty), note: '',
        hirehopId: deck.hirehopId || null,
      });
    }
  }

  // Combiners
  if (hardware.combinerNeeds.fourInOne > 0) {
    const c = STOCK.combiners.fourInOne;
    parts.push({
      category: 'Combiners', name: c.name,
      qtyNeeded: hardware.combinerNeeds.fourInOne, qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.fourInOne - c.qty), note: '',
      hirehopId: c.hirehopId || null,
    });
  }
  if (hardware.combinerNeeds.twoInOne > 0) {
    const c = STOCK.combiners.twoInOne;
    parts.push({
      category: 'Combiners', name: c.name,
      qtyNeeded: hardware.combinerNeeds.twoInOne, qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.twoInOne - c.qty), note: '',
      hirehopId: c.hirehopId || null,
    });
  }

  // Legs
  for (const m of legMatch.matched) {
    parts.push({
      category: 'Legs', name: m.leg.name,
      qtyNeeded: m.qtyNeeded, qtyOwned: m.leg.qty,
      shortfall: m.shortfall, note: m.leg.colour || '',
      hirehopId: m.leg.hirehopId || null,
    });
  }

  // Screwjack combo legs — each combo is a paired standard leg + screwjack
  for (const combo of legMatch.screwjackCombos) {
    // The standard leg used as the base
    parts.push({
      category: 'Legs',
      name: combo.leg.name,
      qtyNeeded: combo.qtyNeeded,
      qtyOwned: combo.leg.qty,
      shortfall: Math.max(0, combo.qtyNeeded - combo.leg.qty),
      note: `${combo.leg.colour || ''}${combo.leg.colour ? ' · ' : ''}with screwjack (${combo.extensionIn.toFixed(1)}" extension)`,
      hirehopId: combo.leg.hirehopId || null,
    });
    // The screwjack itself
    const jackQtyOwned = combo.jack.qty || 0;
    parts.push({
      category: 'Legs',
      name: combo.jack.name,
      qtyNeeded: combo.qtyNeeded,
      qtyOwned: jackQtyOwned,
      shortfall: Math.max(0, combo.qtyNeeded - jackQtyOwned),
      note: `paired with ${combo.leg.name}`,
      hirehopId: combo.jack.hirehopId || null,
    });
  }

  // Impossible/disabled heights — flag clearly, nothing to push to HireHop
  for (const u of legMatch.unavailable) {
    // If this height is (someOtherHeight - COMBINER_HEIGHT_OFFSET), it's a combiner leg,
    // not a standalone stage height. Show the context so it makes sense to the user.
    const finishedEquivalent = u.heightIn + COMBINER_HEIGHT_OFFSET;
    const isCombinerLeg = hardware.legNeeds[finishedEquivalent] !== undefined;

    const displayName = isCombinerLeg
      ? `${u.heightIn}" combiner leg (for ${finishedEquivalent}" finished stage)`
      : `${u.heightIn}" leg`;

    const noteText = u.reason === 'disabled'
      ? '⚠️ Non-standard height — tick "Use screwjacks" to attempt this'
      : '⚠️ No leg + screwjack combo can reach this height — sub-hire needed';

    parts.push({
      category: 'Legs',
      name: `${displayName} — needs screwjack`,
      qtyNeeded: u.qty,
      qtyOwned: 0,
      shortfall: u.qty,
      note: noteText,
      hirehopId: null,
    });
  }

  return parts;
}

// ============================================================================
// MAIN CALCULATION ENTRY POINT
// ============================================================================

/**
 * Run the full staging calculation for a single orientation.
 */
function calculate(params) {
  const { length, width, height, unit, combinerMode, inStockOnly, useScrewjacks = true } = params;

  const toInches = unit === 'm' ? metersToInches : feetToInches;
  const targetLengthIn = toInches(length);
  const targetWidthIn = toInches(width);
  const targetHeightIn = toInches(height);

  const achievableLengths = findNearestAchievable(targetLengthIn, false);
  const achievableWidths = findNearestAchievable(targetWidthIn, false);

  let bestLength = achievableLengths[0];
  let bestWidth = achievableWidths[0];

  const exactLength = achievableLengths.find(l => l === targetLengthIn);
  const exactWidth = achievableWidths.find(w => w === targetWidthIn);
  if (exactLength) bestLength = exactLength;
  if (exactWidth) bestWidth = exactWidth;

  const layout = tileRectangle(bestLength, bestWidth, inStockOnly || false);

  if (!layout) {
    return {
      success: false,
      error: 'Could not tile these dimensions with available deck sizes.',
      suggestions: {
        lengths: achievableLengths.slice(0, 5).map(l => ({ inches: l, display: formatDimensionPrimary(l, unit) })),
        widths: achievableWidths.slice(0, 5).map(w => ({ inches: w, display: formatDimensionPrimary(w, unit) })),
      },
    };
  }

  const standardHeightMatch = LEG_HEIGHTS.includes(targetHeightIn);
  const nearestLegHeight = LEG_HEIGHTS.reduce((best, h) =>
    Math.abs(h - targetHeightIn) < Math.abs(best - targetHeightIn) ? h : best
  , LEG_HEIGHTS[0]);

  // When screwjacks are enabled, pass the actual requested height through — matchLegs will
  // find the right leg+screwjack combo. Only snap to nearest standard leg when screwjacks
  // are OFF (legacy behaviour) or when the target already exactly matches a standard leg.
  const effectiveHeight = (standardHeightMatch || !useScrewjacks)
    ? (standardHeightMatch ? targetHeightIn : nearestLegHeight)
    : targetHeightIn;

  const junctions = mapJunctions(layout);
  const hardware = assignHardware(junctions, effectiveHeight, combinerMode);
  const legMatch = matchLegs(hardware.legNeeds, useScrewjacks);
  const partsList = compilePartsList(layout, hardware, legMatch);

  const totalDecks = layout.length;
  const hasShortfall = partsList.some(p => p.shortfall > 0);
  const dimensionMatch = (bestLength === targetLengthIn && bestWidth === targetWidthIn);

  // Height alternatives
  const hasNonStandardLegs = (legMatch.screwjackCombos.length > 0 || legMatch.unavailable.length > 0);
  const heightWasSnapped = !standardHeightMatch;
  let heightAlternatives = [];
  if (hasNonStandardLegs || heightWasSnapped) {
    heightAlternatives = findAlternativeHeights(effectiveHeight, combinerMode, junctions);
    heightAlternatives = heightAlternatives.filter(a => a.stageHeightIn !== effectiveHeight);
  }

  // Stock-constrained deck alternative (skip if already in stock-only mode)
  const hasDeckShortfall = partsList.some(p => p.category === 'Decks' && p.shortfall > 0);
  let stockAlternativeLayout = null;
  let stockAlternativeParts = null;

  if (hasDeckShortfall && !inStockOnly) {
    const altLayout = tileRectangle(bestLength, bestWidth, true);
    if (altLayout) {
      const altDeckCounts = {};
      for (const placed of altLayout) {
        altDeckCounts[placed.deck.name] = (altDeckCounts[placed.deck.name] || 0) + 1;
      }
      const primaryDeckCounts = {};
      for (const placed of layout) {
        primaryDeckCounts[placed.deck.name] = (primaryDeckCounts[placed.deck.name] || 0) + 1;
      }
      const isDifferent = JSON.stringify(altDeckCounts) !== JSON.stringify(primaryDeckCounts);

      if (isDifferent) {
        stockAlternativeLayout = altLayout;
        stockAlternativeParts = [];
        for (const deck of STOCK.decks) {
          const needed = altDeckCounts[deck.name] || 0;
          if (needed > 0) {
            stockAlternativeParts.push({
              name: deck.name, qtyNeeded: needed, qtyOwned: deck.qty,
              shortfall: Math.max(0, needed - deck.qty), noShortfall: needed <= deck.qty,
              hirehopId: deck.hirehopId || null,
            });
          }
        }
      }
    }

    // Try nearby dimensions with stock-only tiling
    if (!stockAlternativeLayout) {
      const stockLengths = findNearestAchievable(targetLengthIn, true);
      const stockWidths = findNearestAchievable(targetWidthIn, true);

      for (let li = 0; li < Math.min(3, stockLengths.length); li++) {
        for (let wi = 0; wi < Math.min(3, stockWidths.length); wi++) {
          const tryL = stockLengths[li];
          const tryW = stockWidths[wi];
          if (tryL === bestLength && tryW === bestWidth) continue;
          const tryLayout = tileRectangle(tryL, tryW, true);
          if (tryLayout) {
            const tryCounts = {};
            for (const placed of tryLayout) {
              tryCounts[placed.deck.name] = (tryCounts[placed.deck.name] || 0) + 1;
            }
            const tryHasShortfall = Object.entries(tryCounts).some(([name, needed]) => {
              const deck = STOCK.decks.find(d => d.name === name);
              return deck && needed > deck.qty;
            });

            if (!tryHasShortfall) {
              stockAlternativeLayout = tryLayout;
              stockAlternativeLayout._altDimensions = { lengthIn: tryL, widthIn: tryW };
              stockAlternativeParts = [];
              for (const deck of STOCK.decks) {
                const needed = tryCounts[deck.name] || 0;
                if (needed > 0) {
                  stockAlternativeParts.push({
                    name: deck.name, qtyNeeded: needed, qtyOwned: deck.qty,
                    shortfall: 0, noShortfall: true,
                    hirehopId: deck.hirehopId || null,
                  });
                }
              }
              break;
            }
          }
        }
        if (stockAlternativeLayout) break;
      }
    }
  }

  // Total parts count (for orientation comparison)
  const totalParts = partsList.reduce((sum, p) => sum + p.qtyNeeded, 0);
  const totalShortfall = partsList.reduce((sum, p) => sum + p.shortfall, 0);

  return {
    success: true,
    input: {
      requested: {
        length: { value: length, unit, inches: targetLengthIn, display: formatDimensionPrimary(targetLengthIn, unit) },
        width: { value: width, unit, inches: targetWidthIn, display: formatDimensionPrimary(targetWidthIn, unit) },
        height: { value: height, unit, inches: targetHeightIn, display: formatDimensionPrimary(targetHeightIn, unit) },
      },
      combinerMode,
      unit,
    },
    result: {
      actualLength: { inches: bestLength, display: formatDimensionPrimary(bestLength, unit) },
      actualWidth: { inches: bestWidth, display: formatDimensionPrimary(bestWidth, unit) },
      actualHeight: { inches: effectiveHeight, display: formatDimensionPrimary(effectiveHeight, unit) },
      dimensionMatch,
      heightMatch: standardHeightMatch,
      nearestLegHeight: !standardHeightMatch ? { inches: nearestLegHeight, display: formatDimensionPrimary(nearestLegHeight, unit) } : null,
    },
    layout,
    junctions: {
      total: junctions.length,
      solo: junctions.filter(j => j.type === 'solo').length,
      edge: junctions.filter(j => j.type === 'edge').length,
      interior: junctions.filter(j => j.type === 'interior').length,
      all: junctions,
    },
    hardware,
    legMatch,
    partsList,
    heightAlternatives,
    stockAlternativeLayout,
    stockAlternativeParts,
    summary: {
      totalDecks,
      totalParts,
      totalShortfall,
      hasShortfall,
      inStockOnly: inStockOnly || false,
      warnings: hardware.warnings,
      area: {
        sqFt: (bestLength * bestWidth) / 144,
        sqM: (bestLength * bestWidth) / 1550.0031,
      },
    },
  };
}


// ============================================================================
// ORIENTATION OPTIMISATION
// Try both L×W and W×L, pick the one with fewer total parts / less shortfall
// ============================================================================

/**
 * Run calculation in both orientations and return the better one.
 * "Better" = fewer shortfalls first, then fewer total parts.
 */
function calculateBestOrientation(params) {
  const { length, width, height, unit, combinerMode, inStockOnly, useScrewjacks } = params;

  // Orientation A: as entered
  const resultA = calculate({ length, width, height, unit, combinerMode, inStockOnly, useScrewjacks });

  // Orientation B: length and width swapped
  const resultB = calculate({ length: width, width: length, height, unit, combinerMode, inStockOnly, useScrewjacks });

  // If one fails and the other succeeds, use the successful one
  if (!resultA.success && !resultB.success) return resultA;
  if (!resultA.success) return resultB;
  if (!resultB.success) return resultA;

  // Both succeeded — pick the better one
  // Priority 1: fewer total shortfalls
  // Priority 2: fewer total parts (legs, combiners, decks)
  // Priority 3: fewer decks
  const scoreA = resultA.summary.totalShortfall * 1000 + resultA.summary.totalParts;
  const scoreB = resultB.summary.totalShortfall * 1000 + resultB.summary.totalParts;

  if (scoreA <= scoreB) {
    return resultA;
  } else {
    // Mark that we swapped orientation so we can tell the user
    resultB._orientationSwapped = true;
    return resultB;
  }
}


// ============================================================================
// STOCK FETCH — loads live data from HireHop via Netlify function
// ============================================================================

/**
 * Fetch staging stock from the Netlify function.
 * Returns true on success, false on failure.
 */
async function fetchStock() {
  try {
    const response = await fetch('/api/staging/stock', { headers: opAuthHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Unknown error');
    }

    // Set the global STOCK object
    STOCK = data.stock;

    // Ensure all expected arrays exist (backward compat with older stock endpoints)
    if (!STOCK.handrails) STOCK.handrails = [];
    if (!STOCK.steps) STOCK.steps = [];
    if (!STOCK.screwjacks) STOCK.screwjacks = [];
    if (!STOCK.wheels) STOCK.wheels = [];
    if (!STOCK.skirts) STOCK.skirts = [];   // C — skirting/scrim items

    // Rebuild LEG_HEIGHTS from live data
    LEG_HEIGHTS = STOCK.legs.map(l => l.heightIn).sort((a, b) => a - b);

    console.log('Stock loaded from HireHop:', {
      decks: STOCK.decks.length,
      legs: STOCK.legs.length,
      combiners: `${STOCK.combiners.twoInOne.qty} × 2-in-1, ${STOCK.combiners.fourInOne.qty} × 4-in-1`,
      handrails: STOCK.handrails.length,
      steps: STOCK.steps.length,
      screwjacks: STOCK.screwjacks.length,
      timestamp: data.timestamp,
    });

    // Log all legs with their heightIn values — critical for diagnosing screwjack combos
    console.log('Legs in stock:',
      STOCK.legs.map(l => `${l.heightIn}" — ${l.name} (qty: ${l.qty})`).join('\n  '));

    // Log screwjacks
    if (STOCK.screwjacks.length > 0) {
      console.log('Screwjacks:', STOCK.screwjacks.map(sj => `${sj.name} (qty: ${sj.qty})`).join(', '));
    } else {
      console.warn('⚠️ No screwjacks found in stock — check HireHop category 447');
    }

    // Log handrail and step details for debugging
    if (STOCK.handrails.length > 0) {
      console.log('Handrails:', STOCK.handrails.map(h => `${h.name} (${h.qty}×, ${h.lengthIn}")`));
    } else {
      console.warn('⚠️ No handrails found in stock — check HireHop category 448');
    }
    if (STOCK.steps.length > 0) {
      console.log('Steps:', STOCK.steps.map(s => `${s.name} (${s.qty}×, ${s.heightIn}" high)`));
    } else {
      console.warn('⚠️ No steps found in stock — check HireHop category 448');
    }

    return true;
  } catch (err) {
    console.error('Failed to load stock from HireHop:', err);
    return false;
  }
}


// ============================================================================
// AVAILABILITY FETCH — date-specific availability from HireHop API
// ============================================================================

/**
 * Fetch date-based availability for all staging items.
 * Calls the staging-availability Netlify function with item IDs and dates.
 * Updates the global AVAILABILITY object.
 * 
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate - ISO date string (YYYY-MM-DD)
 * @returns {boolean} true on success
 */
async function fetchAvailability(startDate, endDate) {
  try {
    // Collect all HireHop item IDs from STOCK
    const items = [];

    for (const deck of STOCK.decks) {
      if (deck.hirehopId) items.push({ id: deck.hirehopId });
    }
    for (const leg of STOCK.legs) {
      if (leg.hirehopId) items.push({ id: leg.hirehopId });
    }
    if (STOCK.combiners.twoInOne.hirehopId) {
      items.push({ id: STOCK.combiners.twoInOne.hirehopId });
    }
    if (STOCK.combiners.fourInOne.hirehopId) {
      items.push({ id: STOCK.combiners.fourInOne.hirehopId });
    }
    for (const sj of STOCK.screwjacks) {
      if (sj.hirehopId) items.push({ id: sj.hirehopId });
    }
    for (const w of STOCK.wheels) {
      if (w.hirehopId) items.push({ id: w.hirehopId });
    }
    for (const h of STOCK.handrails) {
      if (h.hirehopId) items.push({ id: h.hirehopId });
    }
    for (const s of STOCK.steps) {
      if (s.hirehopId) items.push({ id: s.hirehopId });
    }

    if (items.length === 0) {
      console.warn('No HireHop IDs found in stock — cannot check availability');
      return false;
    }

    console.log(`Fetching availability for ${items.length} items: ${startDate} to ${endDate}`);

    const response = await fetch('/api/staging/availability', {
      method: 'POST',
      headers: opAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items, startDate, endDate }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Unknown error');
    }

    // Store availability data globally
    AVAILABILITY = {
      data: data.availability,      // Map of hirehopId → { stock, available, global }
      startDate,
      endDate,
      timestamp: data.timestamp,
    };

    console.log('Availability loaded:', {
      items: Object.keys(data.availability).length,
      startDate,
      endDate,
    });

    return true;
  } catch (err) {
    console.error('Failed to fetch availability:', err);
    AVAILABILITY = null;
    return false;
  }
}

/**
 * Look up the available quantity for a specific HireHop item ID.
 * Returns null if no availability data loaded, otherwise the available count.
 */
function getAvailableQty(hirehopId) {
  if (!AVAILABILITY || !AVAILABILITY.data || !hirehopId) return null;
  const entry = AVAILABILITY.data[String(hirehopId)];
  return entry ? entry.available : null;
}

/**
 * Look up availability for a parts list entry.
 * Uses the hirehopId stored in the part to find the availability.
 */
function getAvailableQtyForPart(part) {
  if (!part.hirehopId) return null;
  return getAvailableQty(part.hirehopId);
}


// ============================================================================
// JOB DATE AUTO-PULL — fetch hire dates from HireHop job
// ============================================================================

/**
 * Fetch job details from HireHop and auto-populate date fields + client name.
 * Called when calculator is launched with ?job=XXXXX from Staff Hub,
 * or when user types a job number into the field.
 */
async function fetchJobDates(jobId) {
  const clientDisplay = document.getElementById('client-display');

  try {
    // Show loading state
    clientDisplay.textContent = 'Loading…';
    clientDisplay.classList.remove('loaded');
    console.log(`Fetching dates for job ${jobId}...`);

    const response = await fetch(`/api/staging/job?job=${jobId}`, { headers: opAuthHeaders() });

    if (!response.ok) {
      console.warn(`Job fetch returned ${response.status}`);
      clientDisplay.textContent = `Error (HTTP ${response.status})`;
      return;
    }

    const data = await response.json();
    if (!data.success || !data.job) {
      console.warn('Job fetch failed:', data.error);
      clientDisplay.textContent = data.error || 'Job not found';
      return;
    }

    const { startDate, endDate, name } = data.job;

    // Populate date fields
    if (startDate) {
      document.getElementById('avail-start').value = startDate;
    }
    if (endDate) {
      document.getElementById('avail-end').value = endDate;
    }

    // Changing dates invalidates the availability cache
    lastAvailabilityFetch = null;
    AVAILABILITY = null;

    // Populate client display
    clientDisplay.classList.add('loaded');
    clientDisplay.innerHTML = name
      ? `${name}`
      : `Job ${jobId}`;

    // Update the dates label to show job reference
    const dateLabel = document.querySelector('.date-group label');
    if (dateLabel && (startDate || endDate)) {
      dateLabel.innerHTML = `Dates <span style="font-weight:400; color:#3b82f6">(from Job ${jobId})</span>`;
    }

    console.log(`Job ${jobId} loaded:`, { startDate, endDate, name });
  } catch (err) {
    console.warn('Could not fetch job dates:', err);
    clientDisplay.textContent = 'Could not load job';
    // Non-fatal — dates just won't be auto-populated
  }
}


// ============================================================================
// UI LOGIC
// ============================================================================

let currentResult = null;
let currentUnit = 'm';

function getCurrentUnit() {
  return currentUnit;
}

// ── OP integration ──────────────────────────────────────────────────────
// This calculator is served by OP (staff.oooshtours.co.uk/staging-calculator.html)
// and embedded in an iframe on Job Detail. It's same-origin, so it reuses the
// staff JWT the OP app persists to localStorage, and calls /api/staging/*.
function getOpToken() {
  return localStorage.getItem('ooosh_access_token');
}
function opAuthHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = getOpToken();
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}
// Tell the parent OP window when a push completes, so it can reveal the Staging tab.
function notifyParentStagingComplete(planId, shareLink) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'staging-complete', planId, shareLink }, window.location.origin);
    }
  } catch (e) { /* ignore */ }
}

/** Initialize the page */
document.addEventListener('DOMContentLoaded', async () => {
  // OP session check — embedded same-origin, reuses the staff JWT.
  if (!getOpToken()) {
    document.body.innerHTML = '<p style="padding:2rem;font-family:system-ui,sans-serif;color:#374151">Please sign in to OP, then reopen the Staging Calculator.</p>';
    return;
  }

  // Show loading state while fetching stock
  showLoading();

  // Fetch live stock from HireHop
  const stockLoaded = await fetchStock();

  if (!stockLoaded) {
    showStockError();
    return;
  }

  // Stock loaded — enable the form
  hideLoading();

  // Set up event listeners
  document.getElementById('calc-form').addEventListener('submit', handleCalculate);
  const pillBtns = document.querySelectorAll('.unit-btn');
  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => handleUnitToggle(btn.dataset.unit));
  });

  // Set default values (metric)
  currentUnit = 'm';
  document.getElementById('stage-length-m').value = '';
  document.getElementById('stage-width-m').value = '';
  document.getElementById('stage-height-m').value = '';
  syncFieldVisibility();

  // Auto-pull job dates if job ID is in URL (from Staff Hub)
  const urlParams = new URLSearchParams(window.location.search);
  const jobId = urlParams.get('job');
  if (jobId) {
    document.getElementById('job-number').value = jobId;
    fetchJobDates(jobId);
  }

  // Listen for manual job number entry (fetch on blur or Enter)
  const jobInput = document.getElementById('job-number');
  jobInput.addEventListener('blur', () => {
    const val = jobInput.value.trim();
    if (val && /^\d+$/.test(val)) fetchJobDates(val);
  });
  jobInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = jobInput.value.trim();
      if (val && /^\d+$/.test(val)) fetchJobDates(val);
    }
  });
});


// ============================================================================
// LOADING & ERROR STATES
// ============================================================================

/** Clear the persistent action/push containers (called on loading/error states) */
function clearPersistentContainers() {
  const actionContainer = document.getElementById('action-buttons-container');
  if (actionContainer) actionContainer.innerHTML = '';
  const pushContainer = document.getElementById('push-section-container');
  if (pushContainer) pushContainer.innerHTML = '';
}

function showLoading() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = true;
  btn.textContent = 'Loading stock…';

  // Show loading banner
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="loading-banner">
    <div class="loading-spinner"></div>
    <span>Loading stock from HireHop…</span>
  </div>`;

  // Clear action/push buttons while loading
  clearPersistentContainers();
}

function hideLoading() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = false;
  btn.textContent = 'Calculate';

  const resultsEl = document.getElementById('results');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
}

function showStockError() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = true;
  btn.textContent = 'Stock unavailable';

  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="error-banner">
    <strong>Could not load stock from HireHop</strong>
    <p>The staging calculator needs live stock data. Please check your internet connection and try refreshing the page.</p>
    <button class="chip" onclick="location.reload()" style="margin-top:10px">Refresh page</button>
  </div>`;

  // Clear action/push buttons on error
  clearPersistentContainers();
}


// ============================================================================
// UNIT TOGGLE & AUTO-CONVERSION
// ============================================================================

function handleUnitToggle(newUnit) {
  if (newUnit === currentUnit) return;

  const oldUnit = currentUnit;
  const lengthIn = readDimensionInches('length', oldUnit);
  const widthIn = readDimensionInches('width', oldUnit);
  const heightIn = readDimensionInches('height', oldUnit);

  currentUnit = newUnit;
  document.querySelectorAll('.unit-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === newUnit);
  });
  syncFieldVisibility();

  if (lengthIn > 0) writeDimensionFromInches('length', lengthIn, newUnit);
  if (widthIn > 0) writeDimensionFromInches('width', widthIn, newUnit);
  if (heightIn > 0) writeDimensionFromInches('height', heightIn, newUnit);
}

function readDimensionInches(dim, unit) {
  if (unit === 'm') {
    const val = parseFloat(document.getElementById(`stage-${dim}-m`).value);
    return isNaN(val) ? 0 : metersToInches(val);
  } else {
    const ft = parseFloat(document.getElementById(`stage-${dim}-ft`).value) || 0;
    const inches = parseFloat(document.getElementById(`stage-${dim}-in`).value) || 0;
    return (ft * 12) + inches;
  }
}

function writeDimensionFromInches(dim, inches, unit) {
  if (unit === 'm') {
    const meters = inches * 0.0254;
    // Smart rounding: snap to nearest 5cm when within 1.5cm
    const rounded5cm = Math.round(meters * 20) / 20;
    const useSnapped = Math.abs(meters - rounded5cm) < 0.015;
    const display = useSnapped ? rounded5cm.toFixed(2) : meters.toFixed(2);
    document.getElementById(`stage-${dim}-m`).value = display;
  } else {
    let ft = Math.floor(inches / 12);
    let remainIn = Math.round(inches % 12);
    if (remainIn >= 12) {
      ft += 1;
      remainIn = 0;
    }
    document.getElementById(`stage-${dim}-ft`).value = ft || '';
    document.getElementById(`stage-${dim}-in`).value = remainIn || '';
  }
}

function syncFieldVisibility() {
  const isMetric = currentUnit === 'm';
  const dims = ['length', 'width', 'height'];

  for (const dim of dims) {
    const metricEl = document.getElementById(`${dim}-metric`);
    const imperialEl = document.getElementById(`${dim}-imperial`);

    if (isMetric) {
      metricEl.classList.remove('hidden');
      imperialEl.classList.add('hidden');
      document.getElementById(`stage-${dim}-m`).required = true;
      document.getElementById(`stage-${dim}-ft`).required = false;
    } else {
      metricEl.classList.add('hidden');
      imperialEl.classList.remove('hidden');
      document.getElementById(`stage-${dim}-m`).required = false;
      document.getElementById(`stage-${dim}-ft`).required = true;
    }
  }
}


// ============================================================================
// FORM SUBMISSION & CALCULATION
// ============================================================================

async function handleCalculate(e) {
  e.preventDefault();

  if (!STOCK) {
    showError('Stock data not loaded. Please refresh the page.');
    return;
  }

  const unit = getCurrentUnit();
  let length, width, height;

  if (unit === 'm') {
    length = parseFloat(document.getElementById('stage-length-m').value);
    width = parseFloat(document.getElementById('stage-width-m').value);
    height = parseFloat(document.getElementById('stage-height-m').value);
  } else {
    const lFt = parseFloat(document.getElementById('stage-length-ft').value) || 0;
    const lIn = parseFloat(document.getElementById('stage-length-in').value) || 0;
    length = lFt + (lIn / 12);

    const wFt = parseFloat(document.getElementById('stage-width-ft').value) || 0;
    const wIn = parseFloat(document.getElementById('stage-width-in').value) || 0;
    width = wFt + (wIn / 12);

    const hFt = parseFloat(document.getElementById('stage-height-ft').value) || 0;
    const hIn = parseFloat(document.getElementById('stage-height-in').value) || 0;
    height = hFt + (hIn / 12);
  }

  const combinerMode = document.getElementById('combiner-mode').value;
  const useScrewjacks = document.getElementById('use-screwjacks')?.checked ?? true;

  if (isNaN(length) || isNaN(width) || isNaN(height) || length <= 0 || width <= 0 || height <= 0) {
    showError('Please enter valid positive numbers for all dimensions.');
    return;
  }

  // Reset accessory selections on new calculation
  accessorySelections = {
    front: { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
    back:  { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
    left:  { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
    right: { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
  };
  wantsGafferTape = false;  // D — reset gaffer tape on new calculation

  // Use orientation-optimised calculation
  stageRotated = false;  // Reset rotation on each new calculation
  currentResult = calculateBestOrientation({ length, width, height, unit, combinerMode, useScrewjacks });

  if (currentResult.success) {
    const startDate = document.getElementById('avail-start').value;
    const endDate = document.getElementById('avail-end').value;
    const normalizedEnd = endDate || startDate;

    if (startDate) {
      // ── Availability caching ──
      // Only hit the HireHop API if the dates have changed since the last fetch.
      // This prevents redundant calls (and rate-limit issues) when the user clicks
      // Calculate multiple times with the same date range.
      const cachedDatesMatch = lastAvailabilityFetch &&
        lastAvailabilityFetch.startDate === startDate &&
        lastAvailabilityFetch.endDate === normalizedEnd &&
        AVAILABILITY !== null;

      if (cachedDatesMatch) {
        console.log(`Availability cache hit for ${startDate} → ${normalizedEnd} — skipping API call`);
      } else {
        // Show a brief loading indicator while fetching
        const resultsEl = document.getElementById('results');
        resultsEl.classList.remove('hidden');
        resultsEl.innerHTML = `<div class="loading-banner">
          <div class="loading-spinner"></div>
          <span>Checking availability for ${startDate}${endDate ? ' → ' + endDate : ''}…</span>
        </div>`;

        const availLoaded = await fetchAvailability(startDate, normalizedEnd);
        if (availLoaded) {
          // Record what we fetched so we can skip next time if dates are the same
          lastAvailabilityFetch = { startDate, endDate: normalizedEnd };
        } else {
          // Availability failed — render without it but show stock totals
          AVAILABILITY = null;
          lastAvailabilityFetch = null;
          console.warn('Availability check failed — showing stock totals only');
        }
      }
    } else {
      // No dates entered — clear any cached availability so stale data isn't shown
      AVAILABILITY = null;
      lastAvailabilityFetch = null;
    }

    renderResults(currentResult);
  } else {
    renderError(currentResult);
  }
}

function showError(msg) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="error-banner">${msg}</div>`;
}

function renderError(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');

  let html = `<div class="error-banner">
    <strong>Can't build these exact dimensions.</strong>
    <p>${result.error}</p>
  </div>`;

  if (result.suggestions) {
    html += `<div class="suggestions-card">
      <h3>Nearest achievable lengths:</h3>
      <div class="suggestion-chips">
        ${result.suggestions.lengths.map(l =>
          `<button class="chip" onclick="applySuggestion('length', ${l.inches})">${l.display}</button>`
        ).join('')}
      </div>
      <h3>Nearest achievable widths:</h3>
      <div class="suggestion-chips">
        ${result.suggestions.widths.map(w =>
          `<button class="chip" onclick="applySuggestion('width', ${w.inches})">${w.display}</button>`
        ).join('')}
      </div>
    </div>`;
  }

  resultsEl.innerHTML = html;

  // Clear action/push buttons on error state
  clearPersistentContainers();
}

function applySuggestion(dim, inches) {
  writeDimensionFromInches(dim, inches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

function applyHeightSuggestion(heightInches) {
  writeDimensionFromInches('height', heightInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

function applyDimensionSuggestion(lengthInches, widthInches) {
  writeDimensionFromInches('length', lengthInches, getCurrentUnit());
  writeDimensionFromInches('width', widthInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

/**
 * Recalculate using only in-stock decks.
 * Called when user clicks "Use this layout" on the stock alternative card.
 */
async function recalculateStockOnly() {
  if (!STOCK) return;

  const unit = getCurrentUnit();
  let length, width, height;

  if (unit === 'm') {
    length = parseFloat(document.getElementById('stage-length-m').value);
    width = parseFloat(document.getElementById('stage-width-m').value);
    height = parseFloat(document.getElementById('stage-height-m').value);
  } else {
    const lFt = parseFloat(document.getElementById('stage-length-ft').value) || 0;
    const lIn = parseFloat(document.getElementById('stage-length-in').value) || 0;
    length = lFt + (lIn / 12);

    const wFt = parseFloat(document.getElementById('stage-width-ft').value) || 0;
    const wIn = parseFloat(document.getElementById('stage-width-in').value) || 0;
    width = wFt + (wIn / 12);

    const hFt = parseFloat(document.getElementById('stage-height-ft').value) || 0;
    const hIn = parseFloat(document.getElementById('stage-height-in').value) || 0;
    height = hFt + (hIn / 12);
  }

  const combinerMode = document.getElementById('combiner-mode').value;
  const useScrewjacks = document.getElementById('use-screwjacks')?.checked ?? true;

  currentResult = calculateBestOrientation({
    length, width, height, unit, combinerMode, useScrewjacks, inStockOnly: true,
  });

  if (currentResult.success) {
    // Re-use existing availability data if we have it (no need to re-fetch)
    const startDate = document.getElementById('avail-start').value;
    const endDate = document.getElementById('avail-end').value;
    if (startDate && !AVAILABILITY) {
      await fetchAvailability(startDate, endDate || startDate);
    }
    renderResults(currentResult);
  } else {
    renderError(currentResult);
  }
}

/**
 * Switch back to showing all stock (not just in-stock).
 */
function recalculateAllStock() {
  handleCalculate(new Event('submit'));
}


// ============================================================================
// 3D CLIENT VIEW — generate shareable link
// ============================================================================

/**
 * Build the URL for the 3D stage viewer with current layout data.
 * Uses pako compression + base64url encoding for shorter URLs.
 * Falls back to legacy ?config= format if pako isn't available.
 */
// Build the compact config object the 3D viewer renders. Split out from
// build3DViewUrl so pushToJob can send it to OP (which stores it and mints a
// short share link) rather than baking the whole thing into a huge URL.
function build3DConfig() {
  if (!currentResult || !currentResult.success) return null;

  const r = currentResult;
  const unit = r.input.unit;

  return {
    // Dimensions in inches (internal unit)
    l: r.result.actualLength.inches,
    w: r.result.actualWidth.inches,
    h: r.result.actualHeight.inches,
    // Layout: array of [x, y, deckLengthIn, deckWidthIn]
    d: r.layout.map(p => [p.x, p.y, p.orientedLength, p.orientedWidth]),
    // Junction points for legs: [x, y, type]
    j: r.junctions.all.map(j => [j.x, j.y, j.type]),
    // Combiner mode
    cm: r.input.combinerMode,
    // Display unit
    u: unit,
    // Accessories: which edges have handrails/steps/skirt
    acc: accessorySelections,
    // Whether the stage view is rotated 90° (swaps length/width axes in 3D scene)
    rot: stageRotated,
    // D — whether white gaffer tape was selected (no 3D render, just for record)
    tape: wantsGafferTape,
  };
}

function build3DViewUrl() {
  const config = build3DConfig();
  if (!config) return null;

  // Compress config using pako deflate + base64url encoding for shorter URLs
  if (typeof pako !== 'undefined') {
    try {
      const json = JSON.stringify(config);
      const compressed = pako.deflate(json);
      // Convert Uint8Array to base64url (URL-safe base64 with no padding)
      let binary = '';
      for (let i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed[i]);
      }
      const base64 = btoa(binary)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${window.location.origin}/stage-view.html?c=${base64}`;
    } catch (e) {
      console.warn('Pako compression failed, using legacy URL format:', e);
    }
  }

  // Fallback: legacy uncompressed format
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `${window.location.origin}/stage-view.html?config=${encoded}`;
}

/**
 * Toggle the stage layout rotation 90°.
 * Swaps the SVG axes (length↔width) and remaps accessory edge selections
 * so that handrail/step assignments follow the visual rotation.
 *
 * Rotation is 90° clockwise — the right edge becomes the new audience-facing front.
 * Rotating again reverses (CCW) back to normal.
 * The actual parts calculation is completely unchanged.
 */
function rotateStageLayout() {
  stageRotated = !stageRotated;

  // Remap accessory selections to follow the rotation.
  // 90° CW: old_right → new_front, old_front → new_left, old_left → new_back, old_back → new_right
  // 90° CCW (toggle back): old_left → new_front, old_back → new_left, old_right → new_back, old_front → new_right
  const old = {
    front: { ...accessorySelections.front },
    back:  { ...accessorySelections.back },
    left:  { ...accessorySelections.left },
    right: { ...accessorySelections.right },
  };

  if (stageRotated) {
    // Going to rotated state (CW): right side becomes new audience front
    accessorySelections.front = old.right;
    accessorySelections.left  = old.front;
    accessorySelections.back  = old.left;
    accessorySelections.right = old.back;
  } else {
    // Going back to normal state (CCW): invert the CW remap
    accessorySelections.front = old.left;
    accessorySelections.back  = old.right;
    accessorySelections.left  = old.back;
    accessorySelections.right = old.front;
  }

  if (!currentResult || !currentResult.success) return;
  const r = currentResult.result;
  const unit = currentResult.input.unit;

  // ── 1. Update the 2D deck layout SVG ──
  const layoutContainer = document.querySelector('.layout-visual-container');
  if (layoutContainer) {
    layoutContainer.innerHTML = renderLayoutVisual(
      currentResult.layout,
      r.actualLength.inches,
      r.actualWidth.inches,
      unit,
      stageRotated
    );
  }

  // ── 2. Update the accessories card (edge labels + parts list) ──
  const accContainer = document.getElementById('accessories-container');
  if (accContainer) {
    accContainer.innerHTML = renderAccessoriesSection(currentResult);
  }

  // ── 3. Rebuild the action/push buttons so the 3D URL captures the new rotation ──
  const actionContainer = document.getElementById('action-buttons-container');
  if (actionContainer) actionContainer.innerHTML = renderActionButtons();
  const pushContainer = document.getElementById('push-section-container');
  if (pushContainer) pushContainer.innerHTML = renderPushButton();
}

/**
 * Open the 3D view in a new tab.
 */
function open3DView() {
  const url = build3DViewUrl();
  if (url) {
    window.open(url, '_blank');
  }
}

/**
 * Copy the 3D view link to clipboard.
 */
async function copy3DLink() {
  const url = build3DViewUrl();
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
    // Brief visual feedback
    const btn = event.target;
    const origText = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = origText; }, 2000);
  } catch (err) {
    // Fallback for older browsers
    prompt('Copy this link:', url);
  }
}


// ============================================================================
// RENDER RESULTS
// ============================================================================

function renderResults(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  const unit = result.input.unit;

  let html = '';

  // Orientation swap notice
  if (result._orientationSwapped) {
    html += `<div class="info-banner">
      <strong>💡 Orientation optimised</strong> — swapped length and width to reduce parts count.
    </div>`;
  }

  // Dimension summary
  html += `<div class="result-card summary-card">
    <h2>Stage Configuration</h2>
    <div class="dim-grid">
      <div class="dim-item">
        <span class="dim-label">Length</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualLength.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualLength.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${!result.result.dimensionMatch && result.result.actualLength.inches !== result.input.requested.length.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.length.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Width</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualWidth.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualWidth.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${!result.result.dimensionMatch && result.result.actualWidth.inches !== result.input.requested.width.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.width.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Height</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualHeight.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualHeight.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${result.result.nearestLegHeight
          ? `<span class="dim-adjusted">Snapped from ${result.input.requested.height.display} (nearest standard leg)</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Area</span>
        <span class="dim-value">${unit === 'm'
          ? `${result.summary.area.sqM.toFixed(1)} sq m`
          : `${result.summary.area.sqFt.toFixed(1)} sq ft`}</span>
        <span class="dim-secondary">${unit === 'm'
          ? `${result.summary.area.sqFt.toFixed(1)} sq ft`
          : `${result.summary.area.sqM.toFixed(1)} sq m`}</span>
      </div>
    </div>
  </div>`;

  // Deck layout visual
  html += `<div class="result-card">
    <h2>Deck Layout <span class="badge">${result.summary.totalDecks} decks</span>
      <button onclick="rotateStageLayout()" title="Rotate stage view 90°" 
        style="margin-left:10px; padding:4px 10px; font-size:13px; font-weight:500; 
               background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; 
               cursor:pointer; color:#475569; vertical-align:middle;">⟳ Rotate</button>
    </h2>
    <div class="layout-visual-container">
      ${renderLayoutVisual(result.layout, result.result.actualLength.inches, result.result.actualWidth.inches, unit, stageRotated)}
    </div>`;

  // Stock-only mode banner OR stock-constrained alternative (both live inside the Deck Layout card)
  if (result.summary.inStockOnly) {
    // Currently viewing in-stock layout — show banner with toggle back
    html += `<div class="alt-section">
      <div class="info-banner stock-only-banner">
        <strong>📦 Showing in-stock layout only</strong> — using only decks you currently have available.
        <button class="chip" onclick="recalculateAllStock()" style="margin-left:10px">Show optimal layout</button>
      </div>
    </div>`;
  } else if (result.stockAlternativeParts) {
    // Optimal layout has shortfalls — show in-stock alternative with "Use this layout" button
    const altDims = result.stockAlternativeLayout._altDimensions;
    const altLabel = altDims
      ? `${formatDimensionForUnit(altDims.lengthIn, unit)} × ${formatDimensionForUnit(altDims.widthIn, unit)}`
      : 'same dimensions';

    html += `<div class="alt-section">
      <h3>🟢 In-stock alternative (${altLabel}, ${result.stockAlternativeLayout.length} decks)</h3>
      <div class="alt-deck-card">
        <h4>Uses only decks you currently ${AVAILABILITY ? 'have available' : 'own'}:</h4>
        <ul class="alt-deck-list">
          ${result.stockAlternativeParts.map(p => {
            const availQty = getAvailableQtyForPart(p);
            const displayQty = availQty !== null ? availQty : p.qtyOwned;
            const label = AVAILABILITY ? 'available' : 'in stock';
            const effectiveShortfall = availQty !== null ? Math.max(0, p.qtyNeeded - availQty) : p.shortfall;
            return `<li>${p.qtyNeeded}× ${p.name} (${displayQty} ${label}${effectiveShortfall > 0 ? `, still short ${effectiveShortfall}` : ''})</li>`;
          }).join('')}
        </ul>
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn btn-calculate" style="padding:8px 20px; font-size:14px" onclick="recalculateStockOnly()">
            ✅ Use this layout
          </button>
          ${altDims ? `<button class="chip" onclick="applyDimensionSuggestion(${altDims.lengthIn}, ${altDims.widthIn})">
            Recalculate at ${altLabel}
          </button>` : ''}
        </div>
      </div>
    </div>`;
  }

  html += `</div>`;

  // Parts list (BEFORE junction points)
  const hasAvailability = AVAILABILITY !== null;
  const availDates = hasAvailability
    ? `${AVAILABILITY.startDate}${AVAILABILITY.endDate && AVAILABILITY.endDate !== AVAILABILITY.startDate ? ' → ' + AVAILABILITY.endDate : ''}`
    : '';

  html += `<div class="result-card">
    <h2>Parts List${hasAvailability ? ` <span class="badge">📅 ${availDates}</span>` : ''}</h2>`;

  // Show availability info banner when dates are active
  if (hasAvailability) {
    html += `<div class="info-banner" style="margin-bottom:12px">
      <strong>📅 Showing date-based availability</strong> — "Available" column shows what's not booked on ${availDates}.
    </div>`;
  }

  html += `<table class="parts-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Needed</th>
          <th>${hasAvailability ? 'Owned' : 'In Stock'}</th>
          ${hasAvailability ? '<th>Available</th>' : ''}
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>`;

  let currentCategory = '';
  for (const part of result.partsList) {
    if (part.category !== currentCategory) {
      currentCategory = part.category;
      html += `<tr class="category-row"><td colspan="${hasAvailability ? 6 : 5}">${currentCategory}</td></tr>`;
    }

    // Look up date-based availability for this item
    const availQty = getAvailableQtyForPart(part);
    const effectiveQty = availQty !== null ? availQty : part.qtyOwned;
    const effectiveShortfall = Math.max(0, part.qtyNeeded - effectiveQty);

    const statusClass = effectiveShortfall > 0 ? 'status-short' :
      part.qtyNeeded <= effectiveQty * 0.8 ? 'status-ok' : 'status-tight';
    const statusText = effectiveShortfall > 0 ? `Short ${effectiveShortfall}` :
      part.qtyNeeded === effectiveQty ? 'Exact' : 'OK';
    const statusIcon = effectiveShortfall > 0 ? '🔴' : part.qtyNeeded >= effectiveQty ? '🟡' : '🟢';

    // Availability cell — show with colour coding
    let availCell = '';
    if (hasAvailability) {
      if (availQty !== null) {
        const availClass = availQty >= part.qtyNeeded ? 'ok' :
          availQty > 0 ? 'tight' : 'short';
        availCell = `<td class="num"><span class="avail-badge ${availClass}">${availQty}</span></td>`;
      } else {
        availCell = `<td class="num" style="color:#94a3b8">—</td>`;
      }
    }

    html += `<tr>
      <td>${part.name}</td>
      <td class="num">${part.qtyNeeded}</td>
      <td class="num">${part.qtyOwned}</td>
      ${availCell}
      <td class="${statusClass}">${statusIcon} ${statusText}</td>
      <td class="note">${part.note}</td>
    </tr>`;
  }

  html += `</tbody></table>`;

  // Height alternatives (still inside the parts list card)
  if (result.heightAlternatives && result.heightAlternatives.length > 0) {
    html += `<div class="alt-section">
      <h3>📏 Nearest standard heights from stock</h3>
      <p style="font-size:13px; color:#6b7280; margin-bottom:10px">
        ${(result.legMatch.screwjackCombos?.length > 0 || result.legMatch.unavailable?.length > 0)
          ? 'The required leg height isn\'t standard. Here are the closest achievable stage heights using legs you own:'
          : 'Your requested height was adjusted to the nearest standard leg. Other standard heights available:'}
      </p>
      <div class="alt-height-options">
        ${result.heightAlternatives.map(alt => {
          const label = formatDimensionForUnit(alt.stageHeightIn, unit);
          const secondary = formatDimensionForUnit(alt.stageHeightIn, unit === 'm' ? 'ft' : 'm');
          const arrow = alt.direction === 'lower' ? '↓' : '↑';
          const legInfo = alt.combinerLeg ? `${alt.legName} + combiner` : alt.legName;
          return `<button class="alt-height-chip" onclick="applyHeightSuggestion(${alt.stageHeightIn})">
            <span class="alt-chip-label">${arrow} ${label}</span>
            <span class="alt-chip-desc">${secondary} — ${legInfo}${alt.legColour ? ` (${alt.legColour})` : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  html += `</div>`;

  // Junction summary (AFTER parts list)
  html += `<div class="result-card">
    <h2>Junction Points <span class="badge">${result.junctions.total} total</span></h2>
    <div class="junction-summary">
      <div class="junction-type">
        <span class="junction-dot solo"></span>
        <span>${result.junctions.solo} solo corners</span>
        <span class="junction-desc">1 deck → 1 standard leg</span>
      </div>
      <div class="junction-type">
        <span class="junction-dot edge"></span>
        <span>${result.junctions.edge} edge junctions</span>
        <span class="junction-desc">2 decks meet${result.input.combinerMode !== 'none' ? ' → 2-in-1 combiner' : ' → 2 separate legs'}</span>
      </div>
      <div class="junction-type">
        <span class="junction-dot interior"></span>
        <span>${result.junctions.interior} interior junctions</span>
        <span class="junction-desc">4 decks meet${result.input.combinerMode !== 'none' ? ' → 4-in-1 combiner' : ' → 4 separate legs'}</span>
      </div>
    </div>
  </div>`;

  // Accessories edge selector — persistent container (innerHTML swapped on toggle)
  html += `<div id="accessories-container">${renderAccessoriesSection(result)}</div>`;

  // Warnings
  if (result.summary.warnings.length > 0) {
    html += `<div class="result-card warnings-card">
      <h2>⚠️ Warnings</h2>
      <ul>${result.summary.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
  }

  // Set the results HTML — this does NOT include action/push buttons
  resultsEl.innerHTML = html;

  // ── Update the persistent action/push containers ──
  // These live OUTSIDE the results div in the HTML, so they are never
  // wiped when resultsEl.innerHTML is replaced (on recalc or accessories toggle).
  const actionContainer = document.getElementById('action-buttons-container');
  if (actionContainer) actionContainer.innerHTML = renderActionButtons();
  const pushContainer = document.getElementById('push-section-container');
  if (pushContainer) pushContainer.innerHTML = renderPushButton();
}


// ============================================================================
// 2D LAYOUT VISUAL (SVG) — unit-aware labels
// ============================================================================

/**
 * Render the 2D deck layout as an SVG.
 * When rotated=true, the stage axes are swapped (length↔width) so the user
 * can view the stage with the wider/narrower dimension facing the audience.
 * The underlying calculation is unchanged — this is purely visual.
 */
function renderLayoutVisual(layout, totalLength, totalWidth, unit, rotated) {
  // When rotated, swap which axis is horizontal vs vertical in the SVG
  const svgTotalX = rotated ? totalWidth : totalLength;
  const svgTotalY = rotated ? totalLength : totalWidth;

  const maxViewWidth = 600;
  const maxViewHeight = 300;
  const padding = 30;

  const scaleX = (maxViewWidth - padding * 2) / svgTotalX;
  const scaleY = (maxViewHeight - padding * 2) / svgTotalY;
  const scale = Math.min(scaleX, scaleY);

  const svgWidth = svgTotalX * scale + padding * 2;
  const svgHeight = svgTotalY * scale + padding * 2;

  const deckColours = {
    96: { fill: '#dbeafe', stroke: '#3b82f6' },
    72: { fill: '#dcfce7', stroke: '#22c55e' },
    48: { fill: '#fef3c7', stroke: '#f59e0b' },
    24: { fill: '#fce7f3', stroke: '#ec4899' },
  };

  let svgContent = '';

  for (const placed of layout) {
    // When rotated, swap the x/y coordinates and length/width of each deck
    const px = rotated ? placed.y : placed.x;
    const py = rotated ? placed.x : placed.y;
    const pw = rotated ? placed.orientedWidth : placed.orientedLength;
    const ph = rotated ? placed.orientedLength : placed.orientedWidth;

    const x = px * scale + padding;
    const y = py * scale + padding;
    const w = pw * scale;
    const h = ph * scale;
    const colour = deckColours[placed.deck.lengthIn] || { fill: '#f3f4f6', stroke: '#6b7280' };

    svgContent += `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
      fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="2" rx="3" />`;

    if (w > 40 && h > 20) {
      const labelSize = Math.min(12, w / 6, h / 3);
      svgContent += `<text x="${x + w / 2}" y="${y + h / 2}" 
        text-anchor="middle" dominant-baseline="middle" 
        font-size="${labelSize}" fill="${colour.stroke}" font-weight="600"
        font-family="Inter, sans-serif">
        ${placed.deck.lengthIn / 12}'×${placed.deck.widthIn / 12}'
      </text>`;
    }
  }

  // Horizontal label (top) — always shows the dimension that runs left-right in the view
  const hLabel = formatDimensionForUnit(svgTotalX, unit);
  // Vertical label (left side) — the dimension that runs top-bottom
  const vLabel = formatDimensionForUnit(svgTotalY, unit);

  svgContent += `<text x="${svgWidth / 2}" y="${padding - 10}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif">← ${hLabel} →</text>`;

  svgContent += `<text x="${padding - 10}" y="${svgHeight / 2}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif"
    transform="rotate(-90, ${padding - 10}, ${svgHeight / 2})">← ${vLabel} →</text>`;

  // "Audience" label at the bottom — the front/audience edge is always at the bottom of the layout
  svgContent += `<text x="${svgWidth / 2}" y="${svgHeight - 2}"
    text-anchor="middle" font-size="12" fill="#94a3b8" font-weight="500"
    font-family="Inter, sans-serif">▼ Audience</text>`;

  return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" 
    style="max-width:${svgWidth}px" xmlns="http://www.w3.org/2000/svg">
    ${svgContent}
  </svg>`;
}


// ============================================================================
// ACCESSORIES — handrails and steps edge selection
// ============================================================================

/**
 * Current accessory selections, keyed by edge name.
 * Each edge has independent handrail and steps toggles.
 * Only one edge can have steps at a time.
 * 
 * "Front" and "Back" run along the stage LENGTH.
 * "Left" and "Right" run along the stage WIDTH.
 */
let accessorySelections = {
  front: { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
  back:  { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
  left:  { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
  right: { handrail: false, steps: false, stepPosition: 'middle', skirt: false },
};

/**
 * Calculate handrail sections needed to cover a given edge length.
 * Uses greedy fill: largest available handrail first (8ft, 4ft, 2ft).
 * 
 * @param {number} edgeLengthIn - Edge length in inches
 * @param {number} stepGapIn - Gap to leave for steps (0 if no steps on this edge)
 * @returns {Array} Array of { handrail, qty } objects
 */
function calculateHandrailSections(edgeLengthIn, stepGapIn) {
  if (!STOCK || !STOCK.handrails || STOCK.handrails.length === 0) return [];

  const effectiveLength = edgeLengthIn - stepGapIn;
  if (effectiveLength <= 0) return [];

  // Sort handrails by length descending (largest first for greedy fill)
  const sorted = [...STOCK.handrails]
    .filter(h => h.lengthIn > 0)
    .sort((a, b) => b.lengthIn - a.lengthIn);

  if (sorted.length === 0) return [];

  const result = [];
  let remaining = effectiveLength;

  for (const rail of sorted) {
    if (remaining <= 0) break;
    const qty = Math.floor(remaining / rail.lengthIn);
    if (qty > 0) {
      result.push({ handrail: rail, qty });
      remaining -= qty * rail.lengthIn;
    }
  }

  // If there's leftover (edge not perfectly divisible), add one more of smallest
  if (remaining > 0 && sorted.length > 0) {
    const smallest = sorted[sorted.length - 1];
    const existing = result.find(r => r.handrail.name === smallest.name);
    if (existing) {
      existing.qty += 1;
    } else {
      result.push({ handrail: smallest, qty: 1 });
    }
  }

  return result;
}

/**
 * Calculate the gap needed in a handrail run to accommodate steps.
 * Steps are ~90cm wide. We round UP to the nearest handrail section
 * length so the gap aligns with the modular handrail system.
 * 
 * @param {number} stageHeightIn - Stage height (to pick correct step)
 * @returns {number} Gap in inches (0 if no suitable step)
 */
function calculateStepGapIn(stageHeightIn) {
  const step = pickBestStep(stageHeightIn);
  if (!step) return 0;

  const stepWidthIn = getStepWidthIn(step);  // ~36" (90cm)

  // Find the smallest handrail section length that's >= step width
  if (!STOCK || !STOCK.handrails || STOCK.handrails.length === 0) return stepWidthIn;

  const railLengths = STOCK.handrails
    .map(h => h.lengthIn)
    .filter(l => l > 0)
    .sort((a, b) => a - b);

  // Find smallest rail section >= step width
  const fittingRail = railLengths.find(l => l >= stepWidthIn);
  if (fittingRail) return fittingRail;

  // If no single section is wide enough, use multiples of smallest
  const smallest = railLengths[0] || 24;
  return Math.ceil(stepWidthIn / smallest) * smallest;
}

/**
 * Pick the best step size for the current stage height.
 * A — Exact match only. Steps must be exactly the stage height.
 * If no exact match, returns null → shown as shortfall in the parts list.
 * (A 1ft step cannot safely serve a 2ft stage, and vice versa.)
 * 
 * @param {number} stageHeightIn - Stage height in inches
 * @returns {Object|null} Best matching step from STOCK, or null
 */
function pickBestStep(stageHeightIn) {
  if (!STOCK || !STOCK.steps || STOCK.steps.length === 0) return null;
  // A — Exact match only. Steps must be exactly the stage height.
  // If no exact match, returns null → shown as shortfall in the parts list.
  // (A 1ft step cannot safely serve a 2ft stage, and vice versa.)
  return STOCK.steps.find(s => s.heightIn === stageHeightIn) || null;
}

/**
 * Get the width of the step unit in inches (for handrail gap calculation).
 * Steps are approximately 36" (~90cm) wide.
 */
function getStepWidthIn(step) {
  return step && step.widthIn ? step.widthIn : 36;  // Default 36" if not specified
}

/**
 * B — Count shared edges between adjacent deck panels in the layout.
 * A shared edge = two decks that touch along a full side.
 * Each shared edge needs 2 × 70mm bolts.
 * 
 * Detection rules (matches the spec):
 *   Vertical (side-by-side in same row): same y, and A.x + A.length === B.x
 *   Horizontal (one row above the other): same x start, and A.y + A.width === B.y
 * 
 * Note: this is about deck frame joins only — completely independent of what
 * legs or combiners are underneath.
 * 
 * @param {Array} layout - result.layout array from calculate()
 * @returns {number} count of shared edges
 */
function countSharedDeckEdges(layout) {
  let count = 0;
  for (let i = 0; i < layout.length; i++) {
    for (let j = i + 1; j < layout.length; j++) {
      const a = layout[i];
      const b = layout[j];

      // Shared vertical edge: same row (y), and one deck's right side touches the other's left
      const sameRow = a.y === b.y;
      if (sameRow && (
        a.x + a.orientedLength === b.x ||
        b.x + b.orientedLength === a.x
      )) {
        count++;
        continue;
      }

      // Shared horizontal edge: same x start, and one deck's bottom touches the other's top
      const sameColStart = a.x === b.x;
      if (sameColStart && (
        a.y + a.orientedWidth === b.y ||
        b.y + b.orientedWidth === a.y
      )) {
        count++;
      }
    }
  }
  return count;
}

/**
 * C — Calculate skirting panels needed to cover a given edge length.
 * Uses greedy fill: longest pieces first. Always rounds UP (a bit of overhang is fine).
 * 
 * Only uses skirts whose drop height is within ±3" of stage height — this handles
 * minor rounding differences while still avoiding obviously wrong sizes.
 * 
 * @param {number} edgeLengthIn - Edge length to skirt, in inches
 * @param {number} stageHeightIn - Stage height in inches (for matching skirt drop)
 * @returns {Array} Array of { skirt, qty } objects
 */
function calculateSkirtSections(edgeLengthIn, stageHeightIn) {
  if (!STOCK || !STOCK.skirts || STOCK.skirts.length === 0) return [];

  // Find skirts with drop height within ±3" of stage height
  // Sort longest pieces first for greedy fill
  const valid = STOCK.skirts
    .filter(s => Math.abs(s.heightIn - stageHeightIn) <= 3 && s.lengthIn > 0)
    .sort((a, b) => b.lengthIn - a.lengthIn);

  if (valid.length === 0) return [];

  const result = [];
  let remaining = edgeLengthIn;

  // Greedy fill: use as many of each size as possible before moving to smaller
  for (const skirt of valid) {
    if (remaining <= 0) break;
    const qty = Math.floor(remaining / skirt.lengthIn);
    if (qty > 0) {
      result.push({ skirt, qty });
      remaining -= qty * skirt.lengthIn;
    }
  }

  // Round up: if any length remains, add one more of the smallest valid piece
  if (remaining > 0 && valid.length > 0) {
    const smallest = valid[valid.length - 1];
    const existing = result.find(r => r.skirt.name === smallest.name);
    if (existing) {
      existing.qty += 1;
    } else {
      result.push({ skirt: smallest, qty: 1 });
    }
  }

  return result;
}

/**
 * Calculate all accessory parts based on current edge selections.
 * Returns an array of parts list entries (same format as compilePartsList).
 * 
 * Implements:
 *   A — Steps: exact height match only (shortfall if no match)
 *   B — Bolts: 70mm for deck joins, 90mm for handrail attachment
 *   C — Skirting: per-edge skirt panels + velcro hook tape
 *   D — Gaffer tape: optional global checkbox
 * 
 * @param {Object} result - The current calculation result
 * @returns {Array} Accessory parts list entries
 */
function calculateAccessories(result) {
  if (!result || !result.success) return [];
  if (!STOCK) return [];

  // Ensure arrays exist (backward compat / safety)
  if (!STOCK.handrails) STOCK.handrails = [];
  if (!STOCK.steps) STOCK.steps = [];
  if (!STOCK.skirts) STOCK.skirts = [];

  const lengthIn = result.result.actualLength.inches;
  const widthIn = result.result.actualWidth.inches;
  const heightIn = result.result.actualHeight.inches;

  const parts = [];
  const handrailTotals = {};  // name → total qty across all edges
  const skirtTotals = {};     // name → total qty across all skirted edges

  // Determine edge lengths — when the layout is rotated, front/back run along the
  // *width* dimension and left/right run along the *length* dimension.
  const edgeLengths = stageRotated ? {
    front: widthIn,
    back:  widthIn,
    left:  lengthIn,
    right: lengthIn,
  } : {
    front: lengthIn,
    back:  lengthIn,
    left:  widthIn,
    right: widthIn,
  };

  const warnings = [];
  const stepEntries = {};   // aggregated by step name (or missing key) across edges

  // ── A. Steps — exact match only ──
  // pickBestStep() now returns null unless stage height exactly matches a step height.
  // When null: add a shortfall line item so it shows clearly in the parts list.
  for (const [edge, sel] of Object.entries(accessorySelections)) {
    if (!sel.steps) continue;

    const step = pickBestStep(heightIn);
    const edgeLen = edgeLengths[edge];

    if (step) {
      // Found an exact match — aggregate qty in case multiple edges have steps
      const stepWidth = getStepWidthIn(step);
      if (stepWidth > edgeLen) {
        warnings.push(`⚠️ Steps (${inchesToFeetStr(stepWidth)} wide) exceed the ${edge} edge (${inchesToFeetStr(edgeLen)}). Consider placing steps on a longer edge.`);
      }
      if (stepEntries[step.name]) {
        stepEntries[step.name].qtyNeeded += 1;
        stepEntries[step.name].note += `, ${edge} edge`;
      } else {
        stepEntries[step.name] = {
          category: 'Accessories',
          name: step.name,
          qtyNeeded: 1,
          qtyOwned: step.qty || 0,
          note: `${edge} edge`,
          hirehopId: step.hirehopId || null,
        };
      }
    } else {
      // A — No exact match: flag as shortfall so it's clearly visible
      warnings.push(`⚠️ No step in stock for ${inchesToFeetStr(heightIn)} stage height — sub-hire or check stock.`);
      const missingKey = `__missing_step_${heightIn}`;
      if (stepEntries[missingKey]) {
        stepEntries[missingKey].qtyNeeded += 1;
        stepEntries[missingKey].note += `, ${edge} edge`;
      } else {
        stepEntries[missingKey] = {
          category: 'Accessories',
          name: `${inchesToFeetStr(heightIn)} staging step`,
          qtyNeeded: 1,
          qtyOwned: 0,
          note: `${edge} edge — not in stock at this exact height`,
          hirehopId: null,
        };
      }
    }
  }

  // ── Handrails + count 90mm bolt qty at the same time ──
  let total90mmBolts = 0;

  for (const [edge, sel] of Object.entries(accessorySelections)) {
    if (!sel.handrail) continue;

    const edgeLen = edgeLengths[edge];
    const stepGap = sel.steps ? calculateStepGapIn(heightIn) : 0;
    const sections = calculateHandrailSections(edgeLen, stepGap);

    // B — 90mm bolt count: 2 bolts per section to attach to stage, 1 extra per internal join
    // Formula per edge: (numSections × 2) + (numSections - 1) = numSections × 3 - 1
    const numSections = sections.reduce((sum, s) => sum + s.qty, 0);
    if (numSections > 0) {
      total90mmBolts += numSections * 2 + (numSections - 1);
    }

    // Accumulate handrail totals across all edges
    for (const { handrail, qty } of sections) {
      handrailTotals[handrail.name] = (handrailTotals[handrail.name] || 0) + qty;
    }
  }

  // Convert handrail totals to parts list entries
  for (const rail of STOCK.handrails) {
    const needed = handrailTotals[rail.name] || 0;
    if (needed > 0) {
      parts.push({
        category: 'Accessories',
        name: rail.name,
        qtyNeeded: needed,
        qtyOwned: rail.qty || 0,
        shortfall: Math.max(0, needed - (rail.qty || 0)),
        note: '',
        hirehopId: rail.hirehopId || null,
      });
    }
  }

  // Add step entries (aggregated across all edges)
  for (const entry of Object.values(stepEntries)) {
    parts.push({
      ...entry,
      shortfall: Math.max(0, entry.qtyNeeded - (entry.qtyOwned || 0)),
    });
  }

  // ── C. Skirting ──
  let totalSkirtedLengthIn = 0;

  for (const [edge, sel] of Object.entries(accessorySelections)) {
    if (!sel.skirt) continue;

    const edgeLen = edgeLengths[edge];
    totalSkirtedLengthIn += edgeLen;

    const skirtSections = calculateSkirtSections(edgeLen, heightIn);

    if (skirtSections.length === 0) {
      warnings.push(`⚠️ No skirting in stock for ${inchesToFeetStr(heightIn)} stage height (${edge} edge) — sub-hire needed.`);
    }

    for (const { skirt, qty } of skirtSections) {
      skirtTotals[skirt.name] = (skirtTotals[skirt.name] || 0) + qty;
    }
  }

  // Add skirt parts
  if (STOCK.skirts) {
    for (const skirt of STOCK.skirts) {
      const needed = skirtTotals[skirt.name] || 0;
      if (needed > 0) {
        parts.push({
          category: 'Skirting',
          name: skirt.name,
          qtyNeeded: needed,
          qtyOwned: skirt.qty || 0,
          shortfall: Math.max(0, needed - (skirt.qty || 0)),
          note: '',
          hirehopId: skirt.hirehopId || null,
        });
      }
    }
  }

  // ── B. Bolts (Fixings category) ──
  // Hardcoded owned quantities — these are consumables kept in bulk.
  const BOLT_70MM_OWNED = 90;
  const BOLT_90MM_OWNED = 10;

  // 70mm bolts: 2 per shared edge between adjacent deck panels
  const sharedEdges = countSharedDeckEdges(result.layout);
  const bolt70qty = sharedEdges * 2;

  if (bolt70qty > 0) {
    parts.push({
      category: 'Fixings',
      name: 'M10 70mm bolt, nut, 2 x washers',
      qtyNeeded: bolt70qty,
      qtyOwned: BOLT_70MM_OWNED,
      shortfall: Math.max(0, bolt70qty - BOLT_70MM_OWNED),
      note: `${sharedEdges} deck-to-deck joins × 2`,
      hirehopId: 803,
    });
  }

  // 90mm bolts: handrail attachment (calculated per edge above)
  if (total90mmBolts > 0) {
    parts.push({
      category: 'Fixings',
      name: 'M10 90mm bolt, nut, 2 x washers',
      qtyNeeded: total90mmBolts,
      qtyOwned: BOLT_90MM_OWNED,
      shortfall: Math.max(0, total90mmBolts - BOLT_90MM_OWNED),
      note: 'Handrail attachment bolts',
      hirehopId: 1910,
    });
  }

  // C. Velcro hook tape — required wherever skirting is used
  // Total skirted perimeter in inches → metres, rounded up, +1m spare (always go over).
  if (totalSkirtedLengthIn > 0) {
    const velcroMetres = Math.ceil(totalSkirtedLengthIn * 0.0254) + 1;
    parts.push({
      category: 'Fixings',
      name: 'Self adhesive Velcro - hook (per meter)',
      qtyNeeded: velcroMetres,
      qtyOwned: 0,   // consumable — always ordered per job, never in stock
      shortfall: velcroMetres,
      note: `${Math.ceil(totalSkirtedLengthIn * 0.0254)}m skirted perimeter + 1m spare`,
      hirehopId: 1013,
      saleItem: true,   // consumable → pushes to HireHop as s1013, not b1013 (see push handler)
    });
  }

  // ── D. White gaffer tape (optional global checkbox) ──
  if (wantsGafferTape) {
    parts.push({
      category: 'Consumables',
      name: '2" (50mm x 50m) MagTape white gaffa tape',
      qtyNeeded: 1,
      qtyOwned: 0,
      shortfall: 1,  // consumable — needs ordering
      note: 'Optional — add if requested',
      hirehopId: 740,
      saleItem: true,   // consumable → pushes to HireHop as s740, not b740 (b740 = a Pioneer DJM900!)
    });
  }

  parts._accessoryWarnings = warnings;
  return parts;
}


/**
 * Render the accessories edge selector UI.
 * Shows after the main parts list, with independent toggle buttons for each edge.
 */
function renderAccessoriesSection(result) {
  if (!result || !result.success) return '';
  if (!STOCK) return '';

  // Ensure arrays exist (might be undefined if stock endpoint is older version)
  if (!STOCK.handrails) STOCK.handrails = [];
  if (!STOCK.steps) STOCK.steps = [];

  const unit = result.input.unit;
  const lengthIn = result.result.actualLength.inches;
  const widthIn = result.result.actualWidth.inches;
  const heightIn = result.result.actualHeight.inches;

  // When the layout is rotated, the front/back edges run along the width dimension
  // (and left/right run along the length dimension), so swap the display labels.
  const frontEdgeLengthIn = stageRotated ? widthIn : lengthIn;
  const sideEdgeLengthIn  = stageRotated ? lengthIn : widthIn;

  const frontEdgeLabel = formatDimensionForUnit(frontEdgeLengthIn, unit);
  const sideEdgeLabel  = formatDimensionForUnit(sideEdgeLengthIn, unit);
  const heightLabel = formatDimensionForUnit(heightIn, unit);

  // Stage body dimensions for display — show the view-oriented dims (h × d)
  const stageBodyHoriz = formatDimensionForUnit(frontEdgeLengthIn, unit);  // left-right in current view
  const stageBodyVert  = formatDimensionForUnit(sideEdgeLengthIn, unit);   // top-bottom in current view

  // Auto-suggestions
  const suggestions = [];
  if (heightIn >= 24) {  // 2ft+
    suggestions.push('🪜 Stage is ' + heightLabel + ' high — steps recommended for safe access.');
  }
  // Check for open edges (any edge without handrail)
  const hasAnySelection = Object.values(accessorySelections).some(s => s.handrail || s.steps);
  const openEdges = Object.entries(accessorySelections)
    .filter(([_, sel]) => !sel.handrail)
    .map(([edge]) => edge);
  if (heightIn >= 24 && openEdges.length > 0) {
    suggestions.push('🛡️ Open edges detected — consider handrails for safety.');
  }

  let html = `<div class="result-card accessories-card">
    <h2>🔧 Accessories</h2>`;

  // Suggestions
  if (suggestions.length > 0) {
    html += `<div class="info-banner" style="margin-bottom:16px">
      ${suggestions.join('<br>')}
    </div>`;
  }

  // Edge selector grid — simple visual layout
  html += `<div class="edge-selector">
    <p class="edge-selector-label">Select accessories for each edge:</p>
    <div class="edge-grid">`;

  // Visual stage representation with edge selectors
  html += `<div class="stage-edge-visual">
      <div class="edge-visual-top">
        <span class="edge-dim">${frontEdgeLabel}</span>
      </div>`;

  // Back edge (top)
  html += renderEdgeRow('back', 'Back', frontEdgeLabel);

  // Middle row with left, stage body, right
  html += `<div class="edge-visual-middle">`;
  html += renderEdgeSide('left', 'Left', sideEdgeLabel);
  html += `<div class="stage-body">
        <span class="stage-body-label">STAGE</span>
        <span class="stage-body-dim">${stageBodyHoriz} × ${stageBodyVert}</span>
        <span class="stage-body-dim">Height: ${heightLabel}</span>
      </div>`;
  html += renderEdgeSide('right', 'Right', sideEdgeLabel);
  html += `</div>`;

  // Front edge (bottom)
  html += renderEdgeRow('front', 'Front (audience)', frontEdgeLabel);

  // Close stage-edge-visual, edge-grid, and edge-selector
  html += `</div></div></div>`;

  // Accessory parts breakdown
  const accessoryParts = calculateAccessories(result);
  if (accessoryParts.length > 0) {
    const hasAvailability = AVAILABILITY !== null;

    html += `<div class="accessory-parts" style="margin-top:20px">
      <h3>Accessory Parts Needed</h3>
      <table class="parts-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Needed</th>
            <th>${hasAvailability ? 'Owned' : 'In Stock'}</th>
            ${hasAvailability ? '<th>Available</th>' : ''}
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>`;

    for (const part of accessoryParts) {
      const availQty = getAvailableQtyForPart(part);
      const effectiveQty = availQty !== null ? availQty : part.qtyOwned;
      const effectiveShortfall = Math.max(0, part.qtyNeeded - effectiveQty);

      const statusClass = effectiveShortfall > 0 ? 'status-short' :
        part.qtyNeeded <= effectiveQty * 0.8 ? 'status-ok' : 'status-tight';
      const statusText = effectiveShortfall > 0 ? `Short ${effectiveShortfall}` :
        part.qtyNeeded === effectiveQty ? 'Exact' : 'OK';
      const statusIcon = effectiveShortfall > 0 ? '🔴' : part.qtyNeeded >= effectiveQty ? '🟡' : '🟢';

      let availCell = '';
      if (hasAvailability) {
        if (availQty !== null) {
          const availClass = availQty >= part.qtyNeeded ? 'ok' :
            availQty > 0 ? 'tight' : 'short';
          availCell = `<td class="num"><span class="avail-badge ${availClass}">${availQty}</span></td>`;
        } else {
          availCell = `<td class="num" style="color:#94a3b8">—</td>`;
        }
      }

      html += `<tr>
        <td>${part.name}</td>
        <td class="num">${part.qtyNeeded}</td>
        <td class="num">${part.qtyOwned}</td>
        ${availCell}
        <td class="${statusClass}">${statusIcon} ${statusText}</td>
        <td class="note">${part.note}</td>
      </tr>`;
    }

    html += `</tbody></table>`;

    // Show accessory warnings
    if (accessoryParts._accessoryWarnings && accessoryParts._accessoryWarnings.length > 0) {
      html += `<div class="info-banner" style="margin-top:12px; background:#fef3c7; border-left-color:#f59e0b">
        ${accessoryParts._accessoryWarnings.join('<br>')}
      </div>`;
    }

    html += `</div>`;
  } else if (hasAnySelection) {
    html += `<p style="color:#6b7280; margin-top:12px">No matching accessories found in stock.</p>`;
  }

  // ── D. Gaffer tape checkbox — global option, not per-edge ──
  html += `<div style="margin-top:16px; padding-top:12px; border-top:1px solid #374151">
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; color:#e5e7eb; font-size:14px; font-weight:500">
      <input type="checkbox" id="gaffer-tape-checkbox"
        ${wantsGafferTape ? 'checked' : ''}
        onchange="wantsGafferTape = this.checked; refreshAccessoriesAndPush()"
        style="width:16px; height:16px; accent-color:#6366f1; cursor:pointer; flex-shrink:0">
      🗒️ Add white gaffer tape — 1 roll (2" MagTape, 50m)
    </label>
  </div>`;

  // Close the result-card div
  html += `</div>`;
  return html;
}

/**
 * Render a horizontal edge selector row (for front/back edges).
 * Each edge has independent Handrail, Steps, and Skirt toggle buttons.
 */
function renderEdgeRow(key, label, lengthLabel) {
  const sel = accessorySelections[key];
  // "None" is active only when all three accessories are off
  const noneActive = !sel.handrail && !sel.steps && !sel.skirt;
  let html = `<div class="edge-row">
    <span class="edge-label">${label} <span class="edge-length">(${lengthLabel})</span></span>
    <div class="edge-options">
      <button class="edge-btn ${noneActive ? 'active' : ''}" onclick="clearEdge('${key}')">None</button>
      <button class="edge-btn ${sel.handrail ? 'active' : ''}" onclick="toggleEdge('${key}','handrail')">🛡️ Handrail</button>
      <button class="edge-btn ${sel.steps ? 'active' : ''}" onclick="toggleEdge('${key}','steps')">🪜 Steps</button>
      <button class="edge-btn ${sel.skirt ? 'active' : ''}" onclick="toggleEdge('${key}','skirt')">🎭 Skirt</button>
    </div>`;

  // Show step position selector when both handrail AND steps are on this edge
  if (sel.handrail && sel.steps) {
    html += renderStepPositionSelector(key, sel.stepPosition);
  }

  html += `</div>`;
  return html;
}

/**
 * Render a vertical edge selector (for left/right edges).
 * Each edge has independent Handrail, Steps, and Skirt toggle buttons.
 */
function renderEdgeSide(key, label, lengthLabel) {
  const sel = accessorySelections[key];
  // "None" is active only when all three accessories are off
  const noneActive = !sel.handrail && !sel.steps && !sel.skirt;
  let html = `<div class="edge-side">
    <span class="edge-label">${label} <span class="edge-length">(${lengthLabel})</span></span>
    <div class="edge-options edge-options-vertical">
      <button class="edge-btn edge-btn-sm ${noneActive ? 'active' : ''}" onclick="clearEdge('${key}')">None</button>
      <button class="edge-btn edge-btn-sm ${sel.handrail ? 'active' : ''}" onclick="toggleEdge('${key}','handrail')">🛡️</button>
      <button class="edge-btn edge-btn-sm ${sel.steps ? 'active' : ''}" onclick="toggleEdge('${key}','steps')">🪜</button>
      <button class="edge-btn edge-btn-sm ${sel.skirt ? 'active' : ''}" onclick="toggleEdge('${key}','skirt')">🎭</button>
    </div>`;

  // Show step position selector when both handrail AND steps are on this edge
  if (sel.handrail && sel.steps) {
    html += renderStepPositionSelector(key, sel.stepPosition);
  }

  html += `</div>`;
  return html;
}

/**
 * Render step position selector (front/middle/back).
 * Shows when both handrail AND steps are on the same edge, so the user
 * can choose where the gap in the handrail run goes for the steps.
 * 
 * Steps are ~90cm wide (~3ft), so the gap is rounded to the nearest
 * handrail section size (2ft or 4ft).
 * 
 * @param {string} edge - Edge key (front/back/left/right)
 * @param {string} currentPos - Current position (front/middle/back)
 */
function renderStepPositionSelector(edge, currentPos) {
  const pos = currentPos || 'middle';
  return `<div class="step-position-selector" style="margin-top:6px; display:flex; align-items:center; gap:6px; font-size:12px">
    <span style="color:#6b7280">Steps position:</span>
    <button class="edge-btn edge-btn-sm ${pos === 'front' ? 'active' : ''}" 
      onclick="setStepPosition('${edge}','front')" style="font-size:11px; padding:2px 8px">◀ Front</button>
    <button class="edge-btn edge-btn-sm ${pos === 'middle' ? 'active' : ''}" 
      onclick="setStepPosition('${edge}','middle')" style="font-size:11px; padding:2px 8px">● Middle</button>
    <button class="edge-btn edge-btn-sm ${pos === 'back' ? 'active' : ''}" 
      onclick="setStepPosition('${edge}','back')" style="font-size:11px; padding:2px 8px">▶ Back</button>
  </div>`;
}

/**
 * Set the step position (front/middle/back) on a given edge.
 * Only relevant when both steps AND handrails are on the same edge —
 * controls where the gap appears in the handrail run.
 */
function setStepPosition(edge, position) {
  if (accessorySelections[edge]) {
    accessorySelections[edge].stepPosition = position;
    refreshAccessoriesAndPush();
  }
}

/**
 * Toggle a specific accessory type on an edge.
 * Handrails and steps are independent — you can have both on the same edge.
 * Multiple edges can have steps simultaneously.
 */
function toggleEdge(edge, type) {
  // Toggle the selected type
  accessorySelections[edge][type] = !accessorySelections[edge][type];

  refreshAccessoriesAndPush();
}

/**
 * Clear all accessories from an edge (set handrail, steps, and skirt to false).
 */
function clearEdge(edge) {
  accessorySelections[edge].handrail = false;
  accessorySelections[edge].steps = false;
  accessorySelections[edge].stepPosition = 'middle';
  accessorySelections[edge].skirt = false;  // C — also clear skirt

  refreshAccessoriesAndPush();
}

/**
 * Re-render the accessories card and push button after an accessory change.
 * The accessories container is inside the results div.
 * The action/push containers are OUTSIDE the results div (static HTML), so
 * they will always be found by getElementById regardless of what happens
 * inside the results div.
 */
function refreshAccessoriesAndPush() {
  if (!currentResult || !currentResult.success) return;

  // Re-render accessories card (uses persistent container — safe innerHTML swap)
  try {
    const accContainer = document.getElementById('accessories-container');
    if (accContainer) {
      accContainer.innerHTML = renderAccessoriesSection(currentResult);
    }
  } catch (accErr) {
    console.warn('Accessories re-render failed (non-fatal):', accErr);
  }

  // Re-render the persistent action/push containers.
  // These live in the HTML file outside the results div, so they are
  // immune to anything that happens inside the results div.
  try {
    const pushContainer = document.getElementById('push-section-container');
    if (pushContainer) {
      pushContainer.innerHTML = renderPushButton();
    }
    const actionContainer = document.getElementById('action-buttons-container');
    if (actionContainer) {
      actionContainer.innerHTML = renderActionButtons();
    }
  } catch (pushErr) {
    console.warn('Push button re-render failed:', pushErr);
  }
}


// ============================================================================
// PUSH TO HIREHOP — add parts to a HireHop job
// ============================================================================

/**
 * Collect all items (main parts + accessories) and push to HireHop job.
 * Shows a confirmation dialog first.
 * Also sends the 3D viewer share link as a job note.
 */
async function pushToJob() {
  if (!currentResult || !currentResult.success) return;

  const jobId = document.getElementById('job-number').value.trim();
  if (!jobId || !/^\d+$/.test(jobId)) {
    alert('Please enter a valid job number first.');
    return;
  }

  // Collect all items with HireHop IDs
  const items = [];

  // Main parts list
  for (const part of currentResult.partsList) {
    if (part.hirehopId && part.qtyNeeded > 0) {
      items.push({ hirehopId: part.hirehopId, qty: part.qtyNeeded, name: part.name, saleItem: !!part.saleItem });
    }
  }

  // Accessory parts
  const accessoryParts = calculateAccessories(currentResult);
  for (const part of accessoryParts) {
    if (part.hirehopId && part.qtyNeeded > 0) {
      items.push({ hirehopId: part.hirehopId, qty: part.qtyNeeded, name: part.name, saleItem: !!part.saleItem });
    }
  }

  if (items.length === 0) {
    alert('No items with HireHop IDs to add.');
    return;
  }

  // Build confirmation message
  const totalQty = items.reduce((sum, i) => sum + i.qty, 0);
  const itemList = items.map(i => `  ${i.qty}× ${i.name}`).join('\n');
  const confirmed = confirm(
    `Add ${items.length} item types (${totalQty} total) to Job ${jobId}?\n\n${itemList}\n\nThis will ADD items to the job (won't replace existing items).`
  );

  if (!confirmed) return;

  // Update button state
  const btn = document.getElementById('push-to-job-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Adding…';
  }

  // Send the stage config to OP — it stores it and mints a short 3D share link
  // (no more huge encode-everything-in-the-URL link). OP returns the short link.
  const stageConfig = build3DConfig();

  // Build a human-readable stage summary for the job note
  const r = currentResult.result;
  const unit = currentResult.input.unit;
  const lenLabel = formatDimensionForUnit(r.actualLength.inches, 'ft');
  const widLabel = formatDimensionForUnit(r.actualWidth.inches, 'ft');
  const hLabel = formatDimensionForUnit(r.actualHeight.inches, 'ft');
  const stageSummary = `To form a stage ${lenLabel} × ${widLabel} @ ${hLabel} high`;

  try {
    const response = await fetch('/api/staging/push', {
      method: 'POST',
      headers: opAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        jobId: jobId,
        items: items.map(i => ({ hirehopId: i.hirehopId, qty: i.qty, saleItem: !!i.saleItem })),
        stageConfig: stageConfig || undefined,
        stageSummary: stageSummary,
      }),
    });

    const data = await response.json();

    if (data.success) {
      // Tell the OP parent window so it reveals/refreshes the Staging tab with the short link.
      notifyParentStagingComplete(data.planId, data.shareLink);
      if (btn) {
        btn.textContent = '✅ Added!';
        btn.classList.add('btn-success');
        setTimeout(() => {
          btn.textContent = `📤 Add to Job ${jobId}`;
          btn.classList.remove('btn-success');
          btn.disabled = false;
        }, 3000);
      }
    } else {
      throw new Error(data.error || 'Unknown error');
    }

  } catch (err) {
    console.error('Add to job failed:', err);
    if (btn) {
      btn.textContent = '❌ Failed';
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = `📤 Add to Job ${jobId}`;
      }, 3000);
    }
    alert(`Failed to add to job: ${err.message}`);
  }
}

/**
 * Render the "action buttons" card — 3D view and share link.
 * Displayed at the bottom of results alongside push button.
 */
function renderActionButtons() {
  if (!currentResult || !currentResult.success) return '';

  return `<div class="result-card" style="text-align:center">
    <h2>📤 Share & Export</h2>
    <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-top:12px">
      <button class="btn btn-calculate" style="padding:10px 24px; font-size:14px; background:linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)"
        onclick="open3DView()">
        🎨 Open 3D Client View
      </button>
      <button class="chip" style="padding:10px 18px; font-size:14px" onclick="copy3DLink()">
        📋 Copy share link
      </button>
    </div>
  </div>`;
}

/**
 * Render the "Add to Job" button.
 * Always visible — shows disabled state when no job number entered.
 */
function renderPushButton() {
  if (!currentResult || !currentResult.success) return '';

  const jobId = document.getElementById('job-number')?.value?.trim();
  const hasJob = jobId && /^\d+$/.test(jobId);

  if (hasJob) {
    return `<div class="result-card push-card" style="text-align:center">
      <button id="push-to-job-btn" class="btn btn-calculate" 
        style="padding:12px 32px; font-size:15px; background:linear-gradient(135deg, #059669 0%, #10b981 100%)"
        onclick="pushToJob()">
        📤 Add to Job ${jobId}
      </button>
      <p style="font-size:12px; color:#6b7280; margin-top:8px">
        Adds all items (including accessories) to HireHop job. Won't replace existing items.
      </p>
    </div>`;
  } else {
    return `<div class="result-card push-card" style="text-align:center">
      <button class="btn btn-calculate" disabled
        style="padding:12px 32px; font-size:15px; background:#94a3b8; cursor:not-allowed">
        📤 Add to HireHop Job
      </button>
      <p style="font-size:12px; color:#6b7280; margin-top:8px">
        Enter a HireHop job number above to add items directly.
      </p>
    </div>`;
  }
}