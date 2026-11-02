'use client'

/**
 * Forgot Password Page
 * 
 * Allows users to request a password reset email.
 * Route: /forgot-password
 */

import { useState } from 'react'
import Link from 'next/link'
import { cls, Banner } from '@/components/ui'
import { AuthShell, AuthResult, authInput, authLabel } from '@/components/AuthShell'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess(false)
    setLoading(true)

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to send reset email')
        return
      }

      setSuccess(true)
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link"
      footer={<Link href="/login" className={cls.link}>Back to sign in</Link>}
    >
      {success ? (
        <AuthResult tone="success" title="Check your email">
          <p>If an account exists for <span className="font-semibold">{email}</span>, you&apos;ll receive a password reset link shortly.</p>
          <p className="text-[14px] text-hf-muted">Don&apos;t see it? Check your spam folder.</p>
        </AuthResult>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {error && <Banner tone="error">{error}</Banner>}
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
              className={`${cls.input} ${authInput}`}
              placeholder="you@example.com"
            />
          </div>
          <button type="submit" disabled={loading} className={`${cls.btnPrimary} w-full`}>
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
