/**
 * OP Integration — one-call setup for embedding VM in the OP (workplace) app.
 *
 * Call `initVehicleModule()` once in the OP app's entry point, before
 * rendering the <VehicleRoutes /> component.
 *
 * Example (in OP's App.tsx or module loader):
 *
 *   import { initVehicleModule } from './modules/vehicles/adapters/op-integration'
 *   import { useAuthStore } from './hooks/useAuthStore'
 *   import { VehicleRoutes } from './modules/vehicles/VehicleRoutes'
 *
 *   // Initialize once at app startup
 *   initVehicleModule({
 *     apiBaseUrl: '/api/vehicles',
 *     getAuthHeaders: () => {
 *       const token = useAuthStore.getState().accessToken
 *       return token ? { Authorization: `Bearer ${token}` } : {}
 *     },
 *     authStoreGetter: () => useAuthStore.getState(),
 *   })
 *
 *   // Then in routes:
 *   <Route path="/vehicles/*" element={<VehicleRoutes />} />
 */

import { configureApi } from '../config/api-config'
import { setOpAuthStore } from './auth-adapter'

interface VehicleModuleConfig {
  /**
   * Base URL for all VM backend calls.
   * In OP: '/api/vehicles' (Express routes that proxy to Netlify or handle directly).
   * Default: '/.netlify/functions' (standalone mode).
   */
  apiBaseUrl: string

  /**
   * Returns auth headers to attach to every API request.
   * In OP: reads the Bearer token from Zustand auth store.
   */
  getAuthHeaders: () => Record<string, string>

  /**
   * Getter for the OP's Zustand auth store state.
   * Used by the auth adapter to provide user info (name, email, role) to VM components.
   */
  authStoreGetter: () => {
    user: {
      id: string
      email: string
      role: string
      first_name: string
      last_name: string
    } | null
    accessToken: string | null
    isAuthenticated: boolean
    logout: () => void
  }
}

/**
 * Initialize the Vehicle Management module for embedded (OP) mode.
 * Must be called before any VM components render.
 */
export function initVehicleModule(config: VehicleModuleConfig) {
  // Configure API layer to use OP's backend + auth
  configureApi({
    baseUrl: config.apiBaseUrl,
    getAuthHeaders: config.getAuthHeaders,
  })

  // Inject OP auth store for the auth adapter
  setOpAuthStore(config.authStoreGetter)

  console.log('[vehicle-module] Initialized for OP integration', {
    apiBaseUrl: config.apiBaseUrl,
  })
}
