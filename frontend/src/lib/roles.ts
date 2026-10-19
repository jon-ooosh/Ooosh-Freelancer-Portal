// Role helpers — single source of truth for privilege grouping on the frontend.
//
// weekend_manager has IDENTICAL privileges to manager (jon, Jun 2026 — one
// privilege level in our eyes). The backend enforces this structurally in
// authorize() (middleware/auth.ts); the frontend must mirror it so the UI a
// weekend_manager sees matches what the API will let them do.
//
// RULE: never write `role === 'manager'` for an RBAC gate — use hasManagerRole().
// For nav/role-array gates, use roleAllowed().

type Role = string | null | undefined;

// True for the manager privilege tier: admin, manager, weekend_manager.
export function hasManagerRole(role: Role): boolean {
  return role === 'admin' || role === 'manager' || role === 'weekend_manager';
}

// Does `role` satisfy a required-roles list, treating weekend_manager as
// manager? Use for nav items / components that carry a `roles: string[]`.
export function roleAllowed(role: Role, allowed: string[]): boolean {
  if (!role) return false;
  if (allowed.includes(role)) return true;
  // weekend_manager passes anywhere manager is allowed.
  return role === 'weekend_manager' && allowed.includes('manager');
}
