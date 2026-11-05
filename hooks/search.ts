// Searches what was said in Claude tabs: the person's own messages and
// Claude's replies, not tool output or the reminders every tab carries (the
// memory index alone can name a word in every transcript). Run as
// `python3 -I -c SEARCH_PY <query> <days> <projects dir> <open ids>`; prints
// a JSON list of the tabs where every word of the query was said.
// Open tabs are always searched; others only if used in the last <days>.
export const SEARCH_PY = String.raw`
import json, os, re, sys, time

query, days, root, wanted = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4]
open_ids = set(one for one in wanted.split(',') if one)
phrases = re.findall(r'"([^"]+)"', query)
words = re.sub(r'"[^"]*"', ' ', query).split()
terms = [t.lower() for t in phrases + words if t.strip()]
if not terms:
    print('[]')
    sys.exit(0)
# Raw lines are checked as bytes first: far faster than decoding each one.
raw = [t.encode('utf-8') for t in terms]

since = time.time() - days * 86400
paths = {}
for project in os.listdir(root):
    folder = os.path.join(root, project)
    if not os.path.isdir(folder):
        continue
    for name in os.listdir(folder):
        if not name.endswith('.jsonl'):
            continue
        sid = name[:-6]
        path = os.path.join(folder, name)
        # Not open: recent, and not a throwaway run in a temp folder.
        recent = os.path.getmtime(path) >= since and not project.startswith(('-private-', '-tmp'))
        if sid in open_ids or recent:
            paths[sid] = path


def said(row):
    content = (row.get('message') or {}).get('content')
    if isinstance(content, str):
        return [content]
    out = []
    for block in content or []:
        if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
            out.append(block['text'])
    return out


def snip(text, term):
    flat = ' '.join(text.split())
    at = flat.lower().find(term)
    if at < 0:
        return flat[:160]
    start = max(0, at - 60)
    cut = flat[start:start + 160]
    return ('…' if start > 0 else '') + cut + ('…' if start + 160 < len(flat) else '')


found = []
for sid, path in paths.items():
    custom = made = cwd = ''
    seen = set()
    hits = 0
    best = None
    try:
        with open(path, 'rb') as handle:
            for line in handle:
                if b'-title"' in line:
                    try:
                        row = json.loads(line)
                        if row.get('type') == 'custom-title':
                            custom = row.get('customTitle') or custom
                        elif row.get('type') == 'ai-title':
                            made = row.get('aiTitle') or made
                    except ValueError:
                        pass
                    continue
                if not cwd and b'"cwd":"' in line:
                    m = re.search(rb'"cwd":"([^"]*)"', line)
                    cwd = m.group(1).decode('utf-8', 'replace') if m else ''
                low = line.lower()
                if not any(t in low for t in raw):
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                kind = row.get('type')
                if kind not in ('user', 'assistant') or row.get('isMeta') or row.get('isCompactSummary'):
                    continue
                for text in said(row):
                    # Machine notices, reminders and command echoes: nobody said those.
                    if kind == 'user' and text.lstrip().startswith('<'):
                        continue
                    lowered = text.lower()
                    here = [t for t in terms if t in lowered]
                    if not here:
                        continue
                    hits += sum(lowered.count(t) for t in here)
                    seen.update(here)
                    # Shown: the latest line with the most words, the person's own first.
                    rank = (len(here), kind == 'user')
                    if best is None or rank >= best[0]:
                        best = (rank, kind, text, here[0], row.get('timestamp') or '')
    except OSError:
        continue
    title = custom or made
    seen.update(t for t in terms if t in title.lower())
    if len(seen) < len(terms):
        continue
    entry = {
        'id': sid,
        'title': title,
        'cwd': cwd,
        'isOpen': sid in open_ids,
        'hits': hits,
        'modified': int(os.path.getmtime(path) * 1000),
        'who': '',
        'snippet': '',
    }
    if best is not None:
        entry['who'] = 'You' if best[1] == 'user' else 'Claude'
        entry['snippet'] = snip(best[2], best[3])
    found.append(entry)

# Most said first: the tab about it, not the one that mentions it in passing.
found.sort(key=lambda e: (-e['hits'], -e['modified']))
print(json.dumps(found[:40]))
`
