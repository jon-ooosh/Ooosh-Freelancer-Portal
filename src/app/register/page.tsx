'use client'

import { useState } from 'react'
import Link from 'next/link'

type Step = 'email' | 'verify' | 'password'

export default function RegisterPage() {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Step 1: Submit email for validation
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Registration failed')
        return
      }

      setStep('verify')
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Step 2: Verify the code
  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: verificationCode }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Verification failed')
        return
      }

      setStep('password')
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Step 3: Set password and complete registration
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    try {
      const response = await fetch('/api/auth/register/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Registration failed')
        return
      }

      window.location.href = '/dashboard'
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const resendCode = async () => {
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to resend code')
        return
      }

      alert('A new code has been sent to your email')
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-ooosh-50 to-white">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <div className="w-16 h-16 bg-ooosh-600 rounded-xl flex items-center justify-center">
            <span className="text-white text-2xl font-bold">O</span>
          </div>
        </div>
        <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900">
          Create your account
        </h2>
        <p className="mt-2 text-center text-sm text-gray-600">
          {step === 'email' && 'Enter your email to get started'}
          {step === 'verify' && 'Check your email for a verification code'}
          {step === 'password' && 'Almost done! Set your password'}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-lg sm:rounded-xl sm:px-10 border border-gray-100">
          
          {/* Progress indicator */}
          <div className="flex items-center justify-center space-x-2 mb-8">
            <div className={`w-3 h-3 rounded-full ${step === 'email' ? 'bg-ooosh-600' : 'bg-ooosh-200'}`} />
            <div className={`w-8 h-0.5 ${step !== 'email' ? 'bg-ooosh-600' : 'bg-gray-200'}`} />
            <div className={`w-3 h-3 rounded-full ${step === 'verify' ? 'bg-ooosh-600' : step === 'password' ? 'bg-ooosh-200' : 'bg-gray-200'}`} />
            <div className={`w-8 h-0.5 ${step === 'password' ? 'bg-ooosh-600' : 'bg-gray-200'}`} />
            <div className={`w-3 h-3 rounded-full ${step === 'password' ? 'bg-ooosh-600' : 'bg-gray-200'}`} />
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          {/* Step 1: Email */}
          {step === 'email' && (
            <form className="space-y-6" onSubmit={handleEmailSubmit}>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                  Email address
                </label>
                <div className="mt-1">
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="block w-full appearance-none rounded-lg border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-ooosh-500 sm:text-sm"
                    placeholder="you@example.com"
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Must match the email registered with Ooosh
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="flex w-full justify-center rounded-lg bg-ooosh-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-ooosh-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ooosh-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Checking...' : 'Continue'}
              </button>
            </form>
          )}

          {/* Step 2: Verification Code */}
          {step === 'verify' && (
            <form className="space-y-6" onSubmit={handleVerifySubmit}>
              <div>
                <label htmlFor="code" className="block text-sm font-medium text-gray-700">
                  Verification code
                </label>
                <div className="mt-1">
                  <input
                    id="code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    required
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                    className="block w-full appearance-none rounded-lg border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-ooosh-500 sm:text-sm text-center text-2xl tracking-widest"
                    placeholder="000000"
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Enter the 6-digit code sent to {email}
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || verificationCode.length !== 6}
                className="flex w-full justify-center rounded-lg bg-ooosh-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-ooosh-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ooosh-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Verifying...' : 'Verify'}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={resendCode}
                  disabled={loading}
                  className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500 disabled:opacity-50"
                >
                  Didn&apos;t receive the code? Send again
                </button>
              </div>
            </form>
          )}

          {/* Step 3: Password */}
          {step === 'password' && (
            <form className="space-y-6" onSubmit={handlePasswordSubmit}>
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <div className="mt-1">
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full appearance-none rounded-lg border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-ooosh-500 sm:text-sm"
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                  Confirm password
                </label>
                <div className="mt-1">
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="block w-full appearance-none rounded-lg border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-ooosh-500 sm:text-sm"
                    placeholder="••••••••"
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Must be at least 8 characters
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="flex w-full justify-center rounded-lg bg-ooosh-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-ooosh-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ooosh-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Creating account...' : 'Create account'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500">
              Already have an account? Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
