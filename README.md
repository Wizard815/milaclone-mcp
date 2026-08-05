# milaclone-mcp

A self-hosted [Milanote](https://milanote.com)-style canvas board
([`app/`](app)) bundled with an MCP server ([`mcp/`](mcp)) that gives AI
assistants (Claude Code, Claude Desktop, etc.) full read/write access to
it — list and search boards, read cards, and create/edit/delete notes,
to-dos, links, columns, comments, and nested boards.

The two run together as one deployment: `docker compose up` starts both, the
MCP server is wired to talk to the board automatically, and it stays running
alongside it — no separate setup step.

## Quick start

```bash
cp .env.example .env
# edit .env: set API_KEY (recommended) and, if exposing mcp remotely, MCP_AUTH_TOKEN
docker network create edge   # skip if you already have one — see below
docker compose up -d --build
```

- Board UI: `http://<host>:4321`
- MCP endpoint: `http://<host>:8383/mcp` (streamable-http)

## How the two pieces fit together

| Service | Image built from | Port | Talks to |
|---|---|---|---|
| `app` | [`app/Dockerfile`](app/Dockerfile) | `4321` | itself (SQLite in the `milaclone_data` volume) |
| `mcp` | [`mcp/Dockerfile`](mcp/Dockerfile) | `8383` | `app`, over the internal `edge` network, at `http://milaclone-app:4321` |

They share one Docker network (`edge`) so `mcp` can reach `app` by container
name without any manual URL configuration, and so an existing Cloudflare
Tunnel (`cloudflared`) container can reach either of them the same way for
remote access. Create it once if it doesn't already exist:

```bash
docker network create edge
```

Already run `cloudflared` on its own network? Rename `edge` to that network's
name in `docker-compose.yml` instead of creating a new one — then point your
tunnel's ingress rules at `http://milaclone-app:4321` (board) and/or
`http://milaclone-mcp:8383/mcp` (MCP, only if you want a remote AI assistant
reaching it — see [Auth](#auth) first). LAN clients keep using the plain
`<unraid-ip>:4321` / `:8383` host ports regardless.

No Tailscale involved by default; add a sidecar the same way if you'd rather
use that instead.

## Auth

Two independent layers, both optional, both off by default:

- **`API_KEY`** — protects `app`'s own `/api/*`. Set it once in `.env` and
  both services pick it up: `app` enforces it (its browser UI does too,
  automatically), `mcp` sends it on every request to `app`.
- **`MCP_AUTH_TOKEN`** — protects `mcp`'s own network endpoint. Only matters
  if you expose `mcp` beyond your LAN (e.g. through the tunnel, for a remote
  Claude Desktop). It's a plain shared bearer secret, not OAuth — the mcp
  SDK's built-in `auth`/`token_verifier` options wire up a full RFC
  8414/9068 authorization-server integration meant for enterprise identity
  providers, overkill here. Leave blank to rely on network trust instead
  (fine if `mcp` is only reachable on your LAN or through your tunnel).

## Backups

```bash
docker compose cp app:/data/board.db ./backup-$(date +%F).db
```

Board data (`milaclone_data`) and uploads (`milaclone_uploads`) live in named
volumes untouched by `docker compose down` — only `down -v` removes them.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

Both images rebuild from their respective subfolders; `app`'s SQLite data and
`mcp`'s config survive since they're in named volumes / env vars, not baked
into the image.

## Registering `mcp` with a local Claude Code/Desktop instead

If you'd rather run the MCP server as a local stdio subprocess (no Docker,
no network exposure) against a board running anywhere — see
[`mcp/README.md`](mcp/README.md#standalone-dev-setup).

## Subproject docs

- [`app/README.md`](app/README.md) — the board itself: features, data model,
  local (non-Docker) dev, keyboard shortcuts
- [`mcp/README.md`](mcp/README.md) — the MCP server: tool list, data-model
  notes, standalone dev setup

## License

[MIT](LICENSE)
