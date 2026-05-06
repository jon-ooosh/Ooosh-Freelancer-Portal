import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuthStore } from './hooks/useAuthStore';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PeoplePage from './pages/PeoplePage';
import PersonDetailPage from './pages/PersonDetailPage';
import OrganisationsPage from './pages/OrganisationsPage';
import OrganisationDetailPage from './pages/OrganisationDetailPage';
import VenuesPage from './pages/VenuesPage';
import VenueDetailPage from './pages/VenueDetailPage';
import JobsPage from './pages/JobsPage';
import JobDetailPage from './pages/JobDetailPage';
import ReturnsPage from './pages/ReturnsPage';
import PipelinePage from './pages/PipelinePage';
import SettingsPage from './pages/SettingsPage';
import ProfilePage from './pages/ProfilePage';
import DuplicatesPage from './pages/DuplicatesPage';
import DataCleanupPage from './pages/DataCleanupPage';
import DriversPage from './pages/DriversPage';
import DriverDetailPage from './pages/DriverDetailPage';
import TransportOpsPage from './pages/TransportOpsPage';
import BacklinePage from './pages/BacklinePage';
import IssuesPage from './pages/IssuesPage';
import ProblemsPage from './pages/ProblemsPage';
import ExcessLedgerPage from './pages/ExcessLedgerPage';
import VE103BCertificatesPage from './pages/VE103BCertificatesPage';
import InboxPage from './pages/InboxPage';
import LostCancelledPage from './pages/LostCancelledPage';
import FreelancerBookoutShell from './pages/FreelancerBookoutShell';
import WarehousePinPage from './pages/WarehousePinPage';
import WarehouseCollectionsPage from './pages/WarehouseCollectionsPage';
import OohReturnParkingPage from './pages/OohReturnParkingPage';
import WarehouseCollectionDetailPage from './pages/WarehouseCollectionDetailPage';
import Layout from './components/Layout';
import { VehicleRoutes, initVehicleModule } from './modules/vehicles';
import { BookOutPage as StaffBookOutPage } from './modules/vehicles/pages/BookOutPage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sharedRefreshToken } from './services/api';
import { getFreelancerSession, isFreelancerSessionActive } from './modules/vehicles/adapters/freelancer-session';

const staffBookOutQueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 60 * 2, retry: 1 } },
});

// Initialize Vehicle Module with OP auth and API config.
//
// getAuthHeaders picks the right token for the current mode:
//   - Staff logged in → staff JWT (even if a stale freelancer session is
//     also present in localStorage; staff session wins)
//   - Else freelancer session present → scoped freelancer JWT
//   - Else → no auth header
// This ordering stops a lingering freelancer session (up to 4h old) from
// accidentally piggy-backing on a staff user's API calls in the same
// browser.
initVehicleModule({
  apiBaseUrl: '/api/vehicles',
  getAuthHeaders: (): Record<string, string> => {
    const staffToken = useAuthStore.getState().accessToken;
    if (staffToken) return { Authorization: `Bearer ${staffToken}` };
    const freelancer = getFreelancerSession();
    if (freelancer) return { Authorization: `Bearer ${freelancer.token}` };
    return {};
  },
  authStoreGetter: () => useAuthStore.getState(),
  sharedRefreshToken: async () => {
    // Freelancer sessions don't refresh — they're one-shot, 4h TTL.
    // If a freelancer's JWT 401s, they have to go back to the portal
    // and get a new HMAC token. Skip the staff refresh path entirely.
    if (!useAuthStore.getState().accessToken && isFreelancerSessionActive()) {
      throw new Error('Freelancer session expired');
    }
    return sharedRefreshToken();
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

/**
 * Book-out entry point that decides between freelancer mode (portal
 * handoff, no staff JWT needed) and staff mode (normal protected route).
 * Freelancer mode is triggered by `?freelancerToken=` on the URL OR an
 * already-active freelancer session in localStorage.
 *
 * Staff mode renders BookOutPage directly (with its own QueryClient)
 * rather than going through VehicleRoutes, because this component is
 * the TERMINAL match for `/vehicles/book-out` — nesting VehicleRoutes
 * here would leave no remaining path for its internal Routes to match,
 * and we'd render HomePage by mistake.
 */
function BookOutEntry() {
  const [params] = useSearchParams();
  const hasFreelancerToken = params.has('freelancerToken') || isFreelancerSessionActive();
  if (hasFreelancerToken) {
    return <FreelancerBookoutShell />;
  }
  return (
    <ProtectedRoute>
      <Layout>
        <QueryClientProvider client={staffBookOutQueryClient}>
          <StaffBookOutPage />
        </QueryClientProvider>
      </Layout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public freelancer book-out entry — bypasses ProtectedRoute */}
      <Route path="/vehicles/book-out" element={<BookOutEntry />} />
      {/* Public OOH parking-confirmation form — token-authenticated, no Layout wrapper */}
      <Route path="/return-parking/:token" element={<OohReturnParkingPage />} />
      {/* Warehouse kiosk — own PIN-based session, no Layout wrapper */}
      <Route path="/warehouse" element={<WarehousePinPage />} />
      <Route path="/warehouse/collections" element={<WarehouseCollectionsPage />} />
      <Route path="/warehouse/collections/:jobId" element={<WarehouseCollectionDetailPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/people/:id" element={<PersonDetailPage />} />
                <Route path="/organisations" element={<OrganisationsPage />} />
                <Route path="/organisations/:id" element={<OrganisationDetailPage />} />
                <Route path="/venues" element={<VenuesPage />} />
                <Route path="/venues/:id" element={<VenueDetailPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/jobs/returns" element={<ReturnsPage />} />
                <Route path="/jobs/lost-cancelled" element={<LostCancelledPage />} />
                <Route path="/jobs/:id" element={<JobDetailPage />} />
                <Route path="/pipeline" element={<PipelinePage />} />
                <Route path="/operations/transport" element={<TransportOpsPage />} />
                <Route path="/operations/backline" element={<BacklinePage />} />
                <Route path="/operations/issues" element={<IssuesPage />} />
                <Route path="/operations/issues/:id" element={<IssuesPage />} />
                <Route path="/operations/problems" element={<ProblemsPage />} />
                <Route path="/drivers" element={<DriversPage />} />
                <Route path="/drivers/:id" element={<DriverDetailPage />} />
                <Route path="/people/duplicates" element={<DuplicatesPage />} />
                <Route path="/data-cleanup" element={<DataCleanupPage />} />
                <Route path="/money/excess" element={<ExcessLedgerPage />} />
                <Route path="/vehicles/ve103b" element={<VE103BCertificatesPage />} />
                <Route path="/vehicles/*" element={<VehicleRoutes />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/team" element={<Navigate to="/settings" replace />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
