"""
Drive the milaclone MCP server with a real LLM (via OpenRouter) and check
what it actually did against the board's state.

    MILACLONE_URL=http://localhost:4399 python scripts/agent_eval.py \
        --boards '{"launch": "...", "ops": "..."}' --model tencent/hy4-flash --budget 1.5

The key is read from OPENROUTER_API_KEY (the sandbox proxy injects the real
one, so a dummy works there). Spend is tracked from OpenRouter's own usage
accounting and the run stops when --budget (USD) is reached.
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

API = "https://openrouter.ai/api/v1/chat/completions"


class Budget:
    def __init__(self, cap: float):
        self.cap, self.spent, self.calls = cap, 0.0, 0

    def add(self, usage: dict) -> None:
        self.spent += float(usage.get("cost") or 0)
        self.calls += 1
        if self.spent >= self.cap:
            raise SystemExit(f"budget ${self.cap:.2f} reached (spent ${self.spent:.4f})")


async def run_task(session, tools, http, model, budget, prompt, max_steps=14):
    msgs = [
        {"role": "system", "content": "You manage a Milanote-style board through the provided tools. Use ids you "
         "discover with the tools; never invent ids. Be efficient. When finished, reply with a one-paragraph summary."},
        {"role": "user", "content": prompt},
    ]
    calls: list[dict] = []
    for _ in range(max_steps):
        r = await http.post(API, json={"model": model, "messages": msgs, "tools": tools, "temperature": 0,
                                        "usage": {"include": True}})
        r.raise_for_status()
        j = r.json()
        budget.add(j.get("usage", {}))
        m = j["choices"][0]["message"]
        msgs.append({k: v for k, v in m.items() if k in ("role", "content", "tool_calls") and v is not None})
        if not m.get("tool_calls"):
            return m.get("content") or "", calls
        for tc in m["tool_calls"]:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
                res = await session.call_tool(name, args)
                text = "".join(getattr(c, "text", "") for c in res.content)
                err = bool(res.is_error)
            except Exception as e:  # noqa: BLE001 - surface any failure to the model
                args, text, err = tc["function"]["arguments"], f"error: {e}", True
            calls.append({"tool": name, "args": args, "error": err, "result": text[:300] if err else None})
            msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": text[:12000]})
    return "(step limit reached)", calls


def api_get(base, path):
    return httpx.get(base + path, timeout=20).json()


def find(items, pred):
    return next((i for i in items if pred(i)), None)


class World:
    """Read-only view of the board's current state, for checking what the agent did."""

    def __init__(self, base):
        self.base = base

    def get(self, path):
        return httpx.get(self.base + path, timeout=20).json()

    def canvases(self):
        """Every live board, found by walking down from Home (there's no list-all endpoint)."""
        root = self.get("/api/root")["rootCanvasId"]
        out, queue = [], [root]
        while queue:
            cid = queue.pop()
            data = self.get(f"/api/canvas/{cid}")
            out.append({"id": cid, "title": data["canvas"]["title"]})
            queue += [i["data"]["childCanvasId"] for i in data["items"] if i["type"] == "board" and i["data"].get("childCanvasId")]
        return out

    def canvas_id(self, title):
        return next((c["id"] for c in self.canvases() if c["title"] == title), None)

    def items(self, title=None):
        out = []
        for c in self.canvases():
            if title and c["title"] != title:
                continue
            for it in self.get(f"/api/canvas/{c['id']}")["items"]:
                it["_canvas"] = c["title"]
                out.append(it)
        return out

    def card(self, label, canvas=None, type=None):
        def lab(i):
            d = i.get("data") or {}
            # notes keep "title\nbody" in data.text: a note's label is its first line
            return d.get("title") or (d.get("text") or "").split("\n")[0] or d.get("body") or i.get("_childTitle")
        return next((i for i in self.items(canvas) if lab(i) == label and (not type or i["type"] == type)), None)


def suite(W):
    """name -> (prompt, check(final_text, calls) -> (ok, detail)). Prompts name boards by title, never by id."""
    def tasks_of(label):
        c = W.card(label, type="todo")
        return [(t["text"], t["done"]) for t in (c["data"]["tasks"] if c else [])]

    def has(text, *words):
        return all(w.lower() in text.lower() for w in words)

    def used(calls, *names):
        return all(any(c["tool"] == n for c in calls) for n in names)

    expected_open = None  # computed lazily from todo state at check time

    def open_tasks():
        return sum(1 for i in W.items() if i["type"] == "todo" for t in i["data"].get("tasks", []) if t["text"] and not t["done"])

    n_open_before = open_tasks()

    def build_check(out, calls):
        b = W.card("Hiring Plan", type="board")
        if not b:
            return False, "no Hiring Plan board"
        its = W.items("Hiring Plan")
        notes = lambda t: [i for i in its if i.get("_panelTitle") == t and i["type"] == "note"]
        todo_in = [i for i in its if i["type"] == "todo" and i.get("_panelTitle") == "Interview loop"]
        lines = [i for i in its if i["type"] == "line"]
        ok = len(notes("Roles")) >= 2 and len(notes("Interview loop")) >= 2 and todo_in and lines
        return bool(ok), f"roles notes={len(notes('Roles'))}, loop notes={len(notes('Interview loop'))}, loop todos={len(todo_in)}, lines={len(lines)}"

    T = {}
    T["search_facts"] = ("Who is our contact at the Huila supplier, and what's their lead time?",
                         lambda o, c: (has(o, "Marisol") and has(o, "5 week"), "named Marisol / 5 weeks"))
    T["count_open"] = ("How many unfinished tasks are there across every to-do list in the whole workspace? Give just the number.",
                       lambda o, c: (str(n_open_before) in o, f"expected {n_open_before}"))
    T["todo_add"] = ("Add the task 'Book photographer' to the Marketing checklist.",
                     lambda o, c: (("Book photographer", False) in tasks_of("Marketing checklist"), "task added"))
    T["todo_done"] = ("In the Product tasks list on Spring Launch, tick off 'Cup three batches blind'.",
                      lambda o, c: (("Cup three batches blind", True) in tasks_of("Product tasks"), "ticked"))
    T["todo_remove"] = ("Remove 'Lock bag size at 12oz' from the Product tasks list.",
                        lambda o, c: (not any(t == "Lock bag size at 12oz" for t, _ in tasks_of("Product tasks")), "removed"))
    T["edit_note"] = ("In the Customer interviews note, change the count of cafe owners interviewed from 12 to 15. Keep the rest of the text.",
                      lambda o, c: (lambda n: ("15 cafe" in n["data"].get("text", "") and "espresso" in n["data"].get("text", ""), n["data"].get("text", "")[:70]))(W.card("Customer interviews")))
    T["restyle"] = ("Make the Competitor scan note red and 320 wide.",
                    lambda o, c: (lambda n: (n["color"] == "red" and n["w"] == 320, f"color={n['color']} w={n['w']}"))(W.card("Competitor scan")))
    T["make_table"] = ("On the Roastery Ops board add a table of the weekly roast plan with a header row 'Day','Roast' and rows Mon/House blend, Tue/Single origins, Wed/Wholesale.",
                       lambda o, c: (lambda t: (bool(t) and t["data"]["rows"][0] == ["Day", "Roast"] and len(t["data"]["rows"]) == 4, f"rows={t and t['data']['rows']}"))(
                           next((i for i in W.items("Roastery Ops") if i["type"] == "table"), None)))
    T["heading_link"] = ("On Brand & Packaging add a heading that says 'Launch palette' and a link card titled 'Pantone chips' pointing to https://example.com/pantone.",
                         lambda o, c: (bool(W.card("Launch palette", "Brand & Packaging")) and (W.card("Pantone chips", "Brand & Packaging", "link") or {"data": {}})["data"].get("url") == "https://example.com/pantone", "heading + link"))
    T["connector"] = ("On Spring Launch, draw a 'relates' arrow from the Customer interviews note to the Open question note, labelled 'raises'.",
                      lambda o, c: (lambda a, b, ln: (bool(ln), f"line={ln and ln['data']}"))(
                          W.card("Customer interviews"), W.card("Open question"),
                          next((i for i in W.items("Spring Launch") if i["type"] == "line" and i["data"].get("label") == "raises"), None)))
    T["column"] = ("On Roastery Ops create a column called Backlog containing two notes: 'Repair grinder' and 'Order filters'.",
                   lambda o, c: (lambda col, n1, n2: (bool(col and n1 and n2) and n1["parentItemId"] == col["id"] == n2["parentItemId"], "both notes in Backlog"))(
                       W.card("Backlog", "Roastery Ops", "column"), W.card("Repair grinder"), W.card("Order filters")))
    T["stage"] = ("Mark the Subscription swap note as being at the 'code' stage, then tell me how many cards are currently at the code stage in the idea pipeline.",
                  lambda o, c: (lambda n: (n["stage"] == "code" and "1" in o, f"stage={n['stage']}"))(W.card("Subscription swap")))
    T["nested_board"] = ("Inside Roastery Ops create a sub-board named Wholesale that contains a to-do list called Accounts with the tasks 'Send price sheet', 'Call Bean Barn' and 'Set up invoicing'.",
                         lambda o, c: (lambda t: (bool(t) and len(t["data"]["tasks"]) == 3, f"tasks={t and [x['text'] for x in t['data']['tasks']]}"))(W.card("Accounts", "Wholesale", "todo")))
    T["move_card"] = ("Move the Open question note from Spring Launch over to the Roastery Ops board.",
                      lambda o, c: (lambda n: (n["_canvas"] == "Roastery Ops", f"now on {n['_canvas']}"))(W.card("Open question")))
    T["duplicate"] = ("Put a copy of the Marketing checklist to-do on the Roastery Ops board (keep the original where it is).",
                      lambda o, c: (lambda a, b: (bool(a) and bool(b) and len([i for i in W.items() if (i["data"] or {}).get("title") == "Marketing checklist"]) == 2, "two copies"))(
                          W.card("Marketing checklist", "Spring Launch"), W.card("Marketing checklist", "Roastery Ops")))
    T["delete_restore"] = ("Delete the Brand & Packaging board, then change your mind and bring it back exactly as it was.",
                           lambda o, c: (lambda b, kids: (bool(b) and len(kids) >= 4, f"board back, {len(kids)} cards"))(
                               W.card("Brand & Packaging", type="board"), W.items("Brand & Packaging")))
    T["template_save_use"] = ("Save the Spring Launch board as a reusable template named 'Product launch', then start a new board from that template on Home called 'Autumn Launch'.",
                              lambda o, c: (lambda tp, nb: (any(t["name"] == "Product launch" for t in W.get("/api/templates")["templates"]) and bool(nb) and len([i for i in W.items("Autumn Launch") if i["type"] == "panel"]) >= 4,
                                                            f"autumn panels={len([i for i in W.items('Autumn Launch') if i['type'] == 'panel'])}"))(None, W.card("Autumn Launch", type="board")))
    T["template_list"] = ("What templates do we have, and what panels does each one include?",
                          lambda o, c: (has(o, "Product launch") and has(o, "Research"), "mentions template + panels"))
    T["export_import"] = ("Export the Roastery Ops board and import it back onto Home as a board called 'Ops backup'.",
                          lambda o, c: (bool(W.card("Ops backup", type="board")) and used(c, "export_board", "import_board"), "imported"))
    T["copy_board"] = ("Make a copy of the Roastery Ops board on Home and call the copy 'Ops sandbox'.",
                       lambda o, c: (bool(W.card("Ops sandbox", type="board")) and len(W.items("Ops sandbox")) >= 5 and used(c, "copy_board"), f"{len(W.items('Ops sandbox'))} cards"))
    T["trash_roundtrip"] = ("On the Spring Launch board, delete the Competitor scan note, look in the trash to confirm it is there, then put it back.",
                            lambda o, c: (bool(W.card("Competitor scan", "Spring Launch")) and used(c, "delete_item", "list_trash", "restore_item"), "deleted, seen in trash, restored"))
    T["move_board"] = ("Move the Supplier contacts board so it lives inside Brand & Packaging instead of Roastery Ops.",
                       lambda o, c: (bool(W.card("Supplier contacts", "Brand & Packaging", "board")) and not W.card("Supplier contacts", "Roastery Ops", "board"), "moved out of Roastery Ops into Brand & Packaging"))
    T["add_task"] = ("Add a starred task 'Renew roaster permit' due 2027-01-15 to my task inbox.",
                     lambda o, c: (lambda t: (bool(t) and t[0].get("starred") and t[0].get("due") == "2027-01-15", f"task={t and t[0]}"))(
                         [x for i in W.items() if i["type"] == "todo" for x in i["data"].get("tasks", []) if x["text"] == "Renew roaster permit"]))
    T["markdown"] = ("Export the Brand & Packaging board as Markdown and tell me the first heading line you see.",
                     lambda o, c: (used(c, "export_board_markdown") and len(o) > 5, "used markdown export"))
    T["rename_home"] = ("Rename the top-level Home board to 'Lantern HQ'.",
                        lambda o, c: (bool(W.canvas_id("Lantern HQ")), "renamed"))
    T["panel_rename"] = ("Rename the Product panel on Spring Launch to 'Product & Sourcing'.",
                         lambda o, c: (bool(W.card("Product & Sourcing", "Spring Launch", "panel")) and not W.card("Product", "Spring Launch", "panel"), "renamed"))
    T["panel_nest"] = ("Inside the Research panel on Spring Launch, make a smaller panel called 'Hot topics' holding just the Competitor scan note.",
                       lambda o, c: (lambda p, n, r: (bool(p) and n.get("_panelId") == p["id"] and p.get("_panelId") == r["id"], f"scan in {n.get('_panelTitle')}"))(
                           W.card("Hot topics", "Spring Launch", "panel"), W.card("Competitor scan", "Spring Launch"), W.card("Research", "Spring Launch", "panel")))
    T["panel_move"] = ("Slide the Research panel on Spring Launch 200 to the right, but leave every card where it is (don't carry them).",
                       lambda o, c: (lambda p, n: (p["x"] == state_rx[0] + 200 and n["x"] == 70 and "move_members" in json.dumps(c), f"panel x={p['x']} note x={n['x']}"))(
                           W.card("Research", "Spring Launch", "panel"), W.card("Customer interviews", "Spring Launch")))
    T["bad_id"] = ("Delete the card with id i_doesnotexist and tell me whether it worked.",
                   lambda o, c: (bool(re.search(r"not found|doesn.t exist|does not exist|couldn.t|could not|unable|no such|failed|error", o, re.I)), "reported failure honestly"))
    T["promote_fail"] = ("Promote the Product tasks card to a Pondering Orb project.",
                         lambda o, c: (bool(re.search(r"code|orb|not|couldn|unable|fail|error", o, re.I)), "explained why it can't"))
    T["build_page"] = ("Build a new board called 'Hiring Plan' on Home with two panels: 'Roles' (at least 2 notes describing open roles) and 'Interview loop' "
                       "(at least 2 notes on the interview stages plus a to-do list of prep tasks), and draw a line connecting two of the notes.",
                       build_check)
    state_rx = [0]
    return T, state_rx


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--boards", default="{}", help="unused; boards are found by title")
    ap.add_argument("--model", default="tencent/hy4-flash")
    ap.add_argument("--budget", type=float, default=1.5)
    ap.add_argument("--report", help="write a JSON report here")
    ap.add_argument("--only", help="comma-separated task names")
    a = ap.parse_args()
    base = os.environ["MILACLONE_URL"].rstrip("/")
    budget = Budget(a.budget)

    def board(c):
        return api_get(base, f"/api/canvas/{c}")["items"]

    def by_title(items, title):
        return find(items, lambda i: (i.get("data") or {}).get("title") == title)

    def pan(c, title):
        return by_title(board(c), title)

    W = World(base)
    tasks, state_rx = suite(W)
    p = find(W.items(), lambda i: i["type"] == "panel" and i["data"].get("title") == "Research")
    state_rx[0] = p["x"] if p else 0

    here = os.path.dirname(os.path.abspath(__file__))
    py = os.path.join(here, "..", ".venv", "bin", "python")
    params = StdioServerParameters(command=py, args=["-m", "milaclone_mcp.server"], env={**os.environ, "MILACLONE_URL": base})
    headers = {"Authorization": f"Bearer {os.environ.get('OPENROUTER_API_KEY', 'proxy')}"}
    results = []
    report: list[dict] = []
    async with stdio_client(params) as (r, w), ClientSession(r, w) as session, httpx.AsyncClient(headers=headers, timeout=120) as http:
        await session.initialize()
        listed = (await session.list_tools()).tools
        tools = [{"type": "function", "function": {"name": t.name, "description": t.description or "", "parameters": t.input_schema}} for t in listed]
        print(f"{len(tools)} tools exposed: {', '.join(t.name for t in listed)}\n")
        for name, (prompt, check) in tasks.items():
            if a.only and name not in a.only.split(","):
                continue
            t0 = time.time()
            try:
                out, calls = await run_task(session, tools, http, a.model, budget, prompt)
            except httpx.HTTPError as e:
                out, calls = f"(http error: {e})", []
            try:
                ok, detail = check(out, calls)
            except Exception as e:  # noqa: BLE001
                ok, detail = False, f"check crashed: {e!r}"
            ok = bool(ok)
            errs = [c for c in calls if c["error"]]
            results.append((name, ok))
            report.append({"task": name, "ok": ok, "detail": str(detail), "calls": [c["tool"] for c in calls],
                           "errors": [{"tool": c["tool"], "args": c["args"], "result": c["result"]} for c in errs], "final": out})
            print(f"[{'PASS' if ok else 'FAIL'}] {name}  {len(calls)} tool calls, {len(errs)} errors, {time.time()-t0:.0f}s, spent ${budget.spent:.4f}")
            print(f"   check: {detail}")
            print(f"   calls: {[c['tool'] for c in calls]}")
            for c in errs:
                print(f"   ERR {c['tool']} {json.dumps(c['args'])[:160]} -> {c['result']}")
            print(f"   final: {out[:220]!r}\n")
    if a.report:
        json.dump({"model": a.model, "spent": budget.spent, "results": report}, open(a.report, "w"), indent=1)
    print(f"total ${budget.spent:.4f} over {budget.calls} model calls; {sum(ok for _, ok in results)}/{len(results)} passed")
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
