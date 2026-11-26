#!/usr/bin/env python3
"""Refresh this assignment's published Codex conversation before a push."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

GIST = "90a43fc37023e22aeb29ce1cff92f26a"
SESSION = "01a21935-09c9-74f2-9a81-ecb568a62984"


def transcript():
    sessions = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"
    log, = sessions.rglob(f"rollout-*-{SESSION}.jsonl")
    sections = ["# Codex session transcript"]
    for line in log.read_bytes().splitlines(keepends=True):
        if not line.endswith(b"\n"):
            break  # Codex may still be appending the last record.
        record = json.loads(line)
        item = record.get("payload", {})
        if record["type"] != "response_item" or item.get("type") != "message":
            continue
        role = item.get("role")
        if role not in ("user", "assistant") or item.get("channel") == "analysis":
            continue
        message = "\n".join(part.get("text", "") for part in item["content"]).strip()
        if not message or message.startswith(("# AGENTS.md instructions", "<environment_context>")):
            continue
        message = re.sub(r"<image\b[^>]*>|</image>", "", message)
        message = message.replace(str(Path.cwd()) + "/", "").replace(str(Path.home()) + "/", "~/")
        sections.extend(["## User" if role == "user" else "## Codex", message])
    if len(sections) == 1:
        raise ValueError("No conversation messages found")
    return "\n\n".join(sections) + "\n"


if __name__ == "__main__" and sys.stdin.readline():
    subprocess.run(
        ["gh", "api", "--method", "PATCH", f"gists/{GIST}", "--input", "-", "--silent"],
        input=json.dumps({"files": {"codex-session.md": {"content": transcript()}}}),
        text=True, check=True,
    )
