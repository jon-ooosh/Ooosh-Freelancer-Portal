'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cls, Banner } from '@/components/ui'
import { AuthShell, authInput, authLabel } from '@/components/AuthShell'

type Step = 'email' | 'verify' | 'password'

export default function RegisterPage() {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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
        body: JSON.stringify({ email, password, code: verificationCode }),
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
    setNotice('')
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

      setNotice('A new code is on its way to your email.')
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const input = `${cls.input} ${authInput}`
  const steps: Step[] = ['email', 'verify', 'password']
  const at = steps.indexOf(step)

  return (
    <AuthShell
      title="Create your account"
      subtitle={
        step === 'email' ? 'Enter your email to get started'
          : step === 'verify' ? 'Check your email for a verification code'
          : 'Almost done! Set your password'
      }
      footer={<>Already have an account? <Link href="/login" className={cls.link}>Sign in</Link></>}
    >
      {/* Progress: three segments, done = accent */}
      <div className="grid grid-cols-3 gap-1.5" aria-label={`Step ${at + 1} of 3`}>
        {steps.map((s, i) => (
          <div key={s} className={`h-1 rounded-full ${i <= at ? 'bg-hf-accent' : 'bg-hf-control'}`} />
        ))}
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {/* Step 1: Email */}
      {step === 'email' && (
        <form className="flex flex-col gap-4" onSubmit={handleEmailSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className={authLabel}>Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={input}
              placeholder="you@example.com"
            />
            <p className="text-[13px] text-hf-muted">Must match the email registered with Ooosh</p>
          </div>
          <button type="submit" disabled={loading} className={`${cls.btnPrimary} w-full`}>
            {loading ? 'Checking...' : 'Continue'}
          </button>
        </form>
      )}

      {/* Step 2: Verification Code */}
      {step === 'verify' && (
        <form className="flex flex-col gap-4" onSubmit={handleVerifySubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className={authLabel}>Verification code</label>
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
              className={`${cls.input} h-[56px] text-center !text-[26px] tracking-[0.3em] tabular`}
              placeholder="000000"
            />
            <p className="text-[13px] text-hf-muted">Enter the 6-digit code sent to {email}</p>
          </div>
          <button type="submit" disabled={loading || verificationCode.length !== 6} className={`${cls.btnPrimary} w-full`}>
            {loading ? 'Verifying...' : 'Verify'}
          </button>
          <button type="button" onClick={resendCode} disabled={loading} className={`${cls.link} text-[15px] disabled:opacity-50`}>
            Didn&apos;t receive the code? Send again
          </button>
        </form>
      )}

      {/* Step 3: Password */}
      {step === 'password' && (
        <form className="flex flex-col gap-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className={authLabel}>Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirmPassword" className={authLabel}>Confirm password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={input}
            />
            <p className="text-[13px] text-hf-muted">Must be at least 8 characters</p>
          </div>
          <button type="submit" disabled={loading} className={`${cls.btnPrimary} w-full`}>
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
