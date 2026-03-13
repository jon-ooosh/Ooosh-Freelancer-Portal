import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../config/api-config'
import { useAuth } from '../hooks/useAuth'

export function LoginPage() {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()
  const formRef = useRef<HTMLFormElement>(null)

  const handleSubmit = useCallback(async (pinToSubmit: string) => {
    if (!pinToSubmit.trim()) return

    setLoading(true)
    setError('')

    try {
      const response = await apiFetch('/staff-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinToSubmit }),
      })

      const data = (await response.json()) as {
        success: boolean
        sessionToken?: string
        expiresAt?: string
        error?: string
      }

      if (data.success && data.sessionToken) {
        login(data.sessionToken, data.expiresAt!)
      } else {
        setError(data.error || 'Invalid PIN')
        setPin('')
      }
    } catch {
      setError('Connection error — are you online?')
    } finally {
      setLoading(false)
    }
  }, [login])

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit(pin)
  }

  const handlePinInput = (digit: string) => {
    if (pin.length < 6) {
      setPin((prev) => prev + digit)
    }
  }

  const handleBackspace = () => {
    setPin((prev) => prev.slice(0, -1))
  }

  // Keyboard support — listen for number keys, backspace, and enter
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (loading) return

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault()
        handlePinInput(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        handleBackspace()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (pin.length > 0) {
          handleSubmit(pin)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ooosh-navy px-4">
      <div className="w-full max-w-xs">
        {/* Logo / Title */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-white">Ooosh Vehicles</h1>
          <p className="mt-1 text-sm text-blue-200">Enter staff PIN to continue</p>
        </div>

        {/* PIN display */}
        <div className="mb-6 flex justify-center gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className={`flex h-12 w-12 items-center justify-center rounded-lg border-2 text-xl font-bold ${
                i < pin.length
                  ? 'border-ooosh-sky bg-white/10 text-white'
                  : 'border-white/20 bg-white/5'
              }`}
            >
              {i < pin.length ? '●' : ''}
            </div>
          ))}
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/20 px-4 py-2 text-center text-sm text-red-200">
            {error}
          </div>
        )}

        {/* Number pad */}
        <form onSubmit={handleFormSubmit} ref={formRef}>
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => handlePinInput(digit)}
                disabled={loading}
                className="flex h-14 items-center justify-center rounded-lg bg-white/10 text-xl font-semibold text-white transition-colors hover:bg-white/20 active:bg-white/30 disabled:opacity-50"
              >
                {digit}
              </button>
            ))}

            {/* Bottom row */}
            <button
              type="button"
              onClick={handleBackspace}
              disabled={loading || pin.length === 0}
              className="flex h-14 items-center justify-center rounded-lg bg-white/5 text-sm text-white/60 transition-colors hover:bg-white/10 disabled:opacity-30"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => handlePinInput('0')}
              disabled={loading}
              className="flex h-14 items-center justify-center rounded-lg bg-white/10 text-xl font-semibold text-white transition-colors hover:bg-white/20 active:bg-white/30 disabled:opacity-50"
            >
              0
            </button>
            <button
              type="submit"
              disabled={loading || pin.length === 0}
              className="flex h-14 items-center justify-center rounded-lg bg-ooosh-sky text-sm font-semibold text-ooosh-navy transition-colors hover:bg-ooosh-sky/80 disabled:opacity-30"
            >
              {loading ? '...' : 'Go'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
