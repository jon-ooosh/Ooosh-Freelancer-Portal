/**
 * After the van leg is submitted (design 3f), book-out and collection alike.
 *
 * When every step worked: the design's clean screen. When any step failed or
 * left a reminder, the list of what happened stays on screen (restyled), as it
 * always has: a step that quietly did nothing must say so (vehicle rules,
 * "a post-submit step that can no-op MUST report itself"). The page still owns
 * the 3-second hop back to the portal after a clean submit.
 */

import { Check, TriangleAlert, X } from 'lucide-react'
import { Banner, fl, noEmDash } from './ui'

export interface DoneResult {
  label: string
  success: boolean
  detail?: string
  /** A reminder for a person, not a failure (amber). */
  warning?: boolean
}

export function DoneScreen({ allOk, title, message, problemTitle, results, bothNote, continueLabel, onContinue }: {
  allOk: boolean
  /** "Van booked out" */
  title: string
  /** "RX24 KHV is with Fontaines D.C. ..." */
  message: string
  /** Heading when something didn't finish. */
  problemTitle: string
  results: DoneResult[]
  /** A "Both" job: the equipment checklist is next. */
  bothNote?: boolean
  continueLabel: string
  onContinue: (() => void) | null
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-5 py-10">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className={`flex h-[72px] w-[72px] items-center justify-center rounded-full ${
          allOk ? 'bg-hf-green-tint text-hf-green-text' : 'bg-hf-amber-tile text-hf-amber-text'
        }`}>
          {allOk ? <Check size={36} strokeWidth={2.4} /> : <TriangleAlert size={34} strokeWidth={2.2} />}
        </div>
        <h1 className={fl.pageTitle}>{allOk ? title : problemTitle}</h1>
        <p className="max-w-[300px] text-[16px] leading-[1.5] text-hf-body">{message}</p>
      </div>

      {!allOk && results.length > 0 && (
        <div className="flex flex-col gap-2">
          <ul className={`${fl.card} overflow-hidden`}>
            {results.map((r, i) => (
              <li key={i}>
                {i > 0 && <div className="mx-4 h-px bg-hf-divider" />}
                <div className="flex items-start gap-3 px-4 py-3">
                  <span className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full ${
                    r.success ? 'bg-hf-green-tint text-hf-green-text'
                      : r.warning ? 'bg-hf-amber-tile text-hf-amber-text'
                      : 'bg-[#fbeeea] text-hf-error'
                  }`}>
                    {r.success ? <Check size={14} strokeWidth={3} /> : r.warning ? <TriangleAlert size={13} strokeWidth={2.4} /> : <X size={14} strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[15px] font-semibold text-hf-ink">{noEmDash(r.label)}</span>
                    {r.detail && <span className="break-words text-[14px] text-hf-muted">{noEmDash(r.detail)}</span>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {results.some(r => !r.success && !r.warning) && (
            <p className="px-1 text-center text-[14px] text-hf-muted">
              Failed steps were tried 3 times. Check your signal, and call the office if it still needs doing.
            </p>
          )}
        </div>
      )}

      {bothNote && (
        <Banner tone="info" title="Next: the equipment checklist">
          You&apos;re doing the van and the equipment. The button below takes you straight there.
        </Banner>
      )}

      {onContinue && (
        <button type="button" onClick={onContinue} className={`${fl.btnPrimary} w-full`}>
          {continueLabel}
        </button>
      )}
    </div>
  )
}

/** A "Both" job: the portal sends van-only legs back with ?vanOnly=true (src/app/api/jobs/[id]/bookout-token). */
export function isBothJob(returnUrl: string | null | undefined): boolean {
  if (!returnUrl) return false
  try {
    return new URL(returnUrl).searchParams.get('vanOnly') !== 'true'
  } catch {
    return false
  }
}
