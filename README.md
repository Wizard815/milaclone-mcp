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
# edit .env: set API_KEY (recommended), NETWORK_NAME/AI_NETWORK_NAME if yours
# differ from the defaults, and MCP_AUTH_TOKEN if exposing mcp remotely
docker compose up -d --build
```

- Board UI: `http://<host>:4321`
- MCP endpoint: `http://<host>:8383/mcp` (streamable-http)

## How the two pieces fit together

| Service | Image built from | Port | Networks |
|---|---|---|---|
| `app` | [`app/Dockerfile`](app/Dockerfile) | `4321` | `edge` |
| `mcp` | [`mcp/Dockerfile`](mcp/Dockerfile) | `8383` | `edge`, `ai` |

Both join **`edge`** (default network name: `proxynat`, override with
`NETWORK_NAME` in `.env`) — the network your Cloudflare Tunnel (`cloudflared`)
container is already on, so it can reach either service by container name
for remote access, and so `mcp` can reach `app` at `http://milaclone-app:4321`
with no manual URL config.

`mcp` *additionally* joins **`ai`** (default network name: `ai_net`, override
with `AI_NETWORK_NAME`) — wherever your AI tooling lives, so it can reach
`mcp` directly without going through the tunnel. `app` deliberately does not
join `ai`; it has no reason to be reachable from there.

Both networks must already exist — compose attaches to them, it doesn't
create them:

```bash
docker network create proxynat   # skip if you already have it
docker network create ai_net     # skip if you already have it
```

If you point your tunnel's ingress rules at either service, that'd be
`http://milaclone-app:4321` (board) and/or `http://milaclone-mcp:8383/mcp`
(MCP — only if you want a remote AI assistant reaching it; see
[Auth](#auth) first). LAN clients keep using the plain `<unraid-ip>:4321` /
`:8383` host ports regardless.

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

## Data location & backups

Board data and uploads are bind-mounted from the host, not Docker-managed
volumes — by default under Unraid's appdata convention:

| Host path (default) | Container path | Holds |
|---|---|---|
| `/mnt/user/appdata/milaclone-mcp/data` | `/data` | `board.db` (SQLite) |
| `/mnt/user/appdata/milaclone-mcp/uploads` | `/app/public/uploads` | uploaded images/files |

Override either with `DATA_PATH` / `UPLOADS_PATH` in `.env` if you want them
elsewhere. Being plain bind mounts, they live entirely outside Docker's
lifecycle — `docker compose down`, `down -v`, and image rebuilds never touch
them; only deleting the files themselves does. That also means they're
covered automatically by Unraid's CA Backup / Restore Appdata plugin, and you
can back the board up directly:

```bash
cp /mnt/user/appdata/milaclone-mcp/data/board.db ./backup-$(date +%F).db
```

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
