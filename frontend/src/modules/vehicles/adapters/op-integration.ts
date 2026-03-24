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
    refreshToken?: string | null
    isAuthenticated: boolean
    logout: () => void
    setTokens?: (accessToken: string, refreshToken: string) => void
  }

  /**
   * Optional: shared token refresh function from the OP's api.ts.
   * Using a shared refresh prevents race conditions when both
   * the OP main API and vehicle module try to refresh simultaneously.
   */
  sharedRefreshToken?: () => Promise<Record<string, string>>
}

/**
 * Initialize the Vehicle Management module for embedded (OP) mode.
 * Must be called before any VM components render.
 */
export function initVehicleModule(config: VehicleModuleConfig) {
  // Configure API layer to use OP's backend + auth + auto-refresh
  // Use shared refresh from OP's api.ts to prevent double-refresh race conditions
  configureApi({
    baseUrl: config.apiBaseUrl,
    getAuthHeaders: config.getAuthHeaders,
    refreshToken: config.sharedRefreshToken || (async () => {
      // Fallback: own refresh logic (standalone mode)
      const state = config.authStoreGetter()
      if (!state.refreshToken || !state.setTokens) {
        throw new Error('No refresh token or setTokens method')
      }

      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      })

      if (!response.ok) {
        state.logout()
        window.location.href = '/login'
        throw new Error('Session expired')
      }

      const tokens = await response.json()
      state.setTokens!(tokens.accessToken, tokens.refreshToken)
      return { Authorization: `Bearer ${tokens.accessToken}` }
    }),
  })

  // Inject OP auth store for the auth adapter
  setOpAuthStore(config.authStoreGetter)

  console.log('[vehicle-module] Initialized for OP integration', {
    apiBaseUrl: config.apiBaseUrl,
  })
}
