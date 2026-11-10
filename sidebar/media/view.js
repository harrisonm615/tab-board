// Draws the side bar from what extension.js sends. Everything shown goes in with textContent, since titles and snippets are chat text.
const vscode = acquireVsCodeApi()
// The panel's words follow the computer: Windows has no ⌘Q, and its meters come from different places.
const ON_WINDOWS = /^Win/.test(navigator.platform || '')
const THIS = ON_WINDOWS ? 'this PC' : 'this Mac'
const list = document.getElementById('list')
const counts = document.getElementById('counts')
const box = document.getElementById('search')
const boxClear = document.getElementById('search-clear')
const statusLine = document.getElementById('status')
const usageBox = document.getElementById('usage')
const gaugeBox = document.getElementById('gauges')
const appsBox = document.getElementById('apps')
const lowerBox = document.getElementById('lower')

let tabs
let jobs
let boardMissing = false
let update
let usage
let gauges
let speed = {}
let found // { query, hits } while a search is showing; hits undefined means it's still running, null means it failed

// With so few sections, each chat's row says what it is: a short word, and more on hover.
const ROW_WORDS = {
  working: ['Chat', 'Claude is doing something in this chat right now.'],
  waiting: ['Chat, waiting', "This chat started something and is waiting for it to finish. It'll carry on by itself."],
  blocked: ['On hold', "It says it's your move, but someone or something else has to go first."],
  sitting: ['Gone quiet', 'Something is still open here, with nothing riding on a date.'],
  idle: ['Idle', ''],
  closable: ['Ready to close?', "Claude's suggestion, yours to decide. Claude read this and found nothing left to do, and it hasn't been touched for at least 6 hours. Close is one click, and it stays under Closed. Keep stops it being suggested."],
  finished: ['Looks done', "Done, parked or gone quiet, but not suggested for closing: it's too recent, or something may still be open. Nothing closes unless you press Close. Keep stops it being suggested."],
  later: ['For later', 'Kept out of your way until you want it, even if you close the tab. Click to pick it back up: once you send it something, it returns to your list.'],
  closed: ['Closed', 'Closed in the last 30 days. Click to bring it back with its whole history. After 30 days Claude Code deletes it, so press Later to keep it for longer.'],
}

// Where sections that no longer exist went, for a panel that saved one of them.
const MOVED = { apps: 'onyou', priority: 'running', jobs: 'running', working: 'running', waiting: 'running', blocked: 'resting', sitting: 'resting', idle: 'resting', closable: 'done', finished: 'done', away: 'later' }

// An accordion: one section open at a time, so the whole list fits and no section pushes the rest off the screen. null means it was shut on purpose.
const saved = vscode.getState() || {}
let opened = saved.opened === undefined ? 'onyou' : MOVED[saved.opened] || saved.opened
let orderOpen = saved.orderOpen // undefined means it follows the Mac: open only while jobs are being slowed
let appsOpen = saved.appsOpen === true
const remember = () => vscode.setState({ opened, orderOpen, appsOpen })

// Open headings stick just under the top bar, whose height changes with the counts.
const topBar = document.getElementById('top')
new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${topBar.offsetHeight}px`)).observe(topBar)

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const dot = tone => el('span', `dot tone-${tone}`)

// The line at the top of an open section: what it is, and any button that goes with it.
function secBar(note) {
  const bar = el('div', 'sec-bar')
  bar.append(el('span', 'sec-note', note))
  return bar
}

// The dot and the count are what make a shut section worth glancing at.
// Every collapse says the same thing: down when pressing drops it open, up when pressing shuts it (his ask, Nov 5).
const chev = isOpen => el('span', 'chev', isOpen ? '▴' : '▾')

function foldHead(key, label, count, tip, tone, isOpen, click) {
  const head = el('button', isOpen ? 'fold open' : 'fold')
  head.id = `sec-${key}`
  head.title = tip
  head.setAttribute('aria-expanded', String(isOpen))
  const mark = dot(tone)
  if (tone === 'working' || tone === 'running') mark.classList.add('live')
  head.append(chev(isOpen), mark, el('span', 'fold-label', label), el('span', 'fold-count', String(count)))
  head.addEventListener('click', click)
  return head
}

// Shutting a section above moves everything up, so the heading just pressed is put back in view.
function reveal(id, toTop) {
  const head = document.getElementById(id)
  if (!head) return
  const target = head.classList.contains('sub') ? head : head.closest('.sec') || head
  target.scrollIntoView({ block: toTop ? 'start' : 'nearest' })
}

function toggle(key) {
  opened = opened === key ? null : key
  remember()
  draw()
  reveal(`sec-${key}`, opened === key)
}

// One accordion section, with its rows only while it's open. Its heading stays on screen while they scroll, so it's always one click to shut.
function section(key, label, count, tip, tone, rows) {
  const box = el('section', 'sec')
  const isOpen = opened === key
  box.append(foldHead(key, label, count, tip, tone, isOpen, () => toggle(key)))
  if (isOpen) box.append(...rows())
  return [box]
}

// A fold inside an open section.
function subFold(key, label, count, tip, tone, isOpen, flip) {
  const head = foldHead(key, label, count, tip, tone, isOpen, () => {
    flip()
    remember()
    draw()
    reveal(`sec-${key}`, !isOpen)
  })
  head.classList.add('sub')
  return head
}

const hasMeter = job => job.frac !== null && job.frac !== undefined

// A job whose chat is known opens that chat. One with no known chat stays a plain row rather than open a guess.
function opensChat(row, chat) {
  if (!chat) return
  row.classList.add('tab')
  row.tabIndex = 0
  row.title += '\nClick to open its chat'
  const go = event => {
    if (!event.target.closest('button')) vscode.postMessage({ type: 'open', id: chat })
  }
  row.addEventListener('click', go)
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter') go(event)
  })
}

const known = secs => secs !== null && secs !== undefined

// How long is left, rounder the further off it is, since it's an estimate: ~12 min, ~1h 20m, ~3 days.
function aboutTime(secs) {
  const mins = secs / 60
  const hours = m => `~${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
  if (mins < 1.5) return '~1 min'
  if (mins < 15) return `~${Math.round(mins)} min`
  if (mins >= 2880) return `~${Math.round(mins / 1440)} days`
  const rounded = Math.round(mins / (mins < 120 ? 5 : 15)) * (mins < 120 ? 5 : 15)
  return rounded < 60 ? `~${rounded} min` : hours(rounded)
}

// The clock time it should finish, as rounded as the estimate: "4:35 PM", or "Sat 8 PM" on another day.
function aroundTime(secs) {
  const step = secs < 900 ? 60_000 : secs < 7200 ? 300_000 : 900_000
  return resetDay(Math.round((Date.now() + secs * 1000) / step) * step)
}

const LEFT_FROM = { job: "the job's own estimate", pace: 'how fast its meter has moved in the last hour', chat: 'what its chat said' }

function leftTip(job) {
  if (job.state !== 'running') return ''
  if (!known(job.left)) return "No estimate yet. A job gets one once its meter has moved twice, over at least 2 minutes, or if its chat says how long it has left."
  const behind = job.behindUnknown ? ' A job ahead of it in line has no estimate, so it may take longer.' : ''
  return `About ${aboutTime(job.left).slice(1)} left, done around ${aroundTime(job.left)}. From ${LEFT_FROM[job.leftBy] || 'its place in line'}.${behind}`
}

// The whole list: when everything's done, and what that leaves out, so a partial total can't pass for a full one.
function totalWords() {
  const total = jobs && jobs.total
  if (!total) return ''
  const longHaul = total.longHaul.length ? `Longer than that: ${total.longHaul.join(', ')}.` : ''
  if (!known(total.left)) return [total.untimed ? 'No estimates yet.' : '', longHaul].filter(Boolean).join(' ')
  const skipped = total.untimed ? `, not counting ${total.untimed} with no estimate` : ''
  return [`All done in ${aboutTime(total.left)}, around ${aroundTime(total.left)}${skipped}.`, longHaul].filter(Boolean).join(' ')
}

const JOB_WORDS = { bad: ['Failed', 'text-needs'], warn: ['Stuck', 'text-step'], done: ['Finished job', 'text-finished'] }

// A running job goes by the kind of work it is, and anything else by what's wrong or waiting.
function jobTag(job) {
  if (job.state === 'running') return el('span', 'tag text-working', /^(jobs|other)$/i.test(job.group) ? 'Job' : job.group)
  const [word, color] = JOB_WORDS[job.state] || ['Waiting', 'text-idle']
  return el('span', `tag ${color}`, word)
}

function jobNote(job) {
  const note = el('span', 'note')
  note.append(jobTag(job), document.createTextNode(job.text || ''))
  return note
}

function jobRow(job) {
  const slim = job.state === 'wait' || job.state === 'done'
  const row = el('div', slim ? 'row job slim' : 'row job')
  row.title = [job.name, job.text, leftTip(job)].filter(Boolean).join('\n')
  opensChat(row, job.chat)
  const mark = dot(job.state)
  if (job.state === 'running') mark.classList.add('live')
  row.append(mark, el('span', 'title', job.name))
  if (slim) {
    row.append(jobNote(job))
    if (job.doneAgo) row.append(el('span', 'age', job.doneAgo))
    return row
  }
  const left = known(job.left) ? `${aboutTime(job.left)}${job.behindUnknown ? '+' : ''}` : ''
  row.append(el('span', 'age', [left, hasMeter(job) ? `${Math.round(job.frac * 100)}%` : ''].filter(Boolean).join(' · ')), jobNote(job))
  if (hasMeter(job)) row.append(meterOf(job))
  return row
}

function meterOf(job) {
  const meter = el('div', 'meter')
  const fill = el('div', `fill tone-${job.state}`)
  fill.style.width = `${Math.round(Math.min(Math.max(job.frac, 0), 1) * 100)}%`
  meter.append(fill)
  return meter
}

// Every job, knowing which group it came from, since that's its word on the row.
const allJobs = () => (jobs ? jobs.groups : []).flatMap(group => group.rows.map(job => ({ ...job, group: group.name })))
const chatsIn = (...states) => states.flatMap(state => (tabs || []).filter(tab => tab.state === state))
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// One thing, one row (his ask, Nov 5: "dont double list things"). A job and its chat are the same work, and a job's row opens its chat, so:
// a finished job gets a row only if its chat isn't on the list anywhere, a waiting job leaves the talking to its chat if that chat is in Running,
// and any other job stands in for its chat in Running, Resting and Done. An ask (On you, Ready to ship), the shelf and Closed are different lists,
// so those chats keep their row beside a job that's still going: hiding either would lose something.
// A job that finishes after its chat was closed is news nobody saw in the chat (his ask, Nov 8: "when i close something that had a background task?"), so it gets its row.
const isListed = id => (tabs || []).some(tab => tab.id === id)
const isMoving = id => chatsIn('working', 'waiting').some(tab => tab.id === id)
const isLive = job => ['bad', 'warn', 'running'].includes(job.state)
const waitingJobs = () => allJobs().filter(job => !isLive(job) && job.state !== 'done' && !isMoving(job.chat))
const endedAfterClose = job => chatsIn('closed').some(tab => tab.id === job.chat && job.doneAt > (tab.closedAt || 0))
const finishedJobs = () => allJobs().filter(job => job.state === 'done' && (!isListed(job.chat) || endedAfterClose(job)))
function ownRows(...states) {
  const spokenFor = new Set([...allJobs().filter(isLive), ...waitingJobs()].map(job => job.chat))
  return chatsIn(...states).filter(tab => !spokenFor.has(tab.id))
}

// Running: what's moving now, chats and jobs together, each row saying which it is. A failed or stuck job goes first, so it can't sit unnoticed.
function runningRows() {
  const all = allJobs()
  const failed = all.filter(job => job.state === 'bad')
  const stuck = all.filter(job => job.state === 'warn')
  const going = all.filter(job => job.state === 'running')
  const chats = ownRows('working', 'waiting')
  const order = jobs && jobs.priority && (jobs.priority.jobs.length > 0 || jobs.priority.taking) ? jobs.priority : null
  if (failed.length + stuck.length + going.length + chats.length === 0 && !order) return []
  const problems = failed.length + stuck.length
  const jobCount = going.length || (chats.length || problems ? 0 : order.jobs.length)
  const moving = [chats.length ? plural(chats.length, 'chat') : '', jobCount ? plural(jobCount, 'job') : ''].filter(Boolean)
  // "1 stuck · 11 chats · 3 jobs" doesn't fit beside "Running" in a narrow panel, so with something stuck the split moves to the tip.
  const count = problems ? [`${problems} stuck`, chats.length + jobCount || ''].filter(Boolean).join(' · ') : moving.join(' · ')
  const tone = failed.length ? 'bad' : stuck.length || (order && (order.slowed || order.taking)) ? 'warn' : chatsIn('working').length || going.length ? 'working' : 'waiting'
  const tip = [moving.join(', '), 'Chats are Claude at work in a chat. Everything else is a long job on the Mac, like an upload or a render.', 'A turn number means it\'s doing heavy work. If the Mac overloads, Turn 1 keeps going and the rest slow down.', totalWords()].filter(Boolean).join('\n')
  return section('running', 'Running', count, tip, tone, () => {
    const rows = totalWords() ? [secBar(totalWords())] : []
    if (order) rows.push(...turnOrder(order))
    // An open turn order already lists its chats and jobs, with their times and arrows, so they don't repeat under it.
    const showing = order && orderShowing(order)
    const placed = [
      ...chats.filter(tab => !(showing && turnOfChat(order, tab))).map(tab => [tabRow(tab), turnOfChat(order, tab)]),
      ...going.filter(job => !(showing && hasTurnLine(order, job))).map(job => [jobRow(job), turnOfJob(order, job)]),
    ]
    // Numbered rows lead, in turn order, so Turn 2 can't sit above Turn 1.
    const numbered = placed.filter(([, turn]) => turn).sort((a, b) => a[1].at - b[1].at)
    const others = placed.filter(([, turn]) => !turn)
    return [...rows, ...failed.map(jobRow), ...stuck.map(jobRow), ...[...numbered, ...others].map(([row, turn]) => withTurn(row, turn))]
  })
}

// What really takes turns: throttle.py only queues what's heavy. Light work gets no number and doesn't use one up, wherever it sits in the saved order.
const inLineJobs = order => order.jobs.filter(job => job.state !== 'idle')

// Where a Running row stands in the turn order.
function inLine(order, matches) {
  const line = order ? inLineJobs(order) : []
  const at = line.findIndex(matches)
  return at < 0 ? null : { at: at + 1, slowed: line[at].slowed > 0, entry: line[at] }
}

// The running job a line in the turn order stands for: its chat's job, or the script job it names. A group's line ("Uploads") doesn't say which upload, so it stands for none.
function turnJob(entry) {
  if (!/^(tab|script):/.test(entry.key)) return null
  return allJobs().find(row => row.state === 'running' && ((row.chat && entry.key === `tab:${row.chat}`) || (entry.matches && row.name.toLowerCase().includes(entry.matches)))) || null
}
function hasTurnLine(order, job) {
  const turn = turnOfJob(order, job)
  return Boolean(turn) && (turnJob(turn.entry) || {}).name === job.name
}
const turnOfChat = (order, tab) => inLine(order, job => job.key === `tab:${tab.id}`)
const turnOfJob = (order, row) => inLine(order, job => job.group === row.group || (job.matches && row.name.toLowerCase().includes(job.matches)) || (row.chat && job.key === `tab:${row.chat}`))

function withTurn(row, turn) {
  if (turn) row.querySelector('.note').prepend(el('span', `tag ${turn.slowed ? 'text-warn' : 'text-working'}`, turn.slowed ? `Turn ${turn.at}, slowed` : `Turn ${turn.at}`))
  return row
}

// Resting: nothing moving, and something else has to happen first, or nothing has to.
function restingRows() {
  const held = waitingJobs()
  const hold = ownRows('blocked')
  const rest = ownRows('sitting', 'idle')
  const total = held.length + hold.length + rest.length
  if (total === 0) return []
  return section('resting', 'Resting', total, 'Chats on hold, gone quiet or idle, and jobs waiting for their time.', 'idle', () => [...hold.map(tabRow), ...held.map(jobRow), ...rest.map(tabRow)])
}

// Done: what's suggested for closing first, the longest sitting at the top, since the longer it's sat, the less likely it gets picked back up.
function doneRows() {
  const closable = ownRows('closable').sort((a, b) => a.since - b.since)
  const finished = ownRows('finished')
  const jobsDone = finishedJobs()
  const total = closable.length + finished.length + jobsDone.length
  if (total === 0) return []
  const note = `Nothing closes unless you press Close. Finished jobs clear by themselves after ${jobs ? jobs.finishedHours : 12} hours.`
  return section('done', 'Done', total, note, 'finished', () => [secBar(note), ...closable.map(tabRow), ...finished.map(tabRow), ...jobsDone.map(jobRow)])
}

// For later: the shelf, chosen on purpose, with its tab open or closed.
function laterRows() {
  const later = chatsIn('later')
  if (later.length === 0) return []
  return section('later', 'For later', later.length, 'Kept out of your way until you want it, even with its tab closed.', 'idle', () => later.map(tabRow))
}

// Closed: every chat closed in the last 30 days, newest first.
function closedRows() {
  const closed = chatsIn('closed').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  if (closed.length === 0) return []
  return section('closed', 'Closed', closed.length, 'Closed in the last 30 days. A click brings one back with its whole history.', 'idle', () => closed.map(tabRow))
}

// The heavy jobs in the order picked (throttle.py): Claude's order unless it's overridden here. Top runs first when the Mac overloads.
const orderShowing = p => (orderOpen === undefined ? p.slowed > 0 || Boolean(p.taking) : orderOpen)

function turnOrder(p) {
  const isOpen = orderShowing(p)
  const line = inLineJobs(p)
  const first = line[0] && (turnJob(line[0]) || line[0]) // the same name its row shows
  const label = p.slowed ? `Turn order · ${p.slowed} slowed` : first ? `Turn order · ${first.name} first` : p.taking ? 'Turn order · nothing heavy to slow' : 'Turn order · nothing heavy'
  const head = subFold('order', label, line.length || '', p.note, p.slowed || p.taking ? 'warn' : 'idle', isOpen, () => (orderOpen = !isOpen))
  return isOpen ? [head, ...priorityBody(p)] : [head]
}

function priorityBody(p) {
  const head = secBar(p.note)
  if (p.slowed || p.taking || p.off) {
    const letRun = el('button', 'let-run', p.off ? 'Back to taking turns' : 'Let everything run for 2 hours')
    letRun.addEventListener('click', () => vscode.postMessage({ type: 'letrun', on: !p.off }))
    head.append(letRun)
  }
  const line = inLineJobs(p)
  const rows = line.map((job, i) => {
    const top = i === 0
    const row = el('div', top ? `row prio top by-${p.top.by}` : 'row prio')
    const own = turnJob(job) // its job's own row steps aside for this line, so the job's name and meter come here
    row.title = [own ? own.name : job.name, job.text, leftTip({ ...job, state: 'running' })].join('\n')
    opensChat(row, job.chat || (own && own.chat))
    row.append(dot(job.state), el('span', 'title', `${i + 1}. ${own ? own.name : job.name}`))
    const move = el('span', 'move')
    for (const [step, label, blocked] of [['up', '↑', i === 0], ['down', '↓', i === line.length - 1]]) {
      const arrow = el('button', 'arrow', label)
      arrow.title = step === 'up' ? 'Earlier in line' : 'Later in line'
      arrow.disabled = blocked
      arrow.addEventListener('click', () => vscode.postMessage({ type: 'prio', key: job.key, step }))
      move.append(arrow)
    }
    const note = el('span', 'note')
    if (top) note.append(el('span', `tag ${p.top.by === 'you' ? 'text-step' : 'text-working'}`, p.top.by === 'you' ? '★ Your pick' : "★ Claude's pick"))
    const when = known(job.left) ? `${aboutTime(job.left)}${job.behindUnknown ? '+' : ''}, around ${aroundTime(job.left)}` : ''
    note.append(document.createTextNode([when, top && p.top.why, job.text].filter(Boolean).join(' · ')))
    row.append(move, note)
    if (!top) {
      const pick = el('button', 'make-priority', 'Make priority')
      pick.title = 'Run this one first when the Mac overloads'
      pick.addEventListener('click', () => vscode.postMessage({ type: 'prio', key: job.key, step: 'first' }))
      row.append(pick)
    }
    if (own && hasMeter(own)) row.append(meterOf(own))
    return row
  })
  // Light work isn't in line, so there's nothing to press: just what it is, under the line.
  const light = p.jobs.filter(job => job.state === 'idle').map(job => {
    const row = el('div', 'row prio')
    row.title = [job.name, job.text].join('\n')
    opensChat(row, job.chat)
    row.append(dot(job.state), el('span', 'title', job.name), el('span', 'note', job.text))
    return row
  })
  if (!p.custom) return [head, ...rows, ...light]
  const foot = el('div', 'prio-foot')
  const reset = el('button', 'back', "Back to Claude's order")
  reset.addEventListener('click', () => vscode.postMessage({ type: 'prio', key: 'all', step: 'reset' }))
  foot.append(reset)
  return [head, ...rows, ...light, foot]
}

function action(label, tip, act) {
  const button = el('button', 'act', label)
  button.title = tip
  button.addEventListener('click', event => {
    event.stopPropagation()
    act()
  })
  return button
}

// A row's buttons wait behind one small ⋯, so a click meant to view a tab can't land on Keep or Close (his ask, Nov 6: "too big and easy to press when trying to view").
let actsOpen = null // the chat whose buttons are showing, kept out here because the list redraws every few seconds

function setActs(id) {
  if (actsOpen === id) return
  actsOpen = id
  draw()
}

function rowActs(tab, buttons) {
  const showing = actsOpen === tab.id
  const box = el('span', showing ? 'acts open' : 'acts')
  for (const button of buttons) button.addEventListener('click', () => setActs(null)) // one press and they fold away again
  const names = buttons.map(button => button.textContent).join(', ')
  const more = el('button', 'act-more', '⋯')
  more.title = showing ? 'Hide these' : names
  more.setAttribute('aria-label', `More: ${names}`)
  more.setAttribute('aria-expanded', String(showing))
  more.addEventListener('click', event => {
    event.stopPropagation()
    setActs(showing ? null : tab.id)
  })
  more.addEventListener('keydown', event => event.stopPropagation()) // Enter here means the button, not "open the tab"
  box.append(...buttons, more)
  return box
}

// Anywhere else folds them away. A click on a row also opens that row's tab, as usual.
document.addEventListener('click', event => {
  if (!event.target.closest('.acts')) setActs(null)
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setActs(null)
})

// Sent only if there's a personal script that sends "apps". One app per click; nothing here closes several at once (his ask, Nov 5).
function closeApp(app) {
  const how = ON_WINDOWS ? 'It closes its windows, as clicking their X does' : 'It asks it to quit, as ⌘Q does'
  const button = action('×', `Close ${app.name}. ${how}. If it has unsaved work, it asks you first.`, () => {
    button.textContent = '…'
    button.disabled = true
    vscode.postMessage({ type: 'quit', ids: [app.id] })
  })
  button.classList.add('app-x')
  button.setAttribute('aria-label', `Close ${app.name}`)
  return button
}

function overloadBanner() {
  const banner = el('div', 'alarm', jobs.mac.detail)
  if (jobs.apps && jobs.apps.rows.length > 0) {
    const wrap = el('div', 'alarm-apps')
    const press = action(`See open apps · ${jobs.apps.rows.length}`, `Drops down the apps open on ${THIS}. Each has its own × to close it.`, () => {
      appsOpen = !appsOpen
      remember()
      draw()
      if (appsOpen) appsBox.scrollIntoView({ block: 'nearest' })
    })
    press.append(chev(appsOpen))
    wrap.append(press)
    banner.append(wrap)
  }
  return banner
}

// The other apps open on this Mac or PC, under its meters, since they're how to act on them. Finder or File Explorer, and this window, aren't offered.
// It keeps its own fold, apart from the list's accordion, and its own scrolling, so a long list can't fill the top block.
function drawApps() {
  const before = appsBox.querySelector('.apps-list')
  const scrolled = before ? before.scrollTop : 0
  appsBox.replaceChildren()
  const apps = jobs && jobs.apps
  if (!apps || apps.rows.length === 0) return
  const tip = ON_WINDOWS
    ? "Other apps open on this PC, busiest first, with their share of the PC's CPU and their memory. × closes one's windows, as clicking their X does."
    : "Other apps open on this Mac, busiest first, with their share of the Mac's CPU and their memory. × asks one to quit, as ⌘Q does."
  // A small title over its own list, so it doesn't read as one of the list's sections.
  const head = el('button', 'mini-head')
  head.id = 'sec-apps'
  head.title = tip
  head.setAttribute('aria-expanded', String(appsOpen))
  head.append(el('span', 'mini-label', `Open apps · ${apps.rows.length}`), chev(appsOpen))
  if (!ON_WINDOWS) head.append(el('span', `mini-note ${jobs.mac.warn ? 'text-warn' : ''}`, `load ${jobs.mac.load}`)) // Windows has no load figure
  head.addEventListener('click', () => {
    appsOpen = !appsOpen
    remember()
    draw() // the overload banner's arrow follows this one
  })
  appsBox.append(head)
  if (!appsOpen) return
  const box = el('div', 'apps-list')
  for (const app of apps.rows) {
    const row = el('div', 'row app')
    row.title = `${app.name}\n${app.tip}`
    row.append(dot('idle'), el('span', 'title', app.name), el('span', 'age', app.text), closeApp(app))
    box.append(row)
  }
  appsBox.append(box)
  box.scrollTop = scrolled
}

// Moves it now rather than at the next check, so the click is seen to work.
function shelve(tab, on) {
  tab.state = on ? 'later' : 'idle'
  tab.tone = 'idle'
  tab.tag = ''
  if (!on && !tab.isOpen) tabs = tabs.filter(other => other !== tab)
  vscode.postMessage({ type: 'later', id: tab.id, title: tab.title, on })
  draw()
}

// Moves it now rather than at the next check. A shelved tab stays on the shelf: only the real tab goes away.
function closeTab(tab) {
  if (tab.state !== 'later') {
    tab.state = 'closed'
    tab.tone = 'idle'
    tab.tag = ''
    tab.age = 'now'
    tab.closedAt = Date.now()
  }
  tab.isOpen = false
  vscode.postMessage({ type: 'close', id: tab.id, title: tab.title })
  draw()
}

// Closing is always the person's click, one tab at a time, and never on a chat that's in the middle of something.
const closeAction = tab =>
  tab.isOpen && !['working', 'waiting', 'needs'].includes(tab.liveState || tab.state) // liveState: on the shelf, but still running
    ? action('Close', 'Close this tab. It stays under Closed for 30 days, and a click brings it back.', () => closeTab(tab))
    : undefined

const shelfBack = tab =>
  tab.isOpen
    ? action('Back', 'Take it off the shelf and put it back in your list', () => shelve(tab, false))
    : action('Remove', 'Take it off the shelf. The tab is closed, so it moves to Closed.', () => shelve(tab, false))

const SIZE_WORDS = { quick: 'Quick', sit: 'Sit-down', out: 'Away from Claude' }
function star(tab) {
  tab.starred = !tab.starred
  vscode.postMessage({ type: 'star', id: tab.id, on: tab.starred })
  draw()
}

// One thing that's on you, kept short: its name, how long it's sat, and two lines of the ask. Hover for all of it.
// What can't wait goes first in those two lines, so it can't be cut off. With nothing pressing, they start with how long it takes.
function tile(tab) {
  const urgent = tab.state === 'needs' || tab.dueSoon
  const card = el('div', `tab tile ${urgent ? 'urgent' : ''} ${tab.starred || tab.pick ? 'first' : ''}`)
  card.tabIndex = 0
  card.title = [tab.title, tab.note, tab.why, SIZE_WORDS[tab.size]].filter(Boolean).join('\n')
  const top = el('div', 'tile-top')
  top.append(dot(urgent ? 'needs' : 'step'), el('span', 'title', tab.title), el('span', 'age', tab.age))
  const lead = [tab.dueText, tab.state === 'needs' && 'Stopped for your OK'].filter(Boolean).join(' · ') || SIZE_WORDS[tab.size]
  const ask = el('div', 'tile-ask')
  if (lead) ask.append(el('span', urgent ? 'tile-lead soon' : 'tile-lead', `${lead} · `))
  ask.append(document.createTextNode(tab.note))
  card.append(top, ask)
  if (tab.woke) card.append(el('div', 'tile-why', 'Back from For later, as you asked'))
  if (tab.starred) card.append(el('div', 'tile-why', '★ Your pick'))
  else if (tab.pick) card.append(el('div', 'tile-why', tab.why ? `★ Claude's pick: ${tab.why}` : "★ Claude's pick"))
  const buttons = [action(tab.starred ? '★' : '☆', tab.starred ? 'Take it out of your picks' : 'Put this one first', () => star(tab))]
  if (tab.woke) buttons.push(shelfBack(tab))
  buttons.push(action('Later', 'Put it on the For later shelf, out of your way', () => shelve(tab, true)))
  const close = closeAction(tab)
  if (close) buttons.push(close)
  card.append(rowActs(tab, buttons))
  const go = () => vscode.postMessage({ type: 'open', id: tab.id })
  card.addEventListener('click', go)
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter') go()
  })
  return card
}

const tileWall = items => {
  const wall = el('div', 'tiles')
  wall.append(...items.map(tile))
  return wall
}

// Ready to ship: finished work that only needs your OK to go live. It's the first section, in bold green, with a green count, and its heading stays on screen however far down the list you are.
// It shuts like the rest, because a stack of these would otherwise push everything else off the screen. One press and it's on its way, with a few seconds to take it back, because a slip here reaches real people.
const SHIP_SECONDS = 5
const shipping = new Map() // what's been pressed, by chat and the ask it answers, so it survives the list being redrawn
const shipKey = tab => `${tab.id}:${tab.since}`
const toShip = () => (tabs || []).filter(tab => tab.ship && tab.state === 'step')

function pressShip(tab) {
  const press = { status: 'counting', left: SHIP_SECONDS }
  press.timer = setInterval(() => {
    press.left -= 1
    if (press.left <= 0) {
      clearInterval(press.timer)
      press.status = tab.ship === 'command' ? 'running' : 'sending'
      vscode.postMessage({ type: 'ship', id: tab.id, since: tab.since })
    }
    draw()
  }, 1000)
  shipping.set(shipKey(tab), press)
  draw()
}

function undoShip(tab) {
  const press = shipping.get(shipKey(tab))
  if (!press || press.status !== 'counting') return // already gone, or this was the release of the press that took it back
  clearInterval(press.timer)
  shipping.delete(shipKey(tab))
  draw()
}

function shipButton(tab) {
  const press = shipping.get(shipKey(tab))
  const status = press ? press.status : 'ready'
  const go = tab.ship === 'command' ? 'Run it' : 'Ship it'
  const words = {
    ready: go,
    counting: `Undo · going in ${press ? press.left : ''}`,
    sending: 'Sending…',
    running: 'Running in the terminal…',
    sent: 'Sent ✓',
    copied: 'On your clipboard: paste it in the chat',
    moved: 'Not sent: this chat has moved on',
    done: 'Done ✓',
    handed: "It's in the terminal",
    failed: `${go} again`,
  }
  const button = el('button', `ship-go is-${status}`, words[status])
  button.title = tab.ship === 'command' ? `Runs the command above in a terminal you can watch${tab.shipFolder ? `, from ${tab.shipFolder}` : ''}` : 'Replies "ship it" in this chat for you'
  button.disabled = !['ready', 'counting', 'failed'].includes(status)
  // The list redraws every second of the countdown. A redraw between press and release swaps the button out and loses the click, so an Undo counts from the moment the button goes down.
  button.addEventListener('pointerdown', event => {
    if (status !== 'counting' || event.button !== 0) return
    event.stopPropagation()
    undoShip(tab)
  })
  button.addEventListener('click', event => {
    event.stopPropagation()
    if (status === 'counting') undoShip(tab)
    else pressShip(tab)
  })
  button.addEventListener('keydown', event => event.stopPropagation()) // Enter here means the button, not "open the tab"
  return button
}

function shipTile(tab) {
  const card = el('div', 'tab tile ship')
  card.tabIndex = 0
  card.title = [tab.title, tab.why].filter(Boolean).join('\n')
  const top = el('div', 'tile-top')
  top.append(dot('finished'), el('span', 'title', tab.title), el('span', 'age', tab.age))
  card.append(top, el('div', 'tile-ask', tab.note))
  if (tab.shipCommand) card.append(el('code', 'ship-cmd', tab.shipCommand))
  const press = shipping.get(shipKey(tab))
  if (press && press.status === 'failed') card.append(el('div', 'ship-failed', press.code === undefined ? "It didn't finish. See the terminal." : `It failed with exit code ${press.code}. See the terminal.`))
  if (press && press.status === 'handed') card.append(el('div', 'ship-note', "I can't see how it ends. Check the terminal. Once it's in, close this chat from its ⋯."))
  card.append(shipButton(tab))
  card.append(
    rowActs(tab, [
      action('Later', 'Put it on the For later shelf, out of your way', () => shelve(tab, true)),
      closeAction(tab),
    ].filter(Boolean)),
  )
  const go = () => vscode.postMessage({ type: 'open', id: tab.id })
  card.addEventListener('click', go)
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter') go()
  })
  return card
}

function shipRows() {
  const items = toShip().sort((a, b) => a.rank - b.rank)
  if (items.length === 0) return []
  const note = `One press, then ${SHIP_SECONDS} seconds to undo`
  const showing = opened === 'ship' && !found // a search takes over the list, so the tiles wait behind it
  const head = foldHead('ship', 'Ready to ship', items.length, note, 'finished', showing, toggleShip)
  head.classList.add('ship-head')
  const spot = el('div', 'ship-spot') // the heading sticks, so it can't say where the section really starts
  spot.id = 'ship-spot'
  const parts = [spot, head]
  if (showing) parts.push(secBar(note))
  // Shut or not, a pressed tile stays out: its Undo has to be there for the whole countdown, and a failure has to be seen.
  const tiles = showing ? items : items.filter(tab => shipping.has(shipKey(tab)))
  if (tiles.length > 0) {
    const wall = el('div', 'tiles')
    wall.append(...tiles.map(shipTile))
    parts.push(wall)
  }
  return parts
}

// Everything that's truly on you, in one list: Claude's order, marked as Claude's, and any star goes above it. Each tile says what kind of ask it is.
function onYou() {
  const mine = (tabs || []).filter(tab => !tab.ship && (tab.state === 'needs' || tab.state === 'step')).sort((a, b) => a.rank - b.rank)
  if (mine.length === 0) return []
  const urgent = mine.some(tab => tab.state === 'needs' || tab.dueSoon)
  return section('onyou', 'On you', mine.length, "Claude's order. Star one to put it first.", urgent ? 'needs' : 'step', () => {
    const head = secBar("Claude's order. Star one to put it first.")
    const next = el('button', 'next', 'Next ▸')
    next.title = 'Go to the next tab waiting on you (⌃⌘N)'
    next.addEventListener('click', () => vscode.postMessage({ type: 'next' }))
    head.append(next)
    const first = tab => tab.starred || tab.pick
    return [head, tileWall([...mine.filter(first), ...mine.filter(tab => !first(tab))])]
  })
}

// Two chats still working that edited the same file lately can get in each other's way. A row leaves by itself once either stops working or the edits are 30 minutes old.
function overlapRows() {
  const sets = (jobs && jobs.overlap) || []
  if (sets.length === 0) return []
  const what = 'Two chats still working have both edited these in the last 30 minutes'
  return section('overlap', 'Same files', sets.length, what, 'warn', () => {
    const out = [secBar(what)]
    for (const set of sets) {
      const row = el('div', 'overlap')
      const who = el('div', 'overlap-who')
      set.chats.forEach((chat, i) => {
        if (i > 0) who.append(' + ')
        const link = el('button', 'link', chat.title)
        link.title = `Go to ${chat.title}`
        link.addEventListener('click', () => vscode.postMessage({ type: 'open', id: chat.id }))
        who.append(link)
      })
      row.append(dot('warn'), who, el('div', 'overlap-files', `${set.files.join(', ')} · ${set.ago}`))
      out.push(row)
    }
    return out
  })
}

// What a reload would stop: commands chats are running, and chats in the middle of something. Null until it's known.
function wouldStop() {
  if (!jobs || !jobs.reload) return null
  const out = new Map()
  const named = id => ((tabs || []).find(tab => tab.id === id) || {}).title
  for (const job of jobs.reload) out.set(job.id || job.what, { id: job.id, title: named(job.id) || job.title, why: `Running a job for ${job.for}`, tip: job.what })
  for (const tab of tabs || []) {
    const state = tab.liveState || tab.state // a shelved chat can still be running
    if ((state === 'working' || state === 'needs') && !out.has(tab.id)) out.set(tab.id, { id: tab.id, title: tab.title, why: state === 'needs' ? 'Stopped, waiting for your OK' : 'In the middle of something' })
  }
  return [...out.values()]
}

function reloadButton(label, tip) {
  const go = el('button', 'reload-go', label)
  go.title = tip
  go.setAttribute('aria-label', tip)
  go.addEventListener('click', () => vscode.postMessage({ type: 'reload' }))
  return go
}

// The first thing in the panel, in one of three looks you can tell apart at a glance: faint when no reload is needed, amber when a new
// version is waiting on running work, solid green when it's time. extension.js decides "calm", so a chat between two steps doesn't make it blink.
function reloadLine() {
  if (!update || !update.pending) {
    const line = el('div', 'reload-none')
    line.append(el('span', 'reload-say', '✓ No reload needed'), reloadButton('↻', "Nothing new to load, so there's no need. If you do, it asks first."))
    return line
  }
  const stops = wouldStop()
  if (stops && stops.length === 0 && update.calm) {
    const line = el('div', 'reload-time')
    line.append(el('div', 'reload-head', 'Time to reload'), el('div', 'reload-sub', 'New version ready. Nothing is running.'), reloadButton('↻ Reload now', 'Reload this window. It checks once more that nothing is running.'))
    return line
  }
  const line = el('div', 'reload-wait')
  const top = el('div', 'reload-top')
  top.append(el('span', 'reload-head', 'Update waiting'), reloadButton('↻ Reload', 'Reload this window. It asks first if that would stop work.'))
  line.append(top)
  if (stops && stops.length) {
    const open = el('button', 'reload-sub')
    open.title = 'See what a reload would stop'
    open.append(document.createTextNode(`Turns green when ${stops.length} ${stops.length === 1 ? 'chat finishes' : 'chats finish'}`), chev(opened === 'reload'))
    open.addEventListener('click', () => toggle('reload'))
    line.append(open)
  } else line.append(el('div', 'reload-sub', stops ? 'Looks clear, checking…' : 'Checking what a reload would stop…'))
  return line
}

function drawStatus() {
  statusLine.replaceChildren(reloadLine())
  if (update && update.available) {
    const more = el('div', 'status-line')
    const get = el('button', 'status-go', update.busy ? 'Updating…' : 'Update')
    get.disabled = update.busy
    get.title = 'Downloads and installs the new version. It starts at your next reload.'
    get.addEventListener('click', () => vscode.postMessage({ type: 'update' }))
    more.append(dot('step'), document.createTextNode('A newer version is available'), get)
    statusLine.append(more)
  }
}

function reloadRows() {
  const stops = wouldStop()
  if (!stops || stops.length === 0 || opened !== 'reload' || !update || !update.pending) return [] // only there once it's asked for, from the amber box at the top
  return section('reload', 'A reload would stop', stops.length, 'Uploads and anything not started by a chat keep going', 'working', () => {
    const out = [secBar('Uploads and anything not started by a chat keep going')]
    for (const stop of stops) {
      const row = el('div', 'row tab')
      row.tabIndex = 0
      row.title = stop.tip || ''
      row.append(dot('working'), el('span', 'title', stop.title), el('span', 'age', ''), el('span', 'note', stop.why))
      if (stop.id) row.addEventListener('click', () => vscode.postMessage({ type: 'open', id: stop.id }))
      out.push(row)
    }
    return out
  })
}

function tabRow(tab) {
  const row = el('div', ['blocked', 'sitting', 'closable'].includes(tab.state) ? 'row tab full-note' : 'row tab')
  row.tabIndex = 0
  const [word, tip] = ROW_WORDS[tab.state] || []
  const tag = tab.tag || word
  row.title = [tab.title, [tag, tab.note].filter(Boolean).join(': '), tip].filter(Boolean).join('\n')
  const mark = dot(tab.tone)
  if (tab.state === 'working') mark.classList.add('live')
  row.append(mark, el('span', 'title', tab.title), el('span', 'age', tab.age))
  const note = el('span', 'note')
  if (tag) note.append(el('span', `tag text-${tab.tone}`, tag))
  if (tab.wakeText) note.append(el('span', 'tag text-step', tab.wakeText))
  if (tab.liveState) note.append(tab.liveState === 'needs' ? el('span', 'tag text-step', 'Stopped for your OK') : el('span', 'tag text-working', 'Still working'))
  note.append(document.createTextNode(tab.note))
  row.append(note)
  if (tab.state === 'closable' && tab.lastSaid) row.append(el('span', 'note', `You last said: “${tab.lastSaid}”`)) // so the call can be checked at a glance
  const buttons = []
  if (tab.state === 'later') {
    buttons.push(
      action('Remind', 'Pick a day for this to come back on its own', () => vscode.postMessage({ type: 'wake', id: tab.id })),
      shelfBack(tab),
    )
  } else if (tab.state === 'closed') {
    buttons.push(action('Later', 'Put it on the For later shelf, so it stays past 30 days', () => shelve(tab, true)))
  } else {
    if (tab.state === 'finished' || tab.state === 'closable') {
      buttons.push(action('Keep', 'Keep this tab: stop suggesting it can close', () => vscode.postMessage({ type: 'seen', id: tab.id, since: tab.since })))
    }
    buttons.push(action('Later', 'Put it on the For later shelf, out of your way', () => shelve(tab, true)))
  }
  const close = closeAction(tab)
  if (close) buttons.push(close)
  row.append(rowActs(tab, buttons))
  const go = () => vscode.postMessage({ type: tab.state === 'closed' ? 'reopen' : 'open', id: tab.id })
  row.addEventListener('click', go)
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter') go()
  })
  return row
}

// With a search up the section isn't showing, so a press shows it even if it was the one left open. The heading may be stuck far below where the section starts, so it goes to the start.
function toggleShip() {
  const showing = opened === 'ship' && !found
  if (found) clearSearch()
  opened = showing ? null : 'ship'
  remember()
  draw()
  document.getElementById('ship-spot').scrollIntoView({ block: showing ? 'nearest' : 'start' })
}

// The section headings carry each section's count. This is the one total: tabs really open in VS Code, shelved ones included, closed chats not.
function drawCounts() {
  counts.replaceChildren()
  if (!tabs) return
  const open = tabs.filter(tab => tab.isOpen).length
  const total = el('span', 'none', open === 0 ? 'No Claude tabs open' : `${open} ${open === 1 ? 'tab' : 'tabs'} open`)
  if (open) total.title = 'Claude tabs open in VS Code right now, including any on the For later shelf. Closed chats aren\'t counted.'
  counts.append(total)
}

function drawSearch() {
  const { query, hits } = found
  const top = el('div', 'found-top')
  const said =
    hits === undefined
      ? `Searching every tab for “${query}”…`
      : hits === null
        ? `Couldn't search for “${query}”. Try again.`
        : hits.length === 0
          ? `No tab mentions “${query}”, open or from the last 7 days`
          : hits.length === 1
            ? `1 tab mentions “${query}”`
            : `${hits.length} tabs mention “${query}”, newest first`
  const back = el('button', 'back', 'Back to all tabs')
  back.addEventListener('click', clearSearch)
  top.append(el('div', 'found-said', said), back)
  list.append(top)
  for (const hit of hits || []) {
    const times = !hit.isOpen ? 'not open' : hit.hits === 0 ? 'in its name' : hit.hits === 1 ? 'said once' : `said ${hit.hits} times`
    const row = el('div', 'row tab')
    row.tabIndex = 0
    row.title = hit.snippet
    row.append(dot(hit.isOpen ? 'working' : 'idle'), el('span', 'title', hit.title), el('span', 'age', `${hit.age} · ${times}`))
    const note = el('span', 'note')
    if (hit.who) note.append(el('span', `tag text-${hit.who === 'You' ? 'step' : 'working'}`, hit.who))
    note.append(document.createTextNode(hit.snippet))
    row.append(note)
    const go = () => vscode.postMessage({ type: 'open', id: hit.id })
    row.addEventListener('click', go)
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') go()
    })
    list.append(row)
  }
  if ((hits || []).some(hit => !hit.isOpen)) list.append(el('div', 'foot', "Click a tab that's not open and it comes back."))
}

const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// "8 PM" today, "Sat 8 PM" any other day.
function resetDay(ms) {
  const when = new Date(ms)
  const time = when.toLocaleTimeString([], when.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

// The plan's limits, always in view. The mark on a bar is how far through that limit's time you are, so a bar short of it is on track to last.
function drawUsage() {
  if (!usageBox) return
  usageBox.replaceChildren()
  const stale = usage && Date.now() - usage.at > 15 * 60_000 // say so rather than pass an old number off as current
  for (const limit of (usage && usage.limits) || []) {
    const used = Math.round(limit.percent)
    const when = stale ? `as of ${clock(usage.at)}` : limit.resets ? `resets ${resetDay(limit.resets)}` : ''
    const top = el('div', 'usage-top')
    top.append(el('span', 'usage-label', limit.label), el('span', 'usage-num', [`${used}%`, when].filter(Boolean).join(' · ')))
    const bar = el('div', 'usage-bar')
    const fill = el('div', `usage-fill tone-${{ warning: 'warn', critical: 'bad' }[limit.severity] || 'ok'}`)
    fill.style.width = `${Math.min(Math.max(limit.percent, 0), 100)}%`
    bar.append(fill)
    const tip = [`${limit.label}: ${used}% used.`]
    const gone = limit.resets && limit.windowMs ? 1 - (limit.resets - Date.now()) / limit.windowMs : -1
    if (gone >= 0 && gone <= 1) {
      const mark = el('div', 'usage-mark')
      mark.style.left = `${gone * 100}%`
      bar.append(mark)
      tip.push(`${Math.round(gone * 100)}% of the ${limit.window} has gone by, shown by the mark on the bar. If the bar stays short of the mark, it lasts until the reset.`)
    }
    if (limit.resets) tip.push(`Resets ${resetDay(limit.resets)}.`)
    tip.push(`Checked ${clock(usage.at)}.`)
    const row = el('div', 'usage-row')
    row.title = tip.join('\n')
    row.append(top, bar)
    usageBox.append(row)
  }
}

// A number in Mbps: 34, 2.4, 0.3. Under 0.05 is nothing to speak of.
const mbps = value => (value >= 10 ? String(Math.round(value)) : value >= 0.05 ? value.toFixed(1) : '0')

const sizeGB = value => (value >= 1000 ? `${(value / 1000).toFixed(1)} TB` : `${Math.round(value)} GB`)

// One meter, the same shape for CPU, GPU, memory and each drive, so they line up in three columns. The bar fills as it gets tighter, and its color says whether that matters.
function gaugeCell(label, figure, percent, tone, tip) {
  const cell = el('div', 'gauge')
  cell.title = tip
  const top = el('div', 'gauge-top')
  top.append(el('span', 'gauge-label', label), el('span', 'gauge-figure', figure))
  const bar = el('div', 'usage-bar')
  const fill = el('div', `usage-fill tone-${tone}`)
  fill.style.width = `${known(percent) ? percent : 0}%`
  bar.append(fill)
  cell.append(top, bar)
  return cell
}

const percentWords = percent => (known(percent) ? `${Math.round(percent)}%` : '…')

const busyTone = percent => (percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'ok')

// 25 Mbps carries a video call and a decent upload. Under 5, even small things drag.
const lineTone = value => (value >= 25 ? 'ok' : value >= 5 ? 'warn' : 'bad')

// Four steps, like the bars on a phone. Under -70 dBm is where it starts to cost speed.
function signalOf(rssi) {
  if (rssi >= -60) return { bars: 4, word: 'Strong', tone: 'ok' }
  if (rssi >= -70) return { bars: 3, word: 'Good', tone: 'ok' }
  if (rssi >= -80) return { bars: 2, word: 'Weak', tone: 'warn' }
  return { bars: 1, word: 'Very weak', tone: 'bad' }
}

function signalBars({ bars, tone }) {
  const box = el('span', `signal text-${tone}`)
  for (let step = 1; step <= 4; step++) box.append(el('span', step <= bars ? 'signal-bar on' : 'signal-bar'))
  return box
}

const tipped = (node, tip) => {
  node.title = tip
  return node
}

// The first row: are we connected, and how well. The link's figure swings too much, and drops whenever there's little to send, to say anything by itself, so it's only in the tip.
function linkRow(link) {
  const status = el('span', 'net-wide net-status')
  let tip = ''
  if (link.kind === 'Offline') status.append(dot('bad'), el('span', 'text-bad', 'Not connected'))
  else if (link.rate && known(link.rssi)) {
    const signal = signalOf(link.rssi)
    status.append(signalBars(signal), el('span', `text-${signal.tone}`, `${signal.word} signal`))
    tip = `Wi-Fi signal: ${signal.word.toLowerCase()} (${link.rssi} dBm)${link.band ? ` on ${link.band}` : ''}. Green is fine, orange is costing some speed, red is close to dropping.\nSending at ${link.rate} Mbps this moment, which drops when there's little to send, so it isn't a speed limit.`
  }
  else if (link.kind) status.append(dot('ok'), el('span', 'text-ok', 'Connected'))
  else status.textContent = '…'
  return [tipped(el('span', 'net-label', link.kind || 'Network'), tip), tipped(status, tip)]
}

function usingRow(net) {
  const tip = known(net) ? `Going through ${THIS} right now, in megabits a second: ${mbps(net.down)} down, ${mbps(net.up)} up.` : ''
  const label = tipped(el('span', 'net-label', 'Using now'), tip)
  if (!known(net)) return [label, el('span', 'net-wide', '…')]
  const number = (arrow, value) => tipped(el('span', value >= 0.05 ? 'net-num text-working' : 'net-num', `${arrow} ${mbps(value)}`), tip)
  return [label, number('↓', net.down), number('↑', net.up), tipped(el('span', 'net-unit', 'Mbps'), tip)]
}

function speedRow() {
  const test = el('button', 'speed-go', speed.busy ? 'Testing…' : 'Test')
  test.disabled = Boolean(speed.busy)
  test.title = "Runs macOS's own speed test, about 45 seconds. Anything uploading right now shares the line, so it reads low."
  test.addEventListener('click', () => vscode.postMessage({ type: 'speedtest' }))
  const label = el('span', 'net-label', 'Speed test')
  if (speed.busy) return [label, el('span', 'net-words', 'About 45 sec…'), test]
  if (speed.failed) return [label, el('span', 'net-words text-warn', "Didn't finish"), test]
  if (!speed.last) return [label, el('span', 'net-words', 'Not run yet'), test]
  const tip = `The most the line carried in a full test at ${resetDay(speed.last.at)}, on top of anything already running then. Green is 25 Mbps or more, orange is under 25, red is under 5.`
  const number = (arrow, value) => tipped(el('span', `net-num text-${lineTone(value)}`, `${arrow} ${mbps(value)}`), tip)
  return [tipped(label, tip), number('↓', speed.last.down), number('↑', speed.last.up), tipped(el('span', 'net-unit', 'Mbps'), tip), test]
}

function netTable() {
  const link = gauges.link || {}
  const table = el('div', 'net')
  table.append(...linkRow(link))
  if (link.kind !== 'Offline') table.append(...usingRow(gauges.net), ...(ON_WINDOWS ? [] : speedRow())) // Windows has no speed test of its own
  return table
}

function diskGrid() {
  const grid = el('div', 'gauge-grid disk-grid')
  for (const disk of gauges.disks) {
    const used = 100 * (1 - disk.freeGB / disk.totalGB)
    grid.append(gaugeCell(disk.name, `${sizeGB(disk.freeGB)} free`, used, disk.tone || 'ok', `${disk.name}: ${sizeGB(disk.freeGB)} free of ${sizeGB(disk.totalGB)}${disk.tone ? '. Getting full.' : ''}`))
  }
  return grid
}

// The Mac's meters, redrawn on their own every few seconds. Redrawing the whole list that often would drop whatever the mouse is over.
function drawGauges() {
  gaugeBox.replaceChildren()
  lowerBox.replaceChildren()
  if (!gauges) return
  const grid = el('div', 'gauge-grid')
  const isWindows = gauges.os === 'windows'
  const cpuTip = isWindows
    ? `CPU: ${known(gauges.cpu) ? `${Math.round(gauges.cpu)}% of everything the PC has` : 'reading…'}.\nOrange from 70%, red from 90%.`
    : `CPU: ${known(gauges.cpu) ? `${Math.round(gauges.cpu)}% of everything the Mac has` : 'reading…'}.\nSystem load ${gauges.load}. Heavy jobs start taking turns over 70, and the Mac counts as overloaded over 100.\nOrange from 70%, red from 90%.`
  grid.append(gaugeCell('CPU', percentWords(gauges.cpu), gauges.cpu, busyTone(gauges.cpu), cpuTip))
  const gpuTip = isWindows
    ? `GPU: ${gauges.gpu}% busy, going by its busiest part, the way Task Manager counts it. Video encoding is one of those parts, so a render shows here.\nOrange from 70%, red from 90%.`
    : `GPU: ${gauges.gpu}% busy. Hardware video encoding runs on its own chip and mostly doesn't show here, so a render can be going with this low.\nOrange from 70%, red from 90%.`
  if (known(gauges.gpu)) grid.append(gaugeCell('GPU', percentWords(gauges.gpu), gauges.gpu, busyTone(gauges.gpu), gpuTip))
  const memory = gauges.memory
  if (memory) {
    const tone = { warning: 'warn', critical: 'bad' }[memory.pressure] || 'ok'
    const memoryTip = isWindows
      ? `Memory: ${memory.usedGB.toFixed(1)} of ${Math.round(memory.totalGB)} GB in use. Orange from 85%, red from 95%.`
      : `Memory: ${memory.usedGB.toFixed(1)} of ${Math.round(memory.totalGB)} GB in use. macOS says pressure is ${memory.pressure}, and that's what the color follows: a Mac using most of its memory is normal.`
    grid.append(gaugeCell('Memory', percentWords(memory.percent), memory.percent, tone, memoryTip))
  }
  gaugeBox.append(grid)
  // Open apps sits between these two boxes (his order, Nov 5): meters, apps, storage, Wi-Fi last.
  if (gauges.disks && gauges.disks.length > 0) lowerBox.append(diskGrid())
  if (gauges.link) lowerBox.append(netTable())
}

function draw() {
  drawCounts()
  drawUsage()
  drawGauges()
  drawApps()
  drawStatus()
  list.replaceChildren()
  if (found) {
    list.append(...shipRows(), ...reloadRows()) // a search still showing mustn't swallow the ship count, or the answer to the amber box up top
    return drawSearch()
  }
  if (jobs && jobs.mac.warn) list.append(overloadBanner())
  if (boardMissing) list.append(el('div', 'hint', "Install the tab-board plugin so each chat can say what it's doing. See this extension's README."))
  if (!tabs) list.append(el('div', 'foot', "Looking at what's running…"))
  list.append(...shipRows(), ...reloadRows(), ...overlapRows(), ...onYou(), ...runningRows(), ...restingRows(), ...doneRows(), ...laterRows(), ...closedRows())
  if (jobs) {
    const time = new Date(jobs.updated * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    list.append(el('div', 'foot', `Updated ${time}`))
  }
  // What was open has emptied out: open the most useful thing left rather than show nothing. It stays moved, so a section that blinks away and back doesn't make the list jump.
  if (tabs && jobs && opened && !document.getElementById(`sec-${opened}`)) {
    opened = ['onyou', 'running', 'resting', 'done'].find(key => document.getElementById(`sec-${key}`)) || null
    remember()
    draw()
  }
}

function clearSearch() {
  box.value = ''
  boxClear.hidden = true
  found = undefined
  vscode.postMessage({ type: 'search', query: '' })
  draw()
}

box.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    const query = box.value.trim()
    if (!query) return clearSearch()
    found = { query, hits: undefined }
    vscode.postMessage({ type: 'search', query })
    window.scrollTo(0, 0)
    draw()
  } else if (event.key === 'Escape') {
    clearSearch()
    box.blur()
  }
})

box.addEventListener('input', () => {
  boxClear.hidden = box.value === ''
  if (box.value === '' && found) clearSearch()
})

boxClear.addEventListener('click', () => {
  clearSearch()
  box.focus()
})

window.addEventListener('message', ({ data }) => {
  if (data.type === 'gauges') {
    gauges = data.gauges
    speed = data.speed || {}
    return drawGauges()
  }
  if (data.type === 'tabs') {
    tabs = data.tabs
    boardMissing = data.hasBoard === false
  }
  else if (data.type === 'jobs') jobs = data.jobs
  else if (data.type === 'update') update = data.update
  else if (data.type === 'usage') usage = data.usage
  else if (data.type === 'shipped') {
    const press = shipping.get(`${data.id}:${data.since}`)
    if (press) Object.assign(press, { status: data.status, code: data.code })
    else if (data.kept) shipping.set(`${data.id}:${data.since}`, { status: data.status, code: data.code }) // from before this panel was reloaded or replaced
  }
  else if (data.type === 'found') {
    if (!found || found.query !== data.query) return
    found = { query: data.query, hits: data.hits === undefined ? null : data.hits }
  }
  draw()
})

draw()
vscode.postMessage({ type: 'ready' })
