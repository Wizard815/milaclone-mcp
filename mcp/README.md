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
| `search` | Search card contents and board titles |
| `list_todo_lists` | List every to-do checklist across the whole tree |
| `create_item` | Create a note/todo/link/column/comment/board card |
| `update_item` | Edit a card's data/position/color/parent |
| `delete_item` | Delete a card (recursively, if it's a nested board) |
| `add_todo_task` | Append a task to a to-do card |
| `set_todo_task_done` | Check/uncheck a task on a to-do card |

Image and file-upload cards can't be created via MCP (they require an actual
file upload) but are visible in `get_board`/`search` results.

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
