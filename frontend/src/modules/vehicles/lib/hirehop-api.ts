/**
 * HireHop API — client-side wrapper for the HireHop proxy function.
 *
 * All requests go through /.netlify/functions/hirehop to keep the token server-side.
 *
 * Endpoints used (verified working):
 * - /php_functions/job_refresh.php  — Get single job data (documented API)
 * - /frames/items_to_supply_list.php — Get job items (confirmed working)
 * - /php_functions/search_list.php   — Search/list jobs
 * - /frames/status_save.php          — Update job status
 */

import type {
  HireHopJob,
  HireHopJobItem,
  HireHopJobStatus,
  VanRequirement,
} from '../types/hirehop'
import {
  HIREHOP_STOCK_MAPPINGS,
  HIREHOP_VIRTUAL_ITEM_IDS,
  HIREHOP_STATUS_LABELS,
} from '../types/hirehop'

import { apiFetch } from '../config/api-config'

// Vehicle category ID in HireHop (from OOOSH HireHop docs)
const VEHICLE_CATEGORY_ID = 370

// ── Core Request ──

/** Send a request to the HireHop proxy */
async function hirehopRequest<T = unknown>(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  params: Record<string, string> = {},
): Promise<T> {
  const response = await apiFetch('/hirehop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, method, params }),
  })

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({})) as { error?: string; details?: string }
    const errorMsg = errBody.details || errBody.error || `HireHop API error: ${response.status}`
    console.error(`[hirehop-api] Error from ${endpoint}:`, errorMsg)
    throw new Error(errorMsg)
  }

  return response.json() as Promise<T>
}

// ── Job Endpoints ──

/**
 * Fetch a single job by ID using job_refresh.php (documented HireHop API endpoint).
 * Then fetch its items separately via items_to_supply_list.php (confirmed working).
 */
export async function fetchJob(jobId: number): Promise<HireHopJob> {
  if (!jobId || jobId === 0) {
    throw new Error(`Invalid job ID: ${jobId}`)
  }

  // Fetch job data and items in parallel
  const [jobData, items] = await Promise.all([
    hirehopRequest<Record<string, unknown>>(
      '/php_functions/job_refresh.php',
      'GET',
      { job: String(jobId) },
    ),
    fetchJobItems(jobId),
  ])

  // HireHop returns {"error": 3} for invalid/inaccessible jobs
  if (jobData.error) {
    throw new Error(`HireHop error ${jobData.error} for job ${jobId}`)
  }

  return mapHireHopJob(jobData, items)
}

/**
 * Fetch items for a job using items_to_supply_list.php.
 * This endpoint is confirmed working per OOOSH HireHop documentation.
 * Uses CATEGORY_ID to identify vehicle items vs accessories/virtual items.
 *
 * THROWS on error (e.g. error 327) — callers must handle errors.
 */
async function fetchJobItems(jobId: number): Promise<HireHopJobItem[]> {
  const data = await hirehopRequest<unknown>(
    '/frames/items_to_supply_list.php',
    'GET',
    { job: String(jobId) },
  )

  // Detect error responses (e.g. {error: 327} — HireHop rate/session limit)
  if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in (data as Record<string, unknown>)) {
    const errCode = (data as Record<string, unknown>).error
    throw new Error(`HireHop items error ${errCode} for job ${jobId}`)
  }

  // Handle both array and object response formats
  const rawItems = Array.isArray(data)
    ? data as Array<Record<string, unknown>>
    : ((data as Record<string, unknown>).items || []) as Array<Record<string, unknown>>

  // Log first item's keys for diagnostics
  if (rawItems.length > 0) {
    console.log(`[hirehop-api] fetchJobItems job ${jobId}: ${rawItems.length} raw items, first item keys: ${Object.keys(rawItems[0]!).join(', ')}`)
  }

  return rawItems
    .map((item: Record<string, unknown>): HireHopJobItem | null => {
      const itemId = Number(item.ITEM_ID ?? item.item_id ?? item.LIST_ID ?? item.ID ?? item.id ?? 0)
      if (!itemId) return null

      // Skip virtual items (VIRTUAL === "Yes" or "1") unless they're vehicles
      const isVirtual = String(item.VIRTUAL) === '1' || String(item.VIRTUAL) === 'Yes'
      const categoryId = Number(item.CATEGORY_ID ?? 0)

      // Only include real hire items (not headers, notes, or virtual placeholders)
      const kind = Number(item.kind ?? 2)
      if (kind === 0 || kind === 3) return null  // Skip headers and notes
      if (isVirtual && categoryId !== VEHICLE_CATEGORY_ID) return null

      return {
        id: Number(item.ID ?? item.id ?? 0),
        ITEM_ID: itemId,
        ITEM_NAME: String(item.NAME ?? item.title ?? item.ITEM_NAME ?? item.item_name ?? ''),
        QUANTITY: Number(item.QTY ?? item.qty ?? item.quantity ?? item.QUANTITY ?? 1),
        CATEGORY_ID: categoryId,
      }
    })
    .filter((i): i is HireHopJobItem => i !== null)
}

// ── Global Item Fetch Queue ──
// HireHop returns error 327 when too many concurrent requests hit the API.
// This queue limits concurrency and caches results to prevent rate limiting
// across multiple React Query hooks firing simultaneously.
//
// Original problem: 30+ concurrent items_to_supply_list.php calls → error 327.
// Fix: max 3 concurrent + 150ms stagger + 5-min cache + deduplication.

const ITEMS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes — matches React Query staleTime
const FETCH_DELAY_MS = 1200 // ms between starting new fetches — keeps us under 60 req/min
const MAX_CONCURRENT = 1   // max in-flight item requests (serialize to avoid error 327)

interface ItemsCacheEntry {
  items: HireHopJobItem[]
  ts: number
}

const _itemsCache = new Map<number, ItemsCacheEntry>()
const _pendingFetches = new Map<number, Promise<HireHopJobItem[]>>()
const _fetchQueue: Array<{
  jobId: number
  resolve: (items: HireHopJobItem[]) => void
  reject: (err: unknown) => void
}> = []
let _activeCount = 0

function _getCachedItems(jobId: number): HireHopJobItem[] | undefined {
  const entry = _itemsCache.get(jobId)
  if (entry && Date.now() - entry.ts < ITEMS_CACHE_TTL) return entry.items
  return undefined
}

async function _processNextItem(): Promise<void> {
  if (_activeCount >= MAX_CONCURRENT || _fetchQueue.length === 0) return

  const { jobId, resolve, reject } = _fetchQueue.shift()!

  // Check cache (may have been populated while queued)
  const cached = _getCachedItems(jobId)
  if (cached) {
    resolve(cached)
    _processNextItem() // Process next immediately
    return
  }

  _activeCount++

  try {
    const items = await fetchJobItems(jobId)
    _itemsCache.set(jobId, { items, ts: Date.now() })
    resolve(items)
  } catch (err) {
    // Retry once on error 327 after a pause
    if (err instanceof Error && err.message.includes('327')) {
      console.log(`[hirehop-api] Retrying items for job ${jobId} after error 327...`)
      await new Promise(r => setTimeout(r, 1500))
      try {
        const items = await fetchJobItems(jobId)
        _itemsCache.set(jobId, { items, ts: Date.now() })
        resolve(items)
      } catch (retryErr) {
        reject(retryErr)
      }
    } else {
      reject(err)
    }
  } finally {
    _activeCount--
    // Stagger next fetch slightly to avoid bursts
    if (_fetchQueue.length > 0) {
      setTimeout(() => _processNextItem(), FETCH_DELAY_MS)
    }
  }
}

/**
 * Fetch items for a job via the global throttled queue.
 * - Max 3 concurrent requests (prevents HireHop error 327)
 * - 150ms stagger between new requests
 * - Caches results for 5 minutes across all React Query hooks
 * - Deduplicates in-flight requests for the same job
 * - Retries once on error 327 with 1.5s backoff
 */
function fetchJobItemsQueued(jobId: number): Promise<HireHopJobItem[]> {
  // Return from cache if available
  const cached = _getCachedItems(jobId)
  if (cached) return Promise.resolve(cached)

  // Deduplicate: if already fetching this job, share the promise
  const pending = _pendingFetches.get(jobId)
  if (pending) return pending

  const promise = new Promise<HireHopJobItem[]>((resolve, reject) => {
    _fetchQueue.push({ jobId, resolve, reject })
    _processNextItem()
  })

  _pendingFetches.set(jobId, promise)
  promise.finally(() => _pendingFetches.delete(jobId))

  return promise
}

/**
 * Search for jobs with optional filters.
 *
 * Uses /php_functions/search_list.php which returns a list of matching jobs.
 * Note: search_list.php is an undocumented internal endpoint. It ignores
 * date_from/date_to parameters and returns only ~10 results per page (default).
 * We paginate through all pages and filter by date client-side.
 */
export async function searchJobs(params: {
  status?: string       // Comma-separated status codes e.g. "2,3,4"
  dateFrom?: string     // YYYY-MM-DD
  dateTo?: string       // YYYY-MM-DD
  dateField?: 'out' | 'return'  // Which date to filter on (default: overlap matching)
}): Promise<HireHopJob[]> {
  const searchParams: Record<string, string> = {}
  if (params.status) searchParams.status = params.status
  // Request max rows per page to minimise pagination calls
  searchParams.rows = '500'
  // Send date params to HireHop (it ignores them, but send anyway in case a future update fixes this)
  if (params.dateFrom) searchParams.date_from = params.dateFrom
  if (params.dateTo) searchParams.date_to = params.dateTo

  // Paginate through all results — search_list.php defaults to ~10 rows
  // and ignores date filters, so we need to fetch everything
  let allRows: Array<Record<string, unknown>> = []
  let page = 1
  const MAX_PAGES = 20 // Safety limit to avoid infinite loops

  while (page <= MAX_PAGES) {
    searchParams.page = String(page)

    let data: unknown
    try {
      data = await hirehopRequest<unknown>(
        '/php_functions/search_list.php',
        'GET',
        searchParams,
      )
    } catch (err) {
      if (page === 1) {
        // First page failed — try POST as fallback
        console.warn('[hirehop-api] search_list GET failed, trying POST:', err)
        try {
          data = await hirehopRequest<unknown>(
            '/php_functions/search_list.php',
            'POST',
            searchParams,
          )
        } catch (postErr) {
          console.error('[hirehop-api] search_list POST also failed:', postErr)
          throw postErr
        }
      } else {
        console.warn(`[hirehop-api] search_list page ${page} failed, stopping pagination:`, err)
        break
      }
    }

    const rows = extractRows(data)

    if (page === 1) {
      // Log the full response shape on first page for diagnostics
      const dataObj = data as Record<string, unknown>
      const topKeys = Object.keys(dataObj).filter(k => !/^\d+$/.test(k))
      console.log(`[hirehop-api] search_list response keys: ${topKeys.join(', ')} (${rows.length} rows on page ${page})`)

      // Log raw date fields from first row
      if (rows.length > 0) {
        const sample = rows[0]!
        const dateKeys = Object.keys(sample).filter(k => /date|out|return|end|start/i.test(k))
        const dateValues: Record<string, unknown> = {}
        for (const k of dateKeys) dateValues[k] = sample[k]
        console.log(`[hirehop-api] Sample row date fields:`, JSON.stringify(dateValues))
        console.log(`[hirehop-api] Sample row all keys:`, Object.keys(sample).join(', '))
      }
    }

    if (rows.length === 0) {
      console.log(`[hirehop-api] Page ${page} returned 0 rows, stopping pagination`)
      break
    }

    allRows = allRows.concat(rows)
    console.log(`[hirehop-api] Page ${page}: ${rows.length} rows (total so far: ${allRows.length})`)

    // If we got fewer rows than requested, we've reached the end
    if (rows.length < 50) {
      break
    }

    // Rate-limit pause between pagination requests
    await new Promise(r => setTimeout(r, 1000))
    page++
  }

  // Deduplicate rows by job ID (pagination can return overlapping results)
  const seenIds = new Set<string>()
  const uniqueRows: typeof allRows = []
  for (const row of allRows) {
    const id = String(row.JOB ?? row.NUMBER ?? row.ID ?? row.id ?? '')
    if (id && seenIds.has(id)) continue
    if (id) seenIds.add(id)
    uniqueRows.push(row)
  }
  if (uniqueRows.length < allRows.length) {
    console.log(`[hirehop-api] Deduplicated: ${allRows.length} → ${uniqueRows.length} rows`)
  }

  console.log(`[hirehop-api] searchJobs got ${uniqueRows.length} total rows from API for status=${params.status}`)

  let jobs = uniqueRows.map(row => mapHireHopJob(row))

  // Client-side date filtering — search_list.php ignores date_from/date_to
  if (params.dateFrom || params.dateTo) {
    const before = jobs.length
    const isValidDate = (d: string) => /^\d{4}-\d{2}-\d{2}/.test(d)

    jobs = jobs.filter(job => {
      // When dateField is specified, filter strictly on that specific date
      if (params.dateField === 'out') {
        const outDate = isValidDate(job.outDate) ? job.outDate.slice(0, 10) :
                        isValidDate(job.jobDate) ? job.jobDate.slice(0, 10) : ''
        if (!outDate) return true
        if (params.dateFrom && outDate < params.dateFrom) return false
        if (params.dateTo && outDate > params.dateTo) return false
        return true
      }

      if (params.dateField === 'return') {
        const returnDate = isValidDate(job.returnDate) ? job.returnDate.slice(0, 10) :
                           isValidDate(job.jobEndDate) ? job.jobEndDate.slice(0, 10) : ''
        if (!returnDate) return true
        if (params.dateFrom && returnDate < params.dateFrom) return false
        if (params.dateTo && returnDate > params.dateTo) return false
        return true
      }

      // Default: overlap matching (keep jobs whose date range overlaps with the query range)
      const start = isValidDate(job.outDate) ? job.outDate.slice(0, 10) :
                     isValidDate(job.jobDate) ? job.jobDate.slice(0, 10) : ''
      const end = isValidDate(job.returnDate) ? job.returnDate.slice(0, 10) :
                  isValidDate(job.jobEndDate) ? job.jobEndDate.slice(0, 10) : ''

      if (!start && !end) return true
      if (params.dateTo && start && start > params.dateTo) return false
      if (params.dateFrom && end && end < params.dateFrom) return false

      return true
    })
    console.log(`[hirehop-api] Client-side date filter: ${before} → ${jobs.length} jobs (dateFrom=${params.dateFrom}, dateTo=${params.dateTo}, dateField=${params.dateField || 'overlap'})`)
  }

  console.log(`[hirehop-api] searchJobs returning ${jobs.length} jobs for status=${params.status}, dateFrom=${params.dateFrom}, dateTo=${params.dateTo}`)

  return jobs
}

/** Extract rows from search_list.php response (handles various response shapes) */
function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data as Array<Record<string, unknown>>
  }
  const dataObj = data as Record<string, unknown>
  // Detect error responses (e.g. {error: 327}) — not data rows
  if ('error' in dataObj && Object.keys(dataObj).length <= 2) {
    console.warn('[hirehop-api] search_list returned error:', JSON.stringify(dataObj))
    return []
  }
  if (dataObj.rows && Array.isArray(dataObj.rows)) {
    return dataObj.rows as Array<Record<string, unknown>>
  }
  if (dataObj.data && Array.isArray(dataObj.data)) {
    return dataObj.data as Array<Record<string, unknown>>
  }
  // Could be an object with numeric keys (e.g. { "0": {...}, "1": {...}, ... })
  const values = Object.values(dataObj).filter(v => typeof v === 'object' && v !== null)
  if (values.length > 0 && typeof values[0] === 'object') {
    return values as Array<Record<string, unknown>>
  }
  console.warn('[hirehop-api] search_list returned unexpected format:', JSON.stringify(data).substring(0, 300))
  return []
}

// ── Global serialization lock for searchJobsWithItems ──
// Multiple React Query hooks fire simultaneously (going-out + due-back).
// Without serialization, they'd flood HireHop with concurrent search + item requests.
let _searchWithItemsLock: Promise<unknown> = Promise.resolve()

/**
 * Search for jobs and enrich with line items (for van requirement extraction).
 *
 * Uses search_list.php for job summaries, then fetches items via a global
 * sequential queue to avoid overwhelming HireHop's request limits.
 * The queue serializes ALL item fetches across all React Query hooks,
 * preventing the concurrent request storm that causes error 327.
 *
 * Calls are globally serialized — if two hooks fire simultaneously,
 * the second waits for the first to fully complete (search + items).
 */
export async function searchJobsWithItems(params: {
  status?: string
  dateFrom?: string
  dateTo?: string
  dateField?: 'out' | 'return'
}): Promise<HireHopJob[]> {
  // Serialize: wait for any previous searchJobsWithItems to finish
  const previousLock = _searchWithItemsLock
  let releaseLock: () => void
  _searchWithItemsLock = new Promise<void>(resolve => { releaseLock = resolve })

  try {
    await previousLock
  } catch {
    // Previous call failed — continue anyway
  }

  try {
  const summaries = await searchJobs(params)

  if (summaries.length === 0) return []

  // Filter out jobs with invalid IDs (0 or NaN) before fetching items
  const validSummaries = summaries.filter(job => job.id > 0)
  if (validSummaries.length < summaries.length) {
    console.warn(`[hirehop-api] Skipped ${summaries.length - validSummaries.length} jobs with invalid IDs`)
  }

  if (validSummaries.length === 0) return summaries

  console.log(`[hirehop-api] Queuing item fetches for ${validSummaries.length} jobs (global sequential queue)`)

  // Enqueue all item fetches — the global queue processes them one at a time
  const enriched = await Promise.all(
    validSummaries.map(async job => {
      try {
        const items = await fetchJobItemsQueued(job.id)
        return { ...job, items }
      } catch (err) {
        console.warn(`[hirehop-api] Failed to fetch items for job ${job.id}:`, err)
        return { ...job, itemsFetchFailed: true }
      }
    }),
  )

  const failed = enriched.filter(j => j.itemsFetchFailed).length
  if (failed > 0) {
    console.warn(`[hirehop-api] ${failed}/${enriched.length} jobs had item fetch failures`)
  }

  return enriched
  } finally {
    releaseLock!()
  }
}

// ── Status Update ──

/**
 * Update a job's status on HireHop.
 * Used on check-in (→ Returned). Book-out uses barcode checkout instead.
 */
export async function updateJobStatus(
  jobId: number,
  status: HireHopJobStatus,
): Promise<{ success: boolean; error?: string }> {
  try {
    await hirehopRequest(
      '/frames/status_save.php',
      'POST',
      { job: String(jobId), status: String(status) },
    )
    console.log(`[hirehop-api] Job ${jobId} status updated to ${HIREHOP_STATUS_LABELS[status]}`)
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Status update failed'
    console.error(`[hirehop-api] Failed to update job ${jobId} status:`, errMsg)
    return { success: false, error: errMsg }
  }
}

// ── Barcode Checkout ──

/**
 * Check out a vehicle from a HireHop job using barcode scan.
 * The vehicle registration IS the barcode.
 *
 * POST /php_functions/items_barcode_save.php
 *   job: HireHop job ID
 *   barcode: vehicle registration (the barcode)
 *   action: 1 (checkout)
 *
 * Returns the full item list including autopulls. Items with NO_SCAN=1
 * (typically text/custom billing items, kind=3) don't need scanning.
 */
export async function barcodeCheckout(
  jobId: number,
  vehicleReg: string,
): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const result = await hirehopRequest<Record<string, unknown>>(
      '/php_functions/items_barcode_save.php',
      'POST',
      { job: String(jobId), barcode: vehicleReg, action: '1' },
    )

    // Check for error responses from HireHop
    if (result.error) {
      const errorCode = Number(result.error)
      // Map known HireHop error codes to human-readable messages
      let errMsg: string
      if (errorCode === 101) {
        errMsg = `Barcode "${vehicleReg}" not found on job #${jobId}. Check that the vehicle registration is set as the barcode for the stock item in HireHop.`
      } else if (errorCode === 3) {
        errMsg = `Access denied for job #${jobId}. The API token may not have permission.`
      } else if (errorCode === 327) {
        errMsg = `Job #${jobId} is not accessible (may be archived or restricted).`
      } else {
        errMsg = `HireHop error ${result.error} for job #${jobId}, reg ${vehicleReg}`
      }
      console.error(`[hirehop-api] Barcode checkout failed:`, errMsg, 'Full response:', JSON.stringify(result))
      return { success: false, error: errMsg }
    }

    console.log(`[hirehop-api] Barcode checkout successful: job ${jobId}, reg ${vehicleReg}`)

    // Log autopull items for visibility
    const items = result.items || result.ITEMS
    if (Array.isArray(items)) {
      const noScanItems = items.filter((i: Record<string, unknown>) => i.NO_SCAN === 1 || i.no_scan === 1)
      if (noScanItems.length > 0) {
        console.log(`[hirehop-api] ${noScanItems.length} autopull items with NO_SCAN=1 (no checkout needed)`)
      }
      const needsScan = items.filter((i: Record<string, unknown>) =>
        (i.NO_SCAN === 0 || i.no_scan === 0) && Number(i.ITEM_ID ?? i.item_id ?? 0) !== 0,
      )
      if (needsScan.length > 1) {
        console.warn(`[hirehop-api] ${needsScan.length} items still need scanning (unexpected — may need items_scan_save.php fallback)`)
      }
    }

    return { success: true, data: result }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Barcode checkout failed'
    console.error(`[hirehop-api] Barcode checkout error for job ${jobId}:`, errMsg)
    return { success: false, error: errMsg }
  }
}

// ── Barcode Check-In ──

/**
 * Check in (return) a vehicle to a HireHop job using barcode scan.
 * The vehicle registration IS the barcode.
 *
 * POST /php_functions/items_barcode_save.php
 *   job: HireHop job ID
 *   barcode: vehicle registration (the barcode)
 *   action: 2 (check-in / return)
 */
export async function barcodeCheckin(
  jobId: number,
  vehicleReg: string,
): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const result = await hirehopRequest<Record<string, unknown>>(
      '/php_functions/items_barcode_save.php',
      'POST',
      { job: String(jobId), barcode: vehicleReg, action: '2' },
    )

    if (result.error) {
      const errorCode = Number(result.error)
      let errMsg: string
      if (errorCode === 101) {
        errMsg = `Barcode "${vehicleReg}" not found on job #${jobId}. Check that the vehicle registration is set as the barcode for the stock item in HireHop.`
      } else if (errorCode === 3) {
        errMsg = `Access denied for job #${jobId}. The API token may not have permission.`
      } else {
        errMsg = `HireHop error ${result.error} for job #${jobId}, reg ${vehicleReg}`
      }
      console.error(`[hirehop-api] Barcode check-in failed:`, errMsg, 'Full response:', JSON.stringify(result))
      return { success: false, error: errMsg }
    }

    console.log(`[hirehop-api] Barcode check-in successful: job ${jobId}, reg ${vehicleReg}`)
    return { success: true, data: result }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Barcode check-in failed'
    console.error(`[hirehop-api] Barcode check-in error for job ${jobId}:`, errMsg)
    return { success: false, error: errMsg }
  }
}

// ── Van Requirements ──

// Vehicle category IDs in HireHop (from OOOSH HireHop docs)
// 369 = Vehicle parent/header, 370 = Actual vehicles, 371 = Vehicle accessories
const VEHICLE_CATEGORY_IDS = [369, 370, 371]

/**
 * Extract van requirements from a job's line items.
 * Uses CATEGORY_ID to identify vehicle items FIRST, then maps to fleet types.
 *
 * IMPORTANT: Stock ID matching alone is NOT sufficient — low stock IDs like 8, 10, 11
 * collide with non-vehicle items (e.g. a Pioneer CDJ with LIST_ID=11 would falsely
 * match "Basic MWB manual"). CATEGORY_ID 370 is the only reliable vehicle indicator.
 */
export function extractVanRequirements(job: HireHopJob): VanRequirement[] {
  const requirements: VanRequirement[] = []

  for (const item of job.items) {
    // Skip virtual items (damage charges, etc.)
    if (HIREHOP_VIRTUAL_ITEM_IDS.includes(item.ITEM_ID)) continue

    // MUST be in a vehicle category (370 = actual vehicles) to be considered
    const categoryId = item.CATEGORY_ID ?? 0
    if (!VEHICLE_CATEGORY_IDS.includes(categoryId)) continue

    // Only count actual vehicles (category 370), not headers (369) or accessories (371)
    if (categoryId !== VEHICLE_CATEGORY_ID) continue

    // Try known stock mapping first
    const mapping = HIREHOP_STOCK_MAPPINGS.find(m => m.stockId === item.ITEM_ID)
    if (mapping) {
      requirements.push({
        stockId: item.ITEM_ID,
        simpleType: mapping.simpleType,
        gearbox: mapping.gearbox,
        quantity: item.QUANTITY,
      })
      continue
    }

    // Fall back to name-based inference for unknown vehicle stock IDs
    const name = item.ITEM_NAME.toLowerCase()
    let simpleType = 'Premium'  // Default
    let gearbox: 'auto' | 'manual' = 'auto'

    if (name.includes('basic') || name.includes('mwb')) simpleType = 'Basic'
    else if (name.includes('vito')) simpleType = 'Vito'
    else if (name.includes('panel')) simpleType = 'Panel'

    if (name.includes('manual')) gearbox = 'manual'

    console.warn(`[hirehop-api] Vehicle item ${item.ITEM_ID} ("${item.ITEM_NAME}") not in STOCK_MAPPINGS, inferred: ${simpleType} ${gearbox}`)
    requirements.push({
      stockId: item.ITEM_ID,
      simpleType,
      gearbox,
      quantity: item.QUANTITY,
    })
  }

  return requirements
}

// ── Mapping ──

/**
 * Map raw HireHop API response to clean HireHopJob type.
 *
 * HireHop field names vary between endpoints (some use JOB_NAME, others job_name),
 * so we handle multiple conventions.
 *
 * @param raw - Raw HireHop API response object
 * @param items - Optional pre-fetched items (from items_to_supply_list.php)
 */
function mapHireHopJob(raw: Record<string, unknown>, items?: HireHopJobItem[]): HireHopJob {
  // search_list.php returns NUMBER (integer) and ID (string like "j6926")
  // job_refresh.php returns ID (string like "7017") — no JOB or NUMBER field
  // Handle all formats, preferring JOB > NUMBER > ID
  const jobId = Number(raw.JOB ?? raw.NUMBER ?? raw.ID ?? raw.id ?? raw.job ?? 0)
  if (jobId === 0 || isNaN(jobId)) {
    console.warn('[hirehop-api] mapHireHopJob: job ID is 0/NaN. Raw keys:', Object.keys(raw).join(', '))
    console.warn('[hirehop-api] Raw data sample:', JSON.stringify(raw).slice(0, 500))
  }

  const status = Number(raw.STATUS ?? raw.status ?? 0) as HireHopJobStatus

  // Use pre-fetched items if provided, otherwise parse from response
  let jobItems: HireHopJobItem[]
  if (items) {
    jobItems = items
  } else {
    const rawItems = raw.items || raw.ITEMS || []
    jobItems = (Array.isArray(rawItems) ? rawItems : Object.values(rawItems as Record<string, unknown>))
      .map((item: unknown): HireHopJobItem | null => {
        const i = item as Record<string, unknown>
        const itemId = Number(i.ITEM_ID ?? i.item_id ?? 0)
        if (!itemId) return null
        return {
          id: Number(i.id ?? 0),
          ITEM_ID: itemId,
          ITEM_NAME: String(i.ITEM_NAME ?? i.item_name ?? i.title ?? ''),
          QUANTITY: Number(i.QUANTITY ?? i.quantity ?? i.qty ?? 1),
          CATEGORY_ID: Number(i.CATEGORY_ID ?? 0),
        }
      })
      .filter((i): i is HireHopJobItem => i !== null)
  }

  // DEPOT can be a string ("Main Stock") or number — store as number only if numeric
  const depotRaw = raw.DEPOT ?? raw.depot
  const depotNum = depotRaw != null ? Number(depotRaw) : null
  const depot = depotNum != null && !isNaN(depotNum) ? depotNum : null

  // Normalize dates to YYYY-MM-DD — HireHop returns full datetime strings like "2026-03-08 19:00:00"
  const normalizeDate = (val: unknown): string => {
    if (!val) return ''
    const s = String(val)
    // Extract just the YYYY-MM-DD portion
    const match = s.match(/^(\d{4}-\d{2}-\d{2})/)
    return match ? match[1]! : ''
  }

  return {
    id: jobId,
    // search_list uses JOB_NAME; job_refresh uses JOB_NAME or NAME
    jobName: String(raw.JOB_NAME ?? raw.job_name ?? ''),
    // search_list uses COMPANY; job_refresh uses COMPANY
    company: String(raw.COMPANY ?? raw.company ?? ''),
    // search_list uses CLIENT for contact name; job_refresh uses NAME or CONTACT
    contactName: String(raw.CLIENT ?? raw.NAME ?? raw.name ?? raw.CONTACT ?? ''),
    contactEmail: String(raw.EMAIL ?? raw.email ?? ''),
    status,
    statusLabel: HIREHOP_STATUS_LABELS[status] || 'Unknown',
    outDate: normalizeDate(raw.OUT_DATE ?? raw.out_date),
    jobDate: normalizeDate(raw.JOB_DATE ?? raw.job_date),
    jobEndDate: normalizeDate(raw.JOB_END ?? raw.job_end),
    returnDate: normalizeDate(raw.RETURN_DATE ?? raw.return_date),
    items: jobItems,
    depot,
    notes: raw.NOTES ? String(raw.NOTES) : null,
  }
}
