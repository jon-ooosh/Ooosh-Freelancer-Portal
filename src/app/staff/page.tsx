'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Staff Area - PIN Entry Page
 * 
 * Similar to the warehouse PIN entry, this provides access to staff-only features
 * like the Crew & Transport costing wizard.
 * 
 * Supports:
 * - Return URL - redirects back to the page that sent user here after login
 * - Hub token - if arriving from Staff Hub with valid token, skip PIN entry
 */

// Inner component that uses useSearchParams (must be wrapped in Suspense)
function StaffLoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)

  // Get the return URL (stored by the page that redirected here)
  const getReturnUrl = (): string => {
    if (typeof window === 'undefined') return '/staff/crew-transport'
    const returnUrl = sessionStorage.getItem('staffReturnUrl')
    // Clear it so we don't keep redirecting to old URLs
    sessionStorage.removeItem('staffReturnUrl')
    
    if (returnUrl && returnUrl.includes('/staff/')) {
      try {
        // Extract just the path + query string from the full URL
        const url = new URL(returnUrl)
        return url.pathname + url.search
      } catch {
        // If URL parsing fails, try to extract path manually
        const staffIndex = returnUrl.indexOf('/staff/')
        if (staffIndex !== -1) {
          return returnUrl.substring(staffIndex)
        }
      }
    }
    return '/staff/crew-transport'
  }

  // Build return URL from current URL params (for hub token flow)
  const buildReturnUrlFromParams = (): string => {
    const job = searchParams.get('job')
    if (job) {
      return `/staff/crew-transport?job=${job}`
    }
    return '/staff/crew-transport'
  }

  // Validate hub token against the Staff Hub
  const validateHubToken = async (token: string): Promise<boolean> => {
    try {
      const response = await fetch('https://ooosh-utilities.netlify.app/.netlify/functions/validate-tool-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token, 
          toolId: 'crew-transport'  // This tool's ID
        }),
      })

      const data = await response.json()
      
      if (data.valid) {
        console.log('Hub token valid, job:', data.jobId)
        // Store a marker that indicates hub-authenticated session
        sessionStorage.setItem('staffPin', '__HUB_AUTH__')
        sessionStorage.setItem('hubJobId', data.jobId || '')
        return true
      }
      
      console.log('Hub token invalid:', data.error)
      return false
    } catch (err) {
      console.error('Hub token validation error:', err)
      return false
    }
  }

  // Check if already authenticated
  useEffect(() => {
    const checkAuth = async () => {
      // FIRST: Check for hub token in URL
      const hubToken = searchParams.get('hubToken')
      if (hubToken) {
        console.log('Hub token found, validating...')
        const isValid = await validateHubToken(hubToken)
        if (isValid) {
          // Get job ID from URL or from token validation
          const jobId = searchParams.get('job') || sessionStorage.getItem('hubJobId')
          const returnUrl = jobId ? `/staff/crew-transport?job=${jobId}` : '/staff/crew-transport'
          console.log('Hub auth success, redirecting to:', returnUrl)
          router.push(returnUrl)
          return
        }
        // If hub token invalid, fall through to normal PIN check
        console.log('Hub token invalid, falling back to PIN entry')
      }

      // SECOND: Check for existing PIN session
      const savedPin = sessionStorage.getItem('staffPin')
      if (savedPin) {
        // If it's a hub session marker, redirect directly (already validated)
        if (savedPin === '__HUB_AUTHENTICATED__') {
          const returnUrl = getReturnUrl() || buildReturnUrlFromParams()
          router.push(returnUrl)
          return
        }
        // Otherwise verify the saved PIN is still valid
        verifyPin(savedPin, true)
      } else {
        setCheckingSession(false)
      }
    }

    checkAuth()
  }, [searchParams])

  const verifyPin = async (pinToVerify: string, isAutoCheck = false) => {
    setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/staff/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinToVerify }),
      })

      const data = await response.json()

      if (data.success) {
        sessionStorage.setItem('staffPin', pinToVerify)
        // Redirect to return URL (with job number) or default
        const returnUrl = getReturnUrl()
        console.log('Staff auth success, redirecting to:', returnUrl)
        router.push(returnUrl)
      } else {
        if (!isAutoCheck) {
          setError('Incorrect PIN')
        }
        sessionStorage.removeItem('staffPin')
        setCheckingSession(false)
      }
    } catch (err) {
      console.error('Auth error:', err)
      if (!isAutoCheck) {
        setError('Something went wrong. Please try again.')
      }
      setCheckingSession(false)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length >= 4) {
      verifyPin(pin)
    }
  }

  // Show loading while checking existing session
  if (checkingSession) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Checking session...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🔐</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Staff Area</h1>
          <p className="text-gray-600 mt-2">Enter PIN to access staff tools</p>
        </div>

        {/* PIN Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="pin" className="block text-sm font-medium text-gray-700 mb-2">
              Staff PIN
            </label>
            <input
              type="password"
              id="pin"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter PIN"
              className="w-full px-4 py-3 text-lg text-center tracking-widest border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoComplete="off"
              autoFocus
            />
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || pin.length < 4}
            className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Verifying...
              </span>
            ) : (
              'Enter Staff Area'
            )}
          </button>
        </form>

        {/* Staff Tools Preview */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <p className="text-sm text-gray-500 text-center mb-4">Available tools:</p>
          <div className="grid grid-cols-1 gap-3">
            <div className="flex items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-2xl mr-3">🚚</span>
              <div>
                <p className="font-medium text-gray-900">Crew & Transport</p>
                <p className="text-sm text-gray-500">Quote deliveries, collections & crewed jobs</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Main export - wraps content in Suspense for useSearchParams
export default function StaffLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <StaffLoginContent />
    </Suspense>
  )
}