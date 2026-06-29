/**
 * Canonical "what counts as backline" category list — the SINGLE SOURCE OF TRUTH.
 *
 * "Backline" in Ooosh's operational context = ALL hireable equipment the
 * warehouse preps: instruments, PA/sound (incl. microphones), DJ, lighting,
 * power, staging, video, accessories. Essentially everything EXCEPT vehicles
 * (370-371), storage (449) and rehearsal rooms (450).
 *
 * Source: HireHop categories_list.php, verified 9 Apr 2026.
 *
 * Why this module exists: the HH-derived requirements engine
 * (`hh-requirement-derivation.ts`) and the Backline Matcher
 * (`backline-stock.ts`) BOTH need this list. They used to keep their own
 * copies, and they drifted — the matcher's copy stopped at 410 (instruments
 * only), so PA/Sound (mics, speakers, mixers, monitors), DJ, lighting, power,
 * staging and video were silently filtered out of the matcher's stock list and
 * Claude reported "not in stock" for items we hold plenty of. Importing from one
 * place makes that drift impossible.
 */
export const BACKLINE_CATEGORY_IDS: number[] = [
  // Guitars (372-378) — amps, cabs, combos, FX
  372, 373, 374, 375, 376, 377, 378,
  // Basses (379-384)
  379, 380, 381, 382, 383, 384,
  // Drums (385-398)
  385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398,
  // Keyboards (399-404)
  399, 400, 401, 402, 403, 404,
  // Woodwind (405)
  405,
  // Backline accessories — stands, cases, fans, valves (406-410)
  406, 407, 408, 409, 410,
  // PA / Sound (411-428) — microphones, DIs, mixers, speakers, monitors, etc.
  411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428,
  // DJ (429-431)
  429, 430, 431,
  // Lighting (432-438)
  432, 433, 434, 435, 436, 437, 438,
  // Power (439-443)
  439, 440, 441, 442, 443,
  // Staging (444-448)
  444, 445, 446, 447, 448,
  // Video (451-453)
  451, 452, 453,
];

/** Set form for fast membership checks (e.g. the matcher's stock filter). */
export const BACKLINE_CATEGORY_ID_SET: ReadonlySet<number> = new Set(BACKLINE_CATEGORY_IDS);
