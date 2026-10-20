# Shop till guide for studio sitters

`shop-till-guide.pdf` is the "How to use the shop till" guide for studio sitters. It lives in
OP as a Staff Document (category **Training**, **Share with freelancers** ticked, uploaded with
"Upload a PDF"), which puts it on the freelancer portal's **Resources** page. The till's
**How to use** button (`src/app/shift/[date]/till/page.tsx`) opens Resources in a new tab.

The pages are phone-width (105 x 220 mm), because sitters read it on their phones.

House rules for the copy: British English, no em or en dashes (`build-pdf.js` refuses them).

## Files

| File | What it is |
|---|---|
| `guide.html` | The guide's text and layout. Edit this to change the words. |
| `img/*.png` | Screenshots, made by `screenshots.js`. Don't edit by hand. |
| `screenshots.js` | Renders the real portal pages on a phone-sized screen with made-up data. No backend, nothing recorded. |
| `build-pdf.js` | Turns `guide.html` into `shop-till-guide.pdf`, and refuses if a page overflows. |
| `fonts/` | Inter, bundled so the PDF embeds it cleanly (SIL Open Font License, `fonts/OFL.txt`). |

## Changing the guide

Words only:

```bash
node docs/guides/shop-till/build-pdf.js
```

The till has changed, so the screenshots need redoing:

```bash
# terminal 1, from the repo root (any 32+ character secret, used only for a fake login cookie)
npm install
SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100

# terminal 2, from the repo root, same secret
SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/shop-till/screenshots.js
node docs/guides/shop-till/build-pdf.js
```

Both scripts need Playwright (`npm i -g playwright` or a dev dependency) and Chromium.

Then upload the new PDF as a **new version** of the same Staff Document in OP, so its
Resources entry stays where it is.

## Sample data

Real shop items and prices (Can of Coke £1.50; 2" ProGaff matt white gaffa tape £15), made-up
bands (The Lantern Thieves, Paper Satellites) and a made-up contact (`sam@example.com`).
All of it is at the top of `screenshots.js`.
