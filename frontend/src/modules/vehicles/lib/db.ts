/**
 * IndexedDB offline storage using idb.
 * Stores vehicles, events, pending sync queue, and form drafts.
 */

import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'ooosh-vehicles'
const DB_VERSION = 2

// ── Sync Queue ──

export interface SyncQueueItem {
  id: string
  type: 'book_out_submission' | 'check_in_submission' | 'collection_submission'
  payload: unknown
  createdAt: string
  retryCount: number
  status: 'pending' | 'processing' | 'failed'
}

// ── Form Drafts ──

export type DraftFlowType = 'book-out' | 'check-in' | 'collection'

export interface FormDraft {
  id: string // flowType used as key
  flowType: DraftFlowType
  step: number
  formData: Record<string, unknown>
  photos: Array<{
    angle: string
    label: string
    blob: Blob
    timestamp: number
    /** Capture-time PDF thumbnail (data URI) — optional, survives draft resume */
    pdfBase64?: string
  }>
  signatureBlob: Blob | null
  savedAt: string
  vehicleReg: string
}

// ── Pending Submissions (full form data queued for offline sync) ──

export interface PendingSubmission {
  id: string
  flowType: DraftFlowType
  formData: Record<string, unknown>
  photos: Array<{
    angle: string
    label: string
    blob: Blob
    timestamp: number
    /** Capture-time PDF thumbnail (data URI) — optional, survives draft resume */
    pdfBase64?: string
  }>
  signatureBlob: Blob | null
  createdAt: string
  retryCount: number
  status: 'pending' | 'processing' | 'failed'
  lastError?: string
  vehicleReg: string
}

// ── DB Schema ──

interface OooshDB {
  vehicles: {
    key: string
    value: {
      id: string
      name: string
      reg: string
      type: string
      data: Record<string, unknown>
      updatedAt: string
    }
    indexes: { 'by-reg': string }
  }
  events: {
    key: string
    value: {
      id: string
      vehicleId: string
      eventType: string
      data: Record<string, unknown>
      createdAt: string
    }
    indexes: { 'by-vehicle': string }
  }
  syncQueue: {
    key: string
    value: SyncQueueItem
    indexes: { 'by-type': string }
  }
  formDrafts: {
    key: string
    // A draft (key = flow type) or one of its photos (key `photo:<flow>:…`)
    value: StoredFormDraft | StoredDraftPhoto
  }
  pendingSubmissions: {
    key: string
    value: StoredPendingSubmission
    indexes: { 'by-status': string }
  }
}

let dbPromise: Promise<IDBPDatabase<OooshDB>> | null = null

export function getDB(): Promise<IDBPDatabase<OooshDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OooshDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 stores
        if (oldVersion < 1) {
          const vehicleStore = db.createObjectStore('vehicles', { keyPath: 'id' })
          vehicleStore.createIndex('by-reg', 'reg', { unique: true })

          const eventStore = db.createObjectStore('events', { keyPath: 'id' })
          eventStore.createIndex('by-vehicle', 'vehicleId')

          const syncStore = db.createObjectStore('syncQueue', { keyPath: 'id' })
          syncStore.createIndex('by-type', 'type')
        }

        // v2 stores
        if (oldVersion < 2) {
          db.createObjectStore('formDrafts', { keyPath: 'id' })

          const pendingStore = db.createObjectStore('pendingSubmissions', { keyPath: 'id' })
          pendingStore.createIndex('by-status', 'status')
        }
      },
    })
  }
  return dbPromise
}

// ── Sync queue operations (legacy — kept for compatibility) ──

export async function addToSyncQueue(item: Omit<SyncQueueItem, 'id' | 'createdAt' | 'retryCount' | 'status'>) {
  const db = await getDB()
  const entry: SyncQueueItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  }
  await db.put('syncQueue', entry)
  return entry
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  const db = await getDB()
  return db.getAll('syncQueue')
}

export async function removeSyncItem(id: string) {
  const db = await getDB()
  await db.delete('syncQueue', id)
}

export async function getSyncQueueCount(): Promise<number> {
  const db = await getDB()
  return db.count('syncQueue')
}

// ── Photo bytes (Nov 2026) ──
//
// iPhone Safari can lose a Blob kept in IndexedDB once it has reloaded the
// tab (phone locked, tab killed): the record comes back but the photo inside
// can no longer be read. RX22SXL / 16157: a book-out resumed at the signature
// page, 0 of 19 photos uploaded, and the photos were rebuilt from the PDF by
// hand. Plain bytes (ArrayBuffer) are kept reliably, so every photo and
// signature is stored as bytes and turned back into a Blob when read.
//
// Each draft photo is its own record in the formDrafts store, written ONCE
// when first saved (one photo's bytes in memory at a time) — an autosave then
// rewrites only the small draft record, never 20 photos. Same store rather
// than a new one: a new store needs a database upgrade, and an older Ooosh
// tab left open would block that upgrade until it was closed.

interface StoredBytes {
  bytes: ArrayBuffer
  type: string
}

interface StoredDraftPhoto extends StoredBytes {
  id: string // `photo:<flow>:<angle>:<timestamp>`
  kind: 'draft-photo'
  flowType: DraftFlowType
}

interface StoredDraftPhotoRef {
  angle: string
  label: string
  timestamp: number
  pdfBase64?: string
  /** Key of the StoredDraftPhoto holding the bytes */
  photoId?: string
  /** Drafts saved before Nov 2026 kept the Blob inline */
  blob?: Blob
}

interface StoredFormDraft {
  id: string
  flowType: DraftFlowType
  step: number
  formData: Record<string, unknown>
  photos: StoredDraftPhotoRef[]
  signature?: StoredBytes | null
  /** Drafts saved before Nov 2026 */
  signatureBlob?: Blob | null
  savedAt: string
  vehicleReg: string
}

type PendingPhoto = PendingSubmission['photos'][number]

interface StoredPendingSubmission extends Omit<PendingSubmission, 'photos' | 'signatureBlob'> {
  photos: Array<Omit<PendingPhoto, 'blob'> & { data?: StoredBytes; blob?: Blob }>
  signature?: StoredBytes | null
  /** Submissions queued before Nov 2026 */
  signatureBlob?: Blob | null
}

async function toBytes(blob: Blob): Promise<StoredBytes> {
  return { bytes: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' }
}

function fromBytes(s: StoredBytes): Blob {
  return new Blob([s.bytes], { type: s.type })
}

/** Can this Blob still be read? (An old inline Blob may not be, on an iPhone.) */
async function isReadable(blob: Blob): Promise<boolean> {
  try {
    await blob.slice(0, 1).arrayBuffer()
    return true
  } catch {
    return false
  }
}

function draftPhotoId(flowType: DraftFlowType, angle: string, timestamp: number): string {
  return `photo:${flowType}:${angle}:${timestamp}`
}

function draftPhotoRange(flowType: DraftFlowType): IDBKeyRange {
  return IDBKeyRange.bound(`photo:${flowType}:`, `photo:${flowType}:\uffff`)
}

// Draft writes run one at a time, in order. Two overlapping saves could
// otherwise have the older one delete a photo the newer one had just added,
// and a clear could land before a save still in flight.
let draftQueue: Promise<unknown> = Promise.resolve()
function inDraftQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = draftQueue.then(fn, fn)
  draftQueue = run.catch(() => undefined)
  return run
}

// ── Form draft operations ──

export function saveDraft(draft: FormDraft): Promise<void> {
  return inDraftQueue(async () => {
    const db = await getDB()
    const refs: StoredDraftPhotoRef[] = []
    const keep = new Set<string>()
    for (const p of draft.photos) {
      const photoId = draftPhotoId(draft.flowType, p.angle, p.timestamp)
      if ((await db.getKey('formDrafts', photoId)) === undefined) {
        try {
          const bytes = await toBytes(p.blob)
          await db.put('formDrafts', { id: photoId, kind: 'draft-photo', flowType: draft.flowType, ...bytes })
        } catch (err) {
          // Left off the draft; the form still holds it until the page closes.
          console.warn('[draft] Could not store photo', p.angle, err)
          continue
        }
      }
      keep.add(photoId)
      refs.push({ angle: p.angle, label: p.label, timestamp: p.timestamp, pdfBase64: p.pdfBase64, photoId })
    }

    let signature: StoredBytes | null = null
    if (draft.signatureBlob) {
      try { signature = await toBytes(draft.signatureBlob) } catch { signature = null }
    }

    const record: StoredFormDraft = {
      id: draft.id,
      flowType: draft.flowType,
      step: draft.step,
      formData: draft.formData,
      photos: refs,
      signature,
      savedAt: draft.savedAt,
      vehicleReg: draft.vehicleReg,
    }
    await db.put('formDrafts', record)

    // Photos retaken or removed since the last save
    const ids = await db.getAllKeys('formDrafts', draftPhotoRange(draft.flowType))
    for (const id of ids) {
      if (!keep.has(String(id))) await db.delete('formDrafts', id)
    }
  })
}

export function loadDraft(flowType: DraftFlowType): Promise<FormDraft | undefined> {
  return inDraftQueue(async () => {
    const db = await getDB()
    const rec = (await db.get('formDrafts', flowType)) as StoredFormDraft | undefined
    if (!rec) return undefined

    const photos: FormDraft['photos'] = []
    for (const p of rec.photos) {
      let blob: Blob | null = null
      if (p.photoId) {
        const stored = (await db.get('formDrafts', p.photoId)) as StoredDraftPhoto | undefined
        if (stored) blob = fromBytes(stored)
      } else if (p.blob && (await isReadable(p.blob))) {
        blob = p.blob
      }
      if (blob) {
        photos.push({ angle: p.angle, label: p.label, blob, timestamp: p.timestamp, pdfBase64: p.pdfBase64 })
      } else {
        // Dropped rather than restored broken: the photo then shows as still
        // to take, and the book-out won't submit without it.
        console.warn('[draft] Photo could not be restored:', p.angle)
      }
    }

    let signatureBlob: Blob | null = null
    if (rec.signature) signatureBlob = fromBytes(rec.signature)
    else if (rec.signatureBlob && (await isReadable(rec.signatureBlob))) signatureBlob = rec.signatureBlob

    return {
      id: rec.id,
      flowType: rec.flowType,
      step: rec.step,
      formData: rec.formData,
      photos,
      signatureBlob,
      savedAt: rec.savedAt,
      vehicleReg: rec.vehicleReg,
    }
  })
}

export function clearDraft(flowType: DraftFlowType): Promise<void> {
  return inDraftQueue(async () => {
    const db = await getDB()
    await db.delete('formDrafts', flowType)
    const ids = await db.getAllKeys('formDrafts', draftPhotoRange(flowType))
    for (const id of ids) await db.delete('formDrafts', id)
  })
}

export async function hasDraft(flowType: DraftFlowType): Promise<boolean> {
  const draft = await loadDraft(flowType)
  return draft !== undefined
}

// ── Pending submission operations ──

export async function addPendingSubmission(
  submission: Omit<PendingSubmission, 'id' | 'createdAt' | 'retryCount' | 'status'>,
): Promise<PendingSubmission> {
  const db = await getDB()
  const entry: PendingSubmission = {
    ...submission,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  }
  await db.put('pendingSubmissions', await pendingToStored(entry))
  return entry
}

/** Photos and signature as bytes (see "Photo bytes" above). Converted one at a time. */
async function pendingToStored(sub: PendingSubmission): Promise<StoredPendingSubmission> {
  const photos: StoredPendingSubmission['photos'] = []
  for (const p of sub.photos) {
    photos.push({ angle: p.angle, label: p.label, timestamp: p.timestamp, pdfBase64: p.pdfBase64, data: await toBytes(p.blob) })
  }
  const { signatureBlob, ...rest } = sub
  return { ...rest, photos, signature: signatureBlob ? await toBytes(signatureBlob) : null }
}

function pendingFromStored(rec: StoredPendingSubmission): PendingSubmission {
  const { signature, signatureBlob, photos, ...rest } = rec
  return {
    ...rest,
    photos: photos.flatMap(p => {
      const blob = p.data ? fromBytes(p.data) : p.blob
      return blob ? [{ angle: p.angle, label: p.label, timestamp: p.timestamp, pdfBase64: p.pdfBase64, blob }] : []
    }),
    signatureBlob: signature ? fromBytes(signature) : (signatureBlob ?? null),
  }
}

export async function getPendingSubmissions(): Promise<PendingSubmission[]> {
  const db = await getDB()
  return (await db.getAll('pendingSubmissions')).map(pendingFromStored)
}

export async function getPendingByStatus(status: PendingSubmission['status']): Promise<PendingSubmission[]> {
  const db = await getDB()
  return (await db.getAllFromIndex('pendingSubmissions', 'by-status', status)).map(pendingFromStored)
}

export async function updatePendingSubmission(submission: PendingSubmission): Promise<void> {
  const db = await getDB()
  await db.put('pendingSubmissions', await pendingToStored(submission))
}

export async function removePendingSubmission(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('pendingSubmissions', id)
}

export async function getPendingSubmissionCount(): Promise<number> {
  const db = await getDB()
  return db.count('pendingSubmissions')
}
