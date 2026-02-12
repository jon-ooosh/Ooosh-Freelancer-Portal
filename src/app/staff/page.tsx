'use client'

/** 
 * Warehouse PIN Entry Page
 * 
 * Simple PIN-based authentication for in-house tablet use.
 * Once PIN is entered correctly, redirects to collections list.
 * PIN is stored in sessionStorage so it persists during the browser session.
 * 
 * Also supports authentication via Staff Hub token.
 */

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'

function WarehouseContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isCheckingSession, setIsCheckingSession] = useState(true)

  // Validate hub token against the Staff Hub
  const validateHubToken = async (token: string): Promise<boolean> => {
    try {
      console.log('Validating hub token for warehouse...')
      const response = await fetch('https://ooosh-utilities.netlify.app/.netlify/functions/validate-tool-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token, 
          toolId: 'warehouse'
        }),
      })

      const data = await response.json()
      console.log('Hub token validation response:', data)
      
      if (data.valid) {
        console.log('Hub token valid')
        // Store a marker so we know this is a hub-authenticated session
        sessionStorage.setItem('warehouse_pin', '__HUB_AUTH__')
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
        console.log('Hub token found in URL, validating...')
        const isValid = await validateHubToken(hubToken)
        if (isValid) {
          console.log('Hub auth success, redirecting to collections')
          router.push('/warehouse/collections')
          return
        }
        console.log('Hub token invalid, falling back to PIN entry')
      }

      // SECOND: Check for existing session
      const storedPin = sessionStorage.getItem('warehouse_pin')
      if (storedPin) {
        // If it's a hub session marker, redirect directly
        if (storedPin === '__HUB_AUTH__') {
          router.push('/warehouse/collections')
          return
        }
        // Otherwise verify the stored PIN is still valid
        verifyPin(storedPin, true)
      } else {
        setIsCheckingSession(false)
      }
    }

    checkAuth()
  }, [searchParams, router])

  async function verifyPin(pinToVerify: string, isAutoRedirect: boolean = false) {
    setIsLoading(true)
    setError('')

    try {
      const response = await fetch('/api/warehouse/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinToVerify }),
      })

      const data = await response.json()

      if (data.success) {
        sessionStorage.setItem('warehouse_pin', pinToVerify)
        router.push('/warehouse/collections')
      } else {
        if (!isAutoRedirect) {
          setError('Incorrect PIN')
        }
        sessionStorage.removeItem('warehouse_pin')
        setIsCheckingSession(false)
      }
    } catch (err) {
      console.error('PIN verification error:', err)
      if (!isAutoRedirect) {
        setError('Failed to verify PIN. Please try again.')
      }
      setIsCheckingSession(false)
    } finally {
      setIsLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pin.length < 4) {
      setError('PIN must be at least 4 digits')
      return
    }
    verifyPin(pin)
  }

  function handlePinChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value.replace(/\D/g, '') // Only digits
    setPin(value)
    setError('')
  }

  // Show loading while checking existing session
  if (isCheckingSession) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Checking session...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-purple-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Image
            src="/ooosh-tours-logo-small.png"
            alt="Ooosh Tours"
            width={120}
            height={120}
            className="mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-gray-800">Warehouse Collections</h1>
          <p className="text-gray-500 mt-2">Enter PIN to continue</p>
        </div>

        {/* PIN Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={handlePinChange}
              placeholder="Enter PIN"
              className={`w-full text-center text-3xl tracking-[0.5em] py-4 px-6 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 transition-colors ${
                error ? 'border-red-300 bg-red-50' : 'border-gray-200'
              }`}
              maxLength={8}
              autoFocus
              disabled={isLoading}
            />
            {error && (
              <p className="mt-2 text-center text-red-600 text-sm">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={isLoading || pin.length < 4}
            className="w-full bg-purple-600 text-white py-4 rounded-xl font-semibold text-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Verifying...
              </span>
            ) : (
              'Continue'
            )}
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-gray-400 text-sm mt-8">
          For staff use only
        </p>
      </div>
    </div>
  )
}

export default function WarehousePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <WarehouseContent />
    </Suspense>
  )
} 