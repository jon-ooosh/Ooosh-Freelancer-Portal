import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../../config/route-paths'
import { getLowStockItems } from '../../lib/stock-api'
import type { StockItem } from '../../types/stock'

/**
 * Shows a warning banner on the dashboard when stock items are at or below
 * their reorder threshold. Fetches on mount, doesn't poll.
 */
export function LowStockBanner() {
  const [lowItems, setLowItems] = useState<StockItem[]>([])

  useEffect(() => {
    getLowStockItems().then(setLowItems).catch(() => {})
  }, [])

  if (lowItems.length === 0) return null

  const outOfStock = lowItems.filter(i => i.currentStock === 0)
  const low = lowItems.filter(i => i.currentStock > 0)

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold text-amber-700">
            {outOfStock.length > 0
              ? `${outOfStock.length} item${outOfStock.length !== 1 ? 's' : ''} out of stock`
              : `${low.length} item${low.length !== 1 ? 's' : ''} running low`}
          </p>
          <p className="mt-0.5 text-xs text-amber-600">
            {lowItems.map(i => i.name).join(', ')}
          </p>
        </div>
        <Link
          to={vmPath('/settings')}
          className="flex-shrink-0 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 active:bg-amber-200"
        >
          View Stock
        </Link>
      </div>
    </div>
  )
}
