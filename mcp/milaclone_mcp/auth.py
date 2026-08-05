import os
from pathlib import Path

from dotenv import load_dotenv

from milaclone_mcp.exceptions import AuthError

# Project root (parent of the `milaclone_mcp` package). The .env here is the
# canonical location — works regardless of the cwd the binary is launched
# from (e.g. when Claude Code spawns the MCP server).
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_PROJECT_ENV = _PROJECT_ROOT / ".env"


def load_config(env_file: Path | None = None) -> tuple[str, str]:
    """
    Returns (base_url, api_key).

    Reads MILACLONE_URL (required) and MILACLONE_API_KEY (optional — only
    required if the server was started with API_KEY set).

    Loads .env from (in order): explicit path, cwd, project root. Existing
    process env vars always win over .env values.
    """
    if env_file is not None:
        load_dotenv(env_file)
    else:
        load_dotenv()  # cwd
        if _PROJECT_ENV.is_file():
            load_dotenv(_PROJECT_ENV)

    base_url = os.environ.get("MILACLONE_URL", "").strip().rstrip("/")
    if not base_url:
        raise AuthError("MILACLONE_URL is not set. Add it to .env — see README.")

    api_key = os.environ.get("MILACLONE_API_KEY", "").strip()
    return base_url, api_key
