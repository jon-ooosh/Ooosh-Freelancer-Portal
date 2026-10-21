'use client'

/**
 * Login Page (Oct 2026 refresh, design 1a)
 *
 * - The Ooosh logo, "Freelancer portal", no subtitle
 * - Show/hide password
 * - "Forgotten it?" beside the password label (the error messages in
 *   /api/auth/login name it, so keep the wording in step)
 * - "New to Ooosh? Create an account" at the foot
 */

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { cls, Banner } from '@/components/ui'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Login failed')
        return
      }

      // Redirect to dashboard on success
      window.location.href = '/dashboard'
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const input = `${cls.input} h-[52px] !text-[17px]`

  return (
    <div className="min-h-screen bg-hf-page flex flex-col safe-top safe-bottom">
      <div className="flex-1 w-full max-w-md mx-auto flex flex-col px-5 pt-16 pb-7 gap-7">
        <div className="flex flex-col items-center gap-4 pt-6">
          <Image src="/ooosh-tours-logo-small.png" alt="Ooosh Tours" width={64} height={64} className="object-contain" priority />
          <h1 className="text-[26px] font-bold tracking-[-0.02em] text-hf-ink">Freelancer portal</h1>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-hf-border rounded-[18px] p-5 flex flex-col gap-4">
          {error && <Banner tone="error">{error}</Banner>}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-[14px] font-semibold text-hf-body">Email</label>
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
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-baseline">
              <label htmlFor="password" className="text-[14px] font-semibold text-hf-body">Password</label>
              <Link href="/forgot-password" className={`${cls.link} text-[14px]`}>Forgotten it?</Link>
            </div>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
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
          </div>

          <button type="submit" disabled={loading} className={`${cls.btnPrimary} w-full mt-1`}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="flex-1" />

        <p className="text-center text-[15px] text-hf-muted">
          New to Ooosh? <Link href="/register" className={cls.link}>Create an account</Link>
        </p>
      </div>
    </div>
  )
}
