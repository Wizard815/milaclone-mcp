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
| `get_board_outline` | Compact map of a board: one line per card with id, type, label, position, panel. Start here |
| `get_board` | A board's full cards (+ `_panelId`, breadcrumb) — heavier than the outline |
| `get_item` | Fetch a single card by id |
| `search` | Search card text and board titles (`{results: [...]}`) |
| `list_todo_lists` | Every to-do checklist across the whole tree |
| `create_item` / `create_items` | Create one card / several in one call (note, todo, link, column, comment, board, document, table, swatch, line, shortcut, panel; optional `stage`) |
| `update_item` | Edit a card's data/position/size/color/parent/stage (a panel's x/y carries its members) |
| `move_item` | Move a card (with its column cards / nested boards) to another board |
| `duplicate_item` | Deep-copy a card (a column with its cards, a board with its subtree) |
| `delete_item` / `restore_item` / `list_trash` | Delete to the Trash, undo any delete, see what's in the Trash |
| `create_panel` | A named floating panel (any size; rect/rounded/ellipse) that groups the cards placed inside it |
| `group_into_panel` | Wrap existing cards in a new panel sized to fit them (warns if bystanders get swept in) |
| `add_to_panel` | Put cards inside a panel (laid out in its free space; warns if it's too small) |
| `list_panels` | Every panel with its members, plus the cards in no panel |
| `copy_board` | Copy a whole board (panels, nested boards, lines) as a new board |
| `list_templates` / `save_as_template` / `create_from_template` | Reusable board templates (kept in the Templates board on Home) |
| `export_board` / `import_board` / `export_board_markdown` | JSON Canvas (Obsidian) out/in; Markdown snapshot |
| `list_pipeline` / `promote_item` | Miladash: staged ideas (thought/design/code); promote a Code idea to a Pondering Orb project |
| `add_todo_task` / `set_todo_task_done` / `remove_todo_task` | Edit a to-do card's checklist |
| `add_task` / `list_tasks` | The app's task API (Inbox; the voice add-on's target). Need `TASK_API_TOKEN` |
| `update_canvas` | Rename/recolor/re-icon a board by canvas id (mainly for Home) |

Image and file-upload cards can't be created via MCP (they require an actual
file upload) but are visible in `get_board`/`search` results.

`update_item` on a `board` card syncs title/color changes to its canvas
automatically — `update_canvas` exists for the one case that doesn't cover:
the root "Home" board has no card of its own, so it's the only board you
need `update_canvas` for in practice.

Deleting a card moves it (and what hangs off it: a board's nested boards, a
column's cards, attached lines) to the Trash; `restore_item(item_id)` brings
back exactly that delete, and `list_trash` shows what is there. Nothing is
erased until the Trash is emptied in the web UI.

Notes and comments are rich text: write them with `{"title", "body"}` (plain
text) and read them back from `data.text` (a note's title is its first line).
Editing one body through the MCP flattens any rich formatting made in the app.

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

## Panels

A panel is a named, free-form background region. Membership is **positional**:
a card is in a panel when its anchor (horizontal centre, 24px below its top
edge) lies inside it, so "putting a card in a panel" is just placing it there.
The API reports it on every read: `_panelId`/`_panelTitle` on cards and
`_memberIds`/`_memberCount` on panels. Nested panels work — a card belongs to
the *smallest* panel holding it. `update_item` on a panel's x/y carries
everything inside it (`move_members=False` to move only the panel); deleting a
panel keeps its cards.

`scripts/agent_eval.py` drives these tools with a real model over OpenRouter and
checks the board afterwards (`OPENROUTER_API_KEY`, `--budget` caps spend).
