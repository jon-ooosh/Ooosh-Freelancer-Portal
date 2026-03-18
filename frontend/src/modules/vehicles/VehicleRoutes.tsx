/**
 * VehicleRoutes — all VM routes bundled as a single catch-all component.
 *
 * Usage in the OP app:
 *   <Route path="/vehicles/*" element={<VehicleRoutes />} />
 *
 * In standalone mode, these routes are mounted directly in App.tsx.
 * In embedded mode, the OP mounts this component under /vehicles/*.
 *
 * All paths here are relative — React Router handles the nesting automatically.
 */

import { Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HomePage } from './pages/HomePage'
import { VehiclesPage } from './pages/VehiclesPage'
import { VehicleDetailPage } from './pages/VehicleDetailPage'
import { BookOutPage } from './pages/BookOutPage'
import { CheckInPage } from './pages/CheckInPage'
import { CollectionPage } from './pages/CollectionPage'
import { IssuesPage } from './pages/IssuesPage'
import { NewIssuePage } from './pages/NewIssuePage'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { AllocationsPage } from './pages/AllocationsPage'
import { PrepPage } from './pages/PrepPage'
import { FleetMapPage } from './pages/FleetMapPage'
import { SettingsPage } from './pages/SettingsPage'
import { CostReportPage } from './pages/CostReportPage'
import { VehicleSettingsPage } from './pages/VehicleSettingsPage'

/**
 * All Vehicle Management routes.
 *
 * When mounted at `/vehicles/*` in the OP app:
 *   /vehicles/           → Dashboard (HomePage)
 *   /vehicles/fleet      → Vehicle list
 *   /vehicles/fleet/:id  → Vehicle detail
 *   /vehicles/book-out   → Book-out wizard
 *   /vehicles/check-in   → Check-in wizard
 *   /vehicles/collection → Freelancer collection
 *   /vehicles/issues     → Issues list
 *   /vehicles/issues/new → New issue
 *   /vehicles/issues/:vehicleReg/:issueId → Issue detail
 *   /vehicles/allocations → Van-to-job allocations
 *   /vehicles/prep       → Vehicle prep
 *   /vehicles/fleet-map  → GPS fleet map
 *   /vehicles/settings   → VM settings
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      retry: 1,
    },
  },
})

export function VehicleRoutes() {
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="fleet" element={<VehiclesPage />} />
        <Route path="fleet/:id" element={<VehicleDetailPage />} />
        <Route path="fleet/:id/settings" element={<VehicleSettingsPage />} />
        <Route path="book-out" element={<BookOutPage />} />
        <Route path="check-in" element={<CheckInPage />} />
        <Route path="collection" element={<CollectionPage />} />
        <Route path="issues/new" element={<NewIssuePage />} />
        <Route path="issues/:vehicleReg/:issueId" element={<IssueDetailPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="allocations" element={<AllocationsPage />} />
        <Route path="prep" element={<PrepPage />} />
        <Route path="fleet-map" element={<FleetMapPage />} />
        <Route path="costs" element={<CostReportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </QueryClientProvider>
  )
}
