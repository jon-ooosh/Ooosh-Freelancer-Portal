/**
 * Types for the Spares & Consumables stock management system.
 */

export interface StockItem {
  id: string
  name: string                // "AdBlue 10L", "Engine Oil 5W-30", "Front Wiper Blade"
  category: StockCategory
  currentStock: number
  unit: string                // "litres", "units", "bottles", "pairs"
  reorderThreshold: number    // alert when stock falls to this level
  updatedAt: string           // ISO date
  updatedBy: string
  createdAt: string
}

export type StockCategory =
  | 'Fluids'
  | 'Bulbs'
  | 'Wipers'
  | 'Cleaning'
  | 'Safety Equipment'
  | 'Other'

export const STOCK_CATEGORIES: StockCategory[] = [
  'Fluids',
  'Bulbs',
  'Wipers',
  'Cleaning',
  'Safety Equipment',
  'Other',
]

export interface StockTransaction {
  id: string
  itemId: string
  itemName: string
  type: 'received' | 'consumed' | 'adjustment'
  quantity: number            // positive = added, negative = consumed
  notes?: string
  vehicleReg?: string         // set when consumed during prep
  prepEventId?: string
  createdAt: string
  createdBy: string
}

export interface StockData {
  items: StockItem[]
  transactions: StockTransaction[]
}

/**
 * Maps prep checklist detail prompts to stock consumption.
 * Key = checklist item name, value = how to derive consumption.
 */
export interface StockConsumptionMapping {
  checklistItemName: string   // e.g. "Oil Level"
  triggerOption: string        // e.g. "Topped up"
  stockItemCategory: StockCategory
  stockItemNamePattern: string // partial match against stock item name
  getQuantity: (detailValue: string) => number  // parse detail prompt value to litres/units
}

/** Fluid amount text -> approximate litres */
export function parseFluidAmount(text: string): number {
  if (!text) return 0
  if (text.includes('500ml') && text.startsWith('<')) return 0.3
  if (text.includes('500ml')) return 0.5
  if (text.includes('1.5L')) return 1.5
  if (text.includes('1L')) return 1
  if (text.includes('2L') && text.endsWith('+')) return 3
  if (text.includes('2L')) return 2
  if (text.includes('Full refill')) return 5
  return 0
}

/** Count items in a comma-separated multi-select */
export function countMultiSelect(text: string): number {
  if (!text) return 0
  return text.split(',').map(s => s.trim()).filter(Boolean).length
}
