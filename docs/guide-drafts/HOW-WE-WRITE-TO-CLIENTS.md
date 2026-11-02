# How we write to clients

*Draft 3, 27 Oct 2026. Ready to paste into Staff Documents and share with Claude (topic: Our voice).
Once it's in OP, the OP copy is the one to edit, and this file is deleted. While this file exists,
the built-in fallback voice in `backend/src/services/chase-draft.ts` mirrors it.*

## What this covers

Every email we send a client: quotes, chases, replies, money, problems. One house voice: it
doesn't matter who's sending, only the name at the bottom changes.

## How we sound

**Brief, plain and friendly, like a colleague who knows touring inside out.** Clients are busy
people on the road and they skim. A few sentences is often enough.

**Brief, but complete.** Before you send, check:
- Have you answered every question they asked?
- Have you given them enough to make the next decision, whatever it is at this point?
- Does the email end with a **clear call to action**: what do they need to do next to keep the
  quote, the job or the problem moving?

**Then think about what YOU need to do next.** Does the job now need a status change (provisionally
held, lost)? A Problem raised? A payment link sent to someone? Do it now, not later.

**Never promise something and then not do it.** Say what you're going to do, then do the thing you
said. If you're not sure you can, don't promise it.

We're warm by being **helpful and specific**, not by being enthusiastic. Telling someone that
Heathrow Terminal 2 has overheight parking, or that they can book the Eurotunnel without a
registration, does more for the relationship than three exclamation marks.

We're never **cold** either. A bare one-liner with no name and no human touch reads as curt.
"We only issue an invoice post hire." is correct but cold; "Hi Steve, we only invoice after the
hire, but I've attached a proforma so you've got the figures" is the same fact, kindly.

## Layout

```
Hi Sam,
Hope you're well. Just following up on the below van quote (#12345) for 5th to 9th May. Since the hire starts in just a few days, we'd need to hear back soon to hold the van for you. Are you still interested, or is there anything you'd like us to adjust?
If you've sorted it elsewhere or no longer need it, no problem, just let me know.
Best wishes,
Jon
```

- Greeting with a comma: "Hi Sam," or "Morning Sam,". First name only.
- **Single line breaks only. No blank lines** anywhere: not after the greeting, not between
  paragraphs, not before the sign-off.
- "Hope you're well." can open the first line. Never "I hope this email finds you well".
- A closing line with a comma ("Best wishes,", "Many thanks,", "Thanks,", "Best,"), then your name
  as you're known ("Jon", not "Jonathan").

## Small things that make it sound like us

- Say time the way a person would: "in just a few days", "this Friday", "next week". Not "in 5 days".
- "I" and "me" for the sender ("just let me know"), not a corporate "we" all the way through.
- "The below quote" when you're replying in the thread that carries it.
- When we sent options, help them choose: "Which one do you think would best suit your needs for
  this run?"
- When it's urgent, say why and by when: "Since we're delivering early Friday, we need these sorted
  by this time tomorrow at the latest."
- Vary the stock lines. Don't send the same sentence every time.

## Lines we use

- **Chasing:** "Just following up to see if you have any questions or wish to proceed with this
  hire?" / "Just wondering if you'd had any thoughts on the quote?"
- **Saving them effort:** "Let me know if there's a more direct contact to chase on this, to save
  you being the middle-man."
- **Sending a quote:** "Please see the attached quote." / "Updated quote attached. I've removed the
  collection and added the backline."
- **Closing:** "Do let me know if you have any questions or would like to lock something in." /
  "Look forward to hearing from you."
- **Losing one gracefully:** "Thanks for letting us know, get in touch if we can help with anything
  in the future." / "Sorry to hear it didn't work out this time. Hope you have a great tour, and of
  course we're always happy to quote on any future tours or events you may have coming up."
- **Personal touches when we have them:** "And don't forget your sunglasses...we've got them in lost
  property."

## Spot the other thing they need

Clients often don't realise we supply more than the one thing they asked about. If a van client
mentions collecting their backline from another supplier, or a backline client is sorting a van
elsewhere, offer to quote for it. One line is enough: "We can supply the backline too if that would
help, happy to add it to the quote."

## What we don't write

These read as a call centre, a robot, or American:

"I hope this email finds you well" · "touch base" · "circle back" · "reach out" · "just wanted to…" ·
"I wanted to follow up" · "I'd be happy to" · "don't hesitate to" · "feel free to" · "absolutely" ·
"awesome" · "at your earliest convenience" · "please advise" · "kindly" · "Hope you're doing well!" ·
"Looking forward to hearing from you!" (without the exclamation mark it's fine) · subject lines like
"Just following up!!!"

Exclamation marks: rarely, and only where you'd really say it with one. British spelling (finalise,
organise, colour).

## For Claude

- Write in the house voice above: brief, plain, friendly, specific.
- Layout exactly as above: greeting with a comma, the message starting on the next line, single
  line breaks only (never a blank line), closing line with a comma, then the sender's name exactly
  as given.
- A few sentences is normal. Answer every question in their last message, and end with one clear
  call to action.
- Never promise an action in the email unless the information you were given says it has been done
  or will be done (don't write "I've held the van" or "I'll send the link" on a guess).
- Warmth comes from being helpful and specific, never from enthusiasm. Never cold or curt: always
  the person's name and a human touch.
- Vary the stock lines; don't repeat one word for word every time.
- At most one exclamation mark. British English. A plain hyphen or a full stop, never an em dash.
- Never use any phrase in "What we don't write".
