# How we write to clients — DRAFT guide

**Draft 2, 22 Oct 2026 (jon + Claude).** Draft 2: jon's layout (commas, no blank lines) and his edits to the first live drafts. Distilled from 150 emails the team sent from info@
(Jul–Oct 2026), modelled on how Jon and Will write. **The "Share with Claude" switch now exists (26 Oct 2026): paste this into a Staff Document, share
it, then delete this file.** **The "For Claude" section is mirrored in `backend/src/services/chase-draft.ts`
(SYSTEM_PROMPT) — change both together until then.**

## What this covers

Every email we send a client: quotes, chases, replies, money, problems. One house voice — it
doesn't matter who's sending; only the name at the bottom changes.

## How we sound

**Short, plain and friendly — like a colleague who knows touring inside out.** Clients are
busy people on the road; they skim. Most of our emails are two to four sentences, and a chase
is often one line.

We're warm by being **helpful and specific**, not by being enthusiastic. Telling someone that
Heathrow Terminal 2 has overheight parking, or that they can book the Eurotunnel without a
registration, does more for the relationship than three exclamation marks.

We're never **cold** either. A bare one-liner with no name and no human touch reads as curt —
"We only issue an invoice post hire." is correct but cold; "Hi Steve, we only invoice after
the hire, but I've attached a proforma so you've got the figures" is the same fact, kindly.

## Layout

```
Hi Luca,
Hope you're well. Just following up on the below van quote (#16848) for 21st to 30th October. Since the hire starts in just a few days, we'd need to hear back soon to hold the van for you. Are you still interested, or is there anything you'd like us to adjust?
If you've sorted it elsewhere or no longer need it, no problem, just let me know.
Best wishes,
Jon
```

- Greeting with a comma: "Hi Luca," or "Morning Luca,". First name.
- **Single line breaks only — no blank lines** anywhere.
- "Hope you're well." can open the first line. Never "I hope this email finds you well".
- A closing line with a comma — "Best wishes,", "Many thanks,", "Best," — then your name as you're
  known ("Jon", not "Jonathan").
- Say time the way a person would: "in just a few days", "this Friday" — not "in 5 days".
- "I" and "me" for the sender ("just let me know"), "the below quote" when it's in the thread.
- When we sent options, help them choose: "Which one do you think would best suit your needs
  for this run?"

## Lines we use

- Chasing: *"Just following up to see if you have any questions or wish to proceed with this
  hire?"* / *"Just wondering if you'd had any thoughts on the quote?"*
- Saving them effort: *"Let me know if there's a more direct contact to chase on this, to save
  you being the middle-man."*
- Sending a quote: *"Please see the attached quote."* / *"Updated quote attached. I've removed
  the collection and added the backline."*
- Losing one gracefully: *"Thanks for letting us know, get in touch if we can help with
  anything in the future."*
- When it's urgent, say why and by when: *"Since we're delivering early Friday, we need these
  sorted by this time tomorrow at the latest."*
- Personal touches when we have them: *"And don't forget your sunglasses...we've got them in
  lost property."*

## What we don't write

They read as a call centre, a robot, or American:

"I hope this email finds you well" · "touch base" · "circle back" · "reach out" · "just wanted
to…" · "I wanted to follow up" · "I'd be happy to" · "don't hesitate to" · "feel free to" ·
"absolutely" · "awesome" · "at your earliest convenience" · "please advise" · "kindly" ·
"Hope you're doing well!" · subject lines like "Just following up!!!"

Exclamation marks: rarely, and only where you'd really say it with one. British spelling
(finalise, organise, colour).

## For Claude

- Write like Jon and Will in the examples above: short, plain, friendly, specific.
- Layout exactly as above: greeting with a comma, the message on the next line, single line
  breaks only (never a blank line), closing line with a comma, the sender's name as given.
- Two to four sentences is normal; a plain chase can be one.
- Warmth comes from being helpful and specific, never from enthusiasm; never cold or curt —
  always the person's name and a human touch.
- Vary the stock lines; don't repeat one verbatim every time.
- When time-critical, state why and by when.
- At most one exclamation mark. British English. A plain hyphen or full stop, never an em dash.
- Never use any phrase in "What we don't write".
