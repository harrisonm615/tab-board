#!/usr/bin/env python3
"""How much of the Claude plan is used, for the bars at the top of the side bar.

It asks Claude Code itself, the way its /usage does, through your own login: a small process starts, answers and exits.
No message is sent to a model, so looking uses none of the plan.
The answer is saved to ~/.claude/tab-triage/usage.json, so the bars have a number right after a reload and keep the last one if a check fails."""
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
SAVED = Path(os.environ.get("BAR_TRIAGE") or HOME / ".claude/tab-triage") / "usage.json"   # not in tab-board: the mod takes every file there for a tab
FRESH_S = 240   # the side bar looks every 5 minutes: a reading younger than this is reused rather than starting Claude again
WAIT_S = 30
HOUR_MS = 3_600_000


def claude_path():
    found = os.environ.get("BAR_CLAUDE") or shutil.which("claude")
    if found:
        return found
    # VS Code's Claude extension carries its own copy; the newest install is the one in use.
    copies = glob.glob(str(HOME / ".vscode/extensions/anthropic.claude-code-*/resources/native-binary" / ("claude.exe" if os.name == "nt" else "claude")))
    return max(copies, key=os.path.getmtime) if copies else None


def ask_claude():
    """Claude Code's own answer to "how much is used", or None if it can't say right now."""
    claude = claude_path()
    if not claude:
        return None
    # A bare start: no settings, plugins, tools or saved session, so it can't touch anything or show up as a tab.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_PLUGIN_DIRS"}
    try:
        process = subprocess.Popen(
            [claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
             "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--no-session-persistence"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=str(HOME), text=True, start_new_session=True,
            **({"creationflags": 0x08000000} if os.name == "nt" else {}))   # no console window on Windows
    except OSError:
        return None

    def stop():   # the whole group: anything it started would hold the pipe open and keep this waiting
        try:
            if os.name == "nt":   # no process groups on Windows: taskkill /T takes the whole tree
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, timeout=10, creationflags=0x08000000)
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.SubprocessError):
            pass

    timer = threading.Timer(WAIT_S, stop)
    timer.start()
    answer = None
    try:
        # skip_behaviors: only the plan's limits, not the scan of a week of chats.
        for request in ({"subtype": "initialize"}, {"subtype": "get_usage", "skip_behaviors": True}):
            process.stdin.write(json.dumps({"type": "control_request", "request_id": request["subtype"], "request": request}) + "\n")
        process.stdin.flush()
        for line in process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            reply = message.get("response") or {}
            if message.get("type") == "control_response" and reply.get("request_id") == "get_usage":
                answer = reply.get("response") if reply.get("subtype") == "success" else None
                break
    except OSError:
        pass
    finally:
        timer.cancel()
        try:
            process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            stop()
    return answer


def label_of(row):
    scope = row.get("scope") or {}
    named = (scope.get("model") or {}).get("display_name") or (scope.get("surface") or {}).get("display_name")
    if named:
        return f"{named} this week" if row.get("group") == "weekly" else named
    if row.get("kind") == "session":
        return "Claude 5-hour limit"
    if row.get("kind") == "weekly_all":
        return "Claude this week"
    return str(row.get("kind") or "Claude").replace("_", " ").capitalize()   # a new kind of limit still shows, in the server's word


def when_ms(text):
    try:
        return int(datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def shape(answer):
    """The rows to draw, or None if Claude Code has no reading right now. An empty list means this login has no plan limits to show, as with an API key."""
    if not answer.get("rate_limits_available"):
        return []
    limits = (answer.get("rate_limits") or {}).get("limits")
    if limits is None:   # the check failed on Claude's side: that's not the same as nothing being used
        return None
    rows = []
    for limit in limits:
        window = "5 hours" if limit.get("group") == "session" else "week" if limit.get("group") == "weekly" else None
        rows.append({
            "label": label_of(limit),
            "percent": limit.get("percent") or 0,
            "severity": limit.get("severity") or "normal",
            "resets": when_ms(limit.get("resets_at")),
            "window": window,
            "windowMs": {"5 hours": 5 * HOUR_MS, "week": 7 * 24 * HOUR_MS}.get(window),
            "show": bool(limit.get("percent")) or bool(limit.get("is_active")),
        })
    # A limit you haven't touched is noise, like Fable at 0%. But always keep one, or the bars vanish the moment a week resets.
    kept = [row for row in rows if row.pop("show")]
    return kept or rows[:1]


def read_saved():
    try:
        return json.loads(SAVED.read_text())
    except (OSError, ValueError):
        return None


def save(reading):
    try:
        SAVED.parent.mkdir(parents=True, exist_ok=True)
        temp = SAVED.with_name(f"usage.{os.getpid()}.tmp")
        temp.write_text(json.dumps(reading))
        temp.replace(SAVED)
    except OSError:
        pass


def reading():
    saved = read_saved()
    now = time.time()
    if saved and now - saved.get("at", 0) / 1000 < FRESH_S:
        return saved
    answer = ask_claude()
    limits = shape(answer) if answer else None
    if limits is None:
        return saved or {"limits": []}   # the view says how old a saved reading is
    fresh = {"limits": limits, "at": int(now * 1000)}
    save(fresh)
    return fresh


if __name__ == "__main__":
    json.dump(reading(), sys.stdout)
