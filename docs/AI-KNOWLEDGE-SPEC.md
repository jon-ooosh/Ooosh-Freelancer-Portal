# House knowledge for Claude — the building blocks (SPEC, DRAFT)

**Status (15 Oct 2026): DRAFT for jon.** Nothing is built. §9 lists the open decisions.

**Why this exists.** `AI-QUOTING-SPEC.md` is parked because a good client reply needs
knowledge that mostly lives in people's heads. This spec is how that knowledge gets into
OP, stays current, and reaches Claude in a form it can use. It serves **every** AI
client-facing draft: the chase drafts today (`chase-draft.ts`), quotes later, and
whatever comes next. It absorbs the chase-tone round (`AUTO-CHASE-SPEC.md` §13.6 item 2)
as its first phase, because the chase drafts are the one live place Claude writes to
clients — the test bench for everything here.

## 1. Principles

1. **One source for people and Claude.** Guidance Claude follows is the same approved
   text staff read. No hidden prompt that drifts from what the team does.
2. **Claude gets a brief, not the filing cabinet.** For each draft, code assembles a
   short, relevant brief: the guides for THIS task, the facts about THIS client. Never
   "everything we know".
3. **Code rails beat written guidance.** The hard rules (never invent a discount, never
   fabricate a detail, never promise what isn't on the quote) stay in code. A guide can
   add to them, never loosen them; if a guide contradicts a rail, the rail wins.
4. **Knowledge is captured where it surfaces.** When a person corrects a draft, OP offers
   to remember why. No big sit-down data-entry project.
5. **Every fact is dated and signed.** So stale knowledge is visible, not silently trusted.
6. **Nothing is learned without a human tick.** Claude may propose a fact or a guide
   change; a person accepts it.

## 2. The four kinds of knowledge

| Kind | Example | Where it lives | Section |
|---|---|---|---|
| **Voice** — how we sound | British, understated, "Cheers, Jon" | A Staff Document, shared with Claude | §3 |
| **House rules** — how we do things | 9am–9am vans; ask about drivers; backline deal over 2 days | Staff Documents, shared with Claude | §4 |
| **Client terms** — the deal with this client | 10% off backline; 30-day account | Existing fields on people / organisations | §5 |
| **Client knowledge** — the relationship | "TM books, manager pays"; "breakdown in 2025, be careful" | Client facts (new, small) + retros + history | §5, §6 |

## 3. Phase A — the voice (the chase-tone round)

Today the voice is `system_settings.chase_voice_instructions`, appended to the code rails
in `chase-draft.ts`, and refined by `learnChaseVoice()` from pasted examples. Drafts read
"too AI / too American" (jon, Sep 2026).

- **Rework the rails** in `chase-draft.ts` SYSTEM_PROMPT toward British, understated, short.
- **Move the voice into a Staff Document**, "How we write to clients", shared with Claude
  (§4). Staff read it too — a new starter learns the same voice. `learnChaseVoice()` then
  proposes a **new version** of that document (the existing draft → approve flow) rather
  than overwriting a setting. The setting stays as a fallback until the document exists.
- **Iterate on real drafts** with jon (preview endpoint `POST /api/auto-chase/preview-draft/:jobId`).
- Done when jon would send the drafts unedited most of the time. Auto-send stays OFF
  (that's still `AUTO-CHASE-SPEC.md` Phase 3, after this).

## 4. Phase B — house guides, shared with Claude

Built on Staff Documents (`STAFF-DOCUMENTS-SPEC.md`), which already gives versions,
approval, owners and a content-review cadence — the "how do we keep it current" answer.

**Additions to `staff_documents`:**
- `ai_shared BOOLEAN` — the "Share with Claude" switch. **Admin-only** to set.
- `ai_topics TEXT[]` — which drafting tasks it applies to, from a fixed list (start:
  `voice`, `chasing`, `quoting_vans`, `quoting_general`, `client_questions`). A van quote
  loads `voice` + `quoting_vans` + `quoting_general`; a chase loads `voice` + `chasing`.

**What Claude reads:** only the CURRENT, APPROVED version's markdown body. Uploaded-PDF
documents are not shared (no text to read reliably); a guide meant for Claude is written in-app.

**The guide template** (offered when creating an AI-shared document; staff benefit too):
- **What this covers**
- **Safe to assume** (and what to assume — e.g. 9am–9am)
- **Always ask**
- **Never do or promise**
- **How we price / discount** (where relevant)
- **Examples** — two or three real ones

**One loader:** `services/house-knowledge.ts` `getGuidesFor(topics)` — the only way an AI
caller gets guides. It returns text plus the document id + version used, so every draft
records **which guide versions it was written from** ("why did it say that?" is answerable).
A size budget per call; going over it is a warning to admins, not a silent truncation.
Guides go in the cached system prompt (`cache_control`), so their cost is small.

**First guides (content work — jon, not code):** "How we write to clients" (Phase A),
"Chasing a quote", "Quoting a van hire" (written together in a session, §8). Then the
old Monday how-to guides, triaged: rewrite the live ones in the template, drop the rest.

## 5. Phase C — the client brief

`services/client-brief.ts` `buildClientBrief(…)` — one short, structured brief per draft,
shared by chase drafts and (later) quotes. Sources, all existing unless marked:

- **History** — jobs, outcomes, losses and why: `services/leads/history.ts`
  `getClientHistory()`, `services/job-outcomes.ts`.
- **Retros** — the mini-retro after each hire (`interactions`, content `Job retro: <rating>\n<notes>`).
  The brief carries the latest few notes, not just the counts. Claude reads them for
  context and **never quotes a retro to the client**.
- **Terms** — `working_terms_*`, `payment_terms`, `payment_terms_notes`, `notes` on the
  person and their organisation. These fields exist and are used unevenly; filling them
  for the regular clients is content work, not code.
- **Client facts** (NEW, §6) — short dated lines.
- **No history at all** — the Leads research (`services/leads/`) if the band has been
  researched; otherwise nothing. Never a fresh web search per draft.

The brief is **shown to the admin next to the draft** ("what Claude knew"), so a wrong or
stale fact is spotted where it does harm. Hidden and detached emails stay out, as for
every AI read (`email-and-notifications.md`).

## 6. Phase D — "remember this?"

**Client facts** — a small new table: one line of text, about a person OR an organisation,
author, date, the job it came from, archived flag. Shown on the person / organisation
page, editable and archivable by staff. **Not for** health, personal life or anything
we wouldn't say to the client's face (§9.4).

**The capture loop** (needs the passive draft-vs-sent capture already planned in
`AUTO-CHASE-SPEC.md` §9.3):
1. Claude drafts; the admin edits it before sending (or discards it).
2. OP compares draft and sent; a small Haiku pass proposes **at most two** learnings,
   each labelled as **about this client** (→ a client fact) or **general** (→ a suggested
   edit to a named guide).
3. The admin ticks, edits or ignores each. Ticked client facts are saved; ticked general
   ones become a **proposed new version** of the guide (existing approval flow).
4. Nothing is saved without a tick. An ignored suggestion is not asked again for that draft.

## 7. Phase E — back to quoting

Un-park `AI-QUOTING-SPEC.md` for vans once: the voice is trusted (A), "Quoting a van hire"
is shared (B), and the brief exists (C). Phase D can follow; it isn't a blocker.

## 8. Build order and who does what

| Step | Code (Claude) | Content (jon / team) |
|---|---|---|
| A | Rails rework; voice → Staff Document; learn-voice → proposed version | Review drafts until they'd go unedited |
| B | `ai_shared` + `ai_topics` + template + `house-knowledge.ts`; chase drafts use it | Write "Chasing a quote" + "Quoting a van hire"; triage Monday guides |
| C | `client-brief.ts`; brief shown beside the draft; chase drafts use it | Fill terms for the top regular clients |
| D | Client facts table + page section; draft-vs-sent capture; proposal UI | Tick or reject suggestions as they come |
| E | Un-park the van slice | Test on old enquiries before live ones |

A and the content half of B can run in parallel this week.

## 9. Open decisions (jon)

1. **Client facts: a new small table, or the existing free-text `notes` field?** Lean: the
   table — one line each, dated, signed, archivable. A free-text field can't show which
   line is stale or who said it, and the capture loop needs to add lines without editing
   someone else's prose.
2. **Voice: move it into a Staff Document, or keep the system setting?** Lean: the
   document, so staff and Claude read the same thing and changes go through approval.
3. **Retros in the brief** — any reason Claude shouldn't read retro notes (e.g. blunt
   internal remarks)? Lean: read them, never quote them.
4. **Who sees client facts** — all staff (lean), or managers only? Either way, the rule
   in §6 on what never goes in one.
5. **Which existing clients' terms to fill first** — jon to name the top ten or so.
