/**
 * Maps prep checklist responses to stock consumption transactions.
 *
 * After a prep session, this module examines which items were "topped up"
 * or "replaced" and creates corresponding stock deduction transactions.
 */

import type { StockItem, StockTransaction } from '../types/stock'
import { parseFluidAmount, countMultiSelect } from '../types/stock'

interface PrepItemResponse {
  name: string          // checklist item name
  value: string         // selected option
  detail?: string       // detail prompt response (e.g. "~1L" for fluid amount)
}

/**
 * Mapping rules: checklist item name -> how to find the stock item and quantity.
 * Uses partial matching on stock item names so users can name items freely
 * (e.g. "Engine Oil 5W-30" matches keyword "oil").
 */
interface ConsumptionRule {
  /** Checklist item name (exact match) */
  checklistItem: string
  /** Option value that triggers consumption */
  triggerOption: string
  /** Keywords to match against stock item name (case-insensitive, any match) */
  stockKeywords: string[]
  /** How to derive quantity from the detail prompt value */
  getQuantity: (detailValue: string) => number
}

const CONSUMPTION_RULES: ConsumptionRule[] = [
  // Fluids
  {
    checklistItem: 'Oil level',
    triggerOption: 'Topped up',
    stockKeywords: ['oil'],
    getQuantity: parseFluidAmount,
  },
  {
    checklistItem: 'Water / coolant level',
    triggerOption: 'Topped up',
    stockKeywords: ['coolant', 'antifreeze'],
    getQuantity: parseFluidAmount,
  },
  {
    checklistItem: 'Screen wash level',
    triggerOption: 'Topped up',
    stockKeywords: ['screen wash', 'screenwash'],
    getQuantity: parseFluidAmount,
  },
  {
    checklistItem: 'Ad Blue level',
    triggerOption: 'Topped up',
    stockKeywords: ['adblue', 'ad blue'],
    getQuantity: parseFluidAmount,
  },
  // Bulbs
  {
    checklistItem: 'Headlights',
    triggerOption: 'Replaced bulb(s) & now all working',
    stockKeywords: ['headlight bulb', 'h7', 'h4', 'h1'],
    getQuantity: countMultiSelect,
  },
  {
    checklistItem: 'Indicators',
    triggerOption: 'Replaced bulb(s) & now all working',
    stockKeywords: ['indicator bulb'],
    getQuantity: countMultiSelect,
  },
  {
    checklistItem: 'Rear lights',
    triggerOption: 'Replaced bulb(s) & now all working',
    stockKeywords: ['rear light bulb', 'tail light bulb', 'brake light bulb'],
    getQuantity: countMultiSelect,
  },
  // Wipers
  {
    checklistItem: 'Windscreen wipers',
    triggerOption: 'Replaced wiper(s) & now all working',
    stockKeywords: ['wiper'],
    getQuantity: countMultiSelect,
  },
]

/**
 * Given prep responses and current stock items, build consumption transactions.
 * Only creates transactions for items that exist in stock.
 */
export function buildConsumptionTransactions(
  responses: PrepItemResponse[],
  stockItems: StockItem[],
  context: {
    vehicleReg: string
    prepEventId: string
    preparedBy: string
  },
): StockTransaction[] {
  const transactions: StockTransaction[] = []
  const now = new Date().toISOString()

  for (const rule of CONSUMPTION_RULES) {
    const response = responses.find(
      r => r.name === rule.checklistItem && r.value === rule.triggerOption,
    )
    if (!response) continue

    const quantity = rule.getQuantity(response.detail || '')
    if (quantity <= 0) continue

    // Find matching stock item
    const matchedItem = stockItems.find(item =>
      rule.stockKeywords.some(kw =>
        item.name.toLowerCase().includes(kw.toLowerCase()),
      ),
    )
    if (!matchedItem) continue

    transactions.push({
      id: crypto.randomUUID(),
      itemId: matchedItem.id,
      itemName: matchedItem.name,
      type: 'consumed',
      quantity: -quantity,
      notes: `${rule.checklistItem}: ${response.detail || response.value}`,
      vehicleReg: context.vehicleReg,
      prepEventId: context.prepEventId,
      createdAt: now,
      createdBy: context.preparedBy,
    })
  }

  return transactions
}
