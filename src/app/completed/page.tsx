import JobHistoryList from '@/components/JobHistoryList'

/** "View all" behind the dashboard's Completed section. */
export default function CompletedJobsPage() {
  return <JobHistoryList which="completed" />
}
