FROM python:3.13-slim
WORKDIR /app

COPY pyproject.toml README.md ./
COPY milaclone_mcp/ ./milaclone_mcp/
RUN pip install --no-cache-dir .

ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8383
EXPOSE 8383

CMD ["milaclone-mcp"]
