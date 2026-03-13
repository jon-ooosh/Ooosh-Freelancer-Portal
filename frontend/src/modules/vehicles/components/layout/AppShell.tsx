import { Outlet, NavLink, Link } from 'react-router-dom'
import { vmPath } from '../../config/route-paths'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { SyncQueueBanner } from './SyncQueueBanner'

const navItems = [
  { to: vmPath('/'), label: 'Home', icon: 'home' },
  { to: vmPath('/vehicles'), label: 'Vehicles', icon: 'vehicles' },
  { to: vmPath('/issues'), label: 'Issues', icon: 'issues' },
  { to: vmPath('/prep'), label: 'Prep', icon: 'prep' },
  { to: vmPath('/settings'), label: 'Settings', icon: 'settings' },
]

const icons: Record<string, string> = {
  home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
  vehicles: 'M8 7h8m-8 4h8m-8 4h4M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z',
  issues: 'M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  prep: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
}

export function AppShell() {
  const isOnline = useOnlineStatus()

  return (
    <div className="flex min-h-screen flex-col">
      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-white">
          You're offline — changes will sync when connection returns
        </div>
      )}

      {/* Sync queue banner (pending offline submissions) */}
      <SyncQueueBanner />

      {/* Header */}
      <header className="bg-ooosh-navy px-4 py-3 text-white">
        <Link to={vmPath('/')} className="flex items-center gap-2.5">
          <img src="/ooosh-logo.png" alt="Ooosh" className="h-8 w-auto" />
          <h1 className="text-lg font-semibold">Ooosh Vehicles</h1>
        </Link>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-4 pb-20">
        <Outlet />
      </main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white">
        <div className="mx-auto flex max-w-lg justify-around">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.label === 'Home'}
              className={({ isActive }) =>
                `flex flex-col items-center px-2 py-2 text-xs ${
                  isActive
                    ? 'text-ooosh-blue'
                    : 'text-gray-500 hover:text-gray-700'
                }`
              }
            >
              <svg
                className="mb-1 h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={icons[item.icon]}
                />
              </svg>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
