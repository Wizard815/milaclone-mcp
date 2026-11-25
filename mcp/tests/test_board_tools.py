"""The whiteboard-style board tools: what each sends to the app's agent routes,
who it says made the change, and how errors come back. The app side is tested
in app/test/agent.test.js; this checks the MCP half against a fake app."""

import json

import httpx
import pytest

from milaclone_mcp import server
from milaclone_mcp.client import MilacloneClient
from milaclone_mcp.exceptions import MilacloneError, NotFoundError


@pytest.fixture
def app(monkeypatch):
    seen = []
    answers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append({"method": request.method, "path": request.url.path, "params": dict(request.url.params),
                     "body": body, "agent": request.headers.get("x-milaclone-agent"),
                     "key": request.headers.get("x-api-key")})
        status, doc = answers.get((request.method, request.url.path), (200, {"ok": True}))
        if isinstance(doc, str):
            return httpx.Response(status, text=doc)
        return httpx.Response(status, json=doc)

    monkeypatch.setenv("MILACLONE_AGENT", "")
    client = MilacloneClient("http://mila", "k", agent="MCP agent")
    client._http = httpx.Client(base_url="http://mila", headers=client._http.headers,
                                transport=httpx.MockTransport(handler))
    monkeypatch.setattr(server, "_client", client)
    return seen, answers


def test_lay_out_board_sends_the_plan_as_the_named_agent(app):
    seen, _ = app
    sections = [{"title": "Clear out", "cards": ["Sort boxes", {"text": "Skip", "ref": "s"}]}]
    server.lay_out_board("Garage", sections, layout="route", parent="Home", center="Garage", orb_project="House",
                         agent="Hermes")
    call = seen[-1]
    assert (call["method"], call["path"], call["agent"], call["key"]) == ("POST", "/api/agent/boards", "Hermes", "k")
    assert call["body"] == {"title": "Garage", "sections": sections, "layout": "route", "parent": "Home",
                            "center": "Garage", "orb": {"project": "House"}}


def test_tools_without_a_name_use_the_default_agent(app, monkeypatch):
    seen, _ = app
    server.add_cards("Garage", [{"text": "Pegboard", "section": "Build"}])
    assert seen[-1]["agent"] == "MCP agent"
    assert seen[-1]["body"] == {"board": "Garage", "cards": [{"text": "Pegboard", "section": "Build"}]}
    monkeypatch.setenv("MILACLONE_AGENT", "Ekko")
    server.connect_cards("Garage", [{"from": "a", "to": "b"}])
    assert seen[-1]["agent"] == "Ekko"
    assert seen[-1]["path"] == "/api/agent/board/connect"


def test_every_write_tool_reaches_its_route(app):
    seen, _ = app
    server.add_cards("b", [{"text": "x", "ref": "x"}], connect=[{"from": "x", "to": "y"}], agent="A")
    server.group_cards("b", "Later", ["x", "y"], kind="section", agent="A")
    server.move_cards("b", [{"card": "x", "to": "Later"}], agent="A")
    server.mark_cards("b", [{"card": "x", "state": "doing", "detail": "drafting"}], agent="A")
    server.link_board_to_project("b", "Argos", project_id="p1", agent="A")
    server.link_board_to_project("b", "", agent="A")
    server.board_to_orb("b", ["x"], make="projects", list_name="Argos", agent="A")
    server.board_from_orb("Argos", parent="Projects", agent="A")
    server.sync_board_with_orb("b", agent="A")
    paths = [(c["path"], c["body"]) for c in seen]
    assert paths == [
        ("/api/agent/board/cards", {"board": "b", "cards": [{"text": "x", "ref": "x"}], "connect": [{"from": "x", "to": "y"}]}),
        ("/api/agent/board/group", {"board": "b", "title": "Later", "cards": ["x", "y"], "as": "section"}),
        ("/api/agent/board/move", {"board": "b", "moves": [{"card": "x", "to": "Later"}]}),
        ("/api/agent/board/status", {"board": "b", "marks": [{"card": "x", "state": "doing", "detail": "drafting"}]}),
        ("/api/agent/board/link", {"board": "b", "project": "Argos", "projectId": "p1"}),
        ("/api/agent/board/link", {"board": "b", "project": None}),
        ("/api/agent/board/to-orb", {"board": "b", "cards": ["x"], "as": "projects", "list": "Argos"}),
        ("/api/agent/boards/from-orb", {"project": "Argos", "parent": "Projects"}),
        ("/api/agent/board/sync-orb", {"board": "b"}),
    ]
    assert {c["agent"] for c in seen} == {"A"}


def test_reads(app):
    seen, answers = app
    answers[("GET", "/api/agent/board")] = (200, 'Board "Garage" [c_1]\n- [i_1] Pegboard')
    assert server.read_board("Garage").startswith('Board "Garage"')
    assert seen[-1]["params"] == {"board": "Garage", "format": "text"}
    answers[("GET", "/api/agent/board")] = (200, {"board": "c_1", "sections": []})
    assert server.read_board("c_1", as_text=False)["board"] == "c_1"
    assert seen[-1]["params"] == {"board": "c_1"}
    server.find_boards("gar")
    assert seen[-1]["params"] == {"q": "gar"}
    server.find_boards()
    assert seen[-1]["params"] == {}
    server.board_activity(board="c_1", since=4, limit=999)
    assert seen[-1]["path"] == "/api/activity"
    assert seen[-1]["params"] == {"since": "4", "limit": "200", "canvasId": "c_1"}


def test_bad_arguments_are_refused_before_any_call(app):
    seen, _ = app
    with pytest.raises(ValueError, match="layout must be one of"):
        server.lay_out_board("x", [], layout="spiral")
    with pytest.raises(ValueError, match="kind must be one of"):
        server.group_cards("b", "t", ["x"], kind="pile")
    with pytest.raises(ValueError, match="state must be one of"):
        server.mark_cards("b", [{"card": "x", "state": "meh"}])
    with pytest.raises(ValueError, match="make must be one of"):
        server.board_to_orb("b", ["x"], make="goals")
    assert seen == []


def test_the_apps_explanation_comes_back(app):
    _, answers = app
    answers[("GET", "/api/agent/board")] = (404, {"error": 'No board matches "Gar".', "boards": [{"id": "c_1", "title": "Home"}]})
    with pytest.raises(NotFoundError, match=r'No board matches "Gar"\. .*c_1'):
        server.read_board("Gar", as_text=False)
    answers[("GET", "/api/agent/board")] = (404, {"error": "No board"})
    with pytest.raises(NotFoundError, match="No board"):
        server.read_board("Gar")
    answers[("POST", "/api/agent/board/to-orb")] = (409, {"error": "ORB_URL is not set on the Milaclone server"})
    with pytest.raises(MilacloneError, match="409: ORB_URL is not set"):
        server.board_to_orb("b", ["x"])
    answers[("POST", "/api/item")] = (404, {"error": "not found"})
    with pytest.raises(NotFoundError, match="Not found: http://mila/api/item"):
        server._get_client().create_item({})
