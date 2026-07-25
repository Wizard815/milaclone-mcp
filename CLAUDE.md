# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                     # run the app (default http://localhost:4321)
docker compose up -d --build  # run in Docker on 127.0.0.1:8182
PORT=8080 node server.js      # run on a different port
npm test                      # backend + API tests (node --test, no framework)
node --test test/api.test.js  # run a single test file
npm run test:e2e              # Playwright end-to-end tests
npx playwright test e2e/ui.spec.js -g "creates a note"  # single e2e test
npx playwright install        # one-time: fetch browser binaries for Playwright
```

Both test suites are self-isolating: `test/api.test.js` points `DATA_DIR` at a fresh `mkdtemp` before requiring `db.js`; `playwright.config.js` starts its own server on port 4322 with `DATA_DIR=.e2e-data` (wiped each run). Neither touches real board data — but note that `db.js` opens the SQLite handle on `require`, so any code that requires it must set `DATA_DIR` first if isolation matters.

## Architecture

Three-file Node backend + vanilla ES-module frontend, no build step.

**Backend flow** (`server.js` → `routes.js` → `db.js`):
- `db.js` opens `better-sqlite3` in WAL mode on import, creates schema on first run, and seeds a root `Home` canvas. It exports prepared statements (`stmt.*`) and helpers; **routes call the prepared statements directly** rather than going through a repository layer.
- Schema: `canvases` (self-referential tree via `parentCanvasId`), `items` (belong to a `canvasId`, may nest under `parentItemId` for cards inside a column), `meta` (key/value; stores `rootCanvasId`).
- `items.data` is a JSON string in SQLite but always an object at the API boundary — `rowToItem` parses on read, routes `JSON.stringify` on write.

**The board/canvas duality is the trickiest invariant.** A `board`-type item on canvas A owns a freshly-created child canvas B (see `routes.js` POST `/api/item`). The card's title, color, and icon live on the child canvas row, not the item — GET `/api/canvas/:id` augments board items with `_childTitle`/`_childCount`/`_childColor`/`_childIcon`, and PATCH writes title/color/icon *through* to the child canvas and strips them off `item.data`. Deleting a board triggers `deleteItemDeep` in `db.js`, which recursively collects descendant canvases and wipes the entire subtree in one transaction.

**Frontend** (`public/js/*.js`, ES modules loaded via `<script type="module">` from `index.html`):
- `state.js` is the shared mutable app state. Because ES module bindings can't be reassigned by importers, anything that mutates at runtime (`view`, `cam`, `selectedId`, `drag`, …) lives as a field on the exported `state` object; collections mutated in place (`elMap`) are exported directly.
- `main.js` is the entry point: boots, wires global keyboard/pointer handlers, and owns `openCanvas(id)` — the single navigation primitive that fetches, resets selection, and updates `location.hash`.
- `cards.js` owns all DOM rendering for items. `render()` clears `#world` and re-renders everything; `refreshItem(it)` swaps a single card. Cards inside a column render as children of the column's DOM, not directly under `#world`.
- `drag.js` handles drag-in/drag-out of columns: dragging a card out of a column reparents it to `#world` mid-drag and clears `in-column`; dropping onto a `.col-body` reparents and reorders siblings via `api.patchMany`.
- Other modules: `viewport.js` (pan/zoom + `screenToWorld`), `tools.js` (toolbar arming), `editing.js` (select/edit/save), `menus.js` (color palette + context menu), `clipboard.js` (copy/cut/paste), `create.js`, `api.js` (thin `fetch` wrappers).
- Lucide icons come from a CDN `<script>` and are refreshed after DOM changes via `refreshIcons()`; the helper no-ops if the CDN failed to load.

**Auto-save model:** every user edit fires a PATCH — there is no explicit save. The model is single-document, last-write-wins; there's no concurrency handling and no realtime sync between clients.

## Data & config

- `data/board.db` (+ `-wal`, `-shm`) — all board content. Delete to reset.
- `public/uploads/` — user-uploaded files (25 MB cap, mime-filtered in `routes.js`). The path is hardcoded, not env-configurable — uploads must stay under `public/` for `express.static` to serve them.
- Env vars: `PORT` (4321), `HOST` (0.0.0.0), `DATA_DIR` (`./data`).
- Docker: `Dockerfile` is a two-stage alpine build (stage 1 installs build deps so `better-sqlite3` compiles against musl; stage 2 copies `node_modules` in). `docker-compose.yml` mirrors the sibling `reflections` deployment on `xbox` — loopback-only port, resource caps, named volumes `milaclone_data` (`/data`) and `milaclone_uploads` (`/app/public/uploads`), fronted by Tailscale Serve.
