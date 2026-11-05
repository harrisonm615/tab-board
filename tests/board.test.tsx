import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = 1_800_000_000_000
const DIR = '/home/test/.claude/tab-board'

const RECORDS: Record<string, object> = {
  'b.json': { id: 'b', title: 'Fix the invoice email', cwd: '/x/work', state: 'needs', detail: 'Approve: Running: git push', since: NOW - 120_000, beat: NOW },
  'c.json': { id: 'c', title: 'Card import', cwd: '/x/work', state: 'finished', detail: 'All 42 clips are on Drive.', since: NOW - 60_000, beat: NOW },
  'f.json': { id: 'f', title: 'Monthly report', cwd: '/x/work', state: 'step', detail: 'Next: run ship.sh', since: NOW - 30_000, beat: NOW },
  'd.json': { id: 'd', title: 'Landing page', cwd: '/x/site', state: 'working', detail: 'Editing index.html', since: NOW - 10_000, beat: NOW },
  'e.json': { id: 'e', title: 'Old closed tab', cwd: '/x/work', state: 'working', detail: 'gone', since: NOW - 999_000, beat: NOW - 600_000 },
}

type World = {
  ran: string[][]
  wrote: Record<string, string[]>
  asked: string[]
  verdict: string
  transcript: string
  openTabs: string
  records: Record<string, object>
  found: string
}

const line = (row: object) => JSON.stringify(row)

const engine = (on: On, world: World) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'a' }))
  on('session.cwd', () => ({ value: '/x/work' }))
  on('command.register', () => ({ value: { command: 'tabs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.write', ($, e) => {
    const name = e.path.slice(DIR.length + 1)
    ;(world.wrote[name] ??= []).push(e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({
    value: Object.keys(world.records).map(name => ({
      name,
      kind: 'file' as const,
      size: 100,
      mtimeMs: name === 'e.json' ? NOW - 600_000 : NOW,
      isLink: false,
    })),
  }))
  on('fs.read', ($, e) => {
    const record = world.records[e.path.slice(DIR.length + 1)]
    if (record === undefined) throw new Error('ENOENT')
    return { value: JSON.stringify(record) }
  })
  on('process.run', ($, e) => {
    world.ran.push([...e.argv])
    const answers: Record<string, string> = {
      grep: line({ type: 'ai-title', aiTitle: 'Tab board for VS Code' }),
      tail: world.transcript,
      '/bin/sh': world.openTabs,
      python3: world.found,
    }
    const stdout = answers[e.argv[0] ?? ''] ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    world.asked.push(e.prompt)
    return {
    value: {
      isAnswered: true,
      text: world.verdict,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return clock
}

const world = (patch: Partial<World> = {}): World => ({
  ran: [],
  wrote: {},
  asked: [],
  verdict: '',
  transcript: '',
  openTabs: '',
  records: RECORDS,
  found: '[]',
  ...patch,
})
const last = (w: World, name = 'a.json') =>
  JSON.parse(w.wrote[name]?.at(-1) ?? '{}') as { state?: string; detail?: string; title?: string; since?: number; v?: number }

const BAND = {
  plugin: 'tab-board',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'tab-board',
  component: 'Pane',
  requestId: 'tab-board',
  props: {
    title: 'All tabs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the band names the tabs that want you, counts the rest, and jumps', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  for (const surface of ['vscode', 'terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Your move/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 ready to close/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 working/ })).toBeDefined()
    expect((await ui.find({ key: 'all-tabs' }))?.text).toBe('All tabs (5)')
    expect(await ui.find({ type: 'Text', text: /Old closed tab/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'go-b' })
  expect(w.ran.at(-1)).toEqual(['open', 'vscode://anthropic.claude-code/open?session=b'])
  await ui.unmount()
})

test('the pane splits a tab waiting on you from one ready to close', async ($, on) => {
  engine(on, world())
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  for (const surface of ['vscode', 'terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /Needs you now \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Your move: Claude is waiting on you \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Ready to close: done, parked or gone quiet \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Next: run ship.sh/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Done · All 42 clips/ })).toBeDefined()
      expect((await ui.find({ key: 'open-c' }))?.text).toMatch(/Card import/)
    } else {
      expect(await ui.find({ type: 'Text', text: /1 needs you/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude is waiting on your answer/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 ready to close/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /press ⌘W/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Card import/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /run ship.sh/ })).toBeDefined()
      expect((await ui.find({ key: 'open-c' }))?.text).toBe('Open')
    }
    expect(await ui.find({ type: 'Text', text: /this tab/ })).toBeDefined()
    expect((await ui.find({ key: 'clear-c' }))?.text).toBe('Keep')
    expect((await ui.find({ key: 'clear-f' }))?.text).toBe('Clear')
    expect(await ui.find({ key: 'open-e' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a turn that leaves more to do is a step, with what is next', async ($, on) => {
  const w = world({ verdict: '{"kind":"waiting","note":"Run the settings command"}' })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  await $.turn.start({ text: 'build the tab board', turnId: 't1' })
  expect(last(w).state).toBe('working')

  await $.turn.complete({
    reason: 'answer',
    answer: 'Built it. Paste the command below in a terminal to turn it on for every tab.',
    durationMs: 90_000,
    isAborted: false,
    turnId: 't1',
  })
  await clock.settle()

  expect(last(w).state).toBe('step')
  expect(last(w).detail).toBe('Next: Run the settings command')
  expect(last(w).v).toBe(2)
  expect(last(w).title).toBe('Tab board for VS Code')
  // the judge reads what was asked beside the answer
  expect(w.asked.at(-1)).toMatch(/build the tab board/)
  const notice = w.ran.find(argv => argv[0] === 'osascript')
  expect(notice?.[2]).toMatch(/Your move/)
})

test('a turn that wraps the job up is ready to close', async ($, on) => {
  const w = world({ verdict: '{"kind":"done","note":"Told the time in Tokyo"}' })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  await $.turn.start({ text: 'what time is it in Tokyo?', turnId: 't1' })
  await $.turn.complete({
    reason: 'answer',
    answer: 'It is 3:10 am Tuesday in Tokyo.',
    durationMs: 4_000,
    isAborted: false,
    turnId: 't1',
  })
  await clock.settle()

  expect(last(w).state).toBe('finished')
  expect(last(w).detail).toBe('Done: Told the time in Tokyo')
  // a quick answer does not notify
  expect(w.ran.find(argv => argv[0] === 'osascript')).toBeUndefined()
})

test('a tab that restarts picks up from its transcript, quietly', async ($, on) => {
  const transcript = [
    line({ type: 'user', message: { content: 'send the October invoices' }, timestamp: new Date(NOW - 50_000).toISOString() }),
    line({
      type: 'assistant',
      cwd: '/x/work',
      message: { content: [{ type: 'text', text: 'Invoices are ready. Want me to email them now?' }] },
      timestamp: new Date(NOW - 40_000).toISOString(),
    }),
  ].join('\n')
  const w = world({ transcript, verdict: '{"kind":"step","next":"Say yes to email them"}' })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  // the guess first, from the words of the last reply
  expect(JSON.parse(w.wrote['a.json']?.[0] ?? '{}')).toMatchObject({ state: 'step', since: NOW - 40_000 })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'step', detail: 'Next: Say yes to email them' })
  expect(w.asked.at(-1)).toMatch(/send the October invoices/)
  expect(w.ran.find(argv => argv[0] === 'osascript')).toBeUndefined()
})

test('work left to the person, outside the tab, is parked and ready to close', async ($, on) => {
  const w = world({ verdict: '{"kind":"parked","note":"Send both Gmail drafts yourself"}' })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'draft the two podcast emails', turnId: 't1' })
  await $.turn.complete({
    reason: 'answer',
    answer: 'Both drafts are in Gmail. Review them, then press send. Want me to also add a calendar hold?',
    durationMs: 50_000,
    isAborted: false,
    turnId: 't1',
  })
  await clock.settle()

  expect(last(w)).toMatchObject({ state: 'finished', detail: 'Parked: Send both Gmail drafts yourself' })
  expect(w.ran.find(argv => argv[0] === 'osascript')?.[2]).toMatch(/Ready to close/)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^Parked$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 ready to close/ })).toBeDefined()
  await ui.unmount()
})

test('a tab left waiting or empty a long while is ready to close, until kept', async ($, on) => {
  const records = {
    'q.json': { id: 'q', title: 'Team files', cwd: '/x/work', state: 'step', detail: 'Next: Say go to ship', since: NOW - 13 * 3_600_000, beat: NOW },
    'n.json': { id: 'n', title: 'New tab', cwd: '/x/work', state: 'idle', detail: 'No messages yet', since: NOW - 30 * 60_000, beat: NOW },
    'r.json': { id: 'r', title: 'Fresh ask', cwd: '/x/work', state: 'step', detail: 'Next: Pick a time', since: NOW - 60_000, beat: NOW },
  }
  const w = world({ records })
  engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^Quiet 13h$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /was waiting on: Say go to ship/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Empty$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 ready to close/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 your move/ })).toBeDefined()

  // Keep writes it down as seen at that time, so it rests as idle
  await ui.press({ key: 'clear-q' })
  expect(JSON.parse(w.wrote['seen.json']?.at(-1) ?? '{}')).toEqual({ q: NOW - 13 * 3_600_000 })
  await ui.unmount()
})

test('a restarted tab whose verdict an older judge wrote is asked again', async ($, on) => {
  const transcript = [
    line({ type: 'user', message: { content: 'set up the recipes tab' }, timestamp: new Date(NOW - 90_000).toISOString() }),
    line({
      type: 'assistant',
      cwd: '/x/work',
      message: { content: [{ type: 'text', text: 'The Recipes tab is live. Want me to add a shopping list too?' }] },
      timestamp: new Date(NOW - 80_000).toISOString(),
    }),
  ].join('\n')
  const records = {
    ...RECORDS,
    'a.json': { id: 'a', title: 'Recipes', cwd: '/x/work', state: 'step', detail: 'Next: Say yes for a list', since: NOW - 70_000, beat: NOW - 600_000 },
  }
  const w = world({ transcript, records, verdict: '{"kind":"done","note":"Recipes tab is live"}' })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })
  await clock.settle()

  expect(last(w)).toMatchObject({ state: 'finished', detail: 'Done: Recipes tab is live', since: NOW - 70_000, v: 2 })
  expect(w.asked.at(-1)).toMatch(/set up the recipes tab/)
})

test('every tab VS Code has open is listed, and one not running is filled in', async ($, on) => {
  const openTabs = line({
    panelTabSessions: [
      { sessionId: 'a', title: 'This one' },
      { sessionId: 'c', title: 'Card import' },
      { sessionId: 'z', title: 'A long tab name that get…' },
    ],
  })
  const w = world({ openTabs })
  const clock = engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'open-z' }))?.text).toMatch(/A long tab name/)
  await ui.unmount()

  // the lowest running id leads, and fills in the tab that is not running
  expect(last(w, 'z.json')).toMatchObject({ state: 'idle', title: 'A long tab name that get…' })
})

test('a search finds the tab where the words were said, whatever its name', async ($, on) => {
  const found = JSON.stringify([
    { id: 'p', title: 'Team files', cwd: '/x/work', isOpen: false, hits: 8, modified: NOW - 3_600_000, who: 'You', snippet: 'the payroll run is due on Friday' },
    { id: 'b', title: 'Fix the invoice email', cwd: '/x/work', isOpen: true, hits: 1, modified: NOW, who: 'Claude', snippet: '…owed on your next payroll…' },
  ])
  const w = world({ found })
  engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  for (const surface of ['vscode', 'terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'search', text: 'payroll' })
    expect(await ui.find({ type: 'Text', text: /2 tabs mention “payroll”/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /payroll run is due/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /said 8 times · not open/ })).toBeDefined()
    // the board steps aside while the search shows
    expect(await ui.find({ key: 'clear-c' })).toBeUndefined()

    await ui.press({ key: 'found-p' })
    expect(w.ran.at(-1)).toEqual(['open', 'vscode://anthropic.claude-code/open?session=p'])
    const call = w.ran.findLast(argv => argv[0] === 'python3')
    expect(call?.[4]).toBe('payroll')
    // every tab on the board counts as open
    expect(call?.[7]?.split(',')).toContain('b')

    await ui.press({ key: 'search-back' })
    expect(await ui.find({ key: 'clear-c' })).toBeDefined()
    await ui.unmount()
  }
})

test('/tabs with words searches, and says when nothing was found', async ($, on) => {
  const w = world({ found: '[]' })
  engine(on, w)
  await $.session.start({ cwd: '/x/work', surface: 'vscode', isInteractive: true })

  const result = await $.command.run({
    command: 'tabs',
    args: 'zebra',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(JSON.stringify(result)).toMatch(/No tab mentions “zebra”/)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /No tab mentions “zebra”, open or from the last 7 days/ })).toBeDefined()
  await ui.unmount()
})
