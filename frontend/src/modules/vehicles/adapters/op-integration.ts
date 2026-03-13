/**
 * Vehicle Module ↔ OP Integration
 *
 * Called once at app startup to configure the VM for embedded use inside the OP.
 * This file will be replaced by the VM's own op-integration.ts adapter.
 */

export interface VehicleModuleConfig {
  apiBaseUrl: string;
  getAuthHeaders: () => Record<string, string>;
  authStoreGetter: () => {
    user: { id: string; email: string; role: string; first_name: string; last_name: string } | null;
    accessToken: string | null;
    isAuthenticated: boolean;
  };
}

let _config: VehicleModuleConfig | null = null;

export function initVehicleModule(config: VehicleModuleConfig): void {
  _config = config;
  console.log('[VehicleModule] Initialized with apiBaseUrl:', config.apiBaseUrl);
}

export function getVehicleModuleConfig(): VehicleModuleConfig | null {
  return _config;
}
