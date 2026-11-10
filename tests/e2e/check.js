// End to end, on a real Mac or PC: a real Claude Code session with the tab-board plugin, talking to mock-api.js, then the side bar's own code
// reading what that session left. Run in a throwaway home folder: it writes there.
//   node check.js <side bar folder> <claude program> <project folder> <API address>
//   node check.js reload <side bar folder>     once VS Code is running a chat with a long job (Windows): what a reload would stop
// It prints one line per check and exits 1 if any failed.
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const [sideBar, claude, project, api] = process.argv.slice(2)
const isWindows = process.platform === 'win32'
const repo = path.resolve(__dirname, '..', '..')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
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

  // 7. The meters. On Windows the network and GPU come from a helper that ends by itself once nobody asks, here after 8 seconds
  if (isWindows) process.env.BAR_METER_IDLE_S = '8'
  const { Gauges } = require(path.join(sideBar, 'gauges.js'))
  const gauges = new Gauges({ python: [core.PYTHON, ...core.PYTHON_ARGS] })
  await gauges.read()
  await wait(1200)
  let reading = await gauges.read()
  const memoryOk = reading.memory && reading.memory.totalGB > 0 && reading.memory.percent > 0
  check('the meters read CPU and memory', typeof reading.cpu === 'number' && memoryOk, `cpu ${reading.cpu && reading.cpu.toFixed(0)}%, memory ${memoryOk && reading.memory.percent.toFixed(0)}%`)
  if (isWindows) await windowsChecks(core, gauges, reading, env, question)
}

// What Windows gets beyond the basics: the network line and GPU, Open apps with its ×, notices, and (with `reload`) what a reload would stop
async function windowsChecks(core, gauges, first, env, question) {
  // Something to see on the network line: a real download between two looks
  const started = Date.now()
  const download = await fetch('https://codeload.github.com/harrisonm615/tab-board/zip/refs/heads/main').then(r => r.arrayBuffer()).catch(() => new ArrayBuffer(0))
  await wait(Math.max(0, 5000 - (Date.now() - started)))
  const reading = await gauges.read()
  const link = reading.link || {}
  check('the network line knows the way out', ['Wired', 'Wi-Fi', 'Network'].includes(link.kind), JSON.stringify(link))
  check('the network line counts a download', Boolean(reading.net && reading.net.down > 0), `${(download.byteLength / 1e6).toFixed(1)} MB fetched, ${JSON.stringify(reading.net)}`)
  const gpuCounters = childProcess.spawnSync('typeperf', ['-qx', 'GPU Engine'], { encoding: 'utf8', windowsHide: true }).stdout || ''
  const hasGpu = /Utilization Percentage/.test(gpuCounters)
  check(hasGpu ? 'the GPU meter reads Windows\' GPU counters' : 'with no GPU counters on this PC, the GPU meter stays off', hasGpu ? typeof reading.gpu === 'number' : reading.gpu === undefined, `gpu ${reading.gpu}; counters ${hasGpu ? 'present' : 'absent'}`)
  const helper = gauges.helper && gauges.helper.child
  await wait(18000)
  check('the meters helper ends by itself once nobody asks', Boolean(helper) && helper.exitCode !== null && gauges.helper.child === undefined, helper ? `exit ${helper.exitCode}` : 'never started')

  // Open apps: a real app, then its × button
  const notepad = childProcess.spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
  notepad.unref()
  let apps
  let pad
  for (let i = 0; i < 20 && !pad; i++) {
    await wait(1000)
    apps = await core.collect([])
    pad = apps && apps.apps && apps.apps.rows.find(row => /notepad/i.test(row.id))
  }
  const rows = (apps && apps.apps && apps.apps.rows) || []
  check('Open apps lists an app that was just opened', Boolean(pad), rows.map(row => `${row.name} (${row.text})`).join(', ') || JSON.stringify(apps && apps.apps))
  check("Open apps doesn't offer VS Code or File Explorer", !rows.some(row => /microsoft vs code|\\explorer\.exe$/i.test(row.id)), rows.map(row => row.id).join(', '))
  if (pad) {
    await core.collect(['quit', pad.id])
    let closed = false
    for (let i = 0; i < 20 && !closed; i++) {
      await wait(500)
      closed = !/notepad\.exe/i.test(childProcess.spawnSync('tasklist', ['/fi', 'imagename eq notepad.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout || '')
    }
    check('its × closes it', closed)
  }

  // Notices: the side bar's and the plugin's are the same script, and Windows shows it
  const python = [core.PYTHON, ...core.PYTHON_ARGS]
  const winsys = code => childProcess.spawnSync(python[0], [...python.slice(1), '-I', '-c', `import sys; sys.path.insert(0, sys.argv[1]); import winsys\n${code}`, sideBar], { encoding: 'utf8', windowsHide: true })
  const theirs = /const TOAST_PS = String\.raw`([\s\S]*?)`/.exec(fs.readFileSync(path.join(repo, 'hooks', 'register.tsx'), 'utf8'))
  const ours = winsys('import json; print(json.dumps(winsys.TOAST_PS))')
  // A checkout on Windows can have Windows line ends; the plugin itself reads its template with plain ones
  check("the plugin's notice is the same script as the side bar's", Boolean(theirs) && JSON.parse(ours.stdout || '""') === theirs[1].replace(/\r\n/g, '\n'), ours.stderr.slice(0, 200))
  const app = winsys('print(winsys.notice_app())').stdout.trim()
  const shown = winsys("print(winsys.notice('Shop sign', 'Your move', 'Red or blue? Café sign', 'vscode://anthropic.claude-code/open?session=test', 'tab-test'))")
  const inHistory = tag => {
    const script = `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${app}') | Where-Object { $_.Tag -eq '${tag}' }).Count`
    return childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  }
  check('a side bar notice shows in Windows notifications', shown.stdout.trim() === 'True' && inHistory('tab-test') === '1', `${app}: ${shown.stdout.trim()} ${shown.stderr.slice(0, 200)} history ${inHistory('tab-test')}`)

  // The plugin's own notice: with no side bar, a long turn that ends on a question gets one. This chat runs from a home folder with
  // no side bar in it, and the same Claude settings and plugins
  const bare = path.join(os.tmpdir(), 'home-without-side-bar')
  fs.mkdirSync(bare, { recursive: true })
  const alone = { ...env, USERPROFILE: bare, HOME: bare, CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') }
  // A headless chat ends the moment its answer is out, before the plugin's notice; a tab stays open. So this one is kept open the way a
  // tab is, by taking its messages as a stream, and is only closed once the notice has had time to go out
  const chat = childProcess.spawn(claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: project, env: alone, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  let said = ''
  chat.stdout.setEncoding('utf8')
  chat.stdout.on('data', chunk => (said += chunk))
  chat.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Take your time' } })}\n`)
  for (let i = 0; i < 120 && !said.includes('"type":"result"'); i++) await wait(1000)
  const bareBoard = path.join(bare, '.claude', 'tab-board')
  const findAsked = () => {
    const records = fs.existsSync(bareBoard) ? fs.readdirSync(bareBoard).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)) : []
    return records.map(name => JSON.parse(fs.readFileSync(path.join(bareBoard, name), 'utf8'))).find(one => one.title === 'Take your time')
  }
  let asked
  let shownCount = '0'
  for (let i = 0; i < 30 && shownCount !== '1'; i++) {
    await wait(1000)
    asked = findAsked()
    if (asked) shownCount = inHistory(asked.id)
  }
  chat.stdin.end()
  setTimeout(() => chat.kill(), 10_000).unref()
  check("the plugin's notice shows when a long chat ends by asking you something", shownCount === '1', asked ? `${asked.state}: ${asked.detail}; history ${shownCount}` : `no record: ${said.slice(-300)}`)
}

// Run once VS Code is open with a chat running a long job inside it (see open-panel): the side bar has to name that chat as what a reload would stop
async function reloadChecks(folder) {
  const core = require(path.join(folder, 'core.js'))
  let jobs
  let row
  for (let i = 0; i < 40 && !row; i++) {
    jobs = await core.collect([])
    row = jobs && Array.isArray(jobs.reload) && jobs.reload.find(job => /node/.test(job.what))
    if (!row) await wait(3000)
  }
  check('on Windows the side bar can tell what a reload would stop', Boolean(jobs && Array.isArray(jobs.reload)), JSON.stringify(jobs && jobs.reload))
  check('it names the chat running a long job, and the job', Boolean(row && row.title === 'Run a long job'), JSON.stringify(row || (jobs && jobs.reload)))
  if (!row) {
    // What Windows says is running under Claude, to see why not
    const dump = "import sys, json; sys.path.insert(0, sys.argv[1]); import winsys\nt = winsys.processes()\nfor pid, p in t.items():\n    if 'claude' in p['name'].lower() or 'bash' in p['name'].lower() or 'node' in p['name'].lower():\n        print(pid, p['parent'], p['secs'], round(p['cpu'], 1), p['path'], '|', p['cmd'][:300])"
    console.log(childProcess.spawnSync(core.PYTHON, [...core.PYTHON_ARGS, '-I', '-c', dump, folder], { encoding: 'utf8', windowsHide: true }).stdout)
    try {
      console.log('sessions:', fs.readdirSync(path.join(os.homedir(), '.claude', 'sessions')).join(', '))
    } catch {
      console.log('no ~/.claude/sessions folder')
    }
  }
}

;(sideBar === 'reload' ? reloadChecks(claude) : main())
  .catch(error => check('the checks ran to the end', false, error.stack))
  .finally(() => {
    const failed = results.filter(ok => !ok).length
    console.log(`${results.length - failed} of ${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
  })
