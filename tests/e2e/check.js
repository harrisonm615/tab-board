// End to end, on a real Mac or PC: a real Claude Code session with the tab-board plugin, talking to mock-api.js, then the side bar's own code
// reading what that session left. Run in a throwaway home folder: it writes there.
//   node check.js <side bar folder> <claude program> <project folder> <API address>
// It prints one line per check and exits 1 if any failed.
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const [sideBar, claude, project, api] = process.argv.slice(2)
const isWindows = process.platform === 'win32'
const home = os.homedir()
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  // 1. A real chat, through the mock API
  const env = { ...process.env, ANTHROPIC_BASE_URL: api, ANTHROPIC_API_KEY: 'test-key-not-real', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const chat = childProcess.spawnSync(claude, ['-p', 'Say hello'], { cwd: project, env, encoding: 'utf8', timeout: 180_000, windowsHide: true })
  check('a Claude Code chat runs and answers', (chat.stdout || '').includes('Hello from the test chat'), (chat.stdout || chat.stderr || String(chat.error)).trim().slice(0, 200))

  // 2. The plugin wrote the chat's record where the side bar reads it
  const boardDir = path.join(home, '.claude', 'tab-board')
  let record
  for (let i = 0; i < 20 && !record; i++) {
    const files = fs.existsSync(boardDir) ? fs.readdirSync(boardDir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)) : []
    if (files.length) record = JSON.parse(fs.readFileSync(path.join(boardDir, files[0]), 'utf8'))
    else await new Promise(resolve => setTimeout(resolve, 500))
  }
  check('the plugin wrote the chat to ~/.claude/tab-board', Boolean(record), record ? `${record.state}: ${record.detail}` : `nothing in ${boardDir}`)
  if (!record) return
  check('the record has the chat title and its folder', record.title === 'Say hello' && path.resolve(record.cwd) === path.resolve(project), `${record.title} / ${record.cwd}`)
  check('the plugin judged the finished chat', record.state === 'finished', record.state)

  // A second chat that ends by asking the person something: the kind the side bar's sorter reads
  const asking = childProcess.spawnSync(claude, ['-p', 'Ask me a question'], { cwd: project, env, encoding: 'utf8', timeout: 180_000, windowsHide: true })
  let question
  for (let i = 0; i < 20 && !question; i++) {
    question = fs.readdirSync(boardDir).filter(name => name.endsWith('.json') && name !== `${record.id}.json`).map(name => JSON.parse(fs.readFileSync(path.join(boardDir, name), 'utf8'))).find(one => one.title === 'Ask me a question')
    if (!question) await new Promise(resolve => setTimeout(resolve, 500))
  }
  check('a chat that ends on a question is waiting on the person', Boolean(question && question.state === 'step'), question ? `${question.state}: ${question.detail}` : (asking.stdout || asking.stderr || '').slice(0, 160))

  // 3. The transcript sits where the plugin expects it, so a reloaded tab picks up its state
  const expected = path.join(home, '.claude', 'projects', record.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${record.id}.jsonl`)
  const projects = fs.readdirSync(path.join(home, '.claude', 'projects'))
  check("the transcript is where the plugin looks for it", fs.existsSync(expected), `${path.basename(path.dirname(expected))} vs ${projects.join(', ')}`)

  // 4. VS Code's record of the open Claude tabs, as the real editor keeps it, made with the same Python the side bar uses
  const core = require(path.join(sideBar, 'core.js'))
  const pythonFound = core.PYTHON === 'python3' || fs.existsSync(core.PYTHON)
  check('the side bar finds a Python', pythonFound, [core.PYTHON, ...core.PYTHON_ARGS].join(' '))
  const storage = isWindows
    ? path.join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage', 'testwindow')
    : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'testwindow')
  fs.mkdirSync(storage, { recursive: true })
  const open = [{ sessionId: record.id, title: 'Say hello' }, ...(question ? [{ sessionId: question.id, title: 'Ask me a question' }] : [])]
  const state = JSON.stringify({ panelTabSessions: open })
  const made = childProcess.spawnSync(core.PYTHON, [...core.PYTHON_ARGS, '-I', '-c',
    "import sqlite3, sys\ncon = sqlite3.connect(sys.argv[1])\ncon.execute('create table if not exists ItemTable (key text unique on conflict replace, value blob)')\ncon.execute('insert into ItemTable values (?, ?)', ('Anthropic.claude-code', sys.argv[2]))\ncon.commit()",
    path.join(storage, 'state.vscdb'), state], { encoding: 'utf8', windowsHide: true })
  check("a stand-in for VS Code's open-tabs list is in place", made.status === 0, made.stderr.trim().slice(0, 200))

  // 5. A job card, the way any chat or script reports a long job
  const cards = path.join(home, '.claude', 'progress')
  fs.mkdirSync(cards, { recursive: true })
  fs.writeFileSync(path.join(cards, 'test-render.json'), JSON.stringify({ name: 'Test render', text: 'Frame 40 of 100 · café', frac: 0.4, state: 'running', group: 'Tests' }))

  // 6. The side bar's own calls, the ones its panel draws from. Its sorter asks Claude too, so it gets the same stand-in
  Object.assign(process.env, { ANTHROPIC_BASE_URL: api, ANTHROPIC_API_KEY: 'test-key-not-real', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', BAR_QUIET: '1' })
  const tabs = await core.collect(['tabs', 'sorted'])
  const row = tabs && tabs.tabs && tabs.tabs.find(tab => tab.id === record.id)
  check('the side bar lists the chat as an open tab', Boolean(row && row.isOpen), row ? `${row.title}: ${row.state}, ${row.note}` : JSON.stringify(tabs).slice(0, 200))
  check('the side bar sees the plugin is installed', Boolean(tabs && tabs.hasBoard), String(tabs && tabs.hasBoard))
  const jobs = await core.collect([])
  const card = jobs && (jobs.groups || []).flatMap(group => group.rows || []).find(one => one.name === 'Test render')
  check('the side bar shows a job card, accents and all', Boolean(card && card.text === 'Frame 40 of 100 · café'), card ? card.text : JSON.stringify(jobs).slice(0, 200))
  const found = await core.collect(['search', 'hello'])
  const hits = found && (found.hits || found.tabs || found.results || found)
  check('search finds the chat by what was said in it', JSON.stringify(hits || '').includes(record.id), JSON.stringify(found).slice(0, 200))

  // The sorter runs in the background and leaves its answer for the next look
  const verdictsFile = path.join(home, '.claude', 'tab-triage', 'verdicts.json')
  let verdict
  for (let i = 0; i < 90 && !verdict; i++) {
    try {
      verdict = JSON.parse(fs.readFileSync(verdictsFile, 'utf8')).verdicts[question && question.id]
    } catch {}
    if (!verdict) await new Promise(resolve => setTimeout(resolve, 1000))
  }
  check("the side bar's sorter asks Claude about the chat and keeps the answer", Boolean(verdict && verdict.who === 'nobody'), verdict ? JSON.stringify(verdict).slice(0, 160) : 'no verdict in 90 s')
  const sorted = await core.collect(['tabs', 'sorted'])
  const after = sorted && sorted.tabs && question && sorted.tabs.find(tab => tab.id === question.id)
  check('the sorted list uses that answer', Boolean(after && after.why === 'Test verdict'), after ? JSON.stringify(after).slice(0, 200) : 'missing')

  // 7. The meters
  const { Gauges } = require(path.join(sideBar, 'gauges.js'))
  const gauges = new Gauges()
  await gauges.read()
  await new Promise(resolve => setTimeout(resolve, 1200))
  const reading = await gauges.read()
  const memoryOk = reading.memory && reading.memory.totalGB > 0 && reading.memory.percent > 0
  check('the meters read CPU and memory', typeof reading.cpu === 'number' && memoryOk, `cpu ${reading.cpu && reading.cpu.toFixed(0)}%, memory ${memoryOk && reading.memory.percent.toFixed(0)}%`)
  if (isWindows) check('on Windows the meters skip the Mac-only network line', reading.link === undefined && reading.os === 'windows', JSON.stringify(reading.disks))
}

main()
  .catch(error => check('the checks ran to the end', false, error.stack))
  .finally(() => {
    const failed = results.filter(ok => !ok).length
    console.log(`${results.length - failed} of ${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
  })
