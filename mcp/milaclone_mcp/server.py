"""
MCP server exposing full read/write access to a self-hosted milaclone board.

Two ways to run it:

- stdio (default) — for a locally-installed Claude Code/Desktop that spawns
  the server itself. Register in ~/.claude.json under `mcpServers`:

      "milaclone": {
        "command": "/abs/path/to/.venv/bin/milaclone-mcp"
      }

- streamable-http — for running as a standalone service (e.g. in Docker on
  Unraid) that a remote MCP client connects to over the network. Set
  MCP_TRANSPORT=streamable-http (see README for the rest of the env vars).

Config: set MILACLONE_URL (and MILACLONE_API_KEY if the server has one) in
the project .env file (see README).
"""

import os
import random
import secrets
import string
from typing import Any

from mcp.server.mcpserver import MCPServer

from milaclone_mcp.auth import load_config
from milaclone_mcp.client import MilacloneClient
from milaclone_mcp.exceptions import NotFoundError

mcp = MCPServer("milaclone")

_client: MilacloneClient | None = None

CREATABLE_TYPES = (
    "note", "todo", "link", "column", "comment", "board",
    "heading", "document", "table", "color", "draw", "line",
)


def _get_client() -> MilacloneClient:
    global _client
    if _client is None:
        base_url, api_key = load_config()
        _client = MilacloneClient(base_url, api_key)
    return _client


def _new_task_id() -> str:
    # Mirrors the frontend's `rid()` (public/js/util.js) closely enough —
    # the server treats task ids as opaque strings, so exact format doesn't matter.
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


@mcp.tool()
def get_root() -> dict[str, Any]:
    """Return the ID of the top-level "Home" board. Start here to discover board_id."""
    return _get_client().get_root()


@mcp.tool()
def list_boards(depth: int = 3) -> dict[str, Any]:
    """
    Recursively walk the board tree starting at Home, returning nested board
    titles/ids/item-counts (not card contents — use `get_board` for that).

    Args:
        depth: how many levels of nested boards to descend into (default 3).
            0 = just the root board's info, no recursion.

    Use this first to orient yourself in the workspace, then `get_board` or
    `search` to drill into a specific board's contents.
    """
    client = _get_client()
    root_id = client.get_root()["rootCanvasId"]

    def walk(board_id: str, remaining: int) -> dict[str, Any]:
        data = client.get_canvas(board_id)
        canvas = data["canvas"]
        items = data["items"]
        node: dict[str, Any] = {
            "id": canvas["id"],
            "title": canvas["title"],
            "item_count": len(items),
        }
        sub_boards = [
            it for it in items if it["type"] == "board" and it.get("data", {}).get("childCanvasId")
        ]
        if sub_boards and remaining > 0:
            node["boards"] = [
                walk(it["data"]["childCanvasId"], remaining - 1) for it in sub_boards
            ]
        elif sub_boards:
            node["boards"] = [
                {"id": it["data"]["childCanvasId"], "title": it.get("_childTitle", "Board")}
                for it in sub_boards
            ]
        return node

    return walk(root_id, depth)


@mcp.tool()
def get_board(board_id: str) -> dict[str, Any]:
    """
    Fetch a board's cards and breadcrumb trail.

    Args:
        board_id: from `get_root`, `list_boards`, or a `board`-type item's
            `data.childCanvasId` in a parent board's item list.

    Each item has: id, type (note/todo/link/column/comment/board/image/file/
    heading/document/table/color/draw/line), x/y/w/h, color, data (shape
    depends on type — see `create_item`), and for board items,
    `_childTitle`/`_childCount` describing the nested board.
    """
    return _get_client().get_canvas(board_id)


@mcp.tool()
def get_item(item_id: str) -> dict[str, Any]:
    """
    Fetch a single card by id, without needing its board_id or pulling the
    whole board.

    Same shape as one entry in `get_board`'s `items` list (including
    `_childTitle`/`_childCount`/etc. for board cards).
    """
    return _get_client().get_item(item_id)


@mcp.tool()
def update_canvas(
    canvas_id: str,
    title: str | None = None,
    color: str | None = None,
    icon: str | None = None,
) -> dict[str, Any]:
    """
    Rename/recolor/re-icon a board directly by its canvas id.

    Most boards are better edited through `update_item` on their `board`
    card elsewhere on the tree — changing that card's `data.title`/color
    syncs to the canvas automatically. Use this one specifically for the
    root "Home" board (from `get_root`), which has no card of its own to
    edit that way, or any other time you only have a canvas id on hand.

    Only pass the fields you want to change.
    """
    body: dict[str, Any] = {}
    if title is not None:
        body["title"] = title
    if color is not None:
        body["color"] = color
    if icon is not None:
        body["icon"] = icon
    return _get_client().patch_canvas(canvas_id, body)


@mcp.tool()
def search(query: str, limit: int = 25) -> dict[str, Any]:
    """
    Search card contents and board titles for a substring (case-insensitive).

    Args:
        query: text to search for.
        limit: max matches to return per category (items / boards), default 25.

    Returns {"items": [...], "boards": [...]}. Each item includes its
    canvasId/canvasTitle so you can jump to it with `get_board`.
    """
    return _get_client().search(query, limit=limit)


@mcp.tool()
def list_todo_lists() -> dict[str, Any]:
    """
    Return every `todo` (quick-notes) card across the entire board tree, flattened.

    Each list has: id, canvasId, canvasTitle, title, tasks: [{id, text, done}].
    Use `add_todo_task` / `set_todo_task_done` to edit tasks, or `update_item`
    for anything else (title, color, position).
    """
    return _get_client().get_todos()


@mcp.tool()
def create_item(
    canvas_id: str,
    item_type: str,
    data: dict[str, Any],
    x: int = 60,
    y: int = 60,
    w: int | None = None,
    color: str | None = None,
    parent_item_id: str | None = None,
) -> dict[str, Any]:
    """
    Create a card on a board.

    Args:
        canvas_id: board to add the card to.
        item_type: one of "note", "todo", "link", "column", "comment", "board",
            "heading", "document", "table", "color", "draw", "line".
            (Images and uploaded files aren't supported here — they require a
            file upload through the web UI.)
        data: shape depends on item_type:
            note:     {"title": str, "body": str}
            todo:     {"title": str, "tasks": [{"id": str, "text": str, "done": bool}]}
            link:     {"title": str, "url": str}
            column:   {"title": str}
            comment:  {"body": str}
            board:    {"title": str, "icon": str (optional Lucide icon name)}
            heading:  {"text": str}
            document: {"title": str, "bodyHtml": str} — bodyHtml is rendered
                rich text (the in-app editor writes real HTML: <b>, <i>, <ul>,
                <blockquote>, etc.), not markdown or plain text. The card
                itself is just a tile; opening it in the web UI shows the
                full-page editor.
            table:    {"rows": [[str, ...], ...]} — a rectangular grid; every
                row must be the same length.
            color:    {"hex": str} — a "#rrggbb" swatch value.
            draw:     {"strokes": [{"points": [[x, y], ...], "color": str,
                "width": int}, ...]} — freehand paths in the card's own local
                pixel space (top-left = 0,0). Not practical to hand-author;
                mainly useful for reading back what a user drew.
            line:     {"fromId": str, "toId": str, "label": str (optional),
                "bend": number (optional), "along": number (optional)} — a
                connector between two *other* items already on this board
                (by id). x/y/w are ignored for this type — the connector's
                position is derived entirely from the two cards it joins.
                `bend`/`along` offset the curve's control point
                perpendicular/parallel to the straight line between them;
                omit both for a straight connector.
        x, y: position on the canvas in board units (default 60, 60). Ignored
            for item_type "line".
        w: card width in pixels (defaults to a sensible per-type value).
            Ignored for "line"; "draw" and "document" are fixed-size and
            can't be resized after creation.
        color: one of milaclone's palette names (e.g. "blue", "slate", "rose").
        parent_item_id: set to nest this card inside a `column` card.

    Returns the created item, including its new `id`.
    """
    if item_type not in CREATABLE_TYPES:
        raise ValueError(f"item_type must be one of {CREATABLE_TYPES}, got {item_type!r}")
    body: dict[str, Any] = {
        "canvasId": canvas_id,
        "type": item_type,
        "x": x,
        "y": y,
        "data": data,
    }
    if w is not None:
        body["w"] = w
    if color is not None:
        body["color"] = color
    if parent_item_id is not None:
        body["parentItemId"] = parent_item_id
    return _get_client().create_item(body)


@mcp.tool()
def update_item(
    item_id: str,
    data: dict[str, Any] | None = None,
    x: int | None = None,
    y: int | None = None,
    w: int | None = None,
    h: int | None = None,
    color: str | None = None,
    canvas_id: str | None = None,
    parent_item_id: str | None = None,
) -> dict[str, Any]:
    """
    Partially update a card. Only pass the fields you want to change.

    `data` is shallow-merged into the existing data server-side — for a
    `note`, passing {"body": "new text"} leaves `title` untouched. For a
    `todo`'s `tasks` array specifically, a partial merge won't work (the
    whole array is replaced) — use `add_todo_task`/`set_todo_task_done`, or
    pass the full tasks list yourself.

    `canvas_id`/`parent_item_id` move the card to a different board/column.
    """
    body: dict[str, Any] = {}
    if data is not None:
        body["data"] = data
    if x is not None:
        body["x"] = x
    if y is not None:
        body["y"] = y
    if w is not None:
        body["w"] = w
    if h is not None:
        body["h"] = h
    if color is not None:
        body["color"] = color
    if canvas_id is not None:
        body["canvasId"] = canvas_id
    if parent_item_id is not None:
        body["parentItemId"] = parent_item_id
    return _get_client().patch_item(item_id, body)


@mcp.tool()
def delete_item(item_id: str) -> dict[str, Any]:
    """
    Delete a card. If it's a `board` card, its entire nested board (and
    everything on it, recursively) is deleted too.

    Deleting a `board` card can be undone with `restore_item` (pass this
    same item_id) — the whole nested subtree comes back exactly as it was.
    Deleting any other card type is permanent; there's no restore for those.
    """
    return _get_client().delete_item(item_id)


@mcp.tool()
def restore_item(item_id: str) -> dict[str, Any]:
    """
    Undo the deletion of a `board` card — brings back the board and
    everything nested inside it (however deep), exactly as it was.

    Args:
        item_id: the id of the deleted board card (the id you passed to
            `delete_item`, not its child board's id).

    Only works for boards, and only until something else deletes that same
    board again. Other card types can't be restored this way — deleting
    them is permanent, so there's nothing to call this with.
    """
    return _get_client().restore_item(item_id)


@mcp.tool()
def add_todo_task(item_id: str, text: str, done: bool = False) -> dict[str, Any]:
    """
    Append a task to an existing `todo` card's checklist.

    Args:
        item_id: the todo card's id (from `list_todo_lists` or `get_board`).
        text: task text.
        done: initial checked state (default False).

    Returns the updated item.
    """
    todo = _find_todo(item_id)
    tasks = list(todo.get("tasks", []))
    tasks.append({"id": _new_task_id(), "text": text, "done": done})
    return _get_client().patch_item(item_id, {"data": {"tasks": tasks}})


@mcp.tool()
def set_todo_task_done(item_id: str, task_id: str, done: bool) -> dict[str, Any]:
    """
    Check/uncheck one task within a `todo` card's checklist.

    Args:
        item_id: the todo card's id.
        task_id: the task's id (from `list_todo_lists`).
        done: new checked state.

    Returns the updated item.
    """
    todo = _find_todo(item_id)
    tasks = list(todo.get("tasks", []))
    for t in tasks:
        if t.get("id") == task_id:
            t["done"] = done
            break
    else:
        raise NotFoundError(f"Task {task_id} not found on todo {item_id}")
    return _get_client().patch_item(item_id, {"data": {"tasks": tasks}})


@mcp.tool()
def remove_todo_task(item_id: str, task_id: str) -> dict[str, Any]:
    """
    Remove a task from a `todo` card's checklist.

    Args:
        item_id: the todo card's id.
        task_id: the task's id (from `list_todo_lists`).

    Returns the updated item.
    """
    todo = _find_todo(item_id)
    tasks = [t for t in todo.get("tasks", []) if t.get("id") != task_id]
    if len(tasks) == len(todo.get("tasks", [])):
        raise NotFoundError(f"Task {task_id} not found on todo {item_id}")
    return _get_client().patch_item(item_id, {"data": {"tasks": tasks}})


def _find_todo(item_id: str) -> dict[str, Any]:
    for lst in _get_client().get_todos().get("lists", []):
        if lst["id"] == item_id:
            return lst
    raise NotFoundError(f"Todo card {item_id} not found")


def main() -> None:
    transport = os.environ.get("MCP_TRANSPORT", "stdio").strip().lower()

    if transport == "stdio":
        mcp.run()
        return

    if transport != "streamable-http":
        raise ValueError(
            f"Unknown MCP_TRANSPORT: {transport!r} (use 'stdio' or 'streamable-http')"
        )

    import uvicorn

    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "8383"))
    auth_token = os.environ.get("MCP_AUTH_TOKEN", "").strip()

    app = mcp.streamable_http_app(host=host)

    if auth_token:
        app.add_middleware(_BearerAuthMiddleware, token=auth_token)

    uvicorn.run(app, host=host, port=port, log_level="info")


class _BearerAuthMiddleware:
    """
    Minimal `Authorization: Bearer <token>` gate for the streamable-http
    transport. Not OAuth — MCPServer's built-in `auth`/`token_verifier`
    machinery is a full RFC 8414/9068 authorization-server integration meant
    for enterprise IdPs, overkill for gating a single-user personal server.
    This is the network-facing equivalent of milaclone's own API_KEY check.
    """

    def __init__(self, app: Any, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        headers = dict(scope.get("headers") or [])
        header = headers.get(b"authorization", b"").decode()
        provided = header[7:].strip() if header.lower().startswith("bearer ") else ""

        if provided and secrets.compare_digest(provided, self.token):
            return await self.app(scope, receive, send)

        from starlette.responses import JSONResponse

        response = JSONResponse({"error": "unauthorized"}, status_code=401)
        await response(scope, receive, send)


if __name__ == "__main__":
    main()
