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
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError as e:
            raise MilacloneError(
                f"Non-JSON response from {resp.request.url}: {resp.text[:200]}"
            ) from e

    def _get(self, path: str, **params: Any) -> dict[str, Any]:
        return self._handle(self._http.get(path, params=params or None))

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

    # ---- Items ----------------------------------------------------------------
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

    # ---- Quick notes / search ---------------------------------------------
    def get_todos(self) -> dict[str, Any]:
        """GET /api/todos — every `todo` card across the whole tree, flattened."""
        return self._get("/api/todos")

    def search(self, query: str, limit: int = 25) -> dict[str, Any]:
        """GET /api/search — matching items and boards."""
        return self._get("/api/search", q=query, limit=limit)
