import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

// Routes that require authentication
const protectedRoutes = ['/dashboard', '/earnings', '/settings', '/job']

// Routes that should redirect to dashboard if already logged in
const authRoutes = ['/login', '/register']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const sessionToken = request.cookies.get('session')?.value

  // Check if user has a valid session
  let isAuthenticated = false
  
  if (sessionToken) {
    try {
      const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
      await jwtVerify(sessionToken, secret)
      isAuthenticated = true
    } catch {
      // Invalid or expired token
      isAuthenticated = false
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
