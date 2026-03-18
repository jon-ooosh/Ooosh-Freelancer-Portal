/**
 * Vehicle Management Module — public API.
 *
 * When embedding VM in the OP app, import from this file:
 *
 *   import { VehicleRoutes, initVehicleModule } from './modules/vehicles'
 */

// Route bundle — mount at /vehicles/* in the OP app
export { VehicleRoutes } from './VehicleRoutes'

// OP integration — call once before rendering VehicleRoutes
export { initVehicleModule } from './adapters/op-integration'

// API config — for advanced use (e.g. custom base URL without full OP integration)
export { configureApi, getApiBase } from './config/api-config'

// Auth adapter — for components that need user info
export { getOpAuthState, isEmbeddedMode } from './adapters/auth-adapter'
export type { AuthAdapterState } from './adapters/auth-adapter'

// Route path resolver — for building links that work in both modes
export { vmPath } from './config/route-paths'
