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

from milaclone_mcp.auth import load_config, load_task_token
from milaclone_mcp.client import MilacloneClient
from milaclone_mcp.exceptions import NotFoundError

mcp = MCPServer("milaclone")

_client: MilacloneClient | None = None

STAGES = ("thought", "design", "code")
LINE_KINDS = ("relates", "depends", "became")


def _check_stage(stage: str | None) -> None:
    if stage is not None and stage not in STAGES and stage not in ("", "none"):
        raise ValueError(f"stage must be one of {STAGES} (or 'none' to clear), got {stage!r}")


CREATABLE_TYPES = (
    "note", "todo", "link", "column", "comment", "board",
    "document", "table", "swatch", "line", "shortcut", "panel",
)


def _line_data(data: dict[str, Any]) -> dict[str, Any]:
    """Friendly line fields (fromId/toId, label) -> the app's stored shape (from/to, text)."""
    d = dict(data)
    if "fromId" in d:
        d["from"] = {"id": d.pop("fromId")}
    if "toId" in d:
        d["to"] = {"id": d.pop("toId")}
    if d.get("label") is not None:
        d["text"] = d["label"]
    if d.get("kind") == "depends" and "dashed" not in d:
        d["dashed"] = True
    return d


def _normalize(item_type: str, data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Map legacy/alias item types and friendly fields onto what the app stores."""
    if item_type == "color":
        item_type = "swatch"
    if item_type == "heading":
        item_type, data = "note", {"title": data.get("text") or data.get("title") or "", "body": ""}
    if item_type == "swatch" and "hex" in data and "text" not in data:
        data = {**data, "text": data["hex"]}
    if item_type == "line":
        data = _line_data(data)
        for end in ("from", "to"):
            if not isinstance(data.get(end), dict) or not data[end].get("id"):
                raise ValueError(f"a line needs {end}Id (the id of a card on the same board)")
    return item_type, data


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
    document/table/swatch/sketch/shortcut/line/panel), x/y/w/h, color, stage,
    data (shape depends on type — see `create_item`), and: for board items
    `_childTitle`/`_childCount`; for cards `_panelId`/`_panelTitle` when
    inside a panel; for panels `_memberIds`/`_memberCount`. Notes and comments
    carry their text in `data.text` (a note's title is its first line) beside
    the rich `data.doc`. Prefer `get_board_outline` first — this returns every
    card's full contents.
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
        limit: max results to return, default 25.

    Returns {"results": [...]}: boards first ({"kind": "board", "canvasId",
    "title", "path"}) then cards ({"kind": "item", "id", "canvasId", "type",
    "title" (a snippet around the match), "path"}). `path` is the board
    breadcrumb as titles. Use `get_board_outline`/`get_board` with canvasId or
    `get_item` with id to read more.
    """
    res = _get_client().search(query, limit=limit)
    res["results"] = res.get("results", [])[:limit]
    return res


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
    stage: str | None = None,
) -> dict[str, Any]:
    """
    Create a card on a board.

    Args:
        canvas_id: board to add the card to.
        item_type: one of "note", "todo", "link", "column", "comment", "board",
            "document", "table", "swatch", "line", "shortcut", "panel".
            Aliases: "heading" makes a note whose text is a title only;
            "color" is "swatch". (Images, uploads and sketches need the web UI.)
        data: shape depends on item_type:
            note:     {"title": str, "body": str} — plain text; stored as rich
                text (title becomes a heading). Reading it back gives
                `data.text` ("title\nbody") plus `data.doc` (rich JSON). Rich
                formatting made in the web UI is flattened if you edit the body
                here. Optional "labels": [str, ...].
            comment:  {"body": str}
            todo:     {"title": str, "tasks": [{"id": str, "text": str, "done": bool}]}
            link:     {"title": str, "url": str}
            column:   {"title": str} — a vertical stack; add cards to it with
                parent_item_id.
            board:    {"title": str, "icon": str (optional Lucide icon name)}
            document: {"title": str, "text": str} — a full-page document card.
            table:    {"rows": [[str, ...], ...], "text": str} — rectangular
                grid (every row the same length); `text` is its plain-text
                form for search (join cells with spaces).
            swatch:   {"hex": "#rrggbb", "text": "#rrggbb"}
            shortcut: {"targetCanvasId": str} — an alias card that opens that board.
            line:     {"fromId": str, "toId": str, "label": str (optional),
                "kind": "relates" | "depends" | "became" (optional),
                "arrow": "end" | "both" | "none" (default "end"),
                "dashed": bool} — a connector between two *other* cards on
                this board, by id. (Stored by the app as from:{id}/to:{id};
                fromId/toId are converted for you.) kind is one of "relates",
                "depends" (drawn dashed) or "became". x/y/w are ignored.
            panel:    {"title": str, "shape": "rect" | "rounded" | "ellipse"}
                — see `create_panel`.
        x, y: position on the canvas in board units (default 60, 60); 0 is a
            real coordinate. Ignored for "line".
        w: card width in pixels (defaults to a sensible per-type value).
        color: one of the palette names ("slate", "gray", "teal", "green",
            "brown", "yellow", "orange", "red", "pink", "purple", "blue",
            "indigo").
        parent_item_id: set to nest this card inside a `column` card (same board).
        stage: Miladash idea stage, one of "thought", "design", "code" (omit
            for a card that isn't in the idea pipeline). Stage is a field,
            not a position: it shows as a chip on the card and puts the card
            in the Pipeline view's matching column.

    Returns the created item, including its new `id`.
    """
    _check_stage(stage)
    item_type, data = _normalize(item_type, data)
    if item_type == "line" and data.get("kind") not in (None, *LINE_KINDS):
        raise ValueError(f"line kind must be one of {LINE_KINDS}")
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
    if stage:
        body["stage"] = stage
    return _get_client().create_item(body)


@mcp.tool()
def create_panel(
    canvas_id: str,
    title: str,
    x: int = 60,
    y: int = 60,
    w: int = 480,
    h: int = 320,
    shape: str = "rounded",
    color: str | None = None,
) -> dict[str, Any]:
    """
    Create a named floating panel: a background region of any size/shape that
    groups whatever cards sit inside it. Membership is purely positional — a
    card is "in" the panel when its anchor (horizontal centre, 24px below its
    top edge) lies inside the panel. So to put a card in a panel, place it
    there (create_item/update_item x,y) or use `add_to_panel`.

    Args:
        shape: "rect", "rounded" (default) or "ellipse".
        w, h: any size; a panel is drawn behind all other cards. Leave the top
            44px free for its title bar when placing cards inside.

    Moving a panel (`update_item` with new x/y) carries every card inside it
    (pass move_members=False to move only the panel). Deleting a panel keeps
    its cards. Panels can nest: a card belongs to the smallest panel
    containing it. Read membership from `get_board` (`_panelId`/`_panelTitle`
    on cards, `_memberIds` on panels) or `list_panels`.
    """
    body = {"title": title, "shape": shape}
    data: dict[str, Any] = body
    return _get_client().create_item({
        "canvasId": canvas_id, "type": "panel", "x": x, "y": y, "w": w, "h": h,
        "data": data, **({"color": color} if color else {}),
    })


@mcp.tool()
def group_into_panel(
    canvas_id: str,
    item_ids: list[str],
    title: str,
    shape: str = "rounded",
    color: str | None = None,
    padding: int = 40,
) -> dict[str, Any]:
    """
    Group existing cards by wrapping them in a new named panel sized to fit
    them. Nothing moves — the panel is drawn around the cards. The easiest way
    to organise a board: call once per cluster. Cards must be free cards on
    this board (not lines; a card inside a column is grouped via its column).

    Returns the new panel including `_memberIds`. The panel is a rectangle
    around the cards, so unrelated cards lying between them also become
    members — if that happens the result has a `_warning` naming them.
    """
    body: dict[str, Any] = {"itemIds": item_ids, "title": title, "shape": shape, "padding": padding}
    if color:
        body["color"] = color
    return _get_client().group_items(canvas_id, body)


@mcp.tool()
def add_to_panel(panel_id: str, item_ids: list[str]) -> dict[str, Any]:
    """
    Put cards inside an existing panel. Cards already inside stay where they
    are; others are laid out in rows in the panel's free space. The panel is
    never resized — if it's too small the result has a `warning`; enlarge it
    with `update_item(panel_id, w=..., h=...)`.
    """
    return _get_client().add_panel_members(panel_id, item_ids)


@mcp.tool()
def list_panels(canvas_id: str) -> dict[str, Any]:
    """
    List every panel on a board with the cards inside each (id, type, short
    preview), plus `ungrouped` — cards not in any panel. The compact way to
    see how a board is organised without reading every card.
    """
    return _get_client().list_panels(canvas_id)


@mcp.tool()
def get_board_outline(board_id: str) -> dict[str, Any]:
    """
    Compact map of a board: one short line per card (id, type, label, x/y/w/h,
    panel it is in, stage) instead of full card contents. Cheaper than
    `get_board` for orienting yourself or finding ids — use `get_board`/
    `get_item` only for the few cards whose full contents you need.
    """
    data = _get_client().get_canvas(board_id)
    cards = []
    for it in data["items"]:
        d = it.get("data") or {}
        label = (
            it.get("_childTitle") if it["type"] == "board"
            else d.get("title") or (d.get("text") or "").split("\n")[0] or (d.get("body") or "")[:60] or d.get("url") or ""
        )
        row: dict[str, Any] = {"id": it["id"], "type": it["type"], "label": label[:60],
                               "x": it["x"], "y": it["y"], "w": it.get("w")}
        if it.get("h"):
            row["h"] = it["h"]
        if it["type"] == "line":
            row = {"id": it["id"], "type": "line", "from": (d.get("from") or {}).get("id"),
                   "to": (d.get("to") or {}).get("id"), "label": d.get("label", ""), "kind": d.get("kind", "relates")}
        if it["type"] == "board":
            row["board_id"] = (d or {}).get("childCanvasId")
        if it.get("parentItemId"):
            row["in_column"] = it["parentItemId"]
        if it.get("_panelId"):
            row["panel"] = it["_panelTitle"]
        if it.get("stage"):
            row["stage"] = it["stage"]
        cards.append(row)
    return {"board": data["canvas"]["title"], "board_id": board_id,
            "breadcrumb": [b["title"] for b in data["breadcrumb"]], "cards": cards}


@mcp.tool()
def create_items(canvas_id: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Create several cards on one board in a single call. Each entry takes the
    same fields as `create_item` (item_type, data, x, y, w, color,
    parent_item_id, stage). Cards are created in order, so a column can be
    followed by cards whose parent_item_id is unknown until it exists — for
    that, create the column first with `create_item`. Lines (item_type "line")
    may reference earlier cards via data.fromId/toId only by real ids.

    Returns {"created": [items...], "errors": [{"index": n, "error": str}]}.
    One bad entry doesn't stop the rest.
    """
    created, errors = [], []
    for i, spec in enumerate(items):
        try:
            created.append(create_item(
                canvas_id=canvas_id, item_type=spec["item_type"], data=spec.get("data", {}),
                x=spec.get("x", 60), y=spec.get("y", 60), w=spec.get("w"), color=spec.get("color"),
                parent_item_id=spec.get("parent_item_id"), stage=spec.get("stage"),
            ))
        except Exception as e:  # noqa: BLE001 - report per-entry, keep going
            errors.append({"index": i, "error": str(e)})
    return {"created": created, "errors": errors}


@mcp.tool()
def duplicate_item(
    item_id: str, canvas_id: str | None = None, x: int | None = None, y: int | None = None
) -> dict[str, Any]:
    """
    Deep-copy a card. A column is copied with its cards; a `board` card is
    copied with its entire nested subtree (new independent boards). By default
    the copy lands 30 units down-right of the original on the same board; pass
    canvas_id (and x/y) to copy it to another board. Lines can't be copied on
    their own (they are copied with their cards). To copy a whole board's
    contents as a reusable starting point, use `save_as_template`.
    """
    client = _get_client()
    src = client.get_item(item_id)
    target = canvas_id or src["canvasId"]
    same = target == src["canvasId"]
    return client.copy_item(item_id, {
        "canvasId": target,
        "x": x if x is not None else (src["x"] + 30 if same else src["x"]),
        "y": y if y is not None else (src["y"] + 30 if same else src["y"]),
    })


@mcp.tool()
def move_item(item_id: str, canvas_id: str, x: int = 60, y: int = 60) -> dict[str, Any]:
    """
    Move a card (with its column cards / nested boards) to another board at x, y.
    Use this rather than `update_item(canvas_id=...)` for boards and columns,
    since it carries their contents along. A board can't be moved into itself.
    """
    return _get_client().move_item(item_id, {"canvasId": canvas_id, "x": x, "y": y})


@mcp.tool()
def list_trash() -> dict[str, Any]:
    """
    List deleted cards still in the Trash, newest first: id, type, title, the
    board they were on and whether they are `restorable` (false when their board
    is itself in the Trash — restore that first). `restore_item(id)` brings one
    back. Nothing is erased until someone empties the Trash in the web UI.
    """
    return _get_client().get_trash()


@mcp.tool()
def export_board_markdown(board_id: str) -> str:
    """
    The board as Markdown text (cards under headings; nested boards flattened
    into sections) — a readable snapshot for summaries or hand-off.
    """
    return _get_client().export_markdown(board_id)


@mcp.tool()
def add_task(
    title: str, notes: str | None = None, tags: list[str] | None = None, due_date: str | None = None,
    starred: bool = False, list_id: str | None = None,
) -> dict[str, Any]:
    """
    Add a task to the Inbox to-do on Home (or to the to-do card `list_id`) via the
    app's task API — the same inbox the voice add-on feeds. Needs TASK_API_TOKEN
    in the MCP's environment (and on the app); otherwise explains how to set it.
    due_date is YYYY-MM-DD. Skips an open task with the same title.
    """
    token = load_task_token()
    if not token:
        raise ValueError("add_task needs TASK_API_TOKEN set for the MCP server (same value as the app's). "
                         "To add a task without it, use `add_todo_task` on a to-do card.")
    body: dict[str, Any] = {"title": title, "source": "mcp", "dedupe": True, "starred": starred}
    if notes:
        body["notes"] = notes
    if tags:
        body["tags"] = tags
    if due_date:
        body["dueDate"] = due_date
    if list_id:
        body["listId"] = list_id
    return _get_client().tasks_create(token, body)


@mcp.tool()
def list_tasks(status: str = "open") -> dict[str, Any]:
    """
    Every task across all to-do cards, by due date: status "open" (default),
    "done" or "all". Each task has listId/listTitle. Needs TASK_API_TOKEN like
    `add_task`; `list_todo_lists` works without it.
    """
    token = load_task_token()
    if not token:
        raise ValueError("list_tasks needs TASK_API_TOKEN; use `list_todo_lists` instead.")
    return _get_client().tasks_list(token, status)


@mcp.tool()
def copy_board(
    board_id: str, parent_board_id: str | None = None, title: str | None = None, x: int = 60, y: int = 60
) -> dict[str, Any]:
    """
    Copy a whole board (all its cards, panels, columns, lines and nested
    boards) as a new, independent board card on `parent_board_id` (default
    Home). Takes the *board's* id (as from `list_boards`), not a card id. Use
    this for "make a copy of board X"; use `save_as_template` for reusable
    starting points, and `export_board`/`import_board` only to move a board
    between systems.
    """
    body: dict[str, Any] = {"x": x, "y": y}
    if parent_board_id:
        body["canvasId"] = parent_board_id
    if title:
        body["title"] = title
    return _get_client().copy_board(board_id, body)


@mcp.tool()
def list_templates() -> dict[str, Any]:
    """
    List saved templates. A template is a board (cards, panels, columns, nested
    boards, lines) kept in a "Templates" board on Home, to be copied out again
    and again. Each entry: id, name, itemCount, panel titles, card-type counts.
    """
    return _get_client().list_templates()


@mcp.tool()
def save_as_template(board_id: str, name: str) -> dict[str, Any]:
    """
    Save an existing board (its contents, panels and nested boards) as a named
    template. The original board is untouched; later edits to it don't change
    the template. Names must be unique (case-insensitive).
    """
    return _get_client().save_template({"fromCanvasId": board_id, "name": name})


@mcp.tool()
def create_from_template(
    template_id: str, parent_board_id: str | None = None, title: str | None = None,
    x: int = 60, y: int = 60,
) -> dict[str, Any]:
    """
    Make a new board from a template: an independent copy placed as a board
    card on `parent_board_id` (default: Home). Returns the new board card; its
    `data.childCanvasId` is the new board's id for `get_board`/`list_panels`.
    """
    body: dict[str, Any] = {"x": x, "y": y}
    if parent_board_id:
        body["canvasId"] = parent_board_id
    if title:
        body["title"] = title
    return _get_client().use_template(template_id, body)


@mcp.tool()
def export_board(board_id: str, include_nested: bool = False) -> dict[str, Any]:
    """
    Export a board as an open JSON Canvas document ({"nodes": [...], "edges":
    [...]}), for backup or moving it to another system. (To copy a board within
    this workspace use `copy_board`.) include_nested also exports
    boards nested inside it.
    """
    return _get_client().export_canvas(board_id, include_nested)


@mcp.tool()
def import_board(parent_board_id: str, canvas: dict[str, Any], title: str = "Imported board") -> dict[str, Any]:
    """
    Import a JSON Canvas document (e.g. from `export_board`, or Obsidian) as a
    new board card on `parent_board_id`. Returns the new board card.
    """
    return _get_client().import_canvas(parent_board_id, {"canvas": canvas, "title": title})


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
    stage: str | None = None,
    move_members: bool = True,
) -> dict[str, Any]:
    """
    Partially update a card. Only pass the fields you want to change.

    `data` is shallow-merged into the existing data server-side — for a
    `note`, passing {"body": "new text"} leaves its title untouched (and
    {"title": ...} leaves the body). For a
    `todo`'s `tasks` array specifically, a partial merge won't work (the
    whole array is replaced) — use `add_todo_task`/`set_todo_task_done`, or
    pass the full tasks list yourself.

    Updating a `panel`'s x/y moves every card inside it too; w/h resize it
    (membership is recomputed from positions).

    `canvas_id`/`parent_item_id` move the card to a different board/column.

    `stage` sets the Miladash idea stage ("thought", "design", "code"); pass
    "none" to take the card out of the pipeline. For a `line`, set
    data={"kind": "relates" | "depends" | "became"} and/or {"label": str}.
    """
    _check_stage(stage)
    body: dict[str, Any] = {}
    if data is not None:
        if any(k in data for k in ("fromId", "toId", "label")):
            data = _line_data(data)
            for end in ("from", "to"):  # an end is replaced as a whole: {id} or a free {x, y}
                if end in data and not isinstance(data[end], dict):
                    raise ValueError(f"{end} must be an object like {{\"id\": ...}}")
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
    if stage is not None:
        body["stage"] = None if stage in ("", "none") else stage
    if not move_members:
        body["moveMembers"] = False
    return _get_client().patch_item(item_id, body)


@mcp.tool()
def list_pipeline() -> dict[str, Any]:
    """
    List every card that has a Miladash stage, across all boards, newest
    change first. Each item has `stage`, `_title` and `_canvasTitle` (the
    board it sits on), and `data.promoted` once it became an Orb project.
    """
    return _get_client().get_pipeline()


@mcp.tool()
def promote_item(item_id: str) -> dict[str, Any]:
    """
    Promote a Code-stage idea to a project in Pondering Orb. The Miladash
    server makes the call (it holds ORB_URL/ORB_TOKEN) and marks the card
    promoted. Fails if the card isn't at stage "code", is already promoted,
    or the server has no ORB_URL.
    """
    return _get_client().promote_item(item_id)


@mcp.tool()
def delete_item(item_id: str) -> dict[str, Any]:
    """
    Move a card to the Trash. A `board` card takes its whole nested board with
    it, a column takes its cards, and lines attached to it go too. Nothing is
    erased: `restore_item` (same item_id) brings back exactly what that delete
    removed, and `list_trash` shows what is there.
    """
    return _get_client().delete_item(item_id)


@mcp.tool()
def restore_item(item_id: str) -> dict[str, Any]:
    """
    Undo a delete: brings back the card and everything that went with it (a
    board's nested boards, a column's cards, attached lines).

    Args:
        item_id: the id passed to `delete_item` (see `list_trash`).

    Fails if the card's own board is in the Trash (restore that board first) or
    if the item isn't in the Trash. A card restored after its column was
    deleted separately comes back loose where the column stood.
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
