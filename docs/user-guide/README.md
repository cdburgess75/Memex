# Getting started with Depot: the user guide

This folder builds **Getting started with Depot**, the guide every new user finds at the root
of their personal library (and anyone can open from the account menu). It produces a PDF, which
is what ships, and a Word file from the same chapters, with screenshots taken from a demo copy of Depot that
uses made-up data (the fictional company Acme Co.). No real server or data is involved.

## Rebuild after the app's screens change

```bash
cd docs/user-guide
npm install                      # once: docx, ws, and sharp (for print-size pictures)
node capture/run.js              # re-take every screenshot (or: node capture/run.js share-file)
node build/all.js                # writes out/Getting started with Depot.docx and .pdf
node build/ship.js               # copies the PDF into server/assets/getting-started/
```

Commit `server/assets/getting-started/` with the change. Only the PDF goes into the app. `ship.js`
also lists the edition it replaces in `past-editions.json`; when the server next starts it swaps
every copy of a listed edition that nobody has changed for the new one, so everyone ends up with
the current guide. A copy somebody edited is left alone, and a deleted copy never comes back. The
account menu always opens the newest PDF.

Run `ship.js` only for an edition you mean to release: every build of the PDF has different
bytes, and each one that passes through `ship.js` is listed.

Useful extras:
- `swift build/render-pages.swift "out/Getting started with Depot.pdf" out/pages 110` renders
  every PDF page to PNG so you can look at them.
- `node build/check-docx.js "out/Getting started with Depot.docx"` checks the Word file's structure.
- `node build/all.js --pdf-only` / `--docx-only` builds one format.

## How it fits together

| Folder | What it holds |
|---|---|
| `content/<chapter>.json` | The chapter text. Steps are numbered to match the badges in that section's picture. |
| `shots/<chapter>.js` | What each screenshot shows, how to get there, and where its numbered badges go. |
| `demo/server.js` | The demo copy: the real `index.html`, with every `/api` call answered from `demo/fixtures/`. |
| `demo/fixtures/base.js` | The shared Acme Co. world. `fixtures/<chapter>.js` adds data for one chapter only. |
| `capture/` | Drives the system Chrome (no extra packages) and draws the numbered badges. |
| `build/` | Turns chapters and pictures into the Word file and the PDF. |

Run the demo on its own with `node demo/server.js` and open http://127.0.0.1:8790/ to click
around (any call it cannot answer is logged as `UNMOCKED`).

Rules the chapters follow: Depot branding only, plain short sentences for everyday users,
labels in **bold** exactly as they appear on screen, and only paths that work for a contributor.
