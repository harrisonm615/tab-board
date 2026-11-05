import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SearchHit, TabRecord, TabRow, TabSearch, TabState } from '../types'
import { SEARCH_PY } from './search'

// Every session writes its own state to ~/.claude/tab-board/<session id>.json
// and reads everyone else's, so each tab can show the whole board.

const PANE = 'tab-board'
const rows = atom({ plugin: 'tab-board', key: 'rows' } as const, [])
const NO_SEARCH: TabSearch = { query: '', status: 'idle', hits: [], error: '' }
const search = atom({ plugin: 'tab-board', key: 'search' } as const, NO_SEARCH)
// Tabs not open in VS Code are searched too, if used this many days back.
const SEARCH_DAYS = 7
const PYTHONS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']

const POLL_MS = 4000
const BEAT_MS = 30_000
const GONE_MS = 2 * 60_000 // no heartbeat this long: the tab was closed
const QUIET_MS = 12 * 60 * 60_000 // a tab waiting on you untouched this long has likely run its course
const EMPTY_MS = 10 * 60_000 // a tab never used this long can go
const JUDGE_V = 2
const SWEEP_MS = 3 * 24 * 60 * 60_000
const NOTIFY_END_MS = 30_000 // only ping a turn's end when it ran at least this long
const NOTIFIER = '/opt/homebrew/bin/terminal-notifier'
const OPEN_TABS_MS = 20_000
// Where VS Code keeps, per window, the Claude tabs it has open.
const WORKSPACES = 'Library/Application Support/Code/User/workspaceStorage'

const ORDER: Record<TabState, number> = { needs: 0, step: 1, finished: 2, working: 3, waiting: 4, idle: 5, closed: 6 }
const ICON: Record<TabState, string> = {
  needs: '●',
  step: '→',
  finished: '✓',
  working: '◐',
  waiting: '◌',
  idle: '·',
  closed: '·',
}
const LABEL: Record<TabState, string> = {
  needs: 'Needs you',
  step: 'Your move',
  finished: 'Ready to close',
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  closed: 'Closed',
}
const HEADING: Record<TabState, string> = {
  needs: 'Needs you now',
  step: 'Your move: Claude is waiting on you',
  finished: 'Ready to close: done, parked or gone quiet',
  working: 'Working',
  waiting: 'Waiting on background work',
  idle: 'Idle',
  closed: 'Closed',
}
const COLOR = {
  needs: 'error',
  step: 'warning',
  finished: 'success',
  working: 'suggestion',
  waiting: 'subtle',
  idle: 'inactive',
  closed: 'inactive',
} as const
// VS Code and the desktop app draw a bordered Box as a rounded card. Raw
// colors with some alpha tint it softly on light and dark themes alike.
const TINT: Record<TabState, { fill: string; line: string }> = {
  needs: { fill: '#e5484d1c', line: '#e5484d70' },
  step: { fill: '#f5a5241c', line: '#f5a52470' },
  finished: { fill: '#30a46c1a', line: '#30a46c66' },
  working: { fill: '#3b82f614', line: '#3b82f655' },
  waiting: { fill: '#8b5cf614', line: '#8b5cf655' },
  idle: { fill: '#80808010', line: '#80808038' },
  closed: { fill: '#80808010', line: '#80808038' },
}
const NOTE: Partial<Record<TabState, string>> = {
  needs: 'a question or approval is waiting',
  step: 'Claude is waiting on your answer',
  finished: 'open it, then press ⌘W',
  waiting: 'on background work',
}
const STRIP = { fill: '#80808014', line: '#80808014' }
const isGoneQuiet = (row: TabRow) => row.state === 'finished' && (row.why.startsWith('Quiet') || row.why === 'Empty')
const iconOf = (row: TabRow) => (isGoneQuiet(row) ? '○' : ICON[row.state])
const tintOf = (row: TabRow) => (isGoneQuiet(row) ? TINT.idle : row.why === 'Parked' ? TINT.working : TINT[row.state])
const whyColor = (row: TabRow) => (isGoneQuiet(row) ? COLOR.idle : row.why === 'Parked' ? COLOR.working : COLOR.finished)
// What a ready-to-close row says is left: a quiet tab's last ask of you.
const leftOf = (row: TabRow) => (isGoneQuiet(row) ? row.detail.replace(/^Next: /, 'was waiting on: ') : row.detail)

// Read by a small model at the end of each turn. Tried on 25 real tabs, Nov 3.
const JUDGE = `You look at one of several Claude Code chat tabs a person keeps open side by side and sort it, so they know which tabs they can close.

done: what the person asked for is done. Nothing is pending from Claude; at most it offers optional extras ("want me to also…", "I can…", "if you want…").
parked: nothing more happens in this tab until the person does something on their own, somewhere else or later: buy or set something up, try it on another device or at another place, send drafts from Gmail, post replies, pick a plan, or the work was put off for another day. The tab can close; the rest is theirs.
waiting: the job goes on in this tab and needs the person's reply: Claude asked a question or for a choice it needs to carry on, waits for a yes before doing the main part, or the work is not shipped, not live or half done and Claude will finish it once they answer.

Answer with JSON only: {"kind":"done" or "parked" or "waiting","note":"3 to 8 plain words. For done, what got done. For parked, what is left to them. For waiting, what to answer or do next."}`

// The same call made by eye, used until the model answers or when it cannot.
const STEP_SIGNS =
  /\b(want me to|should i|shall i|let me know|once you|when you're ready|next step|then i'll|waiting (on|for) you|you('ll| will) need to|paste (this|the)|run (this|the)|not (yet )?(shipped|live|done|loaded|running|applied)|still (needs|to do)|blocked)\b/i

type Engine = EngineInterface
/** `tag` heads the detail line: Next (waiting on you), Done, or Parked (the rest is yours). */
type Verdict = { kind: 'step' | 'finished'; tag: 'Next' | 'Done' | 'Parked'; note: string }
/** What a tab's transcript says happened last, and what the person last asked. */
type Snapshot = { cwd: string; reply: string; asked: string; at: number; ending: 'reply' | 'unanswered' | 'mid-task' | 'empty' }

let dir = ''
let home = ''
let openTabs: Map<string, string> | undefined
let openTabsAt = 0
let isLeader = false
let isBackfilling = false
const checked = new Set<string>()
const NO_MESSAGES = 'No messages yet'
let me: TabRecord | undefined
let transcript = ''
let title = ''
let firstPrompt = ''
let lastAsk = ''
let background = 0
let asking = 0
let notified = ''
let shown = ''
let writes: Promise<unknown> = Promise.resolve()

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/^[#>*\-\s]+/, '').replace(/[*`]/g, '').trim())
    .find(line => line !== '') ?? ''

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const serverName = (name: string) => {
  const plain = name.replace(/^claude_ai_/, '').replace(/^claude-in-/, '').replace(/[_-]+/g, ' ')
  return plain.charAt(0).toUpperCase() + plain.slice(1)
}

const describe = (tool: string, input: unknown): string => {
  const args = (input ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return `Running: ${text('description') || text('command')}`
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return `Editing ${baseName(text('file_path'))}`
    case 'NotebookEdit':
      return `Editing ${baseName(text('notebook_path'))}`
    case 'Read':
      return `Reading ${baseName(text('file_path'))}`
    case 'Grep':
    case 'Glob':
      return `Searching for ${text('pattern')}`
    case 'Agent':
    case 'Task':
      return `Agent: ${text('description')}`
    case 'WebFetch':
      return `Reading ${text('url')}`
    case 'WebSearch':
      return `Searching the web: ${text('query')}`
    case 'Skill':
      return `Using ${text('skill')}`
    case 'ToolSearch':
      return 'Loading tools'
    case 'TodoWrite':
      return 'Updating its to-do list'
    case 'AskUserQuestion': {
      const first = Array.isArray(args.questions) ? (args.questions[0] as { question?: unknown }) : undefined
      return `Question: ${typeof first?.question === 'string' ? first.question : 'waiting for your answer'}`
    }
    case 'ExitPlanMode':
      return 'Plan ready for your OK'
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return `${serverName(server)}: ${name.replace(/_/g, ' ')}`
  }
  return tool
}

const age = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

const readJson = async <T,>($: Engine, path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return undefined
  }
}

// Writes are queued so a slow one never lands after a newer one. `onlyIf`
// is checked when the write's turn comes, so a late verdict cannot overwrite
// a turn that started in the meantime.
const save = ($: Engine, patch: Partial<TabRecord>, onlyIf?: (record: TabRecord) => boolean) => {
  writes = writes
    .then(async () => {
      if (me === undefined || (onlyIf !== undefined && !onlyIf(me))) return
      const now = await $.clock.now()
      const isNewState = patch.state !== undefined && patch.state !== me.state
      me = {
        ...me,
        ...patch,
        title: title || clip(firstPrompt, 60) || me.title,
        since: patch.since ?? (isNewState ? now : me.since),
        beat: now,
      }
      await $.fs.write(`${dir}/${me.id}.json`, JSON.stringify(me))
    })
    .catch(() => undefined)
  return writes
}

// The name the VS Code tab shows: the one you gave it, else the one Claude made.
const titleOf = async ($: Engine, path: string) => {
  try {
    const { stdout } = await $.process.run(['grep', '-E', '"type":"(custom-title|ai-title)"', path])
    let custom = ''
    let made = ''
    for (const line of stdout.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line) as { customTitle?: unknown; aiTitle?: unknown }
        if (typeof row.customTitle === 'string') custom = row.customTitle
        if (typeof row.aiTitle === 'string') made = row.aiTitle
      } catch {
        // a line cut short
      }
    }
    return clip(custom || made, 60)
  } catch {
    return ''
  }
}

const readTitle = async ($: Engine) => {
  if (transcript === '') return
  const found = await titleOf($, transcript)
  if (found !== '') title = found
}

type Row = {
  type?: string
  isMeta?: boolean
  cwd?: string
  timestamp?: string
  message?: { content?: unknown }
}
type Block = { type?: string; text?: unknown }

// Reads the end of a transcript, newest line first, for how the tab was left
// and, above the last reply, what the person last typed.
const snapshot = async ($: Engine, path: string): Promise<Snapshot> => {
  const empty: Snapshot = { cwd: '', reply: '', asked: '', at: 0, ending: 'empty' }
  let found: Snapshot | undefined
  const { stdout } = await $.process.run(['tail', '-c', '1500000', path]).catch(() => ({ stdout: '' }))
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let row: Row
    try {
      row = JSON.parse(lines[i] ?? '') as Row
    } catch {
      continue
    }
    if (row.isMeta === true) continue
    const content = row.message?.content
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : []
    const at = row.timestamp ? Date.parse(row.timestamp) : 0
    if (row.type === 'assistant') {
      if (found !== undefined) continue
      const text = blocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .join('\n')
      if (text.trim() !== '') found = { cwd: row.cwd ?? '', reply: text, asked: '', at, ending: 'reply' }
      else if (blocks.some(block => block.type === 'tool_use')) return { ...empty, cwd: row.cwd ?? '', at, ending: 'mid-task' }
      continue
    }
    if (row.type === 'user') {
      const typed =
        typeof content === 'string'
          ? content
          : blocks.find(block => block.type === 'text' && typeof block.text === 'string')?.text
      // A prompt the person typed, not a tool's result or a machine notice.
      if (typeof typed === 'string' && typed.trim() !== '' && !typed.trimStart().startsWith('<')) {
        return found !== undefined ? { ...found, asked: typed } : { ...empty, cwd: row.cwd ?? '', at, ending: 'unanswered' }
      }
    }
  }
  return found ?? empty
}

// How a tab that is not mid-turn reads, from its transcript.
const fromSnapshot = (shot: Snapshot): Pick<TabRecord, 'state' | 'detail'> => {
  switch (shot.ending) {
    case 'reply':
      return { state: guess(shot.reply).kind, detail: clip(firstLine(shot.reply), 160) || 'Finished' }
    case 'unanswered':
      return { state: 'idle', detail: 'Your last message has no reply yet' }
    case 'mid-task':
      return { state: 'idle', detail: 'Stopped partway through' }
    case 'empty':
      return { state: 'idle', detail: NO_MESSAGES }
  }
}

// A /clear gives the session a new id with no new session.start. A tab that
// restarts (a VS Code reload) picks up where its record or transcript left off.
const begin = async ($: Engine) => {
  const id = await $.session.id()
  if (me?.id === id) return
  const cwd = await $.session.cwd()
  transcript = `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  title = ''
  firstPrompt = ''
  lastAsk = ''
  background = 0
  asking = 0
  const prior = await readJson<TabRecord>($, `${dir}/${id}.json`)
  const shot = await snapshot($, transcript)
  // A placeholder ("no messages yet") never outranks a transcript that has some.
  const isPlaceholder = prior?.detail === NO_MESSAGES && shot.ending !== 'empty'
  const isPriorCurrent = prior !== undefined && prior.state !== 'closed' && !isPlaceholder && prior.since >= shot.at
  if (isPriorCurrent) {
    const wasBusy = prior.state === 'working' || prior.state === 'needs' || prior.state === 'waiting'
    me = wasBusy ? { ...prior, state: 'idle', detail: 'Stopped when the tab restarted' } : prior
  } else {
    me = { id, title: '', cwd, ...fromSnapshot(shot), since: shot.at || (await $.clock.now()) }
  }
  await readTitle($)
  await save($, {})
  const isOldVerdict = me.v !== JUDGE_V && (me.state === 'step' || me.state === 'finished')
  if (shot.ending === 'reply' && (!isPriorCurrent || isOldVerdict)) {
    const since = me.since
    const summary = isPriorCurrent ? clip(firstLine(shot.reply), 160) || 'Finished' : me.detail
    const { reply, asked } = shot
    // Asked again, the tab keeps its time: it did nothing new.
    const isAgain = isPriorCurrent
    $.clock.after(0, () => void settle($, reply, summary, since, false, asked, isAgain).catch(() => undefined))
  }
}

const DONE = /^(Done|Parked): /

// How a record shows: a finished tab says why it can close, and one left
// waiting or idle a long while, or never used, joins it. Kept or cleared
// (seen at this `since`), a tab rests as idle until it changes.
const shownState = (record: TabRecord, seen: Record<string, number>, now: number): Pick<TabRow, 'state' | 'detail' | 'why'> => {
  const state: TabState = (record.state as string) === 'done' ? 'step' : record.state
  const { detail } = record
  const isRestful = state === 'step' || state === 'finished' || state === 'idle'
  if (isRestful && seen[record.id] === record.since) return { state: 'idle', detail, why: '' }
  if (state === 'finished') {
    const tag = DONE.exec(detail)?.[1] ?? 'Done'
    return { state, detail: detail.replace(DONE, ''), why: tag }
  }
  const quiet = now - record.since
  if ((state === 'step' || state === 'idle') && quiet >= QUIET_MS) return { state: 'finished', detail, why: `Quiet ${age(quiet)}` }
  if (state === 'idle' && detail === NO_MESSAGES && quiet >= EMPTY_MS) return { state: 'finished', detail: 'Nothing was asked here', why: 'Empty' }
  return { state, detail, why: '' }
}

// The Claude tabs VS Code has open in any window used in the last two days,
// running or not; undefined when it cannot tell (no VS Code, no sqlite3).
const readOpenTabs = async ($: Engine): Promise<Map<string, string> | undefined> => {
  const script =
    'for f in "$1"/*/state.vscdb; do ' +
    'find "$f" -mmin -2880 2>/dev/null | grep -q . && ' +
    'sqlite3 -readonly "$f" "select value from ItemTable where key=\'Anthropic.claude-code\'" 2>/dev/null; ' +
    'done; true'
  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', script, 'sh', `${home}/${WORKSPACES}`])
    const tabs = new Map<string, string>()
    for (const line of stdout.split('\n')) {
      try {
        const state = JSON.parse(line) as { panelTabSessions?: { sessionId?: unknown; title?: unknown }[] }
        for (const tab of state.panelTabSessions ?? []) {
          if (typeof tab.sessionId === 'string') tabs.set(tab.sessionId, typeof tab.title === 'string' ? tab.title : '')
        }
      } catch {
        // not this line
      }
    }
    return tabs.size > 0 ? tabs : undefined
  } catch {
    return undefined
  }
}

// A tab VS Code has open but has not started since it reloaded gets its state
// from its transcript, once, by whichever running tab leads (the lowest id);
// so does one not running whose verdict an older judge wrote.
const backfill = async ($: Engine, missing: string[]) => {
  const id = missing.find(one => !checked.has(one))
  if (!isLeader || isBackfilling || id === undefined) return
  isBackfilling = true
  checked.add(id)
  try {
    const { stdout } = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
    const path = stdout.split('\n')[0] ?? ''
    const shot = path === '' ? undefined : await snapshot($, path)
    const prior = await readJson<TabRecord>($, `${dir}/${id}.json`)
    const at = shot?.at || (await $.clock.now())
    const record: TabRecord = {
      id,
      title: (path === '' ? '' : await titleOf($, path)) || prior?.title || openTabs?.get(id) || '',
      cwd: shot?.cwd || prior?.cwd || '',
      ...(shot === undefined ? { state: 'idle' as const, detail: NO_MESSAGES } : fromSnapshot(shot)),
      // Asked again, a tab keeps its time, so a Keep or Clear on it still holds.
      since: prior !== undefined && prior.since >= at ? prior.since : at,
    }
    const isAgain = prior !== undefined && prior.detail !== NO_MESSAGES
    if (!isAgain) await $.fs.write(`${dir}/${id}.json`, JSON.stringify(record))
    if (shot?.ending === 'reply') {
      const verdict = await judge($, shot.reply, record.title, shot.asked).catch(() => undefined)
      const now = await readJson<TabRecord>($, `${dir}/${id}.json`)
      // Write the verdict only if the tab has not started and moved on meanwhile.
      const expected = isAgain ? prior : record
      if (verdict !== undefined && now?.since === expected.since && now?.beat === expected.beat) {
        await $.fs.write(
          `${dir}/${id}.json`,
          JSON.stringify({ ...record, state: verdict.kind, detail: endDetail(verdict, record.detail), v: JUDGE_V }),
        )
      }
    }
  } finally {
    isBackfilling = false
  }
}

const refresh = async ($: Engine) => {
  if (dir === '') return
  const now = await $.clock.now()
  if (now - openTabsAt > OPEN_TABS_MS) {
    openTabsAt = now
    openTabs = await readOpenTabs($)
  }
  const entries = await $.fs.list(dir).catch(() => [])
  const seen = (await readJson<Record<string, number>>($, `${dir}/seen.json`)) ?? {}
  const records: TabRecord[] = me === undefined ? [] : [me]
  const live = new Set(me === undefined ? [] : [me.id])
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === 'seen.json') continue
    const id = entry.name.slice(0, -'.json'.length)
    const isOpen = openTabs?.has(id) === true
    if (id === me?.id || !(isOpen || now - entry.mtimeMs <= GONE_MS)) continue
    const record = await readJson<TabRecord>($, `${dir}/${entry.name}`)
    if (record === undefined) continue
    // Only a running tab beats; a record another tab filled in for it does not.
    const isLive = now - (record.beat ?? 0) <= GONE_MS
    if (!isLive && !isOpen) continue
    if (isLive) live.add(id)
    // A tab that stopped mid-turn (VS Code reloaded, the tab closed) is not still working.
    const isStale = !isLive && (record.state === 'working' || record.state === 'needs' || record.state === 'waiting')
    records.push(isStale ? { ...record, state: 'idle', detail: 'Stopped when the tab restarted' } : record)
  }
  isLeader = me !== undefined && [...live].sort()[0] === me.id
  // Open tabs with nothing useful on record: none, closed, or a placeholder no running tab owns.
  const known = new Set(
    records
      .filter(record => record.state !== 'closed' && !(record.beat === undefined && record.detail === NO_MESSAGES))
      .map(record => record.id),
  )
  const missing = [...(openTabs?.keys() ?? [])].filter(id => !known.has(id))
  const oldVerdicts = records
    .filter(record => !live.has(record.id) && (record.state === 'step' || record.state === 'finished') && record.v !== JUDGE_V)
    .map(record => record.id)
  const list: TabRow[] = []
  for (const record of records) {
    if (record.state === 'closed') continue
    list.push({
      id: record.id,
      title: record.title || openTabs?.get(record.id) || 'New tab',
      project: baseName(record.cwd),
      ...shownState(record, seen, now),
      age: age(now - record.since),
      since: record.since,
      isMine: record.id === me?.id,
    })
  }
  for (const id of missing) {
    if (records.some(record => record.id === id && record.state !== 'closed')) continue
    list.push({
      id,
      title: openTabs?.get(id) || 'Claude tab',
      project: '',
      state: 'idle',
      detail: 'Checking where this tab left off…',
      why: '',
      age: '',
      since: 0,
      isMine: false,
    })
  }
  if (missing.length + oldVerdicts.length > 0) void backfill($, [...missing, ...oldVerdicts]).catch(() => undefined)
  list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.since - a.since)
  const json = JSON.stringify(list)
  if (json === shown) return
  shown = json
  await update($, rows, () => list)
}

const markSeen = async ($: Engine, row: TabRow) => {
  const seen = (await readJson<Record<string, number>>($, `${dir}/seen.json`)) ?? {}
  seen[row.id] = row.since
  const kept = Object.entries(seen).slice(-200)
  await $.fs.write(`${dir}/seen.json`, JSON.stringify(Object.fromEntries(kept)))
}

const sessionUrl = (id: string) => `vscode://anthropic.claude-code/open?session=${id}`

const jump = async ($: Engine, row: TabRow) => {
  if (!row.isMine) await $.process.run(['open', sessionUrl(row.id)])
}

const clear = async ($: Engine, row: TabRow) => {
  await markSeen($, row)
  await refresh($)
}

const openBoard = async ($: Engine, isSearch = false) => {
  await refresh($)
  await $.ui.open(isSearch ? { id: PANE, title: 'All tabs', focus: true } : { id: PANE, title: 'All tabs' })
}

let searches = 0

// Finds the tabs where the words were said, by the person or by Claude, even
// when the tab's name says nothing of them. Every open tab, plus the chats of
// the last week that are not open, since Open brings those back too.
const runSearch = async ($: Engine, typed: string) => {
  const query = typed.trim()
  const ticket = (searches += 1)
  if (query === '') {
    await update($, search, () => NO_SEARCH)
    return
  }
  await update($, search, (): TabSearch => ({ query, status: 'searching', hits: [], error: '' }))
  const isCurrent = () => ticket === searches
  try {
    if (openTabs === undefined) openTabs = await readOpenTabs($)
    const board = await read($, rows)
    const open = new Set([...(openTabs?.keys() ?? []), ...board.map(row => row.id)])
    let python = 'python3'
    for (const path of PYTHONS) {
      if (await $.fs.exists(path)) {
        python = path
        break
      }
    }
    const { stdout, stderr, exitCode } = await $.process.run([
      python, '-I', '-c', SEARCH_PY,
      query, String(SEARCH_DAYS), `${home}/.claude/projects`, [...open].join(','),
    ])
    if (exitCode !== 0) throw new Error(firstLine(stderr.split('\n').filter(Boolean).pop() ?? '') || `python3 stopped (${exitCode})`)
    type Found = { id: string; title: string; cwd: string; isOpen: boolean; hits: number; modified: number; who: string; snippet: string }
    const found = JSON.parse(stdout) as Found[]
    const now = await $.clock.now()
    const titles = new Map(board.map(row => [row.id, row.title]))
    const hits: SearchHit[] = found.map(one => ({
      id: one.id,
      title: one.title || titles.get(one.id) || openTabs?.get(one.id) || 'Claude tab',
      project: baseName(one.cwd),
      isOpen: one.isOpen,
      isMine: one.id === me?.id,
      hits: one.hits,
      who: one.who,
      snippet: one.snippet,
      age: age(now - one.modified),
    }))
    if (isCurrent()) await update($, search, (): TabSearch => ({ query, status: 'done', hits, error: '' }))
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    if (isCurrent()) await update($, search, (): TabSearch => ({ query, status: 'failed', hits: [], error: clip(why, 160) }))
  }
}

const openHit = async ($: Engine, hit: SearchHit) => {
  if (!hit.isMine) await $.process.run(['open', sessionUrl(hit.id)])
}

const mentions = (hit: SearchHit) => (hit.hits === 0 ? 'in its name' : `said ${hit.hits === 1 ? 'once' : `${hit.hits} times`}`)

// A macOS notification; clicking it jumps to the tab.
const notify = async ($: Engine, heading: string, message: string) => {
  if (me === undefined) return
  const key = `${me.id}:${me.state}:${me.since}`
  if (key === notified) return
  notified = key
  const name = me.title || 'Claude'
  const body = `​${clip(message || heading, 180)}`
  const sound = me.state === 'needs' ? 'Ping' : me.state === 'step' ? 'Glass' : 'Purr'
  try {
    // terminal-notifier makes the notification a link to the tab; it fails
    // until macOS allows it to notify, and then AppleScript stands in.
    const linked = (await $.fs.exists(NOTIFIER))
      ? await $.process.run([
          NOTIFIER,
          '-title', name,
          '-subtitle', heading,
          '-message', body,
          '-open', sessionUrl(me.id),
          '-group', `tab-board-${me.id}`,
          '-sound', sound,
        ])
      : undefined
    if (linked?.exitCode !== 0) {
      const quote = (text: string) => JSON.stringify(text)
      await $.process.run([
        'osascript',
        '-e',
        `display notification ${quote(body)} with title ${quote(name)} subtitle ${quote(heading)} sound name ${quote(sound)}`,
      ])
    }
  } catch {
    // a missed notification is not worth failing a hook over
  }
}

const needsYou = async ($: Engine, detail: string) => {
  await save($, { state: 'needs', detail: clip(detail, 160) })
  await refresh($)
  await notify($, 'Needs you', detail)
}

const guess = (answer: string): Verdict =>
  answer.slice(-400).includes('?') || STEP_SIGNS.test(answer)
    ? { kind: 'step', tag: 'Next', note: '' }
    : { kind: 'finished', tag: 'Done', note: '' }

const KINDS: Record<string, Verdict['kind']> = { done: 'finished', parked: 'finished', waiting: 'step', finished: 'finished', step: 'step' }
const TAGS: Record<string, Verdict['tag']> = { done: 'Done', parked: 'Parked', waiting: 'Next', finished: 'Done', step: 'Next' }

const judge = async ($: Engine, answer: string, name = me?.title ?? '', asked = ''): Promise<Verdict | undefined> => {
  const text = answer.length > 4000 ? `${answer.slice(0, 800)}\n…\n${answer.slice(-3000)}` : answer
  const ask = asked.trim() === '' ? '' : `The person last asked:\n<ask>\n${clip(asked, 1500)}\n</ask>\n\n`
  const reply = await $.model.complete({
    model: 'haiku',
    system: JUDGE,
    prompt: `Tab: ${name || 'untitled'}\n\n${ask}Claude's last message:\n<message>\n${text}\n</message>`,
    maxTokens: 120,
    timeoutMs: 20_000,
  })
  if (!reply.isAnswered) return undefined
  try {
    const parsed = JSON.parse(reply.text.match(/\{[\s\S]*\}/)?.[0] ?? '') as { kind?: unknown; note?: unknown; next?: unknown }
    const kind = typeof parsed.kind === 'string' ? parsed.kind : ''
    const note = typeof parsed.note === 'string' ? parsed.note : typeof parsed.next === 'string' ? parsed.next : ''
    const isKnown = Object.hasOwn(KINDS, kind)
    return isKnown ? { kind: KINDS[kind] ?? 'step', tag: TAGS[kind] ?? 'Next', note: clip(note, 80) } : undefined
  } catch {
    return undefined
  }
}

const endDetail = (verdict: Verdict, summary: string) =>
  verdict.note !== '' ? `${verdict.tag}: ${verdict.note}` : summary

// After a turn: the model's verdict replaces the guess, then the notification.
const settle = async (
  $: Engine,
  answer: string,
  summary: string,
  since: number,
  isLong: boolean,
  asked: string,
  isAgain = false,
) => {
  const verdict = await judge($, answer, me?.title ?? '', asked).catch(() => undefined)
  const isSameTurn = (record: TabRecord) => record.since === since
  if (verdict !== undefined) {
    const patch: Partial<TabRecord> = { state: verdict.kind, detail: endDetail(verdict, summary), v: JUDGE_V }
    await save($, isAgain ? { ...patch, since } : patch, isSameTurn)
  }
  await readTitle($)
  await save($, {})
  await refresh($)
  if (isLong && me !== undefined && (me.state === 'step' || me.state === 'finished')) {
    await notify($, me.state === 'step' ? 'Your move' : 'Ready to close', me.detail)
  }
}

const sweep = async ($: Engine) => {
  const now = await $.clock.now()
  const old = (await $.fs.list(dir).catch(() => []))
    .filter(entry => entry.kind === 'file' && entry.name !== 'seen.json' && now - entry.mtimeMs > SWEEP_MS)
    .map(entry => `${dir}/${entry.name}`)
  if (old.length > 0) await $.process.run(['rm', '-f', ...old])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      home = (await $.env.get('HOME')) ?? ''
      dir = `${home}/.claude/tab-board`
      await $.command.register({
        name: 'tabs',
        description: 'Show every Claude tab: what needs you, what is ready to close, what is working. Add words to find the tab where they were said',
        argumentHint: '[words to find]',
      })
      await begin($)
      await sweep($)
      await refresh($)
      $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
      $.clock.every(BEAT_MS, () => void save($, {}))
    } catch {
      // the board is a nicety; never hold up the session for it
    }
    return next(e)
  })

  on('command.run', { command: 'tabs' }, async ($, e) => {
    const words = e.args.trim()
    if (words === '') {
      await update($, search, () => NO_SEARCH)
      await openBoard($, true)
      return { text: 'Opened the tab board. Type in its search box to find a tab by what was said in it.' }
    }
    await openBoard($)
    await runSearch($, words)
    const { status, hits } = await read($, search)
    if (status === 'failed') return { text: `Could not search the tabs for “${words}”.` }
    return {
      text:
        hits.length === 0
          ? `No tab mentions “${words}”.`
          : `${hits.length === 1 ? '1 tab mentions' : `${hits.length} tabs mention`} “${words}”; see the tab board.`,
    }
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) transcript = e.transcript_path
    if (e.session_title) title = clip(e.session_title, 60)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) transcript = e.transcript_path
    if (e.session_title) title = clip(e.session_title, 60)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      await begin($)
      const isTyped = e.text.trim() !== '' && !e.text.trimStart().startsWith('<')
      if (isTyped) lastAsk = e.text
      if (firstPrompt === '' && isTyped) firstPrompt = e.text
      background = 0
      asking = 0
      await save($, { state: 'working', detail: 'Thinking…' })
      await refresh($)
    } catch {
      // keep going
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isMain = e.agentId === undefined
    const isAsk = isMain && (tool === 'AskUserQuestion' || tool === 'ExitPlanMode')
    if (isAsk) {
      asking += 1
      await needsYou($, describe(tool, e))
    } else if (isMain && me?.state !== 'needs') {
      await save($, { state: 'working', detail: clip(describe(tool, e), 160) })
    }
    const result = await next(e)
    if (isAsk) asking = Math.max(0, asking - 1)
    // An approved permission or an answered question: back to work.
    if (asking === 0 && me?.state === 'needs') {
      await save($, { state: 'working', detail: 'Working…' })
      await refresh($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await needsYou($, `Approve: ${describe(e.tool_name, e.tool_input)}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/.test(e.notification_type) && me?.state !== 'needs') {
      await needsYou($, e.message)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path) transcript = e.transcript_path
    background = e.background_tasks?.length ?? 0
    if (background > 0 && (me?.state === 'step' || me?.state === 'finished')) {
      await save($, { state: 'waiting', detail: `${background} background task${background === 1 ? '' : 's'} running` })
      await refresh($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      if (e.reason === 'answer') {
        const summary = clip(firstLine(e.answer), 160) || 'Finished'
        if (background > 0) {
          await save($, { state: 'waiting', detail: `${background} background task${background === 1 ? '' : 's'} running · ${summary}` })
        } else {
          // Show the guess now; the model's verdict follows a moment later.
          await save($, { state: guess(e.answer).kind, detail: summary })
          const since = me?.since ?? 0
          const answer = e.answer
          const isLong = e.durationMs >= NOTIFY_END_MS
          const asked = lastAsk
          $.clock.after(0, () => void settle($, answer, summary, since, isLong, asked).catch(() => undefined))
        }
      } else if (e.reason === 'aborted') {
        await save($, { state: 'idle', detail: 'Stopped' })
      } else {
        await needsYou($, 'Stopped on an error')
      }
      await refresh($)
    } catch {
      // keep going
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await save($, { state: 'closed', detail: '' })
      me = undefined
    } else if (me?.state === 'working' || me?.state === 'needs' || me?.state === 'waiting') {
      await save($, { state: 'idle', detail: 'Stopped when the tab closed' })
    }
    return next(e)
  })

  // One line above the prompt: the other tabs that want you, and how many are busy.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, rows)
    const others = list.filter(row => !row.isMine)
    const hot = others.filter(row => row.state === 'needs' || row.state === 'step')
    const finished = others.filter(row => row.state === 'finished').length
    const busy = others.filter(row => row.state === 'working' || row.state === 'waiting').length
    if (e.props.hasSurvey || others.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const first = hot.slice(0, 3)

    // The editor draws every Button as a button, so the band is a soft strip of
    // outlined chips there; the terminal keeps its plain line.
    if (e.surface !== 'terminal') {
      return (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          alignItems="center"
          columnGap={1}
          borderStyle="round"
          borderColor={STRIP.line}
          backgroundColor={STRIP.fill}
          paddingX={1}
        >
          {first.map(row => (
            <Button key={`go-${row.id}`} dimColor onPress={() => jump($, row)}>
              <Text bold color={COLOR[row.state]}>
                {ICON[row.state]} {LABEL[row.state]}
              </Text>
              {`  ${clip(row.title, 28)}`}
            </Button>
          ))}
          {hot.length > first.length && <Text dimColor>+{hot.length - first.length} more</Text>}
          {hot.length === 0 && <Text dimColor>Nothing needs you in your other tabs</Text>}
          <Box flexGrow={1} />
          {finished > 0 && <Text color={COLOR.finished}>✓ {finished} ready to close</Text>}
          {busy > 0 && <Text color={COLOR.working}>◐ {busy} working</Text>}
          <Button key="search-tabs" dimColor label="Search" onPress={() => openBoard($, true)} />
          <Button key="all-tabs" dimColor label={`All tabs (${others.length + 1})`} onPress={() => openBoard($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {first.map(row => (
          <Button key={`go-${row.id}`} plain onPress={() => jump($, row)}>
            <Text color={COLOR[row.state]}>
              {ICON[row.state]} {LABEL[row.state]}
            </Text>
            {` ${clip(row.title, 32)}`}
          </Button>
        ))}
        {hot.length > first.length && <Text dimColor>+{hot.length - first.length} more</Text>}
        {finished > 0 && <Text color="success">✓ {finished} ready to close</Text>}
        {busy > 0 && <Text dimColor>{busy} working</Text>}
        <Button key="all-tabs" plain label={`All tabs (${others.length + 1})`} onPress={() => openBoard($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, rows)
    const found = await read($, search)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const room = Math.max(20, (e.props.bodyColumns ?? 60) - 14)

    // The search box heads the pane; once it has searched, what it found takes the board's place.
    const searchBox = Input !== undefined && (
      <Input
        key="search"
        placeholder="Find a tab by what was said in it, like payroll"
        submitLabel="search"
        value={found.query}
        autoFocus
        onSubmit={value => void runSearch($, value)}
        onInput={value => {
          if (value.trim() === '' && found.status !== 'idle') void runSearch($, '')
        }}
      />
    )

    if (found.status !== 'idle') {
      const said = `“${found.query}”`
      const heading =
        found.status === 'searching'
          ? `Searching every tab for ${said}…`
          : found.status === 'failed'
            ? `Could not search: ${found.error}`
            : found.hits.length === 0
              ? `No tab mentions ${said}, open or from the last ${SEARCH_DAYS} days`
              : `${found.hits.length === 1 ? '1 tab mentions' : `${found.hits.length} tabs mention`} ${said}${found.hits.length === 1 ? '' : ', most first'}`
      const meta = (hit: SearchHit) =>
        [hit.project, hit.age, mentions(hit), hit.isOpen ? '' : 'not open'].filter(part => part !== '').join(' · ')
      const top = (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
          <Text bold color={found.status === 'failed' ? COLOR.needs : undefined}>
            {heading}
          </Text>
          <Box flexGrow={1} />
          <Button key="search-back" {...(e.surface === 'terminal' ? { plain: true } : { dimColor: true })} label="Back to all tabs" onPress={() => runSearch($, '')} />
        </Box>
      )
      const hasClosed = found.hits.some(hit => !hit.isOpen)

      if (e.surface !== 'terminal') {
        return (
          <Box flexDirection="column" rowGap={1}>
            {searchBox}
            {top}
            <Box flexDirection="column" rowGap={0.5}>
              {found.hits.map(hit => (
                <Box
                  key={`hit-${hit.id}`}
                  flexDirection="row"
                  flexWrap="nowrap"
                  alignItems="center"
                  columnGap={2}
                  borderStyle="round"
                  borderColor={(hit.isOpen ? TINT.working : TINT.idle).line}
                  backgroundColor={(hit.isOpen ? TINT.working : TINT.idle).fill}
                  paddingX={1}
                >
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Box flexDirection="row" flexWrap="nowrap" columnGap={1}>
                      <Text bold wrap="truncate-end">
                        {hit.title}
                      </Text>
                      <Text dimColor wrap="truncate-end">
                        {meta(hit)}
                      </Text>
                    </Box>
                    {hit.snippet !== '' && (
                      <Text>
                        <Text bold color={hit.who === 'You' ? COLOR.step : COLOR.working}>
                          {hit.who}
                        </Text>
                        {`  ${hit.snippet}`}
                      </Text>
                    )}
                  </Box>
                  {hit.isMine ? (
                    <Text dimColor italic>
                      this tab
                    </Text>
                  ) : (
                    <Button key={`found-${hit.id}`} dimColor label="Open" onPress={() => openHit($, hit)} />
                  )}
                </Box>
              ))}
            </Box>
            {hasClosed && <Text dimColor>A tab that is not open comes back when you press Open.</Text>}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" rowGap={1}>
          {searchBox}
          {top}
          {found.hits.map(hit => (
            <Box key={`hit-${hit.id}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                {hit.isMine ? (
                  <Text>{clip(hit.title, room)} (this tab)</Text>
                ) : (
                  <Button key={`found-${hit.id}`} plain onPress={() => openHit($, hit)}>
                    {clip(hit.title, room)}
                  </Button>
                )}
                <Text dimColor>{meta(hit)}</Text>
              </Box>
              {hit.snippet !== '' && (
                <Text dimColor wrap="truncate-end">
                  {`  ${hit.who}: ${hit.snippet}`}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {searchBox}
          <Text dimColor>No Claude tabs open.</Text>
        </Box>
      )
    }

    const groups = (['needs', 'step', 'finished', 'working', 'waiting', 'idle'] as const)
      .map(state => ({ state, items: list.filter(row => row.state === state) }))
      .filter(group => group.items.length > 0)

    if (e.surface !== 'terminal') {
      const meta = (row: TabRow) => [row.project, row.age].filter(part => part !== '').join(' · ')
      const actions = (row: TabRow) => (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1} flexShrink={0}>
          {row.isMine ? (
            <Text dimColor italic>
              this tab
            </Text>
          ) : (
            <Button key={`open-${row.id}`} dimColor label="Open" onPress={() => jump($, row)} />
          )}
          {(row.state === 'step' || row.state === 'finished') && (
            <Button
              key={`clear-${row.id}`}
              dimColor
              label={row.state === 'finished' ? 'Keep' : 'Clear'}
              onPress={() => clear($, row)}
            />
          )}
        </Box>
      )
      const detail = (row: TabRow) =>
        row.state === 'finished' ? (
          <Text>
            <Text bold color={whyColor(row)}>
              {row.why}
            </Text>
            {`  ${leftOf(row)}`}
          </Text>
        ) : row.state === 'step' && row.detail.startsWith('Next: ') ? (
          <Text>
            <Text bold color={COLOR.step}>
              Next
            </Text>
            {`  ${row.detail.slice('Next: '.length)}`}
          </Text>
        ) : (
          <Text dimColor={row.state !== 'needs'}>{row.detail}</Text>
        )
      // A tab that wants something gets a card of its own, tinted by its state.
      const card = (row: TabRow) => (
        <Box
          key={`row-${row.id}`}
          flexDirection="row"
          flexWrap="nowrap"
          alignItems="center"
          columnGap={2}
          borderStyle="round"
          borderColor={tintOf(row).line}
          backgroundColor={tintOf(row).fill}
          paddingX={1}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" flexWrap="nowrap" columnGap={1}>
              <Text color={row.state === 'finished' ? whyColor(row) : COLOR[row.state]}>{iconOf(row)}</Text>
              <Text bold wrap="truncate-end">
                {row.title}
              </Text>
              <Text dimColor wrap="truncate-end">
                {meta(row)}
              </Text>
            </Box>
            {(row.detail !== '' || row.why !== '') && detail(row)}
          </Box>
          {actions(row)}
        </Box>
      )
      // The rest share one card, a line each.
      const line = (row: TabRow) => (
        <Box key={`row-${row.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1}>
          <Text color={COLOR[row.state]}>{ICON[row.state]}</Text>
          <Text wrap="truncate-end">{clip(row.title, 44)}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {row.detail}
            </Text>
          </Box>
          <Text dimColor>{row.age}</Text>
          {actions(row)}
        </Box>
      )

      return (
        <Box flexDirection="column" rowGap={1}>
          {searchBox}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {groups.map(group => (
              <Box
                key={`count-${group.state}`}
                borderStyle="round"
                borderColor={TINT[group.state].line}
                backgroundColor={TINT[group.state].fill}
                paddingX={1}
              >
                <Text color={COLOR[group.state]}>
                  {ICON[group.state]} {group.items.length} {LABEL[group.state].toLowerCase()}
                </Text>
              </Box>
            ))}
          </Box>
          {groups.map(group => {
            const isHot = group.state === 'needs' || group.state === 'step' || group.state === 'finished'
            return (
              <Box key={`group-${group.state}`} flexDirection="column" rowGap={0.5}>
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  <Text bold color={COLOR[group.state]}>
                    {LABEL[group.state]}
                  </Text>
                  {NOTE[group.state] !== undefined && <Text dimColor>{NOTE[group.state]}</Text>}
                </Box>
                {isHot ? (
                  <Box flexDirection="column" rowGap={0.5}>
                    {group.items.map(card)}
                  </Box>
                ) : (
                  <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor={TINT[group.state].line}
                    backgroundColor={TINT[group.state].fill}
                    paddingX={1}
                  >
                    {group.items.map(line)}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {searchBox}
        {groups.map(group => (
          <Box key={`group-${group.state}`} flexDirection="column">
            <Text bold color={COLOR[group.state]}>
              {HEADING[group.state]} ({group.items.length})
            </Text>
            {group.items.map(row => (
              <Box key={`row-${row.id}`} flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  {row.isMine ? (
                    <Text>
                      {ICON[row.state]} {clip(row.title, room)} (this tab)
                    </Text>
                  ) : (
                    <Button key={`open-${row.id}`} plain onPress={() => jump($, row)}>
                      {`${iconOf(row)} ${clip(row.title, room)}`}
                    </Button>
                  )}
                  <Text dimColor>{[row.project, row.age].filter(part => part !== '').join(' · ')}</Text>
                  {(row.state === 'step' || row.state === 'finished') && (
                    <Button
                      key={`clear-${row.id}`}
                      plain
                      label={row.state === 'finished' ? 'Keep' : 'Clear'}
                      onPress={() => clear($, row)}
                    />
                  )}
                </Box>
                {(row.detail !== '' || row.why !== '') && (
                  <Text dimColor wrap="truncate-end">
                    {row.why === '' ? `  ${row.detail}` : `  ${row.why} · ${leftOf(row)}`}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
