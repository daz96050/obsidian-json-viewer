# Security Policy

## Supported versions

Only the latest release is actively supported.

## Reporting a vulnerability

Please report security issues privately by emailing the maintainer or opening a minimal GitHub security advisory if available.

Do not include sensitive vault content in public issues. If a reproduction requires JSON content, reduce it to a minimal synthetic example first.

## Security posture

JSON Viewer is read-only. It reads JSON/JSONL files through Obsidian's vault API and renders a local view. It does not send vault content to external services and does not write JSON back to disk.

The plugin writes to the system clipboard only when the user explicitly clicks a copy button, such as **Copy raw JSON** or **Copy JSON Pointer**. It does not read clipboard contents.
