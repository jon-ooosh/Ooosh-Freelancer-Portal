import BottomNav from '@/components/BottomNav'

/**
 * Earnings — a placeholder until the real page is built (Oct 2026: the tab used
 * to lead to a page that didn't exist). The design and the plan for its data
 * (fees per job, invoiced, paid) are in docs/FREELANCER-PORTAL-SPEC.md.
 */
export default function EarningsPage() {
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <h1 className="text-lg font-semibold text-gray-900">Earnings</h1>
        </div>
      </header>
      <main className="max-w-lg mx-auto px-4 py-6">
        <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
          <div className="text-4xl mb-3">£</div>
          <h2 className="text-base font-semibold text-gray-900 mb-2">Coming soon</h2>
          <p className="text-sm text-gray-600">
            This page will show what you&apos;ve earned each month, and what&apos;s been invoiced and paid.
            For now, your fee is shown on each job.
          </p>
        </div>
      </main>
      <BottomNav active="earnings" />
    </div>
  )
}
