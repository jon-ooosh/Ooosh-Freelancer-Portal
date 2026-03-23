import { Routes, Route, Navigate } from 'react-router-dom';
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
import PipelinePage from './pages/PipelinePage';
import SettingsPage from './pages/SettingsPage';
import ProfilePage from './pages/ProfilePage';
import DuplicatesPage from './pages/DuplicatesPage';
import DataCleanupPage from './pages/DataCleanupPage';
import DriversPage from './pages/DriversPage';
import DriverDetailPage from './pages/DriverDetailPage';
import TransportOpsPage from './pages/TransportOpsPage';
import Layout from './components/Layout';
import { VehicleRoutes, initVehicleModule } from './modules/vehicles';

// Initialize Vehicle Module with OP auth and API config
initVehicleModule({
  apiBaseUrl: '/api/vehicles',
  getAuthHeaders: (): Record<string, string> => {
    const token = useAuthStore.getState().accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  authStoreGetter: () => useAuthStore.getState(),
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
                <Route path="/jobs/:id" element={<JobDetailPage />} />
                <Route path="/pipeline" element={<PipelinePage />} />
                <Route path="/operations/transport" element={<TransportOpsPage />} />
                <Route path="/drivers" element={<DriversPage />} />
                <Route path="/drivers/:id" element={<DriverDetailPage />} />
                <Route path="/people/duplicates" element={<DuplicatesPage />} />
                <Route path="/data-cleanup" element={<DataCleanupPage />} />
                <Route path="/vehicles/*" element={<VehicleRoutes />} />
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
