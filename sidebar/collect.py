#!/usr/bin/env python3
"""The numbers behind the Tabs & Progress side bar. Generic: nothing here knows what kind of work anyone does.
  collect.py                     the long jobs: job cards plus the optional personal script
  collect.py tabs                every open Claude tab
  collect.py tabs sorted         the same, sorted by who's really up and how soon (see triage.py), sending any reminders that are due
  collect.py star <id> on|off    puts a tab first in the On you list, or takes it back out
  collect.py search <words>      the tabs where the words were said
  collect.py seen <id> <since>   Keep on a tab, or an ask that's settled: writes the same seen.json the tab board's button uses
  collect.py later <id> [title]  puts a tab on the For later shelf
  collect.py unlater <id>        takes it off
  collect.py wake <id> <ms|off>  sets when a shelved tab comes back
  collect.py closed <id> [title] counts a tab as closed straight away (the Close button)
  collect.py unclosed <id>       a closed tab is being brought back
  collect.py <anything else>     passed to the personal script

Job cards: any script or Claude tab keeps one small file per long job at ~/.claude/progress/<name>.json:
  {"name": "Deploy site", "text": "Step 3 of 5", "frac": 0.6, "state": "running", "group": "Builds"}
name and state (running, done, bad, wait) are what matter; the rest is optional.
Personal script: ~/.claude/progress/jobs.py, if there is one, prints {"groups": [{"name", "rows": [{"name", "text", "frac", "state"}]}]}
for checks that belong to this Mac alone. It can also send "mac", "priority" and "apps". Never share it."""
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

HOME = Path.home()
TABS = Path(os.environ.get("BAR_TABS") or HOME / ".claude/tab-board")   # each tab's record, written by the tab-board mod
WORKSPACES = HOME / "Library/Application Support/Code/User/workspaceStorage"
PROGRESS = HOME / ".claude/progress"
JOBS_SCRIPT = PROGRESS / "jobs.py"
LATER = Path(os.environ.get("BAR_LATER") or HOME / ".claude/for-later.json")   # the shelf. Not in TABS: the mod takes every file there for a tab and sweeps old ones
CLOSED = Path(os.environ.get("BAR_CLOSED") or HOME / ".claude/closed-tabs.json")   # Recently closed. Not in TABS either
RENEW_DAYS = 14        # Claude Code deletes a chat nothing has written to for 30 days, so a shelved one is renewed well before that
CARD_DAYS = 7          # a card untouched this long is forgotten
STALE_MINUTES = 30     # a running card untouched this long probably stopped without saying so


# ---------- Which chat a job card belongs to: the one that last wrote it, going by the chats' own tool calls ----------
CARD_PATH = re.compile(r"\.claude/progress/([\w.-]+)\.json")
CHAT_SCAN_SECONDS = 8                  # the first look reads over a GB of chats. Whatever's left waits for the next look
CHAT_KEEP_DAYS = 30                    # Claude Code deletes a chat after about this long, so the link would go nowhere


def shell_writes_card(before, after):
    """Is this mention of a card's path in a shell command a write? Reading a card (cat, grep, json.load) doesn't make a chat its owner.
    before and after are the text either side of the path, on its line."""
    start = re.split(r"[;|&]", before)[-1]
    end = re.split(r"[;|&]", after)[0]
    if re.search(r">\s*[\"']?[^\s\"'>;|&]*$", before):                       # > ~/.claude/progress/x.json
        return True
    if re.search(r"\b(tee|mv|cp|replace|dump)\b|\bsed\s+-i", start) or re.search(r"write_text|[\"']w[\"']", end):
        return True
    # card=~/.claude/progress/x.json, written to further on
    return "read" not in end and bool(re.search(r"(^|[\s;(])\w+\s*=\s*(?:(?!load|open\(|read|cat |\$\(|`)[^;\n])*$", before))


def cards_written(block):
    """The card names one tool call writes."""
    tool, given = block.get("name"), block.get("input") or {}
    if tool == "Bash":
        command = str(given.get("command") or "")
        names = set()
        for m in CARD_PATH.finditer(command):
            line_start = command.rfind("\n", 0, m.start()) + 1
            line_end = command.find("\n", m.end())
            if shell_writes_card(command[line_start:m.start()], command[m.end():line_end if line_end >= 0 else None]):
                names.add(m[1])
        return names
    if tool in ("Write", "Edit"):
        file = str(given.get("file_path") or "")
        m = CARD_PATH.search(file)
        if m:
            return {m[1]}
        if not file.endswith(".md"):       # a script it wrote to keep the card up to date. A note that only mentions one doesn't count
            return {m[1] for m in CARD_PATH.finditer(str(given.get("content") or given.get("new_string") or ""))}
    return set()


def card_writes(path, offset):
    """Reads only what's been added since last time. Returns [[when, card name]], and where to start next time."""
    found = []
    with open(path, "rb") as handle:
        handle.seek(offset)
        for line in handle:
            if not line.endswith(b"\n"):       # still being written: it waits for next time
                break
            offset += len(line)
            if b".claude/progress/" not in line or b'"tool_use"' not in line:
                continue
            try:
                d = json.loads(line)
                if d.get("type") != "assistant":
                    continue
                when = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp() * 1000
            except (ValueError, KeyError, AttributeError):
                continue
            for block in (d.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    found += [[when, name] for name in cards_written(block)]
    return found, offset


def card_chats():
    """{card file name: chat id}, kept in a file so each look only reads what's new in each chat."""
    store_path = SORT_FOLDER / "card-chats.json"
    store = read_json(store_path)
    store = store if isinstance(store, dict) else {}
    offsets = store.get("offsets") if isinstance(store.get("offsets"), dict) else {}
    owners = store.get("owners") if isinstance(store.get("owners"), dict) else {}
    projects = HOME / ".claude/projects"
    now = time.time()
    dated = []
    for path in glob.glob(str(projects / "*/*.jsonl")) + glob.glob(str(projects / "*/*/subagents/*.jsonl")):
        try:
            dated.append((os.path.getmtime(path), os.path.getsize(path), path))
        except OSError:
            pass
    stop = time.monotonic() + CHAT_SCAN_SECONDS
    fresh = {}
    for modified, size, path in sorted(dated, reverse=True):
        if now - modified > CARD_DAYS * 86400:     # a card untouched this long is forgotten anyway
            break
        offset = offsets.get(path, 0)
        offset = 0 if offset > size else offset
        fresh[path] = offset
        if offset == size or time.monotonic() > stop:
            continue
        try:
            found, fresh[path] = card_writes(path, offset)
        except OSError:
            continue
        p = Path(path)
        chat = p.parent.parent.name if p.parent.name == "subagents" else p.stem   # a subagent's work counts as its chat's
        for when, name in found:
            if when >= (owners.get(name) or [0])[0]:
                owners[name] = [when, chat]
    owners = {name: o for name, o in owners.items() if now * 1000 - o[0] < CHAT_KEEP_DAYS * 86_400_000}
    if fresh != offsets or owners != store.get("owners"):
        SORT_FOLDER.mkdir(exist_ok=True)
        tmp = store_path.with_name(f"card-chats.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"offsets": fresh, "owners": owners}))
        os.replace(tmp, store_path)
    return {name: o[1] for name, o in owners.items()}


# ---------- Job cards ----------
def cards():
    groups = {}
    now = time.time()
    chats = safely(card_chats, {})
    for path in glob.glob(str(PROGRESS / "*.json")):
        d = read_json(path)
        try:
            quiet = now - os.path.getmtime(path)
        except OSError:
            continue
        if not isinstance(d, dict) or not d.get("name") or quiet > CARD_DAYS * 86400:
            continue
        state = d.get("state") if d.get("state") in ("running", "done", "bad", "wait") else "running"
        text = str(d.get("text") or "")
        frac = d.get("frac") if isinstance(d.get("frac"), (int, float)) else None
        if state == "done":
            frac = 1.0
        elif state == "running" and quiet > STALE_MINUTES * 60:
            state, text = "warn", " · ".join(filter(None, [f"No update for {age(quiet * 1000)}", text]))
        row = {"name": str(d["name"]), "text": text, "frac": frac, "state": state, "chat": chats.get(Path(path).stem)}
        mins = d.get("mins_left")
        if state == "running" and isinstance(mins, (int, float)) and not isinstance(mins, bool):
            row["said"] = max(60, mins * 60 - quiet)   # what the chat said, less the time since it said it
        groups.setdefault(str(d.get("group") or "Jobs"), []).append(row)
    return [{"name": name, "rows": rows} for name, rows in groups.items()]


def job_times(groups, priority):
    """How long each running job has left and the total, on the rows themselves. See eta.py."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))   # -I leaves this folder off the path
    import eta
    return eta.estimate(groups, priority, SORT_FOLDER / "eta.json", time.time())


def personal(args):
    """This Mac's own checks. One that fails mustn't take the whole list down."""
    if not JOBS_SCRIPT.exists():
        return {}
    try:
        out = subprocess.run([sys.executable, "-I", str(JOBS_SCRIPT), *args], capture_output=True, text=True, timeout=60).stdout
        return json.loads(out) if out.strip() else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def mac():
    load = round(os.getloadavg()[0])
    if load > 100:
        return {"warn": True, "load": load, "detail": f"System load is {load}, which is very high."}
    return {"warn": False, "load": load, "detail": f"System load {load}"}


# ---------- Claude tabs: the same reading of the same records as the tab-board mod's refresh() and shownState() ----------
GONE_MS = 2 * 60_000          # no heartbeat this long: the tab isn't running
QUIET_MS = 12 * 3_600_000     # waiting on you untouched this long: it has likely run its course
EMPTY_MS = 10 * 60_000        # a tab never used this long can go
NO_MESSAGES = "No messages yet"
TAB_ORDER = {"needs": 0, "step": 1, "finished": 2, "working": 3, "waiting": 4, "idle": 5, "later": 6, "closed": 7}
BUSY = ("working", "needs", "waiting")
STOPPED = ("Stopped when the tab closed", "Stopped when the tab restarted")   # a chat that was busy when its window reloaded. Its record says when it stopped, not when it last said anything
REPLY_SCAN_BYTES = 1_500_000  # a chat's last words are near the end of its transcript, and these files run to hundreds of MB


def open_tabs():
    """The Claude tabs VS Code has open in any window used in the last two days: {id: title}, or None if it can't tell."""
    found = {}
    for db in glob.glob(str(WORKSPACES / "*/state.vscdb")):
        try:
            if time.time() - os.path.getmtime(db) > 2 * 86400:
                continue
            con = sqlite3.connect(f"file:{quote(db)}?mode=ro", uri=True, timeout=1)
            try:
                hit = con.execute("select value from ItemTable where key='Anthropic.claude-code'").fetchone()
            finally:
                con.close()
            for tab in (json.loads(hit[0]).get("panelTabSessions") or []) if hit else []:
                if isinstance(tab.get("sessionId"), str):
                    found[tab["sessionId"]] = tab.get("title") if isinstance(tab.get("title"), str) else ""
        except (OSError, ValueError, sqlite3.Error):
            continue
    return found or None


def label_fits(label, title):
    """A tab's label is its chat's title cut short. The chat writes that title itself, under its own id, so a label that doesn't fit could belong to another chat."""
    return bool(label) and title.startswith(label.rstrip("…").rstrip())


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def age(ms):
    minutes = int(ms // 60_000)
    if minutes < 1:
        return "now"
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 48 * 60:
        return f"{minutes // 60}h"
    return f"{minutes // 1440}d"


def tab_row(tab_id, title, state, detail, since, seen, now):
    if state == "done":      # records from before "done" was split up
        state = "step"
    why = ""
    if state in ("step", "finished", "idle") and seen.get(tab_id) == since:
        state = "idle"       # Kept or cleared at this `since`: it rests until it changes
    elif state == "finished":
        m = re.match(r"(Done|Parked): ", detail)
        why = m.group(1) if m else "Done"
        detail = detail[m.end():] if m else detail
    elif state in ("step", "idle") and now - since >= QUIET_MS:
        state, why = "finished", f"Quiet {age(now - since)}"
    elif state == "idle" and detail == NO_MESSAGES and now - since >= EMPTY_MS:
        state, why, detail = "finished", "Empty", "Nothing was asked here"
    tone, tag, note = state, why, detail
    if why.startswith("Quiet") or why == "Empty":
        tone, tag, note = "idle", why.split()[0], re.sub(r"^Next: ", "was waiting on: ", detail)   # the row's age says how long
    elif why == "Parked":
        tone = "idle"
    elif state == "step" and detail.startswith("Next: "):
        tag, note = "Next", detail[len("Next: "):]
    return {"id": tab_id, "title": title, "state": state, "tone": tone, "tag": tag, "note": note,
            "age": age(now - since) if since else "", "since": int(since)}


# ---------- A chat a reload stopped: going by its transcript, because its record only knows when the window reloaded ----------
def last_reply_ms(path):
    """When Claude last wrote words in this transcript, or None if it can't tell."""
    found = None
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        handle.seek(max(0, handle.tell() - REPLY_SCAN_BYTES))
        for line in handle:
            if b'"assistant"' not in line or b'"text"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            content = (d.get("message") or {}).get("content")
            if d.get("type") != "assistant" or not isinstance(content, list):
                continue
            if any(isinstance(b, dict) and b.get("type") == "text" and str(b.get("text") or "").strip() for b in content):
                try:
                    found = int(datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).timestamp() * 1000)
                except ValueError:
                    pass
    return found


def last_asked_ms(path):
    """When the person last wrote to this chat, or None. Tool results, machine notices and notes the editor adds aren't anyone saying anything."""
    found = None
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        handle.seek(max(0, handle.tell() - REPLY_SCAN_BYTES))
        for line in handle:
            if b'"user"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not isinstance(d, dict) or d.get("type") != "user" or d.get("isMeta") or d.get("isCompactSummary"):
                continue
            content = (d.get("message") or {}).get("content")
            blocks = [content] if isinstance(content, str) else [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"] if isinstance(content, list) else []
            if any(isinstance(text, str) and text.strip() and not text.lstrip().startswith("<") for text in blocks):
                try:
                    found = int(datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).timestamp() * 1000)
                except ValueError:
                    pass
    return found


def chat_folder(tab_id):
    """Where this chat was last working, which is what a command it wrote assumes. Every line of a transcript says. Empty if it can't tell."""
    hits = glob.glob(str(HOME / ".claude/projects/*" / f"{glob.escape(tab_id)}.jsonl"))
    if not hits:
        return ""
    try:
        with open(hits[0], "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - REPLY_SCAN_BYTES))
            lines = handle.read().splitlines()
    except OSError:
        return ""
    for line in reversed(lines):
        if b'"cwd"' not in line:
            continue
        try:
            folder = json.loads(line).get("cwd")
        except (ValueError, AttributeError):
            continue
        if isinstance(folder, str) and folder:
            return folder
    return ""


def asked_time(tab_id, book):
    return from_transcript(tab_id, book, f"asked:{tab_id}", last_asked_ms)


def reply_time(tab_id, book):
    return from_transcript(tab_id, book, tab_id, last_reply_ms)


def from_transcript(tab_id, book, slot, read):
    """What `read` finds, remembered until the transcript grows, since this runs every few seconds. Stable across reloads, so a verdict keyed on it stays good."""
    known = book.get(slot) if isinstance(book.get(slot), dict) else {}
    try:
        path = known.get("path")
        if not path or not os.path.exists(path):
            hits = glob.glob(str(HOME / ".claude/projects/*" / f"{glob.escape(tab_id)}.jsonl"))
            path = hits[0] if hits else None
        if not path:
            return None
        size = os.path.getsize(path)
        if known.get("path") != path or known.get("size") != size:
            known = {"path": path, "size": size, "ms": read(path)}
            book[slot] = known
    except OSError:
        return None
    return known.get("ms")


def save_reply_times(book, before, wanted):
    book = {tab_id: book[tab_id] for tab_id in wanted if tab_id in book}
    if book != before:
        try:
            SORT_FOLDER.mkdir(exist_ok=True)
            tmp = REPLY_TIMES.with_name(f"{REPLY_TIMES.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(book))
            os.replace(tmp, REPLY_TIMES)
        except OSError:
            pass


# ---------- The For later shelf: tabs kept out of the way, open or closed ----------
def read_shelf():
    shelf = read_json(LATER)
    return {k: v for k, v in shelf.items() if isinstance(v, dict)} if isinstance(shelf, dict) else {}


def write_shelf(shelf):
    tmp = LATER.with_name(f"{LATER.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(shelf))
    os.replace(tmp, LATER)


def shelve(tab_id, title):
    """Keeps its own copy of what the row shows, because the mod sweeps a tab's record after 3 quiet days."""
    record = read_json(TABS / f"{tab_id}.json")
    record = record if isinstance(record, dict) else {}
    found = glob.glob(str(HOME / ".claude/projects/*" / f"{glob.escape(tab_id)}.jsonl"))
    shelf = read_shelf()
    shelf[tab_id] = {"title": title or record.get("title") or "Claude tab", "note": record.get("detail") or "",
                     "since": record.get("since") or 0, "at": int(time.time() * 1000), "path": found[0] if found else ""}
    write_shelf(shelf)


def unshelve(*tab_ids):
    shelf = read_shelf()
    for tab_id in tab_ids:
        shelf.pop(tab_id, None)
    write_shelf(shelf)


def set_wake(tab_id, when):
    shelf = read_shelf()
    if tab_id in shelf:
        if when:
            shelf[tab_id]["wake"] = when
        else:
            shelf[tab_id].pop("wake", None)
        write_shelf(shelf)


def shelf_fields(entry, now):
    """How a shelved tab shows. Once its date comes, it's back in front of the person, though still on the shelf until they act."""
    wake = entry.get("wake")
    if not isinstance(wake, (int, float)):
        return {"state": "later", "tone": "idle", "tag": ""}
    if now >= wake:
        return {"state": "step", "tone": "step", "tag": "Back", "woke": True}
    try:
        when = datetime.fromtimestamp(wake / 1000)
    except (ValueError, OverflowError, OSError):   # a date too far off to read shouldn't take the whole list down with it
        return {"state": "later", "tone": "idle", "tag": ""}
    return {"state": "later", "tone": "idle", "tag": "", "wakeText": f"Back {when:%b} {when.day}"}


def renew(shelf):
    """A shelved chat is one nothing writes to, which is what gets a chat deleted."""
    limit = time.time() - RENEW_DAYS * 86400
    for entry in shelf.values():
        try:
            if entry.get("path") and os.path.getmtime(entry["path"]) < limit:
                os.utime(entry["path"])
        except (OSError, TypeError):
            continue


def apply_shelf(rows, shelf, listed, details, now, asked=None):
    """A shelved tab shows only under For later, until it's picked back up. Reloads and Claude's own judging can move `since` without anyone
    using the tab, so it takes a tab that's busy now, or the person having written since (`asked`), for a turn too short to be seen as busy."""
    out, back, have = [], [], set()
    for row in rows:
        entry = shelf.get(row["id"])
        at = (entry.get("at") or 0) if entry else 0
        if entry and row["since"] > at and (row["state"] in BUSY or ((asked or {}).get(row["id"]) or 0) > at):
            back.append(row["id"])
        elif entry:
            have.add(row["id"])
            row.pop("stopped", None)      # it's shelved: nothing here puts it back on the list
            if row["state"] in BUSY:      # shelved partway through: out of the way, but a reload or a Close would still stop it
                row["liveState"] = row["state"]
            since = row["since"] or entry.get("since") or 0
            row.update(since=int(since), age=age(now - since) if since else "",
                       note=re.sub(r"^(Done|Parked|Next): ", "", details.get(row["id"]) or entry.get("note") or ""),
                       **shelf_fields(entry, now))
        out.append(row)
    for tab_id, entry in shelf.items():
        if tab_id not in have and tab_id not in back:   # closed, and its record has been swept: the shelf's own copy
            since = entry.get("since") or 0
            out.append({"id": tab_id, "title": entry.get("title") or "Claude tab",
                        "note": re.sub(r"^(Done|Parked|Next): ", "", entry.get("note") or ""),
                        "age": age(now - since) if since else "", "since": int(since), **shelf_fields(entry, now)})
    if back:
        unshelve(*back)
    return out


# ---------- Recently closed: every tab that leaves VS Code's list, however it was closed, so a close is one click from undone ----------
CLOSED_DAYS = 30           # Claude Code deletes a chat nothing has written to for this long, so it can't come back after that
CLOSE_GRACE_MS = 120_000   # VS Code saves its list of open tabs every so often, so a tab just closed can still be on it


def read_closed():
    store = read_json(CLOSED)
    store = store if isinstance(store, dict) else {}
    return {key: store[key] if isinstance(store.get(key), dict) else {} for key in ("open", "closed")}


def write_closed(store):
    tmp = CLOSED.with_name(f"{CLOSED.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(store))
    os.replace(tmp, CLOSED)


def closed_entry(tab_id, title, now, button=False):
    record = read_json(TABS / f"{tab_id}.json")
    record = record if isinstance(record, dict) else {}
    found = glob.glob(str(HOME / ".claude/projects/*" / f"{glob.escape(tab_id)}.jsonl"))
    return {"title": title or record.get("title") or "Claude tab", "note": re.sub(r"^(Done|Parked|Next): ", "", record.get("detail") or ""),
            "since": record.get("since") or 0, "at": int(now), "path": found[0] if found else "", "button": button}


def mark_closed(tab_id, title):
    store = read_closed()
    store["closed"][tab_id] = closed_entry(tab_id, title, time.time() * 1000, button=True)
    store["open"].pop(tab_id, None)
    write_closed(store)


def mark_reopening(tab_id):
    """It stays listed until it really shows up as open, in case bringing it back fails."""
    store = read_closed()
    if tab_id in store["closed"]:
        store["closed"][tab_id]["button"] = False
        write_closed(store)


def track_closed(listed, now):
    store = read_closed()
    before = json.dumps(store, sort_keys=True)
    closed = store["closed"]
    if listed is not None:
        for tab_id, title in store["open"].items():
            if tab_id not in listed and tab_id not in closed:
                closed[tab_id] = closed_entry(tab_id, title, now)
        for tab_id in [t for t in closed if t in listed]:
            entry = closed[tab_id]
            if not (isinstance(entry, dict) and entry.get("button") and now - (entry.get("at") or 0) < CLOSE_GRACE_MS):
                del closed[tab_id]   # it's open again
        store["open"] = listed
    for tab_id, entry in list(closed.items()):
        if not isinstance(entry, dict) or now - (entry.get("at") or 0) > CLOSED_DAYS * 86_400_000 or (entry.get("path") and not os.path.exists(entry["path"])):
            del closed[tab_id]
    if json.dumps(store, sort_keys=True) != before:
        try:
            write_closed(store)
        except OSError:
            pass
    return store["closed"]


def tabs():
    now = time.time() * 1000
    listed = open_tabs()
    closed = track_closed(listed, now)
    seen = read_json(TABS / "seen.json") or {}
    shelf = read_shelf()
    renew(shelf)
    rows, have, details = [], set(), {}
    book = read_json(REPLY_TIMES)
    book = book if isinstance(book, dict) else {}
    book_before, stopped_ids = dict(book), []
    for path in glob.glob(str(TABS / "*.json")):
        tab_id = os.path.basename(path)[:-5]
        if tab_id == "seen":
            continue
        is_open = listed is not None and tab_id in listed
        try:
            fresh = now - os.path.getmtime(path) * 1000 <= GONE_MS
        except OSError:
            continue
        # Only tabs VS Code has open: a headless `claude -p` (an AI cut, say) writes a record too, but has no tab to jump to.
        if not (is_open or tab_id in shelf or (listed is None and fresh)):
            continue
        d = read_json(path)
        if not isinstance(d, dict) or d.get("state") == "closed":
            continue
        state, detail = d.get("state", "idle"), d.get("detail", "")
        if now - (d.get("beat") or 0) > GONE_MS and state in ("working", "needs", "waiting"):
            state, detail = "idle", "Stopped when the tab restarted"   # it stopped mid-turn, so it isn't still working
        title = d.get("title") or (listed or {}).get(tab_id) or "New tab"
        since, stopped = d.get("since") or 0, state == "idle" and detail in STOPPED
        if stopped:
            stopped_ids.append(tab_id)
            since = reply_time(tab_id, book) or since
        rows.append(tab_row(tab_id, title, state, detail, since, seen, now))
        rows[-1]["awake"] = now - (d.get("beat") or 0) <= GONE_MS   # its Claude is running. If not, it starts when the tab opens
        if stopped and seen.get(tab_id) != since:    # Kept or cleared by hand stays that way
            rows[-1]["stopped"] = True
        have.add(tab_id)
        details[tab_id] = detail
    for tab_id, title in (listed or {}).items():
        if tab_id not in have:
            rows.append({"id": tab_id, "title": title or "Claude tab", "state": "idle", "tone": "idle", "tag": "",
                         "note": "Checking where this tab left off…", "age": "", "since": 0})
    # Only a shelved chat whose time has moved can have been picked up, so nothing else has its transcript read for this
    asked = {r["id"]: asked_time(r["id"], book) for r in rows if r["id"] in shelf and r["state"] not in BUSY and r["since"] > (shelf[r["id"]].get("at") or 0)}
    save_reply_times(book, book_before, stopped_ids + [f"asked:{tab_id}" for tab_id in asked])
    rows = [r for r in apply_shelf(rows, shelf, listed, details, now, asked) if r["id"] not in closed or r["id"] in shelf]
    for row in rows:
        row["isOpen"] = row["id"] in (listed or {}) and row["id"] not in closed
        row["label"] = (listed or {}).get(row["id"], "")   # the name on the real tab, which is how the Close button finds it
        row["labelFits"] = label_fits(row["label"], row["title"])
    for tab_id, entry in closed.items():
        if tab_id not in shelf:
            at = entry.get("at") or 0
            rows.append({"id": tab_id, "title": entry.get("title") or "Claude tab", "state": "closed", "tone": "idle", "tag": "",
                         "note": entry.get("note") or "", "age": age(now - at), "since": int(entry.get("since") or 0), "closedAt": at,
                         "isOpen": False, "label": ""})
    rows.sort(key=lambda r: (TAB_ORDER.get(r["state"], 8), -r["since"]))
    return rows


# ---------- Who's really up: triage.py's answers, and the order they put the tabs in ----------
SORT_FOLDER = Path(os.environ.get("BAR_TRIAGE") or HOME / ".claude/tab-triage")   # not in TABS, for the same reason as the shelf
VERDICTS = SORT_FOLDER / "verdicts.json"
REPLY_TIMES = SORT_FOLDER / "reply-times.json"
SORT_LOCK = SORT_FOLDER / "lock"
STARS = SORT_FOLDER / "stars.json"
PINGED = SORT_FOLDER / "pinged.json"
TRIAGE_SCRIPT = Path(__file__).resolve().parent / "triage.py"
RUN_GAP_S = 20                  # between runs of triage.py
RETRY_S = 300                   # after a run that failed
STUCK_S = 180                   # a lock this old was left by a run that died
SOON_MS = 36 * 3_600_000        # a date this close goes to the top and sends a reminder
LAST_CALL_MS = 2 * 3_600_000    # this close, one more reminder
NEW_MS = 30 * 60_000            # a high-stakes ask only pings while it's this new. An old one isn't news
FORGET_DUE_MS = 48 * 3_600_000  # a date this far gone says nothing any more
SIZE_ORDER = {"quick": 0, "sit": 1, "out": 2}
TRIAGE_V = 4                    # triage.py's VERSION. An answer from before gets asked again, and is used until the new one comes
CLOSE_QUIET_MS = 6 * 3_600_000  # no close suggestion sooner. In one heavy user's chats, 57% were picked back up after an hour's quiet, 30% after 6 hours


def to_judge(row):
    """What claims to wait on the person: their move, parked with something left to do, gone quiet with a question still open, or stopped by a reload before anyone could say."""
    return row.get("stopped") or row["state"] == "step" or (row["state"] == "finished" and (row["tag"] == "Parked" or row["note"].startswith("was waiting on")))


def due_text(due, now):
    when = datetime.fromtimestamp(due / 1000)
    days = (when.date() - datetime.now().date()).days
    day_only = when.hour == 17 and when.minute == 0     # the tab named a day with no hour, so don't claim one
    if due < now and not (day_only and days == 0):      # and a day isn't over at 5 PM
        return f"{age(now - due)} overdue"
    if day_only:
        return "by today" if days == 0 else "by tomorrow" if days == 1 else f"by {when:%a}" if days < 7 else f"by {when:%b} {when.day}"
    hour = when.strftime("%-I%p" if when.minute == 0 else "%-I:%M%p").lower()
    if days == 0:
        return f"by {hour} today"
    if days == 1:
        return f"by {hour} tomorrow"
    return f"by {when:%a} {hour}" if days < 7 else f"by {when:%b} {when.day}"


def apply_verdict(row, verdict, now):
    """A row keeps its plain state until judged, so if triage.py can't run the list still works."""
    due = verdict.get("dueMs")
    if due is not None and now - due > FORGET_DUE_MS:
        due = None
    is_yours = verdict.get("who") == "you"
    row.update(who=verdict.get("who"), size=verdict.get("size"), stakes=verdict.get("stakes"), why=verdict.get("why") or "")
    if verdict.get("ask") and verdict.get("who") != "nobody":    # with nothing left to ask, the tab's own note says more
        row["note"] = verdict["ask"]
    if is_yours and verdict.get("ship") in ("reply", "command"):
        row.update(state="step", tone="step", ship=verdict["ship"], shipCommand=verdict.get("command") or "")   # an OK to go live never hides, even gone quiet
        if verdict["ship"] == "command":
            row["shipFolder"] = chat_folder(row["id"])
    elif row.get("stopped") and row["tag"] != "Quiet":    # a reload stopped it before it could say whose move it is, so this is the first anyone has said
        if is_yours:
            row.update(state="step", tone="step", tag="Next")
        elif verdict.get("who") in ("someone", "machine"):
            row.update(state="blocked", tone="idle", tag="")
        else:
            row.update(state="finished", tone="finished", tag="Done", note=verdict.get("closeWhy") or "Nothing left to do here")
    elif row["state"] == "step":
        if verdict.get("who") in ("someone", "machine"):
            row.update(state="blocked", tone="idle", tag="")
    elif is_yours and (due is not None or verdict.get("stakes") == 3):
        row.update(state="step", tone="step")   # went quiet or was parked, but it matters: it doesn't get to hide in Ready to close
    elif is_yours and (row["tag"] == "Quiet" or verdict.get("stakes") == 2):
        row.update(state="sitting", tone="idle")
    if is_yours and due is not None:
        row.update(dueMs=due, dueText=due_text(due, now), dueSoon=due - now < SOON_MS)


def suggest_closing(rows, verdicts, stars, unjudged, now):
    """Marks what looks safe to close, for the person to decide: quiet long enough, read by the model with nothing left for anyone, and no command still running under it,
    since closing a chat stops those. A tab's own "done" isn't enough, and neither is time: people pick up quiet chats all the time. If it's not clear, it isn't suggested."""
    asked = {tab["id"] for tab in unjudged}
    maybe = []
    for row in rows:
        if row["state"] != "finished" or not row.get("isOpen") or row["id"] in stars:
            continue
        if row["tag"] == "Empty":
            maybe.append((row, {"closeWhy": row["note"]}))
        elif now - row["since"] >= CLOSE_QUIET_MS:
            verdict = verdicts.get(row["id"])
            if not (isinstance(verdict, dict) and verdict.get("since") == row["since"] and verdict.get("v") == TRIAGE_V):
                if row["id"] not in asked:
                    unjudged.append({k: row[k] for k in ("id", "title", "state", "tag", "note", "since")})
            elif verdict.get("close") and verdict.get("who") == "nobody":
                maybe.append((row, verdict))
    running = safely(reload_work) if maybe else []
    if running is None:         # can't tell what's running: better to suggest nothing
        return
    busy = {job["id"] for job in running}
    for row, verdict in maybe:
        if row["id"] not in busy:
            row.update(state="closable", tone="finished", tag="", note=verdict["closeWhy"], lastSaid=verdict.get("lastSaid") or "")


def start_triage(rows, store):
    """In the background, one run at a time: it takes a few seconds, and this runs every few."""
    now = time.time()
    if not rows or not TRIAGE_SCRIPT.exists():
        return
    if now - (store.get("ranAt") or 0) < RUN_GAP_S or now - (store.get("failedAt") or 0) < RETRY_S:
        return
    try:
        SORT_FOLDER.mkdir(exist_ok=True)
        if SORT_LOCK.exists() and now - SORT_LOCK.stat().st_mtime > STUCK_S:
            SORT_LOCK.unlink()
        SORT_LOCK.touch(exist_ok=False)
    except OSError:
        return                          # FileExistsError included: one is running
    try:
        run = subprocess.Popen([sys.executable, "-I", str(TRIAGE_SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True, text=True)
        run.stdin.write(json.dumps(sorted(rows, key=lambda r: -r["since"])))    # newest first: those are what's on the person's mind
        run.stdin.close()
    except OSError:
        SORT_LOCK.unlink(missing_ok=True)


def ping(row, heading):
    """A macOS notice that opens the tab when clicked."""
    body = f"​{row['note']}"[:180]     # the blank first character stops text starting with "-" being read as an option
    url = f"vscode://anthropic.claude-code/open?session={row['id']}"
    notifier = shutil.which("terminal-notifier") or "/opt/homebrew/bin/terminal-notifier"
    try:
        sent = os.path.exists(notifier) and subprocess.run(
            [notifier, "-title", row["title"], "-subtitle", heading, "-message", body, "-open", url, "-group", f"tab-sort-{row['id']}", "-sound", "Glass"],
            capture_output=True, timeout=5).returncode == 0
        if not sent:
            quote = json.dumps
            subprocess.run(["osascript", "-e", f"display notification {quote(body)} with title {quote(row['title'])} subtitle {quote(heading)} sound name \"Glass\""],
                           capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def send_reminders(rows, now):
    """Only what can't wait makes a sound: a date that's close, and a new ask with a client, money or something public riding on it."""
    if os.environ.get("BAR_QUIET"):   # for trying the list out without buzzing anyone
        return
    due_now = []
    for row in rows:
        if row.get("woke"):
            due_now.append((row, "woke", "Back from For later"))
            continue
        due = row.get("dueMs")
        if due is not None and due < now:
            continue                    # already gone: it shows as overdue, but a sound can't help now
        if due is not None and due - now < LAST_CALL_MS:
            due_now.append((row, "last", row["dueText"]))
        elif row.get("dueSoon"):
            due_now.append((row, "soon", row["dueText"]))
        elif row.get("stakes") == 3 and row["tag"] == "Next" and now - row["since"] < NEW_MS:
            due_now.append((row, "new", "Needs you soon"))
    if not due_now:
        return
    pinged = read_json(PINGED)
    pinged = pinged if isinstance(pinged, dict) else {}
    fresh = [(f"{row['id']}:{row['since']}:{kind}", row, heading) for row, kind, heading in due_now]
    fresh = [item for item in fresh if item[0] not in pinged]
    if not fresh:
        return
    for key, row, heading in fresh:
        pinged[key] = int(now)
        ping(row, heading)
    PINGED.write_text(json.dumps(dict(list(pinged.items())[-300:])))


def sorted_tabs():
    rows = tabs()
    now = time.time() * 1000
    store = read_json(VERDICTS)
    store = store if isinstance(store, dict) else {}
    verdicts = store.get("verdicts") or {}
    stars = read_json(STARS)
    stars = set(stars) if isinstance(stars, list) else set()
    unjudged = []
    for row in rows:
        if row.get("woke"):             # its own date, set by the person: nothing to judge
            row.update(size="sit", why="You asked to see this again today")
        elif row["state"] == "needs":   # stopped mid-work for an OK: no judging needed to know whose move that is
            row.update(size="quick", why="Its work is stopped until you answer", note=re.sub(r"^Approve: Running: ", "Approve: ", row["note"]))
        elif to_judge(row):
            verdict = verdicts.get(row["id"])
            asked = {k: row[k] for k in ("id", "title", "state", "tag", "note", "since")}
            is_current = isinstance(verdict, dict) and verdict.get("since") == row["since"]
            if is_current:
                apply_verdict(row, verdict, now)
            if not is_current or verdict.get("v") != TRIAGE_V:
                unjudged.append(asked)
    yours = [row for row in rows if row["state"] in ("needs", "step")]
    def place(r):
        soon, due = r.get("dueSoon"), r.get("dueMs") or 0
        return (r["id"] not in stars, not soon, bool(soon and due < now), due if soon else 0,   # dates still ahead first, soonest on top, then missed ones
                r["state"] != "needs", -(r.get("stakes") or 2), SIZE_ORDER.get(r.get("size"), 1), r["since"])
    yours.sort(key=place)
    for i, row in enumerate(yours):
        row.update(rank=i, starred=row["id"] in stars)
    rest = [row for row in yours if not row.get("ship")]   # what's ready to ship has its own place, above the pick
    if rest and (rest[0].get("size") or rest[0]["starred"]):
        rest[0]["pick"] = True
    suggest_closing(rows, verdicts, stars, unjudged, now)
    start_triage(unjudged, store)
    send_reminders(yours, now)
    return rows


def set_star(tab_id, on):
    stars = read_json(STARS)
    stars = [s for s in stars if s != tab_id] if isinstance(stars, list) else []
    if on:
        stars.insert(0, tab_id)
    SORT_FOLDER.mkdir(exist_ok=True)
    STARS.write_text(json.dumps(stars[:50]))


def mark_seen(tab_id, since):
    path = TABS / "seen.json"
    seen = read_json(path) or {}
    seen[tab_id] = since
    tmp = TABS / "seen.tmp"
    tmp.write_text(json.dumps(dict(list(seen.items())[-200:])))
    os.replace(tmp, path)


# ---------- What a window reload would stop: the commands chats are running, which die with them ----------
JOB_MIN_S = 15      # anything younger is likely a quick command, not a job
STARTUP_S = 30      # what a chat starts in its first moments is its own helpers, not work
POLLING = re.compile(r"watch|wait|monitor", re.I)
HEAVY = {"ffmpeg", "whisper", "whisper-cli", "demucs", "rclone", "rsync"}   # real work however little CPU it's getting at the moment
WATCHER_CPU = 30    # a watcher using a little CPU between sleeps is still a watcher. Without this, the reload light blinked each time one checked in


def etime_s(text):
    """ps's elapsed time: [[dd-]hh:]mm:ss."""
    days, _, rest = text.rpartition("-")
    parts = [int(p) for p in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return int(days or 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def base(word):
    return word.rsplit("/", 1)[-1]


def program_names(cmd):
    """The program and what it's running, not its arguments: `rclone copy /Volumes/Watch-party` isn't a watcher, `python3 -I watch.py` is."""
    words = cmd.split() or [""]
    return [base(words[0])] + [base(w) for w in words[1:] if not w.startswith("-")][:1]


def only_watching(members):
    """A sleep beside a render doesn't make the render a watcher, and neither does the render being slowed to almost nothing."""
    names = [name for member in members for name in program_names(member["cmd"])]
    if HEAVY.intersection(names):
        return False
    return "sleep" in names or bool(POLLING.search(" ".join(names)))


def chat_commands(ps_text, session_of):
    """One row per chat with real work running. A loop that only sleeps and checks isn't work: it's nothing to lose, and they'd never let a reload look safe.
    Claude Code run outside VS Code (an AI cut started by launchd, say) survives a reload, so it doesn't count."""
    procs, kids = {}, {}
    for line in ps_text.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)", line)
        if m:
            procs[int(m[1])] = {"parent": int(m[2]), "secs": etime_s(m[3]), "cpu": float(m[4]), "cmd": m[5]}
            kids.setdefault(int(m[2]), []).append(int(m[1]))
    def under_vscode(pid):
        seen = set()
        while pid in procs and pid not in seen:
            seen.add(pid)
            if "Visual Studio Code" in procs[pid]["cmd"]:
                return True
            pid = procs[pid]["parent"]
        return False
    def family(pid):
        out, stack = [], [pid]
        while stack:
            at = stack.pop()
            out.append(at)
            stack.extend(kids.get(at, []))
        return out
    chats = {}
    for pid, chat in procs.items():
        if "/native-binary/claude" not in chat["cmd"] or not under_vscode(pid):
            continue
        for child in kids.get(pid, []):
            job = procs[child]
            members = [procs[p] for p in family(child)]
            a_command = any("shell-snapshots" in m["cmd"] for m in members)   # the chat ran this on purpose. Its own helpers don't look like this
            if job["secs"] < JOB_MIN_S or (chat["secs"] - job["secs"] < STARTUP_S and not a_command):
                continue
            if sum(m["cpu"] for m in members) < WATCHER_CPU and only_watching(members):
                continue
            doing = next((m["cmd"] for m in members if "shell-snapshots" not in m["cmd"]), None)
            if doing is None:          # a shell with nothing under it, between steps of a loop
                continue
            sid = session_of.get(pid, "")
            row = chats.setdefault(sid or str(pid), {"id": sid, "secs": 0, "what": " ".join(base(w) for w in doing.split()[:3])[:80]})
            row["secs"] = max(row["secs"], job["secs"])
    return list(chats.values())


def reload_work():
    try:
        out = subprocess.run(["ps", "-Awwo", "pid=,ppid=,etime=,pcpu=,command="], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return None                    # can't tell: better to say nothing than "safe"
    session_of = {}
    for path in glob.glob(str(HOME / ".claude/sessions/*.json")):
        d = read_json(path)
        if isinstance(d, dict) and isinstance(d.get("pid"), int) and d.get("sessionId"):
            session_of[d["pid"]] = d["sessionId"]
    rows = chat_commands(out, session_of)
    for row in rows:
        record = read_json(TABS / f"{row['id']}.json") if row["id"] else None
        row["title"] = (record or {}).get("title") or "A chat"
        row["for"] = age(row.pop("secs") * 1000)
    return rows


# ---------- Two chats editing the same file. Only what went through Claude's edit tools shows: a file changed by a script won't ----------
OVERLAP_MINUTES = 30
FIRST_READ = 2_000_000                 # how far back to look in a chat seen for the first time
EDIT_TOOLS = ("Edit", "Write", "NotebookEdit", "MultiEdit")
NOT_SHARED = re.compile(r"^(/private)?/tmp/|/\.claude/projects/|/\.claude/progress/|/\.claude/tab-")   # scratch space and each tab's own notes


def new_edits(path, offset):
    """Reads only what's been added since last time. Returns the edits, and where to start next time."""
    size = os.path.getsize(path)
    if offset > size:
        offset = 0
    start = offset or max(0, size - FIRST_READ)
    with open(path, "rb") as handle:
        handle.seek(start)
        data = handle.read(size - start)
    if not offset and start:
        cut = data.find(b"\n") + 1
        data, start = data[cut:], start + cut
    end = data.rfind(b"\n") + 1           # a line still being written waits for next time
    found = []
    for line in data[:end].splitlines():
        if b'"file_path"' not in line or b'"tool_use"' not in line:
            continue
        try:
            d = json.loads(line)
            when = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp() * 1000
        except (ValueError, KeyError, AttributeError):
            continue
        for block in (d.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in EDIT_TOOLS:
                file = (block.get("input") or {}).get("file_path")
                if isinstance(file, str):
                    found.append([when, file])
    return found, start + end


def still_editing(tab_id, now):
    """In the middle of a turn. A chat that has finished its turn, even with a watcher running, isn't in anyone's way."""
    record = read_json(TABS / f"{tab_id}.json")
    return isinstance(record, dict) and record.get("state") in ("working", "needs") and now - (record.get("beat") or 0) <= GONE_MS


def overlaps():
    now = time.time() * 1000
    cutoff = now - OVERLAP_MINUTES * 60_000
    listed = open_tabs() or {}
    store_path = SORT_FOLDER / "edits.json"
    store = read_json(store_path)
    store = store if isinstance(store, dict) else {}
    offsets = store.get("offsets") if isinstance(store.get("offsets"), dict) else {}
    edits = [e for e in store.get("edits") or [] if e[0] >= cutoff]
    fresh = {}
    for path in glob.glob(str(HOME / ".claude/projects/*/*.jsonl")):
        tab_id = os.path.basename(path)[:-6]
        if tab_id not in listed:
            continue
        try:
            if os.path.getmtime(path) * 1000 < cutoff or os.path.getsize(path) == offsets.get(tab_id):
                fresh[tab_id] = offsets.get(tab_id, 0)
                continue
            found, fresh[tab_id] = new_edits(path, offsets.get(tab_id, 0))
        except OSError:
            continue
        edits += [[when, tab_id, file] for when, file in found if when >= cutoff and not NOT_SHARED.search(file)]
    SORT_FOLDER.mkdir(exist_ok=True)
    if fresh != offsets or len(edits) != len(store.get("edits") or []):
        tmp = store_path.with_name(f"edits.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"offsets": fresh, "edits": edits}))
        os.replace(tmp, store_path)
    by_file = {}
    for when, tab_id, file in edits:
        if tab_id in listed:
            by_file.setdefault(file, {})[tab_id] = when
    shared = {tab_id for who in by_file.values() if len(who) > 1 for tab_id in who}
    busy = {tab_id for tab_id in shared if still_editing(tab_id, now)}
    groups = {}
    for file, who in by_file.items():
        who = {tab_id: when for tab_id, when in who.items() if tab_id in busy}
        if len(who) > 1:
            group = groups.setdefault(tuple(sorted(who)), {"files": [], "last": 0})
            group["files"].append(base(file))
            group["last"] = max(group["last"], *who.values())
    out = []
    for ids, group in sorted(groups.items(), key=lambda item: -item[1]["last"]):
        chats =[{"id": i, "title": (read_json(TABS / f"{i}.json") or {}).get("title") or listed.get(i) or "A chat"} for i in ids]
        out.append({"chats": chats, "files": sorted(group["files"]), "ago": age(now - group["last"])})
    return out


def safely(check, otherwise=None):
    """One of these failing mustn't take the whole list down."""
    try:
        return check()
    except (OSError, ValueError, TypeError, AttributeError, IndexError, KeyError):
        return otherwise


# ---------- Search: what was said in the tabs. The same rules as SEARCH_PY in the tab-board mod's hooks/search.ts ----------
SEARCH_DAYS = 7   # tabs not open are searched too, if used this many days back


def said_in(row):
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return [content]
    return [b["text"] for b in content or [] if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]


def snippet(text, term):
    flat = " ".join(text.split())
    at = flat.lower().find(term)
    if at < 0:
        return flat[:160]
    start = max(0, at - 60)
    return ("…" if start else "") + flat[start:start + 160] + ("…" if start + 160 < len(flat) else "")


def search(query):
    """Every word must be said in the tab, by the person or by Claude; "quotes" make a phrase. Tool output and reminders don't count,
    because the memory index alone names "payroll" in every transcript."""
    query = query.replace("“", '"').replace("”", '"')
    phrases = re.findall(r'"([^"]+)"', query)
    terms = [t.lower() for t in phrases + re.sub(r'"[^"]*"', " ", query).split() if t.strip()]
    if not terms:
        return []
    raw = [t.encode("utf-8") for t in terms]   # raw lines are checked as bytes first: far faster than decoding each one
    listed = open_tabs() or {}
    since = time.time() - SEARCH_DAYS * 86400
    root = HOME / ".claude/projects"
    paths = {}
    for project in os.listdir(root):
        folder = root / project
        if not folder.is_dir():
            continue
        for name in os.listdir(folder):
            if name.endswith(".jsonl"):
                path = folder / name
                # Not open: recent, and not a throwaway run in a temp folder.
                if name[:-6] in listed or (os.path.getmtime(path) >= since and not project.startswith(("-private-", "-tmp"))):
                    paths[name[:-6]] = path
    found = []
    for sid, path in paths.items():
        custom = made = ""
        seen, hits, best = set(), 0, None
        try:
            with open(path, "rb") as handle:
                for line in handle:
                    if b'-title"' in line:
                        try:
                            d = json.loads(line)
                            if d.get("type") == "custom-title":
                                custom = d.get("customTitle") or custom
                            elif d.get("type") == "ai-title":
                                made = d.get("aiTitle") or made
                        except ValueError:
                            pass
                        continue
                    low = line.lower()
                    if not any(t in low for t in raw):
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    kind = d.get("type")
                    if kind not in ("user", "assistant") or d.get("isMeta") or d.get("isCompactSummary"):
                        continue
                    for text in said_in(d):
                        if kind == "user" and text.lstrip().startswith("<"):   # machine notices: nobody said those
                            continue
                        lowered = text.lower()
                        here = [t for t in terms if t in lowered]
                        if not here:
                            continue
                        hits += sum(lowered.count(t) for t in here)
                        seen.update(here)
                        rank = (len(here), kind == "user")   # shown: the latest line with the most words, the person's own first
                        if best is None or rank >= best[0]:
                            best = (rank, kind, text, here[0])
        except OSError:
            continue
        title = custom or made
        seen.update(t for t in terms if t in title.lower())
        if len(seen) < len(terms):
            continue
        modified = os.path.getmtime(path) * 1000
        record = read_json(TABS / f"{sid}.json") or {}
        found.append({"id": sid, "title": title or listed.get(sid) or record.get("title") or "Claude tab", "isOpen": sid in listed,
                      "hits": hits, "modified": modified, "age": age(time.time() * 1000 - modified),
                      "who": ("You" if best[1] == "user" else "Claude") if best else "",
                      "snippet": snippet(best[2], best[3]) if best else ""})
    found.sort(key=lambda e: -e["modified"])   # newest first: people look for a chat by when they had it; the row still says how often
    return found[:40]


if __name__ == "__main__":
    command = sys.argv[1:2]
    if command == ["tabs"]:
        print(json.dumps({"tabs": sorted_tabs() if sys.argv[2:3] == ["sorted"] else tabs(), "hasBoard": TABS.is_dir()}))
    elif command == ["star"]:
        set_star(sys.argv[2], sys.argv[3] == "on")
    elif command == ["search"]:
        print(json.dumps({"hits": search(" ".join(sys.argv[2:]))}))
    elif command == ["seen"]:
        mark_seen(sys.argv[2], int(sys.argv[3]))
    elif command == ["later"]:
        shelve(sys.argv[2], " ".join(sys.argv[3:]))
    elif command == ["unlater"]:
        unshelve(sys.argv[2])
    elif command == ["wake"]:
        set_wake(sys.argv[2], 0 if sys.argv[3] == "off" else int(sys.argv[3]))
    elif command == ["closed"]:
        mark_closed(sys.argv[2], " ".join(sys.argv[3:]))
    elif command == ["unclosed"]:
        mark_reopening(sys.argv[2])
    elif command:
        personal(sys.argv[1:])
    else:
        mine = personal([])
        groups = (mine.get("groups") or []) + cards()
        print(json.dumps({"updated": time.time(), "groups": groups, "total": safely(lambda: job_times(groups, mine.get("priority"))),
                          "mac": mine.get("mac") or mac(), "priority": mine.get("priority"), "apps": mine.get("apps"),
                          "reload": safely(reload_work), "overlap": safely(overlaps, [])}))
