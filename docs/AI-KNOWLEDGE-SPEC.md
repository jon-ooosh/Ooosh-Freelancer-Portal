# House knowledge for Claude — the building blocks (SPEC, DRAFT)

**Status (15 Oct 2026): DRAFT.** Nothing is built. §9 records jon's decisions.

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
| **Client terms** — the deal with this client | 5% off vans; 30-day account | Discounts: `DISCOUNTS-SPEC.md` (client tier / custom). Payment terms: existing fields | §5 |
| **Client knowledge** — the relationship | "TM books, manager pays"; "breakdown in 2025, be careful" | Client facts (new, small) + retros + history | §5, §6 |

## 3. Phase A — the voice (the chase-tone round)

**First round BUILT (16 Oct 2026).** Drafts read "too AI / too American" (jon, Sep 2026).

- **The house voice is written into the rails** in `chase-draft.ts` SYSTEM_PROMPT, distilled
  from 150 real sent emails (info@, Jul–Oct 2026) — modelled on Jon and Will, whom jon prefers
  to Rich's cooler register: short, greeting on its own line, "Hope you're well." at most,
  closing line + first name, warm through being helpful not enthusiastic, a list of banned
  AI/American phrases, no em dashes. **One house voice** for every sender (jon); only the
  name changes.
- **The staff half** is the draft guide `docs/guide-drafts/HOW-WE-WRITE-TO-CLIENTS.md`; its
  For-Claude half mirrors the prompt (change both together) until Phase B moves the voice into
  a Staff Document and the prompt reads it from there.
- **`chase_voice_instructions` stays** as the no-deploy steer on top of the house voice.
- **"Teach the voice from real examples" REMOVED** (`learnChaseVoice()`,
  `POST /api/auto-chase/voice/learn`, the Settings panel) — never used; the voice now comes
  from the real-email analysis, and Phase B's guide versions replace it.
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

**One document, two audiences (jon, 15 Oct).** Staff need the judgement and the why;
Claude needs explicit decision rules. So a shared guide is the staff text first, then a
`## For Claude` section of AI-only rules. Both halves are reviewed and approved together,
so they can't drift. Staff can still open the Claude section (collapsed by default) — what
Claude is told is never hidden from the team. Claude reads the whole document.

**The guide template** (offered when creating an AI-shared document; staff benefit too):
- **What this covers**
- **Safe to assume** (and what to assume — e.g. 9am–9am)
- **Always ask**
- **Never do or promise**
- **How we price / discount** (where relevant)
- **Examples** — two or three real ones
- **For Claude** — the AI-only rules

**Fixed text is pasted by code, never rewritten by Claude.** The standard van T&Cs block
that goes in every van quote email lives in OP (a shared document of its own — the ONE copy;
the Gmail template retires once OP can make a van-quote draft without AI) and OP appends
it verbatim under Claude's reply. Claude reads it to answer client questions (excess,
drivers, collection times, Europe) but never rephrases it.

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
- **Discounts** — read from the discounts module (`DISCOUNTS-SPEC.md`: client tier,
  custom deals, endorsements), never from client facts or free text. Until that is built,
  Claude quotes the rate card and flags "this client may have a deal" for a person.
- **Payment terms** — `working_terms_*`, `payment_terms`, `payment_terms_notes`, `notes` on the
  person and their organisation. These fields exist and are used unevenly; filling them
  for the regular clients is content work, not code.
- **Client facts** (NEW, §6) — short dated lines.
- **No history at all** — the Leads research (`services/leads/`) if the band has been
  researched; otherwise nothing. Never a fresh web search per draft.

**How far the brief looks (one hop).** The brief covers the job's client (person or
organisation), the person writing in, and the organisations that person belongs to.
**Terms apply only to the job's client.** If X from band Y writes about a side project, the
brief notes "X is also with Y (Y gets 10% off backline)" but Claude does not apply Y's
deal; a person decides. Nothing further out (Y's other members, other bands X manages).

The brief is **shown to the admin next to the draft** ("what Claude knew"), so a wrong or
stale fact is spotted where it does harm. Hidden and detached emails stay out, as for
every AI read (`email-and-notifications.md`).

## 6. Phase D — "remember this?"

**Client facts** — a small new table: one line of text, about a person OR an organisation,
author, date, the job it came from, archived flag. Shown as a "Things to know" card on the
person's / organisation's address-book **Details** tab (no new tab — the address book was
just tidied to fewer headings), editable and archivable by staff. **Not for discounts** —
those belong to the discounts module. **Not for** health, personal life or anything
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

## 6a. Later — real scarcity

"Only one Basic left on your dates" moves bookings, and OP can know it honestly: HireHop
availability plus OP's own open pipeline (quotes out for the same style and dates). A later
feature for the chase drafts and quotes (`AUTO-CHASE-SPEC.md`); until then Claude only states
scarcity that HireHop availability shows, never "other people are interested".

## 7. Phase E — back to quoting

Un-park `AI-QUOTING-SPEC.md` for vans once: the voice is trusted (A), "Quoting a van hire"
is shared (B), and the brief exists (C). Phase D can follow; it isn't a blocker.

## 8. Build order and who does what

| Step | Code (Claude) | Content (jon / team) |
|---|---|---|
| A | Rails rework (built 16 Oct); voice guide draft; learn-voice removed | Review drafts until they'd go unedited |
| B | `ai_shared` + `ai_topics` + template + `house-knowledge.ts`; chase drafts use it | Write "Chasing a quote" + "Quoting a van hire"; triage Monday guides |
| C | `client-brief.ts`; brief shown beside the draft; chase drafts use it | Fill terms for the top regular clients |
| D | Client facts table + page section; draft-vs-sent capture; proposal UI | Tick or reject suggestions as they come |
| E | Un-park the van slice | Test on old enquiries before live ones |

A and the content half of B can run in parallel this week.

## 9. Decisions (jon, 15 Oct 2026)

1. **Client facts are a new table**, shown on the address-book page (§6).
2. **The voice moves into a Staff Document**, written as one document for two audiences
   (§4): staff text, then a `## For Claude` section.
3. **Retros are read, never quoted** — they guide the reply and what to ask.
4. **All staff see client facts.** Never health, personal life, or anything we wouldn't
   say to the client's face.
5. **Terms:** only one bespoke deal among 50+ upcoming hires (The Wedding Present: 5% off
   vans, 20% off rehearsals of 2+ days). Simpler than expected. Discounts are the discounts
   module's job; client facts still get built. How far the brief looks: §5.
