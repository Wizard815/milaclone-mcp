# Milaclone / Miladash: a self-hosted Milanote-style canvas board

An infinite visual canvas for notes, to-do lists, links, images, columns, and
nested boards. Runs as a small Node.js app with **no frontend build step** —
clone, `npm install`, `node server.js`. Your data lives in a single SQLite file
on disk, so it's trivial to back up and fully yours.

## Features

- Infinite pan/zoom canvas with a dotted grid
- Cards: **Note**, **To-do**, **Link**, **Comment**, **Image**, **Upload** (files),
  **Column**, **Board** (nested sub-canvas with Lucide icons)
- Nested boards with clickable breadcrumb navigation (Home / … / …)
- Drag cards freely, drag them in and out of columns, resize, recolor
- Customizable board icons (Lucide) + 12-color palette
- Right-click menu: copy, cut, paste, duplicate, rename, lock position, trash
- Everything autosaves to SQLite under `data/`
- Per-board camera position remembered in your browser

## Miladash

This branch is **Miladash**, Milaclone trimmed and extended to be the ideas
board for the Pondering Orb homelab dashboard.

What's new:

- **Stage on cards.** Right-click a card and pick *Thought*, *Design* or
  *Code* (or *None*). The stage shows as a chip on the card. It is a field,
  not a position: moving a card on the board never changes it. Stored in a
  new `items.stage` column (added by a migration that keeps existing data),
  returned and accepted as `stage` by `POST/PATCH /api/item`, and by the MCP
  `create_item`/`update_item` tools.
- **Pipeline view** (the kanban button in the top bar): every staged card
  in the workspace in Thought / Design / Code columns, newest change first
  (`items.updatedAt`, bumped by content and stage edits, not by moves).
  Drag a card to another column to change its stage; click it to open it on
  its board. `GET /api/pipeline`, MCP `list_pipeline`.
- **Arrow kinds and labels.** Right-click a connector line: *Relates to*,
  *Depends on* (drawn dashed) or *Became* (drawn heavier), and *Add/Edit
  label*. Stored as `data.kind` / `data.label` on the line.
- **Box-select.** Shift+drag on empty canvas (or use the Select tool) to
  select several cards, then drag one of them to move them all.
- **Promote to a project.** On a Code-stage card, *Promote to a project*
  asks this server to `POST {ORB_URL}/api/c/projects` with
  `{name, next, status: "next"}` and `Authorization: Bearer {ORB_TOKEN}`
  (`POST /api/item/:id/promote`, MCP `promote_item`). The name is the card's
  title, `next` its first body line. The card is then marked promoted
  (`data.promoted`), dimmed, and gets a *Project* chip. The browser never
  sees `ORB_TOKEN`. Without `ORB_URL` the menu item is disabled and says so.
- **JSON Canvas export/import** (the *Export* button). Exports the board as
  [JSON Canvas 1.0](https://jsoncanvas.org) (`.canvas`, which Obsidian
  opens): text, link and group nodes with x, y, width, height and colour,
  and edges with fromNode/toNode/label. Columns become groups; *Export with
  nested boards* turns each board card into a group holding that board's
  cards. Each node/edge also carries a small `miladash` object (type, stage,
  arrow kind) so a Miladash round trip keeps them; other apps ignore it.
  *Import a .canvas file* creates a new board card holding the file's
  contents: groups become nested boards (or columns, if they were exported
  as columns). `GET /api/canvas/:id/export[?nested=1]`,
  `POST /api/canvas/:id/import`.
- **Looks.** Colours that used to be hard-coded are CSS custom properties
  now. Settings → *Look* picks *Classic* (Milaclone's palette, the default),
  *Night* or *Parchment* (Pondering Orb's presets and fonts). In Night or
  Parchment the sun/moon button swaps between the two.

Removed: task starring (on board cards, to-do rows and the Quick notes
*Starred* view, plus the "Starred color" setting) and the workspace-wide
due-date calendar (`/api/calendar` and its view). Tasks belong to CalDAV in
Orb. Due dates on cards and in Quick notes stay.

Known limits: the Pipeline lists staged cards from every board, not just
the open one. Promoting marks the idea but doesn't yet draw a *became* arrow
to a project card. Exported heights are estimates for cards that size
themselves to their content.

## Requirements

- Node.js 18 or newer (`node --version` to check)
- No database server and no Python needed. The only native dependency is
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), which ships
  prebuilt binaries for common platforms; on other platforms `npm install`
  compiles it, which needs a C++ toolchain (`build-essential` on Debian/Ubuntu).

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:4321>.

To use a different port:

```bash
PORT=8080 node server.js
```

## Run it with Docker

This app is meant to be deployed together with its MCP server from the repo
root — see the [top-level README](../README.md) for the combined
`docker compose up`, networking, backups, and deploy/rollback instructions.
This section only covers running `app/` standalone (no MCP) for local dev.

```bash
docker build -t milaclone:local .
docker run -p 4321:4321 -v milaclone_data:/data milaclone:local
```

## Run it as a service (auto-start on boot)

Create `/etc/systemd/system/canvas-board.service` (adjust the paths and user):

```ini
[Unit]
Description=Canvas Board
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/canvas-board
ExecStart=/usr/bin/node server.js
Environment=PORT=4321
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-board
sudo systemctl status canvas-board
```

## Your data & backups

- Board content: `data/board.db` (SQLite; WAL mode also writes
  `board.db-wal` and `board.db-shm` alongside it)
- Uploaded images/files: `public/uploads/`

Back up those paths and you've backed up everything. To reset to a blank
canvas, stop the server and delete `data/board.db` (it'll be recreated on next
start).

## Configuration

All optional, via environment variables:

| Variable     | Default              | Purpose                          |
|--------------|----------------------|----------------------------------|
| `PORT`       | `4321`               | Port to listen on                |
| `HOST`       | `0.0.0.0`            | Bind address                     |
| `DATA_DIR`   | `./data`             | Where the SQLite DB is written   |
| `ORB_URL`    | *(unset = promote off)* | Miladash: Pondering Orb's base URL, for **Promote to a project**. |
| `ORB_TOKEN`  | *(unset)*            | Miladash: an Orb API token, sent as `Authorization: Bearer` by the server only. |
| `API_KEY`    | *(unset = open API)* | If set, every `/api/*` request (except `/api/health`) must send it via `X-API-Key: <key>` or `Authorization: Bearer <key>`. The browser UI picks the key up automatically (it's rendered into `index.html`). The bundled [mcp/](../mcp) server picks it up automatically too when run via the root `docker-compose.yml`. |

Uploads always go to `public/uploads/` (they're served as static files from
there, so the path isn't configurable).

## Tech stack

- **Backend:** [Express](https://expressjs.com/) with
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for storage and
  [`multer`](https://github.com/expressjs/multer) for uploads
- **Frontend:** vanilla JavaScript, HTML, and CSS in `public/` — no bundler, no
  framework

## Development

```bash
npm test        # unit/API tests (node --test)
npm run test:e2e   # Playwright end-to-end tests
```

The Playwright tests drive a real browser, so run
`npx playwright install` once beforehand to fetch the browser binaries.

## MCP server

[`mcp/`](../mcp) is an MCP server bundled in this same repo that gives AI
assistants (Claude Code, Claude Desktop, etc.) full read/write access to this
board over `/api/*` — listing boards, searching, and creating/editing/deleting
cards. It runs alongside this app by default — see the
[top-level README](../README.md).

## Not included (yet)

These were left out to keep the first version small and focused; they're
natural next additions: line/arrow connectors between cards, freehand
drawing/sketch cards, multi-select, and real-time multi-user sync (the current
model is single-document, last-write-wins — great for one person across their
own devices).

## Keyboard shortcuts

- `N` note · `L` link · `T` to-do · `B` board · `C` column · `M` comment
- `⌘/Ctrl+C` copy · `⌘/Ctrl+X` cut · `⌘/Ctrl+V` paste · `⌘/Ctrl+D` duplicate
- `Enter` rename selected card · `Esc` deselect / cancel armed tool
- `Delete` / `Backspace` remove the selected card (when not typing)

## License

[MIT](LICENSE)
