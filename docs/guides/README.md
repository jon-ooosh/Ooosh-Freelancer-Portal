# Freelancer guides

Short PDF guides for freelancers, on the portal's **Resources** page. Each lives in OP as a
Staff Document (category **Training**, **Share with freelancers** ticked, uploaded with
"Upload a PDF"). To update one, upload the new PDF as a **new version** of the same Staff
Document, so its Resources entry stays where it is.

The plan for the set is `docs/FREELANCER-PORTAL-SPEC.md` §8.

| Folder | Guide | State |
|---|---|---|
| `getting-started/` | Getting started with the freelancer portal | draft, Oct 2026 |
| `van-delivery/` | Delivering a hire van (the book-out) | draft, Oct 2026 |
| `van-collection/` | Collecting a hire van | draft, Oct 2026 |
| `backline/` | Delivering and collecting backline | draft, Oct 2026 |
| `shop-till/` | How to use the shop till (studio sitters) | live; still in the old look, has its own scripts |

## How a guide is built

Phone-width pages (105 x 220 mm), real portal screens with made-up data, in the portal's
Oct 2026 look (DM Sans, plum, warm neutrals).

| File | What it is |
|---|---|
| `<guide>/guide.html` | The words and layout. Edit this to change the text. |
| `<guide>/img/*.png` | Screenshots, made by the guide's `screenshots.js`. Don't edit by hand. |
| `<guide>/screenshots.js` | Renders the real portal pages on a phone-sized screen, every `/api` call answered from sample data at the top of the file. Nothing touches OP. |
| `<guide>/<guide>-guide.pdf` | The PDF to upload. |
| `shared/guide.css` | The look, shared by every guide. Each guide sets its footer with `:root { --footer: "…"; }`. |
| `shared/build-pdf.js` | HTML to PDF. Refuses a missing image, an em or en dash, or a page whose content runs into its footer. |
| `shared/shots.js` | Screenshot helpers: the phone, the fake login cookie, the orange rings, clipping, hiding fixed bars, sample photos, a drawn signature. |
| `shared/sample-photos/` | Made-up van photos (18, in the app's order) and a backline one, fed to the camera. |
| `shared/fonts/` | DM Sans, bundled so the PDF embeds it cleanly (SIL Open Font License, `OFL.txt`). |

House rules for the copy: British English, no em or en dashes, plain words, one idea per line.

## Changing a guide

Words only:

```bash
node docs/guides/shared/build-pdf.js getting-started
```

The van guides' screens live in the staff app (`frontend/`), so those two also need it built and
served: `cd frontend && npm run build && npx vite preview --port 4173`. The camera is fed the
placeholder photos in `shared/sample-photos/`.

The portal has changed, so the screenshots need redoing:

```bash
# terminal 1, from the repo root (any 32+ character secret, used only for a fake login cookie)
npm install
SESSION_SECRET=local-preview-only-secret-0123456789abcdef npx next dev -p 3100

# terminal 2, from the repo root, same secret
SESSION_SECRET=local-preview-only-secret-0123456789abcdef node docs/guides/getting-started/screenshots.js
node docs/guides/shared/build-pdf.js getting-started
```

The scripts need Playwright (`npm i -g playwright` or a dev dependency) and Chromium.
