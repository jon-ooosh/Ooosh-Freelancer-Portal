import JobHistoryList from '@/components/JobHistoryList'

/** "View all" behind the dashboard's Cancelled section. */
export default function CancelledJobsPage() {
  return <JobHistoryList which="cancelled" />
}
