# Codex Supervisor

This extension observes Codex app-server endpoints. Its normal OpenClaw plugin
surface is read-only. The standalone MCP server can expose trusted write
controls when it runs in a separate safety-monitor process.

## Safety monitor

The Applied devbox safety monitor uses the standalone MCP server to discover
active OpenClaw Codex threads, read their typed app-server state, and stop one
exact active turn. The stop operation rejects stale turn IDs, interrupts the
turn, cleans that thread's background terminals, waits for both to become
inactive, and persists the result in a local SQLite outbox.

Required supervisor-only environment:

- `OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS`
- `OPENCLAW_CODEX_TARGET_TOKEN`
- `OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS=1`
- `OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS=1`
- `OPENCLAW_CODEX_SUPERVISOR_AUDIT_DB=/path/to/safety-audit.sqlite`

The target OpenClaw-controlled Codex process must not receive this MCP server
or these write-control settings.

## Slack safety alerts

Slack delivery is optional. Configure one fixed channel and exactly one token
source:

- `OPENCLAW_CODEX_SUPERVISOR_SLACK_CHANNEL_ID`
- `OPENCLAW_CODEX_SUPERVISOR_SLACK_BOT_TOKEN_FILE` (preferred), or
- `OPENCLAW_CODEX_SUPERVISOR_SLACK_BOT_TOKEN`

When delivery is disabled, completed and failed stop records remain in the
durable outbox. Enabling delivery drains that backlog. A successful post stores
the Slack channel and message timestamp; a failure records the error and stays
retryable. The decision ID is sent as Slack's client message ID so retries use
a stable deduplication key.

Only trusted control code reads the bot token. Alert text is length-bounded,
redacted again before delivery, and sent as plain text with Slack mention
syntax escaped.
