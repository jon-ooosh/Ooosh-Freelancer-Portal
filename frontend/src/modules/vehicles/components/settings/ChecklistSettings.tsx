import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../../hooks/useSettings'
import { saveSettings } from '../../lib/settings-api'
import type { ChecklistItem, DetailPrompt, SettingsData } from '../../lib/settings-api'
import { DEFAULT_CHECKLIST_SETTINGS } from '../../config/default-checklist-settings'

// ── Vehicle types ──
const VEHICLE_TYPES = ['All', 'Premium', 'Basic', 'Panel', 'Vito'] as const
const PREP_SECTIONS = ['Vehicle Exterior', 'Engine', 'Front Cab', 'Passenger Area', 'Boot'] as const
const INPUT_TYPES = [
  { value: 'options', label: 'Options (pick one)' },
  { value: 'number', label: 'Number input' },
  { value: 'text', label: 'Free text' },
] as const

type Category = 'briefing' | 'prep'

// ── Item Editor Modal ──

function ItemEditor({
  item,
  category,
  onSave,
  onCancel,
}: {
  item: ChecklistItem | null
  category: Category
  onSave: (item: ChecklistItem) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(item?.name || '')
  const [inputType, setInputType] = useState<'options' | 'number' | 'text'>(item?.inputType || 'options')
  const [optionsText, setOptionsText] = useState(item?.options?.join(', ') || '')
  const [flagText, setFlagText] = useState(item?.flagValues?.join(', ') || '')
  const [notes, setNotes] = useState(item?.notes || '')
  const [unit, setUnit] = useState(item?.unit || '')
  const [section, setSection] = useState(item?.section || '')
  const [detailPromptsJson, setDetailPromptsJson] = useState(() => {
    if (!item?.detailPrompts || Object.keys(item.detailPrompts).length === 0) return ''
    return JSON.stringify(item.detailPrompts, null, 2)
  })
  const [detailError, setDetailError] = useState('')

  const isPrepCategory = category === 'prep'

  function handleSave() {
    if (!name.trim()) return

    let detailPrompts: Record<string, DetailPrompt> = {}
    if (detailPromptsJson.trim()) {
      try {
        detailPrompts = JSON.parse(detailPromptsJson)
        setDetailError('')
      } catch {
        setDetailError('Invalid JSON')
        return
      }
    }

    const parsed = optionsText.split(',').map(s => s.trim()).filter(Boolean)
    const flags = flagText.split(',').map(s => s.trim()).filter(Boolean)

    onSave({
      name: name.trim(),
      inputType,
      options: inputType === 'options' ? parsed : [],
      flagValues: flags,
      notes: notes.trim(),
      unit: inputType === 'number' ? unit.trim() : '',
      section: isPrepCategory ? section : '',
      detailPrompts,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold">
          {item ? 'Edit Item' : 'Add Item'}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={category === 'briefing' ? "e.g. I've shown client how to use the deadlocks" : 'e.g. Bodywork'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              autoFocus
            />
          </div>

          {isPrepCategory && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Input Type</label>
                  <select
                    value={inputType}
                    onChange={e => setInputType(e.target.value as 'options' | 'number' | 'text')}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                  >
                    {INPUT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Section</label>
                  <select
                    value={section}
                    onChange={e => setSection(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                  >
                    <option value="">— Select —</option>
                    {PREP_SECTIONS.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {inputType === 'options' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Options <span className="text-gray-400">(comma-separated)</span>
                  </label>
                  <input
                    value={optionsText}
                    onChange={e => setOptionsText(e.target.value)}
                    placeholder="Ok, Problem"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                </div>
              )}

              {inputType === 'number' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                  <input
                    value={unit}
                    onChange={e => setUnit(e.target.value)}
                    placeholder="PSI, mm, etc."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Flag Values <span className="text-gray-400">(trigger issue creation, comma-separated)</span>
                </label>
                <input
                  value={flagText}
                  onChange={e => setFlagText(e.target.value)}
                  placeholder="Problem"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes (helper text)</label>
                <input
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. Should be 1/2 full"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Detail Prompts <span className="text-gray-400">(JSON, optional)</span>
                </label>
                <textarea
                  value={detailPromptsJson}
                  onChange={e => { setDetailPromptsJson(e.target.value); setDetailError('') }}
                  placeholder={'{\n  "Topped up": {\n    "label": "Amount added?",\n    "type": "options",\n    "choices": ["< 500ml", "~1L"]\n  }\n}'}
                  rows={4}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                {detailError && <p className="text-xs text-red-500 mt-1">{detailError}</p>}
              </div>
            </>
          )}
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
            disabled={!name.trim() || (isPrepCategory && !section)}
            className="flex-1 rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-40 active:bg-opacity-90"
          >
            {item ? 'Save Changes' : 'Add Item'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Checklist Item Row ──

function ItemRow({
  item,
  category,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  item: ChecklistItem
  category: Category
  onEdit: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const hasDetailPrompts = Object.keys(item.detailPrompts).length > 0

  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2">
      {/* Reorder arrows */}
      <div className="flex flex-col gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className="text-gray-400 disabled:opacity-20 active:text-gray-600"
          title="Move up"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className="text-gray-400 disabled:opacity-20 active:text-gray-600"
          title="Move down"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Item info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
        {category === 'prep' && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="text-[10px] text-gray-400">
              {item.inputType === 'number' ? `${item.unit}` : item.inputType === 'text' ? 'text' : item.options.join(' / ')}
            </span>
            {item.flagValues.length > 0 && (
              <span className="text-[10px] text-red-400">flags: {item.flagValues.join(', ')}</span>
            )}
            {hasDetailPrompts && (
              <span className="text-[10px] text-blue-400">has detail prompts</span>
            )}
            {item.notes && (
              <span className="text-[10px] text-gray-400 italic">{item.notes}</span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <button
        onClick={onEdit}
        className="shrink-0 rounded-md p-1.5 text-gray-400 active:bg-gray-100 active:text-gray-600"
        title="Edit"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 rounded-md p-1.5 text-gray-400 active:bg-red-50 active:text-red-500"
        title="Delete"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  )
}

// ── Main Component ──

export function ChecklistSettings() {
  const queryClient = useQueryClient()
  const { data: settings, isLoading, error } = useSettings()

  const [category, setCategory] = useState<Category>('briefing')
  const [selectedType, setSelectedType] = useState('All')
  const [editingItem, setEditingItem] = useState<ChecklistItem | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  // Local working copy of settings
  const [localSettings, setLocalSettings] = useState<SettingsData | null>(null)
  const [hasChanges, setHasChanges] = useState(false)

  // Initialize local settings from fetched data or defaults
  useEffect(() => {
    if (settings && !localSettings) {
      const hasData = Object.keys(settings.briefingItems).length > 0 ||
                      Object.keys(settings.prepItems).length > 0
      setLocalSettings(hasData ? settings : DEFAULT_CHECKLIST_SETTINGS)
    }
  }, [settings, localSettings])

  // Current items for the selected category + type
  const currentItems = useMemo(() => {
    if (!localSettings) return []
    const map = category === 'briefing' ? localSettings.briefingItems : localSettings.prepItems
    return map[selectedType] || []
  }, [localSettings, category, selectedType])

  // Group prep items by section for display
  const groupedItems = useMemo(() => {
    if (category !== 'prep') return null
    const groups: { section: string; items: { item: ChecklistItem; index: number }[] }[] = []
    const sectionOrder: string[] = []
    const sectionMap: Record<string, { item: ChecklistItem; index: number }[]> = {}
    currentItems.forEach((item, index) => {
      const s = item.section || 'General'
      if (!sectionMap[s]) {
        sectionOrder.push(s)
        sectionMap[s] = []
      }
      sectionMap[s]!.push({ item, index })
    })
    for (const s of sectionOrder) {
      groups.push({ section: s, items: sectionMap[s]! })
    }
    return groups
  }, [category, currentItems])

  const updateItems = useCallback((newItems: ChecklistItem[]) => {
    setLocalSettings(prev => {
      if (!prev) return prev
      const key = category === 'briefing' ? 'briefingItems' : 'prepItems'
      return {
        ...prev,
        [key]: {
          ...prev[key],
          [selectedType]: newItems,
        },
      }
    })
    setHasChanges(true)
  }, [category, selectedType])

  const handleSaveItem = useCallback((saved: ChecklistItem) => {
    const items = [...currentItems]
    if (editingItem) {
      const idx = items.findIndex(i => i.name === editingItem.name)
      if (idx >= 0) items[idx] = saved
    } else {
      items.push(saved)
    }
    updateItems(items)
    setEditingItem(null)
    setIsAdding(false)
  }, [currentItems, editingItem, updateItems])

  const handleDelete = useCallback((name: string) => {
    updateItems(currentItems.filter(i => i.name !== name))
    setDeleteConfirm(null)
  }, [currentItems, updateItems])

  const handleMove = useCallback((index: number, direction: -1 | 1) => {
    const items = [...currentItems]
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= items.length) return
    ;[items[index], items[newIndex]] = [items[newIndex]!, items[index]!]
    updateItems(items)
  }, [currentItems, updateItems])

  const handleSaveToR2 = useCallback(async () => {
    if (!localSettings) return
    setSaving(true)
    setSaveMessage('')
    const result = await saveSettings(localSettings)
    setSaving(false)
    if (result.success) {
      setHasChanges(false)
      setSaveMessage('Saved!')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setTimeout(() => setSaveMessage(''), 2000)
    } else {
      setSaveMessage(`Error: ${result.error}`)
    }
  }, [localSettings, queryClient])

  const handleResetToDefaults = useCallback(() => {
    if (!window.confirm('Reset all checklist settings to defaults? This will overwrite your current settings.')) return
    setLocalSettings(DEFAULT_CHECKLIST_SETTINGS)
    setHasChanges(true)
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-ooosh-navy" />
      </div>
    )
  }

  if (error && !localSettings) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
        Failed to load settings. Using defaults.
        <button
          onClick={() => setLocalSettings(DEFAULT_CHECKLIST_SETTINGS)}
          className="ml-2 font-medium underline"
        >
          Load defaults
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Category toggle */}
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => { setCategory('briefing'); setSelectedType('All') }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            category === 'briefing'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 active:text-gray-700'
          }`}
        >
          Briefing
        </button>
        <button
          onClick={() => { setCategory('prep'); setSelectedType('All') }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            category === 'prep'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 active:text-gray-700'
          }`}
        >
          Prep
        </button>
      </div>

      {/* Vehicle type filter */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {VEHICLE_TYPES.map(type => (
          <button
            key={type}
            onClick={() => setSelectedType(type)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              selectedType === type
                ? 'bg-ooosh-navy text-white'
                : 'bg-gray-100 text-gray-600 active:bg-gray-200'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Items list */}
      <div className="space-y-1.5">
        {category === 'prep' && groupedItems ? (
          groupedItems.map(group => (
            <div key={group.section}>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 mt-3 first:mt-0">
                {group.section}
              </h4>
              {group.items.map(({ item, index }) => (
                <div key={item.name} className="mb-1.5">
                  <ItemRow
                    item={item}
                    category={category}
                    onEdit={() => setEditingItem(item)}
                    onDelete={() => setDeleteConfirm(item.name)}
                    onMoveUp={() => handleMove(index, -1)}
                    onMoveDown={() => handleMove(index, 1)}
                    isFirst={index === 0}
                    isLast={index === currentItems.length - 1}
                  />
                </div>
              ))}
            </div>
          ))
        ) : (
          currentItems.map((item, index) => (
            <ItemRow
              key={item.name}
              item={item}
              category={category}
              onEdit={() => setEditingItem(item)}
              onDelete={() => setDeleteConfirm(item.name)}
              onMoveUp={() => handleMove(index, -1)}
              onMoveDown={() => handleMove(index, 1)}
              isFirst={index === 0}
              isLast={index === currentItems.length - 1}
            />
          ))
        )}

        {currentItems.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-400">
            No {category} items for {selectedType}
          </p>
        )}
      </div>

      {/* Add item button */}
      <button
        onClick={() => { setEditingItem(null); setIsAdding(true) }}
        className="w-full rounded-lg border-2 border-dashed border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-500 transition-colors active:border-gray-300 active:text-gray-700"
      >
        + Add {category === 'briefing' ? 'Briefing' : 'Prep'} Item
      </button>

      {/* Save bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSaveToR2}
          disabled={!hasChanges || saving}
          className="flex-1 rounded-lg bg-ooosh-navy px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 active:bg-opacity-90"
        >
          {saving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
        </button>
        <button
          onClick={handleResetToDefaults}
          className="rounded-lg border border-gray-200 px-3 py-2.5 text-xs font-medium text-gray-500 active:bg-gray-50"
          title="Reset to default items"
        >
          Reset
        </button>
      </div>
      {saveMessage && (
        <p className={`text-sm ${saveMessage.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
          {saveMessage}
        </p>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold">Delete Item</h3>
            <p className="mb-4 text-sm text-gray-600">
              Delete &ldquo;{deleteConfirm}&rdquo;? This won&apos;t take effect until you save.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 active:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="flex-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white active:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item editor modal */}
      {(editingItem || isAdding) && (
        <ItemEditor
          item={editingItem}
          category={category}
          onSave={handleSaveItem}
          onCancel={() => { setEditingItem(null); setIsAdding(false) }}
        />
      )}
    </div>
  )
}
