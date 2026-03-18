import { useState } from 'react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useAuth } from '../hooks/useAuth'
import { StockManagement } from '../components/stock/StockManagement'
import { ChecklistSettings } from '../components/settings/ChecklistSettings'
import { DataManagement } from '../components/admin/DataManagement'

type SettingsTab = 'general' | 'checklists' | 'stock' | 'data'

export function SettingsPage() {
  const isOnline = useOnlineStatus()
  const { logout } = useAuth()
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Settings</h2>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        <TabButton
          label="General"
          active={activeTab === 'general'}
          onClick={() => setActiveTab('general')}
        />
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
        <TabButton
          label="Data"
          active={activeTab === 'data'}
          onClick={() => setActiveTab('data')}
        />
      </div>

      {/* General tab */}
      {activeTab === 'general' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 font-medium">Connection Status</h3>
            <div className="flex items-center gap-2">
              <span
                className={`h-3 w-3 rounded-full ${
                  isOnline ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className="text-sm">
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 font-medium">Sync Status</h3>
            <p className="text-sm text-gray-500">No pending items</p>
          </div>

          <button
            onClick={logout}
            className="w-full rounded-lg border border-red-200 bg-white px-4 py-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
          >
            Log Out
          </button>
        </div>
      )}

      {/* Checklists tab */}
      {activeTab === 'checklists' && <ChecklistSettings />}

      {/* Stock tab */}
      {activeTab === 'stock' && <StockManagement />}

      {/* Data tab */}
      {activeTab === 'data' && <DataManagement />}
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
