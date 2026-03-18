/**
 * Prompt shown when a saved draft is found for the current wizard flow.
 * Offers to resume from where the user left off or start fresh.
 */

interface DraftResumePromptProps {
  vehicleReg: string
  savedAt: string
  photoCount: number
  step: number
  totalSteps: number
  onResume: () => void
  onDiscard: () => void
}

export function DraftResumePrompt({
  vehicleReg,
  savedAt,
  photoCount,
  step,
  totalSteps,
  onResume,
  onDiscard,
}: DraftResumePromptProps) {
  const savedDate = new Date(savedAt)
  const timeAgo = getTimeAgo(savedDate)

  return (
    <div className="mx-4 my-6 rounded-xl border-2 border-blue-200 bg-blue-50 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100">
          <svg className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-blue-900">Resume where you left off?</h3>
          <p className="mt-1 text-sm text-blue-700">
            You have an unsaved session for <strong>{vehicleReg || 'a vehicle'}</strong>
          </p>
          <div className="mt-2 space-y-0.5 text-xs text-blue-600">
            <p>Saved {timeAgo}</p>
            <p>Step {step + 1} of {totalSteps} &middot; {photoCount} photo{photoCount !== 1 ? 's' : ''} captured</p>
          </div>
        </div>
      </div>

      <div className="mt-4 flex gap-3">
        <button
          onClick={onResume}
          className="flex-1 rounded-lg bg-blue-600 py-2.5 text-center text-sm font-semibold text-white active:bg-blue-700"
        >
          Resume
        </button>
        <button
          onClick={onDiscard}
          className="flex-1 rounded-lg border border-blue-200 bg-white py-2.5 text-center text-sm font-semibold text-blue-700 active:bg-blue-50"
        >
          Start Fresh
        </button>
      </div>
    </div>
  )
}

function getTimeAgo(date: Date): string {
  const now = Date.now()
  const diff = now - date.getTime()
  const mins = Math.floor(diff / 60000)

  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`

  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}
