/**
 * Stage 3 (May 2026) — the legacy R2-backed Issue Detail page is
 * RETIRED. Equivalent (and richer) UI lives at /operations/problems/:id
 * — full control panel with timeline, threaded comments via
 * <ThreadView>, file attachments, sidebar workflow controls.
 *
 * Legacy URLs (/vehicles/issues/:reg/:issueId) can't map deterministic-
 * ally to the new OP UUIDs because the import script deduplicates
 * (multiple legacy rows can collapse into one OP row, with fresh UUID).
 * Best we can do is redirect to the global Problems page where staff
 * can search.
 *
 * The hook + component imports below would resolve to dead code if we
 * left them; gone now, file is purely a redirect shell.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function IssueDetailPage() {
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
