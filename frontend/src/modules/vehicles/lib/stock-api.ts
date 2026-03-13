/**
 * Client-side API wrappers for stock management (R2-backed).
 */

import type { StockData, StockItem, StockTransaction } from '../types/stock'
import { apiFetch } from '../config/api-config'

/** Fetch all stock items and recent transactions */
export async function getStock(): Promise<StockData> {
  try {
    const resp = await apiFetch('/get-stock')
    if (!resp.ok) return { items: [], transactions: [] }
    const data = await resp.json() as StockData
    return data
  } catch (err) {
    console.warn('[stock-api] Failed to fetch stock:', err)
    return { items: [], transactions: [] }
  }
}

/** Save the full stock state (items + new transactions) */
export async function saveStock(
  items: StockItem[],
  transactions: StockTransaction[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/save-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, transactions }),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `HTTP ${resp.status}` }
    }
    return { success: true }
  } catch (err) {
    console.warn('[stock-api] Failed to save stock:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/** Record a stock transaction and update item quantities */
export async function recordStockTransaction(
  transaction: StockTransaction,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/record-stock-transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction }),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `HTTP ${resp.status}` }
    }
    return { success: true }
  } catch (err) {
    console.warn('[stock-api] Failed to record transaction:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/** Record multiple consumption transactions from a prep session */
export async function recordPrepConsumption(
  transactions: StockTransaction[],
): Promise<{ success: boolean; consumed: number; error?: string }> {
  if (transactions.length === 0) return { success: true, consumed: 0 }

  try {
    const resp = await apiFetch('/record-stock-transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions }),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, consumed: 0, error: data.error || `HTTP ${resp.status}` }
    }
    return { success: true, consumed: transactions.length }
  } catch (err) {
    console.warn('[stock-api] Failed to record prep consumption:', err)
    return { success: false, consumed: 0, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/** Get stock items that are at or below reorder threshold */
export async function getLowStockItems(): Promise<StockItem[]> {
  const data = await getStock()
  return data.items.filter(item => item.currentStock <= item.reorderThreshold)
}
