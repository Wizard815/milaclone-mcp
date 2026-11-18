# mcp/

The MCP server half of this repo — see the [top-level README](../README.md)
for how it's deployed (bundled with [`app/`](../app), always running
alongside it). This doc covers just this subfolder: tools, data-model notes,
and standalone dev setup.

## Tools

| Tool | Does |
|---|---|
| `get_root` | Get the Home board's id |
| `list_boards` | Recursively list nested boards (titles/ids/counts) |
| `get_board` | Get a board's cards + breadcrumb |
| `get_item` | Fetch a single card by id, without its board_id |
| `update_canvas` | Rename/recolor/re-icon a board by canvas id (mainly for Home) |
| `search` | Search card contents and board titles |
| `list_todo_lists` | List every to-do checklist across the whole tree |
| `create_item` | Create a note/todo/link/column/comment/board/heading/document/table/color/draw/line/shape card (optional `stage`; lines take `kind`) |
| `update_item` | Edit a card's data/position/color/parent/stage |
| `list_pipeline` | Miladash: every staged idea (thought/design/code), newest change first |
| `promote_item` | Miladash: turn a Code-stage idea into a Pondering Orb project |
| `delete_item` | Move a card to the Trash (with everything inside it) |
| `restore_item` | Restore a deleted card from the Trash |
| `add_todo_task` | Append a task to a to-do card |
| `set_todo_task_done` | Check/uncheck a task on a to-do card |
| `remove_todo_task` | Remove a task from a to-do card |

Image and file-upload cards can't be created via MCP (they require an actual
file upload) but are visible in `get_board`/`search` results.

`update_item` on a `board` card syncs title/color changes to its canvas
automatically — `update_canvas` exists for the one case that doesn't cover:
the root "Home" board has no card of its own, so it's the only board you
need `update_canvas` for in practice.

Deleting moves a card to the app's Trash together with everything inside
it (a column's cards, a board's whole nested subtree, attached lines), so
`restore_item(item_id)` (same id you passed to `delete_item`) brings it all
back exactly as it was — for any card type — until the Trash is emptied in
the web UI.

Notes and comments are rich text: create/update them with `title`/`body` as
before (the server converts that into the stored `doc`), and read them back
through `data.text`.

## Standalone dev setup

Requires [uv](https://docs.astral.sh/uv/). For running against a `milaclone`
instance that isn't the bundled `app/` (e.g. one running elsewhere):

```bash
uv sync
cp .env.example .env
# edit .env: set MILACLONE_URL, and MILACLONE_API_KEY if that instance has one
uv run milaclone-mcp
```

### Register with Claude Code (stdio, local dev)

Add to `~/.claude.json` under `mcpServers`:

```json
"milaclone": {
  "command": "/abs/path/to/mcp/.venv/bin/milaclone-mcp"
}
```

(On Windows: `...\.venv\Scripts\milaclone-mcp.exe`.)

Runs on **mcp 2.0**'s `MCPServer`, which supports `stdio`, `sse`, and
`streamable-http` transports. stdio is for this local-dev case;
streamable-http is what the bundled Docker deployment uses (see root README).

## Notes on milaclone's data model

- A board is a `canvas`; `board`-type cards are portals to a child canvas via
  `data.childCanvasId`.
- `PATCH /api/item/:id` shallow-merges `data` — passing `{"body": "..."}` for
  a note leaves `title` alone. But this means arrays (like a todo's `tasks`)
  are replaced wholesale, not merged — hence the dedicated `add_todo_task` /
  `set_todo_task_done` tools, which read-modify-write the full array for you.
- `search` is a simple `LIKE` scan (see milaclone's `/api/search`), fine at
  personal-notes scale.
