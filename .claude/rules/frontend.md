---
paths:
  - "frontend/src/**/*.{ts,tsx}"
  - "src/**/*.{ts,tsx}"
---

# Frontend conventions — load-bearing rules

Full incident write-ups: `docs/reference/SHARED-UTILITIES.md` (render-crash safety)
and the per-module reference docs.

## Crash safety

- **`ErrorBoundary` is mounted TWICE** — inside `Layout` around the page `<Routes>` (a page crash keeps the nav usable), and around the whole app in `main.tsx` (backstop for `Layout` itself and the public, Layout-less routes). It resets on `location.pathname` change, deliberately **without** re-keying children so navigation keeps page state.
- **Any new SESSION key MUST be added to `SESSION_KEYS`** in `ErrorBoundary.tsx`. The "Reset saved view settings" escape hatch clears all of `localStorage` except that allowlist — miss it and the reset logs people out. Allowlisting sessions (rather than listing prefs) means a new *preference* needs no change here.
- **A persisted view preference can pin a page into a crashing state on reload.** Validate a stored value on read rather than trusting it — a stored `fleet-view-mode` re-crashed the SPA on every reload before anything could be clicked.
- **Never call `toISOString()` on a Date you haven't range-checked** (`Number.isNaN(d.getTime())`, after parsing *and* after any shift). Return `null` and render `—`. One malformed stored date threw inside a row `.map()` and blanked the whole app.

## Detail pages

- **Key a detail page by its route id — don't hand-reset state.** React Router reuses ONE component instance across `/jobs/A` → `/jobs/B`; only the param changes. So every `*DetailPage` needs a thin keyed wrapper as its default export:

  ```tsx
  export default function JobDetailPage() {
    const { id } = useParams<{ id: string }>();
    return <JobDetailContent key={id} />;   // the real page, unexported
  }
  ```

  That fixes three things at once: state can't carry across (`JobDetailPage` had ~86 of ~100 state slots surviving a job change — HireHop derivation flags, client history, open inline-edit drafts that would then save onto the *new* job), a slow reply for the old id can't overwrite the new page (the setter belongs to a dead instance, so React discards it — there is no `AbortController` anywhere in this frontend), and the one-frame flash of the old entity disappears, because the remount happens during the render pass the route change triggers rather than in a post-paint effect.

  **Key on the id ONLY** — never the pathname or `location.key`, or every `?tab=` click remounts the page and closes open modals under the user.

  **Applied to all eight entity detail pages** — jobs, people, organisations, venues, drivers, PCNs (`/vehicles/pcns/:id`), problems (`/operations/problems/:id`) and carnets. A new `*DetailPage` gets the same wrapper.

  **Not for a list page that takes an id.** `IssuesPage` serves `/operations/issues/:id`, where the param only deep-links a detail modal open — keying it would re-fetch the whole filtered list and lose scroll on every modal open. The test is whether the param identifies *the thing the page is about*, not something the page merely points at. Same reasoning skips the public `:token` routes (you never navigate between two of them) and, for now, the vehicles module's `fleet/:id` (no vehicle→vehicle link in the page, and vehicles aren't in global search, so the bug is barely reachable — it's the same pattern if it ever needs doing).

  **The tab effect still has a job to do.** `OrganisationDetailPage` keys its tab effect on `[id, tabParam]` because a same-page link there changes only the query string, which an id-keyed remount cannot see. Keep those effects; don't let the wrapper tempt you into deleting them.

  **Do not "fix" this by adding setters to a manual reset effect.** That was the previous convention and it lost: it is whack-a-mole across ~100 state slots, it drifts the moment someone adds state, and it cannot fix the late-reply race at all. The existing reset block and tab-reset effect in `JobDetailPage` are kept as belt-and-braces only.

  Not in conflict with the `ErrorBoundary` decision above: that deliberately avoids re-keying *children on a crash reset*, which is a different level and a different purpose.
- **No top-of-page "Back to …" breadcrumb on entity detail pages.** They were usually wrong: a hardcoded destination ignores where you came from, and the "smart" variant only worked from the two pages that passed `state.from`. A wrong back button is worse than none. **Don't re-add them.** Deliberately KEPT: contextual deep-links reflecting a real parent (issue → its job, carnet → its job), "not found" recovery buttons inside error states, and vehicle-module kiosk workflow exits (in freelancer mode those are the *only* navigation available).
- A conditional/`hideWhenEmpty` component inside a margined wrapper needs `empty:hidden` on the wrapper, or an empty render leaves a phantom gap.

## Roles

- **Use `hasManagerRole(role)` / `roleAllowed(role, [...])` from `frontend/src/lib/roles.ts`** for any manager-tier UI gate. **Never bare `role === 'manager'`** — that silently hides manager UI from the `weekend_manager`, who has the same privilege level.

## API layer

- `api.ts` errors carry the parsed response `body`, so callers can branch on a machine-readable field. **NB the long-standing `code` property on those errors is the error MESSAGE, not a code — read `body.code`.**
- Private-bucket files (receipts, driver docs, condition photos) must be fetched through the authenticated `api.blob()` helper. A plain `<img src="/api/files/download…">` won't carry the JWT and 401s.
- **To SHOW one, use `hooks/useAuthedFileUrl.ts` rather than calling `api.blob()` in an effect.** Every thumbnail needs the same three things and the hand-rolled copies kept missing them: wait until the element is near the viewport, abort if the caller loses interest, revoke the object URL on unmount. Rolled by hand per component it cost a 25-second Costs page — ~90 requests and ~100MB of full-size originals to draw a column of 32px icons. Attach the returned `ref` to the PLACEHOLDER as well as the loaded element; the ref is how the hook learns the thumbnail is on screen, so a ref only on the success branch never loads at all. Pass `enabled: false` when the caller already knows no image is coming (a PDF rendering as an icon) and nothing is requested. Fetching on a click — a lightbox, a download — is fine as a plain `api.blob()` call; the hook is for things that render on mount.

## File inputs

- **Capture the file array synchronously BEFORE resetting `e.target.value`.** Reading `Array.from(e.target.files)` inside a deferred setState updater runs after the synchronous reset has emptied the FileList — the chip silently never appears.
- **Never reference the `File` global in a Next.js route handler** — it isn't a global in Netlify's Node runtime (only `Blob` is), so `f instanceof File` throws a `ReferenceError` → 502. Iterate `formData` entries as `string | Blob` and duck-type.
- Compress images before upload where the destination is an email or a mobile-viewed page.

## Modals

- **Don't call the parent's refresh callback mid-flow** if the modal should stay open — the parent's reload sets `loading` and unmounts it. Track a `madeChange` flag and refresh at close.
- **Merge an action response into local state, never replace it** — `RETURNING *` rows omit the joined display fields the parent selected and blank the header.
