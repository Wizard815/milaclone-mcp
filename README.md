# milaclone-mcp

An MCP server giving AI assistants (Claude Code, Claude Desktop, etc.) full
read/write access to a self-hosted [milaclone](../milaclone) board: list and
search boards, read cards, and create/edit/delete notes, to-dos, links,
columns, comments, and nested boards.

Unlike [milanote-mcp](../milanote-mcp) (read-only, against the real Milanote
SaaS via a scraped browser token), this talks to your own milaclone instance
over its plain REST API — no token scraping, and full CRUD.

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

## Setup

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync
cp .env.example .env
# edit .env: set MILACLONE_URL, and MILACLONE_API_KEY if your instance has one
```

Test it directly:

```bash
uv run milaclone-mcp
```

### Register with Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
"milaclone": {
  "command": "/abs/path/to/milaclone-mcp/.venv/bin/milaclone-mcp"
}
```

(On Windows: `...\.venv\Scripts\milaclone-mcp.exe`.)

## Auth

milaclone has no auth by default (it relies on network-level trust — e.g.
Tailscale-only exposure). If you've set `API_KEY` in milaclone's environment
(see its README), set the matching `MILACLONE_API_KEY` here so requests are
accepted.

## Notes on milaclone's data model

- A board is a `canvas`; `board`-type cards are portals to a child canvas via
  `data.childCanvasId`.
- `PATCH /api/item/:id` shallow-merges `data` — passing `{"body": "..."}` for
  a note leaves `title` alone. But this means arrays (like a todo's `tasks`)
  are replaced wholesale, not merged — hence the dedicated `add_todo_task` /
  `set_todo_task_done` tools, which read-modify-write the full array for you.
- `search` is a simple `LIKE` scan (see milaclone's `/api/search`), fine at
  personal-notes scale.

## License

[MIT](LICENSE)
