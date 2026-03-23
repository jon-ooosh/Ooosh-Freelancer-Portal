import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

// Routes that require authentication
const protectedRoutes = ['/dashboard', '/earnings', '/settings', '/job']

// Routes that should redirect to dashboard if already logged in
const authRoutes = ['/login', '/register']

// Cache the encoded secret to avoid re-encoding on every request
let cachedSecret: Uint8Array | null = null

function getSecret(): Uint8Array | null {
  if (cachedSecret) return cachedSecret

  const secret = process.env.SESSION_SECRET
  if (!secret) {
    console.error('Middleware: SESSION_SECRET environment variable is not set — all sessions will fail verification')
    return null
  }

  cachedSecret = new TextEncoder().encode(secret)
  return cachedSecret
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const sessionToken = request.cookies.get('session')?.value

  // Check if user has a valid session
  let isAuthenticated = false

  if (sessionToken) {
    const secret = getSecret()
    if (secret) {
      try {
        await jwtVerify(sessionToken, secret)
        isAuthenticated = true
      } catch (err) {
        // Invalid or expired token — clear the stale cookie on protected routes
        // so the user doesn't get stuck in a redirect loop
        const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route))
        if (isProtectedRoute) {
          console.error('Middleware: Session verification failed for', pathname, '- clearing stale cookie')
          const loginUrl = new URL('/login', request.url)
          loginUrl.searchParams.set('from', pathname)
          const response = NextResponse.redirect(loginUrl)
          response.cookies.delete('session')
          return response
        }
        isAuthenticated = false
      }
    }
  }

  // Protect dashboard and other authenticated routes
  const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route))
  if (isProtectedRoute && !isAuthenticated) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Redirect logged-in users away from auth pages
  const isAuthRoute = authRoutes.some(route => pathname.startsWith(route))
  if (isAuthRoute && isAuthenticated) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/earnings/:path*',
    '/settings/:path*',
    '/job/:path*',
    '/login',
    '/register',
  ],
}
