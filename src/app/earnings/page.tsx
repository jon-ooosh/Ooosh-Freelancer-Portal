import { PoundSterling } from 'lucide-react'
import BottomNav from '@/components/BottomNav'
import { cls } from '@/components/ui'

/**
 * Earnings: a placeholder until the real page is built (Oct 2026: the tab used
 * to lead to a page that didn't exist). The design and the plan for its data
 * (fees per job, invoiced, paid) are in docs/FREELANCER-PORTAL-SPEC.md §5.
 */
export default function EarningsPage() {
  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-6 pb-2">
        <h1 className={cls.pageTitle}>Earnings</h1>
      </header>
      <main className="max-w-lg mx-auto px-4 pt-3">
        <div className={`${cls.card} p-6 text-center flex flex-col items-center gap-2`}>
          <div className="w-12 h-12 rounded-full bg-hf-tint text-hf-link flex items-center justify-center">
            <PoundSterling size={24} strokeWidth={1.8} />
          </div>
          <h2 className="text-[17px] font-semibold text-hf-ink mt-1">Coming soon</h2>
          <p className="text-[15px] text-hf-body leading-[1.5]">
            This page will show what you&apos;ve earned each month, and what&apos;s been invoiced and paid.
            For now, your fee is shown on each job.
          </p>
        </div>
      </main>
      <BottomNav active="earnings" />
    </div>
  )
}
