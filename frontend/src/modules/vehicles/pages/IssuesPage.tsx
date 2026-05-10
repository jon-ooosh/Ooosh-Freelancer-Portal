/**
 * Stage 3 (May 2026) — the standalone vehicle-module Issues page is
 * RETIRED. The OP-backed equivalent at /operations/problems carries
 * the same data plus richer filters, the smart picker, NeedsAttention
 * bucket integration, and the new threaded comments / file attachments.
 *
 * This file is now just a redirect so any old bookmarks or in-app
 * links keep landing somewhere sensible.
 *
 * The legacy useAllIssues / useVehicleIssues hooks + IssueCard
 * component still exist in the tree — they remain on the retirement
 * list (Stage 4) along with the legacy /api/vehicles/get-all-issues
 * etc. backend endpoints. Nothing renders them after this commit
 * apart from the deprecated standalone NewIssuePage form (which has
 * been repointed to write into OP, but the page UI still lives in
 * this folder).
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function IssuesPage() {
  const navigate = useNavigate()
  useEffect(() => {
    navigate('/operations/problems', { replace: true })
  }, [navigate])

  return (
    <div className="text-center py-12 text-sm text-gray-500">
      Redirecting to Problems…
    </div>
  )
}
