/**
 * Retry utility — wraps async operations with configurable retry logic.
 * Returns a detailed result so the UI can show what happened.
 *
 * Network-aware: when offline, waits for connectivity before retrying
 * instead of burning through retry attempts.
 */

export interface RetryResult<T> {
  success: boolean
  data?: T
  error?: string
  attempts: number
}

/**
 * Wait for the browser to come back online, with a timeout.
 * Returns true if online, false if timed out.
 */
function waitForOnline(timeoutMs = 30000): Promise<boolean> {
  if (navigator.onLine) return Promise.resolve(true)

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      window.removeEventListener('online', handler)
      resolve(false)
    }, timeoutMs)

    function handler() {
      clearTimeout(timer)
      // Small delay after reconnect to let network stabilise
      setTimeout(() => resolve(true), 500)
    }

    window.addEventListener('online', handler, { once: true })
  })
}

/**
 * Run an async function with retries.
 * @param fn The async function to run
 * @param label Human-readable label for logging (e.g. "Monday event creation")
 * @param maxAttempts Maximum number of attempts (default 3)
 * @param delayMs Delay between retries in ms (default 1500, doubles each retry)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  delayMs = 1500,
): Promise<RetryResult<T>> {
  let lastError = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // If offline, wait for connectivity before attempting
      if (!navigator.onLine) {
        console.warn(`${label} — offline, waiting for connectivity...`)
        const cameOnline = await waitForOnline(60000) // 60s timeout
        if (!cameOnline) {
          lastError = 'No internet connection — timed out waiting to reconnect'
          console.warn(`${label} — still offline after 60s, attempt ${attempt}/${maxAttempts}`)
          continue
        }
        console.info(`${label} — back online, resuming`)
      }

      const data = await fn()
      return { success: true, data, attempts: attempt }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error'
      console.warn(`${label} — attempt ${attempt}/${maxAttempts} failed: ${lastError}`)

      if (attempt < maxAttempts) {
        // If error looks like a network failure and we're offline, wait for online
        if (!navigator.onLine) {
          console.warn(`${label} — went offline, waiting for reconnect before retry...`)
          await waitForOnline(60000)
        } else {
          // Exponential backoff: 1500ms, 3000ms, 6000ms...
          const backoff = delayMs * Math.pow(2, attempt - 1)
          await new Promise(resolve => setTimeout(resolve, backoff))
        }
      }
    }
  }

  console.error(`${label} — all ${maxAttempts} attempts failed: ${lastError}`)
  return { success: false, error: lastError, attempts: maxAttempts }
}
