'use client'

/**
 * Reset Password Page
 * 
 * Allows users to set a new password using a reset token from email.
 * Route: /reset-password?token=xxx
 */

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { cls, Banner } from '@/components/ui'
import { AuthShell, AuthResult, authInput, authLabel } from '@/components/AuthShell'

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token')
  
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  // In OP mode the reset endpoint logs the user straight in (sets a session
  // cookie) and returns the user object. When that happens we send them to the
  // dashboard rather than back to the sign-in page — going via /login would
  // otherwise risk a stale lockout from earlier wrong-password attempts.
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tokenValid, setTokenValid] = useState<boolean | null>(null)

  // Auto-drop the freelancer straight into the dashboard once the reset has
  // logged them in (OP mode sets a session cookie). Stops the Lewis
  // double-reset loop where landing back on a login screen prompted another
  // reset. The success card shows for a beat first, and the button remains as a
  // fallback if the redirect is blocked.
  useEffect(() => {
    if (success && loggedIn) {
      const t = setTimeout(() => router.replace('/dashboard'), 1200)
      return () => clearTimeout(t)
    }
  }, [success, loggedIn, router])

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setTokenValid(false)
      return
    }

    // Verify token is valid
    fetch(`/api/auth/verify-reset-token?token=${encodeURIComponent(token)}`)
      .then(res => res.json())
      .then(data => setTokenValid(data.valid))
      .catch(() => setTokenValid(false))
  }, [token])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    // Validate password length
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to reset password')
        return
      }

      // OP mode returns the user object and has already set the session cookie.
      setLoggedIn(!!data.user)
      setSuccess(true)
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Loading state while checking token
  if (tokenValid === null) {
    return (
      <div className="text-center py-8">
        <div className="w-8 h-8 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin mx-auto" />
        <p className="mt-4 text-[15px] text-hf-muted">Checking your reset link...</p>
      </div>
    )
  }

  // Invalid or expired token
  if (tokenValid === false) {
    return (
      <AuthResult
        tone="error"
        title="Invalid or expired link"
        action={<Link href="/forgot-password" className={`${cls.btnPrimary} w-full`}>Request a new link</Link>}
      >
        <p>This password reset link is invalid or has expired. Please request a new one.</p>
      </AuthResult>
    )
  }

  // Success state
  if (success) {
    return (
      <AuthResult
        tone="success"
        title="Password reset"
        action={<Link href={loggedIn ? '/dashboard' : '/login'} className={`${cls.btnPrimary} w-full`}>{loggedIn ? 'Go to your jobs' : 'Sign in'}</Link>}
      >
        <p>
          {loggedIn
            ? "Your password has been updated and you're now signed in."
            : 'Your password has been updated. You can now sign in with your new password.'}
        </p>
      </AuthResult>
    )
  }

  const input = `${cls.input} ${authInput}`

  // Password reset form
  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className={authLabel}>New password</label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${input} pr-16`}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute inset-y-0 right-0 px-3.5 text-[14px] font-semibold text-hf-muted hover:text-hf-body"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-[13px] text-hf-muted">Must be at least 8 characters</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirmPassword" className={authLabel}>Confirm new password</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={input}
        />
      </div>

      <button type="submit" disabled={loading} className={`${cls.btnPrimary} w-full`}>
        {loading ? 'Resetting...' : 'Reset password'}
      </button>
    </form>
  )
}

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a strong password for your account"
      footer={<Link href="/login" className={cls.link}>Back to sign in</Link>}
    >
      <Suspense fallback={
        <div className="text-center py-8">
          <div className="w-8 h-8 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin mx-auto" />
        </div>
      }>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  )
}
