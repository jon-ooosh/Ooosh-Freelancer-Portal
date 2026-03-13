/**
 * Route path resolver — maps VM internal paths for standalone vs embedded mode.
 *
 * Standalone mode: paths are at root (/, /vehicles, /issues, etc.)
 * Embedded mode:   paths are under /vehicles/* (/vehicles, /vehicles/fleet, /vehicles/issues, etc.)
 *
 * All <Link to="..."> in VM pages should use vmPath() to resolve paths.
 */

import { isEmbeddedMode } from '../adapters/auth-adapter'

/** Map from standalone route to embedded route suffix (after /vehicles) */
const EMBEDDED_ROUTES: Record<string, string> = {
  '/': '/vehicles',
  '/vehicles': '/vehicles/fleet',
  '/issues': '/vehicles/issues',
  '/issues/new': '/vehicles/issues/new',
  '/prep': '/vehicles/prep',
  '/allocations': '/vehicles/allocations',
  '/settings': '/vehicles/settings',
  '/book-out': '/vehicles/book-out',
  '/check-in': '/vehicles/check-in',
  '/collection': '/vehicles/collection',
  '/fleet-map': '/vehicles/fleet-map',
}

/**
 * Resolve a VM route path for the current mode.
 *
 * Usage: <Link to={vmPath('/vehicles')}>Fleet</Link>
 *
 * Standalone: vmPath('/vehicles')   → '/vehicles'
 * Embedded:   vmPath('/vehicles')   → '/vehicles/fleet'
 *
 * Standalone: vmPath('/')           → '/'
 * Embedded:   vmPath('/')           → '/vehicles'
 */
export function vmPath(standaloneRoute: string): string {
  if (!isEmbeddedMode()) return standaloneRoute

  // Exact match
  const mapped = EMBEDDED_ROUTES[standaloneRoute]
  if (mapped) return mapped

  // Handle query params: strip them, map the path, re-append
  const qIdx = standaloneRoute.indexOf('?')
  if (qIdx >= 0) {
    const path = standaloneRoute.slice(0, qIdx)
    const query = standaloneRoute.slice(qIdx)
    const mappedPath = EMBEDDED_ROUTES[path]
    if (mappedPath) return mappedPath + query
  }

  // Dynamic routes: /vehicles/:id → /vehicles/fleet/:id
  if (standaloneRoute.startsWith('/vehicles/')) {
    return '/vehicles/fleet' + standaloneRoute.slice('/vehicles'.length)
  }

  // /issues/:reg/:id → /vehicles/issues/:reg/:id
  if (standaloneRoute.startsWith('/issues/')) {
    return '/vehicles' + standaloneRoute
  }

  // Fallback: prefix with /vehicles
  return '/vehicles' + standaloneRoute
}
