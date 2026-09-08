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

- **Reset tab state on `id` change.** React Router reuses the component instance across `/jobs/A` → `/jobs/B`, so `useState(initialTab)` initialises once and the active tab drags across. Every `*DetailPage` with tabs needs `useEffect(() => setActiveTab(default), [id])` — and the same effect should clear any per-tab cached data.
- **No top-of-page "Back to …" breadcrumb on entity detail pages.** They were usually wrong: a hardcoded destination ignores where you came from, and the "smart" variant only worked from the two pages that passed `state.from`. A wrong back button is worse than none. **Don't re-add them.** Deliberately KEPT: contextual deep-links reflecting a real parent (issue → its job, carnet → its job), "not found" recovery buttons inside error states, and vehicle-module kiosk workflow exits (in freelancer mode those are the *only* navigation available).
- A conditional/`hideWhenEmpty` component inside a margined wrapper needs `empty:hidden` on the wrapper, or an empty render leaves a phantom gap.

## Roles

- **Use `hasManagerRole(role)` / `roleAllowed(role, [...])` from `frontend/src/lib/roles.ts`** for any manager-tier UI gate. **Never bare `role === 'manager'`** — that silently hides manager UI from the `weekend_manager`, who has the same privilege level.

## API layer

- `api.ts` errors carry the parsed response `body`, so callers can branch on a machine-readable field. **NB the long-standing `code` property on those errors is the error MESSAGE, not a code — read `body.code`.**
- Private-bucket files (receipts, driver docs, condition photos) must be fetched through the authenticated `api.blob()` helper. A plain `<img src="/api/files/download…">` won't carry the JWT and 401s.

## File inputs

- **Capture the file array synchronously BEFORE resetting `e.target.value`.** Reading `Array.from(e.target.files)` inside a deferred setState updater runs after the synchronous reset has emptied the FileList — the chip silently never appears.
- **Never reference the `File` global in a Next.js route handler** — it isn't a global in Netlify's Node runtime (only `Blob` is), so `f instanceof File` throws a `ReferenceError` → 502. Iterate `formData` entries as `string | Blob` and duck-type.
- Compress images before upload where the destination is an email or a mobile-viewed page.

## Modals

- **Don't call the parent's refresh callback mid-flow** if the modal should stay open — the parent's reload sets `loading` and unmounts it. Track a `madeChange` flag and refresh at close.
- **Merge an action response into local state, never replace it** — `RETURNING *` rows omit the joined display fields the parent selected and blank the header.
