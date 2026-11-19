# Staff Help guides

The "how do I…?" pages staff read inside OP (the **?** in the header, and `/help`).
Each guide is a folder here; OP's frontend bundles them at build time
(`frontend/src/lib/helpGuides.ts`), so **a guide changes by a pull request, the same way
the code does** — never in the database, never as a PDF.

House rules, policies and anything a person must sign or tick stay in **Staff Documents**.
A guide says how to do a thing in OP; it does not set the rule.

```
help/
  guides/<slug>/guide.json   the guide
  guides/<slug>/*.png        its pictures
  shots/                     the scripts that take the pictures
scripts/check-help-coverage.mjs   the check CI runs
```

## A guide is one task

The title is what somebody would ask: "Keep a client's overpayment for their next hire",
not "Credit on account". One guide, one job to do. If it needs an "or", it is two guides.

Every guide has the same parts, in the same order, so staff learn where to look:

| Field | What it is |
|---|---|
| `title` | The task, as a person would say it |
| `area` | The heading it sits under on the Help page (Money, Jobs, Vehicles…) |
| `who` | Who may do it ("Any staff", "Managers") |
| `checked` | The date somebody last confirmed it against the real screens, `YYYY-MM-DD` |
| `summary` | One or two plain sentences |
| `useWhen` | Use this when… |
| `notWhen` | Not when… — each `{ text, see? }`, `see` = the slug of the guide that IS right |
| `steps` | `{ text, detail?, image?, who?, open?, see? }` — one action each |
| `next` | What happens afterwards, without anybody doing anything |
| `wrong` | `{ problem, fix }` — if it looks wrong |
| `related` | Other guides' slugs |
| `routes` | The OP pages the **?** button offers this guide on (`/jobs/:id`, `/money`) |
| `keywords` | Extra words the search should find it by |
| `covers` | The code this guide describes (see "Keeping them true") |

A step's `open` gives it a link: `job` (the job the reader came from), `job:money` (that
job's Money tab), or a path beginning `/`.

## Writing

- Plain words, short sentences, the words on the screen in the screen's own spelling.
- Say what to press and what you then see. Leave out how it works underneath.
- One action per step. A picture only where it shows where to look.
- Hyphens, not long dashes. No emoji.
- **"Manually", never "by hand"** (jon, Nov 2026): "confirm it manually". And "automatically" for
  what OP does without anybody pressing anything. The check refuses "by hand" in a guide.

## Pictures

Pictures are taken by a script, never manually, so they can be taken again when a screen
changes.

- **Made-up data only**: "The Demo Band", jobs 90001 and up. Never a real client, never production.
- Run against a local stack (backend on 3001, frontend on 5173, a migrated and seeded
  database). HireHop is not called: the script answers those reads itself.
- `help/shots/lib.js` has the pieces (`open`, `card`, `shot`); one script per area of OP.

```bash
node help/shots/money-on-account.js
```

Commit the PNGs it writes. Keep each under about 200 KB.

## Keeping them true

`covers` lists the files a guide describes. CI runs `scripts/check-help-coverage.mjs`
on every pull request: **if the change touches a file a guide covers and leaves that
guide's folder alone, the check fails.** To clear it, either

1. update the guide (and re-run its pictures), or
2. if it still reads true, set `checked` to today.

Keep `covers` to the screens and the service a person would notice changing. A file that
half the app touches would make the check fire on everything and teach people to ignore it.

Staff can press "Tell us" at the foot of any guide; it goes to the admins' bell
(`backend/src/routes/help.ts`).
