"""How long each running job has left, and when everything is done, for collect.py.

A job's time comes from, in order: the job's own figure (an upload's rclone ETA), how fast its meter has been moving, or what its chat said on
its card ("mins_left"). A job with none of those has no estimate, and says so, rather than show a guess.

The order the throttle follows only changes the times while it's making jobs take turns. With room for everything, they all run at once.

Measured on Nov 5 2026 against 3 real jobs replayed from their logs (a 148-minute sermon render and two AI cuts): typically off by about 20%."""
import heapq
import json
import os
from pathlib import Path

WINDOW_S = 3600           # only the last hour counts: speed changes
MIN_SPAN_S = 120          # no estimate from less time than this
MIN_MOVES = 2             # one move could be a card set by hand, which says nothing about speed
READING_EVERY_S = 60      # a meter that hasn't moved is noted this often
KEEP_READINGS = 240
FORGET_S = 86400
SOONEST_S = 30            # a job at or past its estimate is still "about to finish", never "done"
LONG_HAUL_S = 12 * 3600   # a capped upload that runs for days would make the total useless, so it's named instead of added


def remember(readings, frac, now, slowed):
    """Adds one reading of a job's meter. A meter that went backwards started over or moved to its next stage, so the old speed says nothing."""
    if readings and frac < readings[-1][1] - 0.001:
        readings.clear()
    if readings and frac == readings[-1][1] and now - readings[-1][0] < READING_EVERY_S:
        return readings
    readings.append([now, frac, bool(slowed)])
    del readings[:-KEEP_READINGS]
    return readings


def measured_left(readings, now):
    """Seconds left at full speed, or None if the meter hasn't moved enough to tell. Time spent slowed isn't counted as its speed."""
    recent = [r for r in readings if now - r[0] <= WINDOW_S]
    last_move = max((i for i in range(1, len(recent)) if recent[i][1] > recent[i - 1][1]), default=None)
    if last_move is None:
        return None
    spent = moved = moves = 0
    for a, b in zip(recent[:last_move], recent[1:last_move + 1]):
        if a[2] or b[2]:
            continue
        spent += b[0] - a[0]
        moved += b[1] - a[1]
        moves += b[1] > a[1]
    if moves < MIN_MOVES or spent < MIN_SPAN_S or moved <= 0:
        return None
    left = (1 - recent[-1][1]) / (moved / spent)
    if recent[-1][2]:         # slowed right now: it isn't moving at its speed, so the wait since its last move means nothing
        return left
    since = now - recent[last_move][0]
    if since > 2 * spent / moves:   # overdue: it's slower than it was, so count the wait as part of its speed
        return left * (spent + since) / spent
    return max(left - since, SOONEST_S)


def finish_times(lefts, slots):
    """Seconds until each job ends, given in priority order. slots is how many the throttle lets run at once: None means no limit.
    A job with no estimate (None) stays None, and takes no turn, so jobs behind it may run later than this says: see behind_unknown."""
    if slots is None:
        return list(lefts)
    free = [0.0] * max(1, slots)
    out = []
    for left in lefts:
        if left is None:
            out.append(None)
            continue
        start = heapq.heappop(free)
        heapq.heappush(free, start + left)
        out.append(start + left)
    return out


def load(path):
    try:
        data = json.loads(Path(path).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, store):
    path = Path(path)
    tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp")   # the panel and a chat can both be looking
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(store))
    os.replace(tmp, path)


def own_time(row, readings, now):
    """(seconds left at full speed, where that came from). None if there's nothing to go on."""
    if row.get("partial"):    # only one stage of several, so its meter says nothing about the whole job
        return None, None
    if isinstance(row.get("left"), (int, float)):
        return float(row["left"]), "job"
    measured = measured_left(readings, now) if readings else None
    if measured is not None:
        return measured, "pace"
    if isinstance(row.get("said"), (int, float)):
        return float(row["said"]), "chat"
    return None, None


def estimate(groups, priority, store_path, now):
    """Puts left (seconds) and leftBy on each running row and each Priority job, and returns the total for the list. Changes groups and priority in place."""
    store = load(store_path)
    jobs = (priority or {}).get("jobs") or []
    chat_job = {job["chat"]: job for job in jobs if job.get("chat")}
    group_job = {job["group"]: job for job in jobs if job.get("group")}
    owners, live = {}, []
    for group in groups:
        for row in group.get("rows") or []:
            if row.get("state") != "running":
                row.pop("left", None)   # an upload that paused has no time left to speak of
                continue
            job = group_job.get(group.get("name")) or chat_job.get(row.get("chat"))
            key = f"{group.get('name')}/{row.get('name')}"
            if isinstance(row.get("frac"), (int, float)):
                remember(store.setdefault(key, []), row["frac"], now, bool(job and job.get("slowed") and not job.get("running")))
            left, by = own_time(row, store.get(key), now)
            row["left"], row["leftBy"] = left, by
            live.append(row)
            if job:
                owners.setdefault(job["key"], []).append(row)
    for key in [k for k, readings in store.items() if not readings or now - readings[-1][0] > FORGET_S]:
        del store[key]
    save(store_path, store)

    # Each Priority job takes as long as its longest row, then the throttle's order decides who waits for whom.
    own = [max((r["left"] for r in owners.get(job["key"], []) if r["left"] is not None), default=None) for job in jobs]
    ends = finish_times(own, (priority or {}).get("slots"))
    unknown_ahead = False
    for job, mine, end in zip(jobs, own, ends):
        job["left"] = end
        job["behindUnknown"] = bool(unknown_ahead and (priority or {}).get("slots") is not None)
        unknown_ahead = unknown_ahead or mine is None
        for row in owners.get(job["key"], []):
            if end is not None and row["left"] is not None:
                row["left"] += end - mine   # its wait in line
                row["behindUnknown"] = job["behindUnknown"]

    timed = [(r["name"], r["left"]) for r in live if r["left"] is not None]
    untimed = sum(r["left"] is None for r in live) + sum(job["key"] not in owners for job in jobs)   # a heavy job with no row of its own still counts
    if not timed and not untimed:
        return None
    long_haul = [name for name, left in timed if left > LONG_HAUL_S]
    counted = [left for _, left in timed if left <= LONG_HAUL_S]
    return {"left": max(counted, default=None), "timed": len(counted), "untimed": untimed, "longHaul": long_haul}
