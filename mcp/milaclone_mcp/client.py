from typing import Any

import httpx

from milaclone_mcp.exceptions import AuthError, MilacloneError, NotFoundError


class MilacloneClient:
    def __init__(self, base_url: str, api_key: str = "", *, timeout: float = 30.0):
        headers = {"Accept": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        self._http = httpx.Client(base_url=base_url, headers=headers, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "MilacloneClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _handle(self, resp: httpx.Response) -> dict[str, Any]:
        if resp.status_code == 401:
            raise AuthError(
                "milaclone rejected the request (401). Check MILACLONE_API_KEY."
            )
        if resp.status_code == 404:
            raise NotFoundError(f"Not found: {resp.request.url}")
        if resp.status_code >= 400:
            # Surface the server's own explanation (e.g. "Only ideas at the
            # Code stage can be promoted.") instead of a bare status code.
            try:
                msg = resp.json().get("error")
            except ValueError:
                msg = None
            if msg:
                raise MilacloneError(f"milaclone answered {resp.status_code}: {msg}")
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError as e:
            raise MilacloneError(
                f"Non-JSON response from {resp.request.url}: {resp.text[:200]}"
            ) from e

    def _get(self, path: str, **params: Any) -> dict[str, Any]:
        return self._handle(self._http.get(path, params=params or None))

    # ---- Task API (separate bearer token; see app/docs/task-api.md) ----------
    def tasks_create(self, token: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/tasks — add a task to the Inbox (or a given to-do card)."""
        return self._handle(self._http.post("/api/tasks", json=body, headers={"Authorization": f"Bearer {token}"}))

    def tasks_list(self, token: str, status: str) -> dict[str, Any]:
        """GET /api/tasks?status=open|done|all."""
        return self._handle(self._http.get("/api/tasks", params={"status": status}, headers={"Authorization": f"Bearer {token}"}))

    # ---- Copy / move / trash / markdown -----------------------------------------
    def copy_item(self, item_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/item/{id}/copy — deep copy to {canvasId, x, y}."""
        return self._post(f"/api/item/{item_id}/copy", body)

    def move_item(self, item_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/item/{id}/move — move (with subtree) to {canvasId, x, y}."""
        return self._post(f"/api/item/{item_id}/move", body)

    def get_trash(self) -> dict[str, Any]:
        """GET /api/trash — one entry per delete, newest first."""
        return self._get("/api/trash")

    def export_markdown(self, canvas_id: str) -> str:
        """GET /api/canvas/{id}/export.md — the board as Markdown text."""
        resp = self._http.get(f"/api/canvas/{canvas_id}/export.md")
        if resp.status_code == 404:
            raise NotFoundError(f"Not found: {resp.request.url}")
        resp.raise_for_status()
        return resp.text

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._handle(self._http.post(path, json=body))

    def _patch(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._handle(self._http.patch(path, json=body))

    def _delete(self, path: str) -> dict[str, Any]:
        return self._handle(self._http.delete(path))

    # ---- Canvas (boards) ----------------------------------------------------
    def get_root(self) -> dict[str, Any]:
        """GET /api/root — {"rootCanvasId": str}."""
        return self._get("/api/root")

    def get_canvas(self, canvas_id: str) -> dict[str, Any]:
        """GET /api/canvas/{id} — {"canvas", "items", "breadcrumb"}."""
        return self._get(f"/api/canvas/{canvas_id}")

    def patch_canvas(self, canvas_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """PATCH /api/canvas/{id} — rename/recolor/re-icon a board."""
        return self._patch(f"/api/canvas/{canvas_id}", body)

    # ---- Panels ---------------------------------------------------------------
    def list_panels(self, canvas_id: str) -> dict[str, Any]:
        """GET /api/canvas/{id}/panels — panels with members, plus ungrouped cards."""
        return self._get(f"/api/canvas/{canvas_id}/panels")

    def group_items(self, canvas_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/canvas/{id}/panels/group — wrap existing cards in a new panel."""
        return self._post(f"/api/canvas/{canvas_id}/panels/group", body)

    def add_panel_members(self, panel_id: str, item_ids: list[str]) -> dict[str, Any]:
        """POST /api/panel/{id}/members — place cards inside a panel."""
        return self._post(f"/api/panel/{panel_id}/members", {"itemIds": item_ids})

    # ---- Duplicate / templates / JSON Canvas ----------------------------------
    def duplicate_item(self, item_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/item/{id}/duplicate — deep copy of a card (column, board subtree...)."""
        return self._post(f"/api/item/{item_id}/duplicate", body)

    def list_templates(self) -> dict[str, Any]:
        """GET /api/templates."""
        return self._get("/api/templates")

    def save_template(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/templates — copy a board into the Templates board."""
        return self._post("/api/templates", body)

    def use_template(self, template_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/templates/{id}/use — copy a template out as a new board."""
        return self._post(f"/api/templates/{template_id}/use", body)

    def copy_board(self, canvas_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/canvas/{id}/copy — copy a whole board as a new board card."""
        return self._post(f"/api/canvas/{canvas_id}/copy", body)

    def export_canvas(self, canvas_id: str, nested: bool) -> dict[str, Any]:
        """GET /api/canvas/{id}/export — JSON Canvas document."""
        return self._get(f"/api/canvas/{canvas_id}/export", nested="1" if nested else "0")

    def import_canvas(self, canvas_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/canvas/{id}/import — import a JSON Canvas as a new board."""
        return self._post(f"/api/canvas/{canvas_id}/import", body)

    # ---- Items ----------------------------------------------------------------
    def get_item(self, item_id: str) -> dict[str, Any]:
        """GET /api/item/{id} — a single card, wherever it lives."""
        return self._get(f"/api/item/{item_id}")

    def create_item(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/item — create a card on a board."""
        return self._post("/api/item", body)

    def patch_item(self, item_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """PATCH /api/item/{id} — partial update; `data` is shallow-merged server-side."""
        return self._patch(f"/api/item/{item_id}", body)

    def delete_item(self, item_id: str) -> dict[str, Any]:
        """DELETE /api/item/{id} — deletes recursively (children + nested board subtree)."""
        return self._delete(f"/api/item/{item_id}")

    def restore_item(self, item_id: str) -> dict[str, Any]:
        """POST /api/item/{id}/restore — undo a board's deletion (see delete_item)."""
        return self._post(f"/api/item/{item_id}/restore", {})

    def promote_item(self, item_id: str) -> dict[str, Any]:
        """POST /api/item/{id}/promote — create an Orb project from a Code-stage idea."""
        return self._post(f"/api/item/{item_id}/promote", {})

    def get_pipeline(self) -> dict[str, Any]:
        """GET /api/pipeline — every staged card, newest change first."""
        return self._get("/api/pipeline")

    # ---- Quick notes / search ---------------------------------------------
    def get_todos(self) -> dict[str, Any]:
        """GET /api/todos — every `todo` card across the whole tree, flattened."""
        return self._get("/api/todos")

    def search(self, query: str, limit: int = 25) -> dict[str, Any]:
        """GET /api/search — matching items and boards."""
        return self._get("/api/search", q=query, limit=limit)
