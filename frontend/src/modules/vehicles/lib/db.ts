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
    value: FormDraft
  }
  pendingSubmissions: {
    key: string
    value: PendingSubmission
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

// ── Form draft operations ──

export async function saveDraft(draft: FormDraft): Promise<void> {
  const db = await getDB()
  await db.put('formDrafts', draft)
}

export async function loadDraft(flowType: DraftFlowType): Promise<FormDraft | undefined> {
  const db = await getDB()
  return db.get('formDrafts', flowType)
}

export async function clearDraft(flowType: DraftFlowType): Promise<void> {
  const db = await getDB()
  await db.delete('formDrafts', flowType)
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
  await db.put('pendingSubmissions', entry)
  return entry
}

export async function getPendingSubmissions(): Promise<PendingSubmission[]> {
  const db = await getDB()
  return db.getAll('pendingSubmissions')
}

export async function getPendingByStatus(status: PendingSubmission['status']): Promise<PendingSubmission[]> {
  const db = await getDB()
  return db.getAllFromIndex('pendingSubmissions', 'by-status', status)
}

export async function updatePendingSubmission(submission: PendingSubmission): Promise<void> {
  const db = await getDB()
  await db.put('pendingSubmissions', submission)
}

export async function removePendingSubmission(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('pendingSubmissions', id)
}

export async function getPendingSubmissionCount(): Promise<number> {
  const db = await getDB()
  return db.count('pendingSubmissions')
}
