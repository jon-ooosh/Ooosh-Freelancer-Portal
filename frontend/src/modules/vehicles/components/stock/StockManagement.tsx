import { useState, useEffect, useCallback } from 'react'
import { getStock, saveStock, recordStockTransaction } from '../../lib/stock-api'
import type { StockItem, StockTransaction, StockCategory } from '../../types/stock'
import { STOCK_CATEGORIES } from '../../types/stock'

// ── Add / Edit Item Modal ──

function ItemModal({
  item,
  onSave,
  onCancel,
}: {
  item: StockItem | null  // null = adding new
  onSave: (item: StockItem) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(item?.name || '')
  const [category, setCategory] = useState<StockCategory>(item?.category || 'Fluids')
  const [unit, setUnit] = useState(item?.unit || 'units')
  const [currentStock, setCurrentStock] = useState(item?.currentStock?.toString() || '0')
  const [reorderThreshold, setReorderThreshold] = useState(item?.reorderThreshold?.toString() || '2')

  function handleSave() {
    if (!name.trim()) return
    const now = new Date().toISOString()
    onSave({
      id: item?.id || crypto.randomUUID(),
      name: name.trim(),
      category,
      currentStock: parseFloat(currentStock) || 0,
      unit: unit.trim() || 'units',
      reorderThreshold: parseFloat(reorderThreshold) || 0,
      updatedAt: now,
      updatedBy: 'admin',
      createdAt: item?.createdAt || now,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold">
          {item ? 'Edit Item' : 'Add Stock Item'}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. AdBlue 10L, H7 Headlight Bulb"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value as StockCategory)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              >
                {STOCK_CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
              <input
                value={unit}
                onChange={e => setUnit(e.target.value)}
                placeholder="litres, units, pairs"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Current Stock</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={currentStock}
                onChange={e => setCurrentStock(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Reorder At</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={reorderThreshold}
                onChange={e => setReorderThreshold(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 active:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex-1 rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-40 active:bg-opacity-90"
          >
            {item ? 'Save Changes' : 'Add Item'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Receive Stock Modal ──

function ReceiveModal({
  item,
  onReceive,
  onCancel,
}: {
  item: StockItem
  onReceive: (quantity: number, notes: string) => void
  onCancel: () => void
}) {
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <h3 className="mb-1 text-lg font-semibold">Receive Stock</h3>
        <p className="mb-4 text-sm text-gray-500">{item.name}</p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Quantity ({item.unit})
            </label>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Ordered from GSF"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 active:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const qty = parseFloat(quantity)
              if (qty > 0) onReceive(qty, notes)
            }}
            disabled={!quantity || parseFloat(quantity) <= 0}
            className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 active:bg-green-700"
          >
            Receive
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Transaction History ──

function TransactionHistory({
  transactions,
  onClose,
}: {
  transactions: StockTransaction[]
  onClose: () => void
}) {
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[80vh] rounded-xl bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="text-lg font-semibold">Stock History</h3>
          <button onClick={onClose} className="text-gray-400 active:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {sorted.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No transactions yet</p>
          ) : (
            <div className="space-y-2">
              {sorted.map(txn => (
                <div key={txn.id} className="flex items-start gap-3 rounded-lg border border-gray-100 p-3">
                  <span className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    txn.type === 'received'
                      ? 'bg-green-100 text-green-700'
                      : txn.type === 'consumed'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600'
                  }`}>
                    {txn.type === 'received' ? '+' : txn.type === 'consumed' ? '-' : '~'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium truncate">{txn.itemName}</span>
                      <span className={`text-sm font-mono whitespace-nowrap ${
                        txn.quantity > 0 ? 'text-green-600' : 'text-amber-600'
                      }`}>
                        {txn.quantity > 0 ? '+' : ''}{txn.quantity}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 mt-0.5">
                      <span className="text-xs text-gray-400">
                        {txn.createdBy}
                        {txn.vehicleReg && ` · ${txn.vehicleReg}`}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(txn.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    </div>
                    {txn.notes && (
                      <p className="text-xs text-gray-500 mt-0.5">{txn.notes}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Stock Management Component ──

export function StockManagement() {
  const [items, setItems] = useState<StockItem[]>([])
  const [transactions, setTransactions] = useState<StockTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Modal state
  const [editingItem, setEditingItem] = useState<StockItem | null | 'new'>(null)
  const [receivingItem, setReceivingItem] = useState<StockItem | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [filterCategory, setFilterCategory] = useState<StockCategory | 'All'>('All')

  const loadStock = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getStock()
      setItems(data.items)
      setTransactions(data.transactions)
    } catch {
      setError('Failed to load stock data')
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadStock() }, [loadStock])

  async function handleSaveItem(item: StockItem) {
    setSaving(true)
    const updated = items.some(i => i.id === item.id)
      ? items.map(i => i.id === item.id ? item : i)
      : [...items, item]

    const result = await saveStock(updated, transactions)
    if (result.success) {
      setItems(updated)
      setEditingItem(null)
    } else {
      setError(result.error || 'Failed to save')
    }
    setSaving(false)
  }

  async function handleDeleteItem(id: string) {
    const item = items.find(i => i.id === id)
    if (!item || !confirm(`Delete "${item.name}"? This cannot be undone.`)) return

    setSaving(true)
    const updated = items.filter(i => i.id !== id)
    const result = await saveStock(updated, transactions)
    if (result.success) {
      setItems(updated)
    } else {
      setError(result.error || 'Failed to delete')
    }
    setSaving(false)
  }

  async function handleReceive(quantity: number, notes: string) {
    if (!receivingItem) return
    setSaving(true)

    const txn: StockTransaction = {
      id: crypto.randomUUID(),
      itemId: receivingItem.id,
      itemName: receivingItem.name,
      type: 'received',
      quantity,
      notes: notes || undefined,
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    }

    const result = await recordStockTransaction(txn)
    if (result.success) {
      // Update local state
      setItems(prev => prev.map(i =>
        i.id === receivingItem.id
          ? { ...i, currentStock: i.currentStock + quantity, updatedAt: txn.createdAt }
          : i,
      ))
      setTransactions(prev => [...prev, txn])
      setReceivingItem(null)
    } else {
      setError(result.error || 'Failed to record')
    }
    setSaving(false)
  }

  const filtered = filterCategory === 'All'
    ? items
    : items.filter(i => i.category === filterCategory)

  const lowStockCount = items.filter(i => i.currentStock <= i.reorderThreshold).length

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Spares & Consumables</h3>
          {lowStockCount > 0 && (
            <p className="text-xs text-amber-600 font-medium mt-0.5">
              {lowStockCount} item{lowStockCount !== 1 ? 's' : ''} low on stock
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowHistory(true)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 active:bg-gray-50"
          >
            History
          </button>
          <button
            onClick={() => setEditingItem('new')}
            className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white active:bg-opacity-90"
          >
            + Add Item
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Category filter */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <FilterChip label="All" active={filterCategory === 'All'} count={items.length} onClick={() => setFilterCategory('All')} />
        {STOCK_CATEGORIES.map(cat => {
          const count = items.filter(i => i.category === cat).length
          if (count === 0) return null
          return <FilterChip key={cat} label={cat} active={filterCategory === cat} count={count} onClick={() => setFilterCategory(cat)} />
        })}
      </div>

      {/* Items list */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <p className="text-sm text-gray-400">
            {items.length === 0
              ? 'No stock items yet. Add your spares and consumables to get started.'
              : 'No items in this category.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <StockItemCard
              key={item.id}
              item={item}
              onEdit={() => setEditingItem(item)}
              onReceive={() => setReceivingItem(item)}
              onDelete={() => handleDeleteItem(item.id)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {editingItem && (
        <ItemModal
          item={editingItem === 'new' ? null : editingItem}
          onSave={handleSaveItem}
          onCancel={() => setEditingItem(null)}
        />
      )}
      {receivingItem && (
        <ReceiveModal
          item={receivingItem}
          onReceive={handleReceive}
          onCancel={() => setReceivingItem(null)}
        />
      )}
      {showHistory && (
        <TransactionHistory
          transactions={transactions}
          onClose={() => setShowHistory(false)}
        />
      )}

      {saving && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-gray-800 px-4 py-2 text-xs text-white shadow-lg">
          Saving...
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──

function FilterChip({
  label,
  active,
  count,
  onClick,
}: {
  label: string
  active: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-ooosh-navy text-white'
          : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-50'
      }`}
    >
      {label}
      <span className={`ml-1 ${active ? 'text-white/70' : 'text-gray-400'}`}>{count}</span>
    </button>
  )
}

function StockItemCard({
  item,
  onEdit,
  onReceive,
  onDelete,
}: {
  item: StockItem
  onEdit: () => void
  onReceive: () => void
  onDelete: () => void
}) {
  const isLow = item.currentStock <= item.reorderThreshold
  const isOut = item.currentStock === 0
  const [showActions, setShowActions] = useState(false)

  return (
    <div className={`rounded-lg border p-3 ${
      isOut
        ? 'border-red-200 bg-red-50'
        : isLow
          ? 'border-amber-200 bg-amber-50'
          : 'border-gray-200 bg-white'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{item.name}</span>
            <span className="flex-shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
              {item.category}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className={`text-lg font-bold ${
              isOut ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-gray-900'
            }`}>
              {item.currentStock}
            </span>
            <span className="text-xs text-gray-400">{item.unit}</span>
            {isLow && (
              <span className={`text-xs font-medium ${isOut ? 'text-red-600' : 'text-amber-600'}`}>
                {isOut ? 'OUT OF STOCK' : 'LOW STOCK'}
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-0.5">
            Reorder at {item.reorderThreshold} {item.unit}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onReceive}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white active:bg-green-700"
          >
            + Receive
          </button>
          <button
            onClick={() => setShowActions(!showActions)}
            className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-400 active:bg-gray-50"
          >
            ...
          </button>
        </div>
      </div>

      {showActions && (
        <div className="mt-2 flex gap-2 border-t border-gray-100 pt-2">
          <button
            onClick={() => { onEdit(); setShowActions(false) }}
            className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 active:bg-gray-50"
          >
            Edit
          </button>
          <button
            onClick={() => { onDelete(); setShowActions(false) }}
            className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 active:bg-red-50"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
