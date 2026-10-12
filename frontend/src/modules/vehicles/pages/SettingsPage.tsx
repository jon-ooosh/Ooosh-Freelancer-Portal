import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { StockManagement } from '../components/stock/StockManagement'
import { ChecklistSettings } from '../components/settings/ChecklistSettings'

// Checklists = the prep + driver-briefing checklist items PrepPage and
// BookOutPage read; Stock = the prep consumables behind the low-stock banner.
// The General (standalone-app leftovers) and Data (Monday prep import + a
// "wipe test data" button whose endpoints no longer exist) tabs were removed
// Oct 2026.
type SettingsTab = 'checklists' | 'stock'

export function SettingsPage() {
  // ?tab=stock — the low-stock banner's "View Stock" lands on the Stock tab.
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    searchParams.get('tab') === 'stock' ? 'stock' : 'checklists',
  )

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Settings</h2>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        <TabButton
          label="Checklists"
          active={activeTab === 'checklists'}
          onClick={() => setActiveTab('checklists')}
        />
        <TabButton
          label="Stock"
          active={activeTab === 'stock'}
          onClick={() => setActiveTab('stock')}
        />
      </div>

      {/* Checklists tab */}
      {activeTab === 'checklists' && <ChecklistSettings />}

      {/* Stock tab */}
      {activeTab === 'stock' && <StockManagement />}
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-white text-gray-900 shadow-sm'
          : 'text-gray-500 active:text-gray-700'
      }`}
    >
      {label}
    </button>
  )
}
