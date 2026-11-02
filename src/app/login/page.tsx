'use client'

/**
 * Login Page (Oct 2026 refresh, design 1a)
 *
 * - The Ooosh logo, "Freelancer portal", no subtitle
 * - Show/hide password
 * - "Forgotten it?" beside the password label (the error messages in
 *   /api/auth/login name it, so keep the wording in step)
 * - "New to Ooosh? Create an account" at the foot
 *
 * Two-step sign-in (FREELANCER-PORTAL-SPEC §7, Oct 2026): once OP switches it
 * on, a phone it doesn't remember gets a code step after the password. The
 * code is emailed; "Remember this phone for 90 days" is ticked by default.
 * While it is switched off, this page never leaves the password step.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { cls, Banner } from '@/components/ui'
import { RememberPhone } from '@/components/AuthShell'

const RESEND_SECONDS = 30

/**
 * Where to go once signed in: back to the page that sent them here (the
 * middleware passes it as `from` — a reminder text or email links straight to a
 * job), else the dashboard. Only a plain path on this portal, never another
 * site: letters, digits, `/`, `-` and `_`, starting with one `/`.
 */
function afterSignIn(): string {
  try {
    const from = new URLSearchParams(window.location.search).get('from') || ''
    if (/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(from) && !from.startsWith('/login')) return from
  } catch {
    // fall through
  }
  return '/dashboard'
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // The code step
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [pending, setPending] = useState('')
  const [emailHint, setEmailHint] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(true)
  const [notice, setNotice] = useState('')
  const [resendIn, setResendIn] = useState(0)
  /** False when the first email failed (or was refused): don't say a code is on its way. */
  const [codeOut, setCodeOut] = useState(false)

  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  const backToPassword = (message: string) => {
    setStep('password')
    setPending('')
    setCode('')
    setNotice('')
    setError(message)
  }

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

      // Right password; a code is owed before the session.
      if (data.needsCode) {
        setPending(data.pending)
        setEmailHint(data.emailHint || '')
        setCode('')
        setNotice('')
        setStep('code')
        setCodeOut(!!data.codeSent)
        if (data.codeSent) {
          setResendIn(RESEND_SECONDS)
        } else {
          setError(data.codeError || 'We couldn\'t send a code just now. Try "Send a new code", or call the office.')
        }
        return
      }

      // Signed in: back to the page they were heading for, else the dashboard
      window.location.href = afterSignIn()
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setNotice('')
    setLoading(true)
    try {
      const response = await fetch('/api/auth/login/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending, code, trustDevice: remember }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (data.code === 'pending_expired') {
          backToPassword('Your sign-in timed out. Please sign in again.')
          return
        }
        setError(data.error || 'That code didn\'t work. Please try again.')
        return
      }
      window.location.href = afterSignIn()
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
      const response = await fetch('/api/auth/login/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (data.code === 'pending_expired') {
          backToPassword('Your sign-in timed out. Please sign in again.')
          return
        }
        setError(data.error || 'Could not send a code just now. Please try again.')
        return
      }
      setCode('')
      setCodeOut(true)
      setNotice(`New code sent to ${emailHint}. Use the newest one.`)
      setResendIn(RESEND_SECONDS)
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

        {step === 'password' && (
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
        )}

        {step === 'code' && (
        <form onSubmit={handleCodeSubmit} className="bg-white border border-hf-border rounded-[18px] p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[18px] font-semibold text-hf-ink">Check your email</h2>
            <p className="text-[15px] leading-[1.45] text-hf-body">
              {codeOut
                ? <>We&apos;ve emailed a 6-digit sign-in code to <span className="font-semibold">{emailHint}</span>. It works for 10 minutes.</>
                : <>Your sign-in code goes to <span className="font-semibold">{emailHint}</span>.</>}
            </p>
          </div>

          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className="text-[14px] font-semibold text-hf-body">Sign-in code</label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={`${cls.input} h-[56px] text-center !text-[26px] tracking-[0.3em] tabular`}
              placeholder="000000"
            />
          </div>

          <RememberPhone checked={remember} onChange={setRemember} />

          <button type="submit" disabled={loading || code.length !== 6} className={`${cls.btnPrimary} w-full mt-1`}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={resendCode}
            disabled={loading || resendIn > 0}
            className={`${cls.link} text-[15px] disabled:text-hf-muted disabled:font-medium`}
          >
            {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
          </button>

          <p className="text-center text-[14px] leading-[1.45] text-hf-muted border-t border-hf-border pt-4">
            Can&apos;t get the code? Call the office on{' '}
            <a href="tel:+441273911382" className={`${cls.link} whitespace-nowrap`}>01273 911382</a>
          </p>
        </form>
        )}

        <div className="flex-1" />

        {step === 'password' ? (
          <p className="text-center text-[15px] text-hf-muted">
            New to Ooosh? <Link href="/register" className={cls.link}>Create an account</Link>
          </p>
        ) : (
          <p className="text-center text-[15px] text-hf-muted">
            <button type="button" onClick={() => backToPassword('')} className={cls.link}>Back to sign in</button>
          </p>
        )}
      </div>
    </div>
  )
}
