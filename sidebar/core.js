// Tabs & Progress: every Claude chat and long job in one list inside the VS Code side bar, the same whichever chat you're in.
// Being part of the window, it moves, closes and goes behind other apps with it.
// The numbers come from collect.py beside this file: any job cards in ~/.claude/progress, plus that folder's jobs.py if this Mac has one.
// extension.js starts this and swaps it for the newest installed copy, so nothing here should hold on to anything start() can't stop.
// Build and install: ./build.py, see the top of that file.
let vscode // handed over by extension.js: require('vscode') only works from the folder VS Code itself loaded, and this can be a newer one
const use = api => {
  vscode = api
}
const { execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FINISHED_HOURS, pruneFinished } = require('./prune')
const { leaveNote, takeBack, wasTaken } = require('./ship')
const { Gauges, speedTest } = require('./gauges')

const IS_WINDOWS = process.platform === 'win32'

// Windows has no Python of its own. The installer puts python.org's in the person's own Programs folder, which comes first here;
// the py launcher is the fallback. A "python" on the PATH isn't trusted, since on Windows that's often a stand-in that opens the Store.
function windowsPython() {
  const newest = root => {
    try {
      const found = fs.readdirSync(root).filter(name => /^Python3\d+/i.test(name)).map(name => path.join(root, name, 'python.exe')).filter(fs.existsSync)
      return found.sort((a, b) => Number(/Python3(\d+)/i.exec(b)[1]) - Number(/Python3(\d+)/i.exec(a)[1]))[0]
    } catch {
      return undefined
    }
  }
  const local = process.env.LOCALAPPDATA && newest(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'))
  const shared = process.env.ProgramFiles && newest(process.env.ProgramFiles)
  const launcher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe')
  if (local || shared) return [local || shared]
  if (fs.existsSync(launcher)) return [launcher, '-3']
  return ['python']
}

// The Python to run the helpers with, as [program, ...arguments that come first]. On Windows, -X utf8 reads and writes the chats' words as UTF-8
// instead of the old code page. It has to be an argument: -I, which every helper runs under, ignores the PYTHONUTF8 setting.
const [PYTHON, ...PYTHON_ARGS] = IS_WINDOWS ? [...windowsPython(), '-X', 'utf8'] : [['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(fs.existsSync) || 'python3']
// On Windows: no console window flashing up every few seconds.
const QUIET = IS_WINDOWS ? { windowsHide: true } : {}
const COLLECT = path.join(__dirname, 'collect.py')

const collect = args =>
  new Promise(resolve => {
    execFile(PYTHON, [...PYTHON_ARGS, '-I', COLLECT, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000, ...QUIET }, (error, stdout) => {
      if (error) return resolve(undefined)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(undefined)
      }
    })
  })

const readUsage = () =>
  new Promise(resolve => {
    execFile(PYTHON, [...PYTHON_ARGS, '-I', path.join(__dirname, 'usage.py')], { timeout: 60_000, ...QUIET }, (error, stdout) => {
      try {
        resolve(error ? undefined : JSON.parse(stdout))
      } catch {
        resolve(undefined)
      }
    })
  })

// What VS Code itself reads when a window starts. If this differs from the copy it started with, only a reload can bring it in. Anything else swaps in by itself.
function shapeOf(folder) {
  try {
    const { main, activationEvents, engines, contributes } = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
    return JSON.stringify({ main, activationEvents, engines, contributes, loader: fs.readFileSync(path.join(folder, 'extension.js'), 'utf8') })
  } catch {
    return undefined
  }
}

const CALM_MS = 20_000 // how long nothing has to be running before the reload light comes on
const GAUGES_EVERY_MS = 5_000

// Who a reload would stop, by name: chats running a command, and chats in the middle of something. A chat doing both is one chat. Null if it can't tell.
function stopsFor(running, tabs) {
  if (!running || !tabs) return null
  const names = new Map()
  for (const job of running) names.set(job.id || job.what, job.title)
  for (const tab of tabs) {
    const state = tab.liveState || tab.state // a shelved chat can still be running
    if (state === 'working' || state === 'needs') names.set(tab.id, tab.title)
    else if (names.has(tab.id)) names.set(tab.id, tab.title)
  }
  return [...names.values()]
}

const UPDATE_BASE = process.env.BAR_UPDATE_BASE || 'https://raw.githubusercontent.com/harrisonm615/tab-board/main/sidebar'
const UPDATE_EVERY_MS = 6 * 3_600_000

function isNewer(a, b) {
  const [x, y] = [a, b].map(version => String(version).split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

// A typed date, at 9am. A date with no year means the next one to come.
function parseDay(text, now = new Date()) {
  const typed = text.trim()
  const day = new Date(/^\d{4}-\d{2}-\d{2}$/.test(typed) ? `${typed}T00:00` : typed)
  if (Number.isNaN(day.getTime())) return undefined
  if (day.getFullYear() < now.getFullYear()) day.setFullYear(now.getFullYear())
  if (day.getFullYear() > now.getFullYear() + 5) return undefined // a typo, not a plan
  day.setHours(9, 0, 0, 0)
  if (day < now) day.setFullYear(day.getFullYear() + 1)
  return day
}

function dayFromNow(days, now = new Date()) {
  const day = new Date(now)
  day.setDate(day.getDate() + days)
  day.setHours(9, 0, 0, 0)
  return day
}

const openTab = id =>
  // Claude's own command: brings up the tab, and brings back one that isn't running or open.
  Promise.resolve(vscode.commands.executeCommand('claude-vscode.primaryEditor.open', id)).catch(() =>
    vscode.env.openExternal(vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${id}`)),
  )

const SHELL_WAIT_MS = 15_000 // how long a new terminal gets to say it can report how its commands end

const shellOf = terminal =>
  new Promise(resolve => {
    if (terminal.shellIntegration) return resolve(terminal.shellIntegration)
    const timer = setTimeout(() => {
      heard.dispose()
      resolve(undefined)
    }, SHELL_WAIT_MS)
    const heard = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal !== terminal) return
      clearTimeout(timer)
      heard.dispose()
      resolve(event.shellIntegration)
    })
  })

// A plain terminal, for a window with no folder open. It says how the command ended through the shell's own reporting: the exit code, undefined if the terminal
// closed or couldn't tell, or 'terminal' if that reporting never came up, so nobody can say.
async function runInTerminal(command, title, cwd = os.homedir()) {
  const terminal = vscode.window.createTerminal({ name: `Ship: ${title}`, cwd })
  terminal.show(true)
  const shell = await shellOf(terminal)
  if (!shell) {
    terminal.sendText(command)
    return 'terminal'
  }
  return new Promise(resolve => {
    let run
    const finish = code => {
      ended.dispose()
      closed.dispose()
      resolve(code)
    }
    const ended = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.execution === run) finish(event.exitCode)
    })
    const closed = vscode.window.onDidCloseTerminal(gone => {
      if (gone === terminal) finish(undefined)
    })
    run = shell.executeCommand(command)
  })
}

// Where a command runs: the chat's own folder, which is what its relative paths assume, or home if that's gone.
function whereToRun(chatFolder) {
  try {
    if (chatFolder && fs.statSync(chatFolder).isDirectory()) return chatFolder
  } catch {}
  return os.homedir()
}

// Runs in a terminal you can see, and says how it ended. With no folder open VS Code can't run a task, so it goes to a plain terminal instead.
async function runVisibly(command, title, chatFolder) {
  const cwd = whereToRun(chatFolder)
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) {
    const task = new vscode.Task({ type: 'shell' }, folder, `Ship: ${title}`, 'Tabs & Progress', new vscode.ShellExecution(command, { cwd }))
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.New, focus: false, echo: true }
    let ended
    try {
      return await new Promise((resolve, reject) => {
        const early = new Map() // a very short command can end before VS Code has said which run is ours
        let run
        ended = vscode.tasks.onDidEndTaskProcess(event => {
          if (run === undefined) early.set(event.execution, event.exitCode)
          else if (event.execution === run) resolve(event.exitCode)
        })
        vscode.tasks.executeTask(task).then(execution => {
          run = execution
          if (early.has(run)) resolve(early.get(run))
        }, reject)
      })
    } catch {
    } finally {
      ended?.dispose()
    }
  }
  return runInTerminal(command, title, cwd)
}

const chatTabs = () =>
  vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel'))

// The tab-board plugin updates with the side bar, but only where it was installed as a plugin. A Mac that loads it another way would end up running it twice.
const updatePlugin = () =>
  new Promise(resolve => {
    let installed = ''
    try {
      installed = fs.readFileSync(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'), 'utf8')
    } catch {}
    if (!installed.includes('tab-board@tab-board')) return resolve()
    const root = path.join(os.homedir(), '.vscode/extensions')
    let copies = []
    try {
      copies = fs.readdirSync(root).filter(name => name.startsWith('anthropic.claude-code-')).map(name => path.join(root, name, 'resources', 'native-binary', IS_WINDOWS ? 'claude.exe' : 'claude')).filter(fs.existsSync)
    } catch {}
    copies.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    execFile(copies[0] || 'claude', ['plugin', 'update', 'tab-board@tab-board'], { timeout: 120_000, cwd: os.homedir(), ...QUIET }, () => resolve())
  })

const KEEP_RESULT_MS = 7 * 86_400_000

class Provider {
  // folder: the copy this code is from. loaderFolder: the copy VS Code itself started.
  constructor(context, { folder, loaderFolder }) {
    this.context = context
    this.folder = folder
    this.loaderFolder = loaderFolder
    this.update = { available: undefined, pending: false, busy: false }
    this.busy = { tabs: false, jobs: false, usage: false, gauges: false }
    this.meters = new Gauges({ python: [PYTHON, ...PYTHON_ARGS] })
    this.speed = { busy: false, failed: false, last: context.globalState.get('speedTest') }
    this.lastTabs = ''
    this.ticket = 0
    this.shipping = new Set()
  }

  resolveWebviewView(view) {
    this.view = view
    this.lastTabs = ''
    const web = view.webview
    const media = vscode.Uri.file(path.join(this.folder, 'media'))
    web.options = { enableScripts: true, localResourceRoots: [media] }
    const nonce = crypto.randomBytes(16).toString('hex')
    web.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${web.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'))}"></head>
<body><div id="top"><div id="status"></div><div id="search-box"><input id="search" type="text" placeholder="Search tabs, then press Enter" spellcheck="false"><button id="search-clear" type="button" title="Clear search" aria-label="Clear search" hidden>✕</button></div><div id="counts"></div></div><div id="mac"><div id="usage"></div><div id="gauges"></div><div id="apps"></div><div id="lower"></div></div>
<div id="list"></div><script nonce="${nonce}" src="${web.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'))}"></script></body></html>`

    const messages = web.onDidReceiveMessage(message => this.receive(message))
    const shown = view.onDidChangeVisibility(() => {
      if (!view.visible) return
      this.jobs()
      this.usage()
      this.startGauges()
    })
    // While it's hidden, tabs check less often, just to keep the count on its icon right. Jobs only matter when you can see them.
    let tick = 0
    const timers = [
      setInterval(() => {
        tick += 1
        if (view.visible || tick % 4 === 0) this.tabs()
      }, 5_000),
      setInterval(() => view.visible && this.jobs(), 15_000),
      setInterval(() => view.visible && this.usage(), 300_000),
      setInterval(() => view.visible && this.gauges(), GAUGES_EVERY_MS),
    ]
    const gone = view.onDidDispose(() => this.stop())
    this.letGo = () => {
      timers.forEach(clearInterval)
      messages.dispose()
      shown.dispose()
      gone.dispose()
      this.view = undefined
      this.letGo = undefined
    }
  }

  // Lets go of the panel, so a newer copy can take it over or it can close.
  stop() {
    this.letGo?.()
    this.meters.stop() // Windows: its meters helper. It would end by itself a minute later anyway
  }

  // Not a moment to swap this copy out: the result of what's underway would have nowhere to go.
  isBusy() {
    return this.shipping.size > 0 || this.update.busy || this.speed.busy
  }

  receive(message) {
    switch (message.type) {
      case 'ready':
        this.lastTabs = ''
        this.tabs()
        this.jobs()
        this.usage()
        this.postUpdate()
        this.startGauges()
        this.postKeptResults()
        break
      case 'speedtest':
        this.runSpeedTest()
        break
      case 'open':
        openTab(message.id)
        break
      case 'reopen':
        collect(['unclosed', message.id]).then(() => openTab(message.id))
        break
      case 'close':
        this.closeTab(message)
        break
      case 'next':
        this.next()
        break
      case 'wake':
        this.askWake(message.id)
        break
      case 'reload':
        this.reload()
        break
      case 'update':
        this.installUpdate()
        break
      case 'ship':
        this.ship(message)
        break
      case 'seen':
        collect(['seen', message.id, String(message.since)]).then(() => this.tabs())
        break
      case 'later':
        collect(message.on ? ['later', message.id, message.title || ''] : ['unlater', message.id]).then(() => {
          this.lastTabs = '' // the view moved it already: send the list even if it reads the same as the last one
          this.tabs()
        })
        break
      case 'star':
        collect(['star', message.id, message.on ? 'on' : 'off']).then(() => {
          this.lastTabs = '' // send the new order straight away
          this.tabs()
        })
        break
      case 'search':
        this.search(message.query)
        break
      case 'prio':
      case 'letrun':
        collect(message.type === 'prio' ? ['prio', message.key, message.step] : ['letrun', message.on ? 'on' : 'off']).then(() => {
          this.jobs()
          setTimeout(() => this.jobs(), 6_000) // throttle.py acts on it at its next 5 s check, so look again after that
        })
        break
      case 'quit':
        collect(['quit', ...message.ids]).then(() => {
          setTimeout(() => this.jobs(), 1_500) // apps take a moment to close, and longer if one asks about unsaved work
          setTimeout(() => this.jobs(), 6_000)
        })
        break
    }
  }

  sendTabs() {
    this.lastTabs = ''
    this.tabs()
  }

  // A press of Ship it, after its seconds to undo. What goes is read fresh from the list, not from the page, so a chat that has moved on since the button was drawn gets nothing.
  async ship({ id, since }) {
    const key = `${id}:${since}`
    if (this.shipping.has(key)) return
    this.shipping.add(key)
    const say = (status, code) => {
      this.keepResult(key, id, since, status, code)
      this.view?.webview.postMessage({ type: 'shipped', id, since, status, code })
    }
    try {
      const data = await collect(['tabs', 'sorted'])
      const tab = data && data.tabs.find(other => other.id === id && other.since === since && other.ship)
      if (!data) say('failed') // couldn't look, which isn't the same as the chat having moved on
      else if (!tab) say('moved')
      else if (tab.ship === 'command') await this.runShip(tab, say)
      else await this.replyShip(tab, say)
    } catch {
      say('failed')
    } finally {
      this.shipping.delete(key)
    }
  }

  // A press that didn't plainly work stays on its tile, even once this panel has been reloaded or replaced.
  keepResult(key, id, since, status, code) {
    const kept = { ...this.context.globalState.get('shipResults', {}) }
    if (status === 'failed' || status === 'handed') kept[key] = { id, since, status, code, at: Date.now() }
    else delete kept[key]
    for (const [other, result] of Object.entries(kept)) if (Date.now() - result.at > KEEP_RESULT_MS) delete kept[other]
    this.context.globalState.update('shipResults', kept)
  }

  postKeptResults() {
    for (const { id, since, status, code } of Object.values(this.context.globalState.get('shipResults', {}))) this.view?.webview.postMessage({ type: 'shipped', id, since, status, code, kept: true })
  }

  async replyShip(tab, say) {
    const note = leaveNote(tab.id, tab.since, 'ship')
    if (!tab.awake) openTab(tab.id) // a chat that isn't running starts when its tab opens, and finds the note then
    if (await wasTaken(note, tab.awake ? 15_000 : 60_000)) return say('sent')
    takeBack(note)
    await vscode.env.clipboard.writeText('ship it')
    openTab(tab.id)
    vscode.window.showInformationMessage('That chat didn\'t take the button, so I opened it. "ship it" is on your clipboard: paste it and press Enter.')
    say('copied')
  }

  async runShip(tab, say) {
    const code = await runVisibly(tab.shipCommand, tab.title, tab.shipFolder)
    if (code === 'terminal') return say('handed') // it's running, but nobody can say how it ends, so the tile stays until the chat is shelved or closed
    if (Number.isInteger(code)) {
      const note = leaveNote(tab.id, tab.since, 'ran', code) // so the chat can check the result. One that's not running just doesn't hear
      setTimeout(() => takeBack(note), 60_000)
    }
    if (code === 0) {
      await collect(['seen', tab.id, String(tab.since)])
      this.sendTabs()
    }
    say(code === 0 ? 'done' : 'failed', code)
  }

  // VS Code doesn't say which chat a tab belongs to, so the name is all there is to go on. It goes by a fresh look rather than what the page was drawn with.
  // Only a name that fits the chat's own, and that one open tab and no other chat has, closes. Anything else opens the tab rather than guess.
  async closeTab({ id, title }) {
    const fresh = await collect(['tabs'])
    const row = fresh && fresh.tabs.find(tab => tab.id === id)
    if (row && ['working', 'waiting', 'needs'].includes(row.liveState || row.state)) {
      vscode.window.showInformationMessage('That chat is in the middle of something, so I left it open.')
      return this.sendTabs()
    }
    const sure = row && row.labelFits && !fresh.tabs.some(tab => tab.id !== id && tab.isOpen && tab.label === row.label)
    const same = sure ? chatTabs().filter(tab => tab.label === row.label) : []
    if (same.length === 1 && (await vscode.window.tabGroups.close(same[0], true))) await collect(['closed', id, title || ''])
    else {
      openTab(id)
      vscode.window.showInformationMessage("I couldn't tell for sure which tab that was, so I opened it instead. Press ⌘W to close it.")
    }
    this.sendTabs()
  }

  // Goes down the On you list in its order, then starts over. Answering a tab takes it off the list, so this keeps moving forward.
  async next() {
    const all = this.latestTabs || ((await collect(['tabs', 'sorted'])) || {}).tabs || []
    const mine = all.filter(tab => tab.state === 'needs' || tab.state === 'step').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    if (mine.length === 0) return vscode.window.showInformationMessage('Nothing is waiting on you.')
    const tab = mine[(mine.findIndex(other => other.id === this.lastNext) + 1) % mine.length]
    this.lastNext = tab.id
    openTab(tab.id)
  }

  async askWake(id) {
    const now = new Date()
    const toMonday = ((8 - now.getDay()) % 7) || 7
    const picks = [
      { label: 'Tomorrow', when: dayFromNow(1, now) },
      { label: 'Monday', when: dayFromNow(toMonday, now) },
      { label: 'In 2 weeks', when: dayFromNow(14, now) },
      { label: 'In a month', when: dayFromNow(30, now) },
      { label: 'Pick a date…', typed: true },
      { label: 'No date', off: true },
    ]
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'When should this come back?' })
    if (!pick) return
    let when = pick.when
    if (pick.typed) {
      const typed = await vscode.window.showInputBox({
        prompt: 'What day should it come back?',
        placeHolder: 'Dec 1',
        validateInput: text => (text.trim() && !parseDay(text) ? "That doesn't read as a date. Try Dec 1." : undefined),
      })
      if (!typed || !typed.trim()) return
      when = parseDay(typed)
    }
    await collect(['wake', id, pick.off ? 'off' : String(when.getTime())])
    this.sendTabs()
  }

  // Looks again rather than trust the light. With nothing running it just goes: the button was the ask.
  async reload() {
    const [data, fresh] = await Promise.all([collect([]), collect(['tabs', 'sorted'])])
    const stops = stopsFor(data && data.reload, fresh && fresh.tabs)
    const pending = this.reloadNeeded()
    if (stops && stops.length === 0 && pending) return vscode.commands.executeCommand('workbench.action.reloadWindow')
    const question = !stops
      ? "I couldn't check what's running. Reload anyway?"
      : stops.length
        ? `This would stop work in ${stops.length} ${stops.length === 1 ? 'chat' : 'chats'}: ${stops.slice(0, 3).join(', ')}${stops.length > 3 ? ' and more' : ''}. Reload anyway?`
        : "No update is waiting, so there's no need. Reload anyway?"
    if ((await vscode.window.showInformationMessage(question, { modal: true }, 'Reload')) === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow')
  }

  // Calm means nothing would stop, and it's stayed that way for a little while.
  judgeReload() {
    const stops = stopsFor(this.latestReload, this.latestTabs)
    if (!stops || stops.length > 0) this.calmSince = 0
    else if (!this.calmSince) this.calmSince = Date.now()
    this.update.calm = Boolean(this.calmSince) && Date.now() - this.calmSince >= CALM_MS
    if (!this.reloadLight) return
    const time = this.update.pending && this.update.calm
    this.reloadLight.text = time ? '$(refresh) Reload now' : '$(refresh) Update waiting'
    this.reloadLight.tooltip = time
      ? 'A new version of Tabs & Progress is ready, and nothing is running that a reload would stop.'
      : "A new version of Tabs & Progress is ready, but a reload would stop work right now, so it asks first. This lights up when it's clear."
    this.reloadLight.backgroundColor = time ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    if (this.update.pending) this.reloadLight.show()
    else this.reloadLight.hide()
  }

  // Runs with the panel collapsed, or never opened since a reload, so a new version can't sit there unnoticed. An open panel's own checks already do this.
  // It only looks at what's running while a version is waiting.
  async lookForUpdate() {
    if (this.view && this.view.visible) return
    if (this.reloadNeeded()) {
      const [data, fresh] = await Promise.all([collect([]), collect(['tabs', 'sorted'])])
      this.latestReload = data && data.reload
      this.latestTabs = fresh && fresh.tabs
    }
    this.postUpdate()
  }

  // Most versions swap in by themselves. This is for the rare one VS Code has to start for itself.
  reloadNeeded() {
    const [mine, started] = [shapeOf(this.folder), shapeOf(this.loaderFolder)]
    return Boolean(mine && started && mine !== started)
  }

  newestInstalled() {
    const folder = path.dirname(this.folder)
    let newest = this.running()
    try {
      for (const name of fs.readdirSync(folder)) {
        const found = /^hcmnj\.progress-sidebar-(\d+\.\d+\.\d+)/.exec(name)
        if (found && isNewer(found[1], newest)) newest = found[1]
      }
    } catch {}
    return newest
  }

  running() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.folder, 'package.json'), 'utf8')).version
    } catch {
      return '0.0.0'
    }
  }

  postUpdate() {
    this.update.pending = this.reloadNeeded()
    this.judgeReload()
    if (this.view) this.view.webview.postMessage({ type: 'update', update: this.update })
  }

  // Asks GitHub for the newest version's number, nothing more. A failed check just means no line until the next one.
  async checkUpdate() {
    try {
      const answer = await fetch(`${UPDATE_BASE}/package.json`, { signal: AbortSignal.timeout(15_000) })
      if (!answer.ok) return
      const { version } = await answer.json()
      this.update.available = version && isNewer(version, this.newestInstalled()) ? version : undefined
      this.postUpdate()
    } catch {}
  }

  async installUpdate() {
    if (!this.update.available || this.update.busy) return
    this.update.busy = true
    this.postUpdate()
    const file = path.join(os.tmpdir(), `progress-sidebar-${this.update.available}.vsix`)
    try {
      const answer = await fetch(`${UPDATE_BASE}/progress-sidebar.vsix`, { signal: AbortSignal.timeout(120_000) })
      const bytes = Buffer.from(await answer.arrayBuffer())
      if (!answer.ok || bytes.subarray(0, 2).toString() !== 'PK') throw new Error('not an extension file')
      fs.writeFileSync(file, bytes)
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file))
      await updatePlugin()
      this.update.available = undefined
    } catch {
      vscode.window.showWarningMessage("The update didn't download. It'll be offered again, or try it from the same button.")
    }
    fs.rmSync(file, { force: true })
    this.update.busy = false
    this.postUpdate()
  }

  async tabs() {
    if (this.busy.tabs || !this.view) return
    this.busy.tabs = true
    const data = await collect(['tabs', 'sorted'])
    this.busy.tabs = false
    if (!data || !this.view) return
    this.latestTabs = data.tabs
    const json = JSON.stringify(data.tabs)
    if (json === this.lastTabs) return
    this.lastTabs = json
    const waiting = data.tabs.filter(tab => tab.state === 'needs' || tab.state === 'step').length
    this.view.badge = waiting ? { value: waiting, tooltip: `${waiting} waiting on you` } : undefined
    const toShip = data.tabs.filter(tab => tab.ship && tab.state === 'step').length
    if (this.button) {
      this.button.text = toShip ? `$(rocket) ${toShip} to ship` : '$(list-unordered) Tabs'
      this.button.color = toShip ? new vscode.ThemeColor('charts.green') : undefined // green like the panel's Ready to ship. VS Code only allows amber or red behind a bottom-bar button.
    }
    this.view.webview.postMessage({ type: 'tabs', tabs: data.tabs, hasBoard: data.hasBoard })
  }

  // Each look starts a small Claude process for a second, and the number moves slowly, so it's every 5 minutes and only while showing.
  async usage() {
    if (this.busy.usage || !this.view) return
    this.busy.usage = true
    const data = await readUsage()
    this.busy.usage = false
    if (data && this.view) this.view.webview.postMessage({ type: 'usage', usage: data })
  }

  // CPU and network are measured between two looks, so the second look comes a second later rather than leaving them blank for the full wait.
  startGauges() {
    this.gauges()
    setTimeout(() => this.gauges(), 1_000)
  }

  async gauges() {
    if (this.busy.gauges || !this.view) return
    this.busy.gauges = true
    this.latestGauges = await this.meters.read().catch(() => this.latestGauges)
    this.busy.gauges = false
    this.postGauges()
  }

  postGauges() {
    if (this.view && this.latestGauges) this.view.webview.postMessage({ type: 'gauges', gauges: this.latestGauges, speed: this.speed })
  }

  async runSpeedTest() {
    if (this.speed.busy) return
    this.speed = { ...this.speed, busy: true, failed: false }
    this.postGauges()
    const result = await speedTest()
    if (result) this.context.globalState.update('speedTest', result)
    this.speed = { busy: false, failed: !result, last: result || this.speed.last }
    this.postGauges()
  }

  async jobs() {
    if (this.busy.jobs || !this.view) return
    this.busy.jobs = true
    const data = await collect([])
    this.busy.jobs = false
    if (!data || !this.view) return
    this.latestReload = data.reload
    const before = this.context.globalState.get('doneAt', {})
    const { groups, doneAt } = pruneFinished(data.groups, before, Date.now())
    if (JSON.stringify(doneAt) !== JSON.stringify(before)) this.context.globalState.update('doneAt', doneAt)
    this.view.webview.postMessage({ type: 'jobs', jobs: { ...data, groups, finishedHours: FINISHED_HOURS } })
    this.postUpdate()
  }

  // Runs only on Enter: each search reads every transcript, hundreds of MB. Only the newest search counts.
  async search(query) {
    const ticket = ++this.ticket
    if (!query) return
    const data = await collect(['search', query])
    if (ticket !== this.ticket || !this.view) return
    this.view.webview.postMessage({ type: 'found', query, hits: data ? data.hits : undefined })
  }
}

// Everything VS Code needs from this copy, for extension.js to start and stop. If it can't start, it takes back what it had registered, so the copy before it can run again.
function start({ vscode: api, context, folder, loaderFolder }) {
  use(api)
  const provider = new Provider(context, { folder, loaderFolder })
  const parts = []
  const keep = part => (parts.push(part), part)
  try {
    // The arrow in the panel's header. The icon on the left edge stays, with its count, to bring the panel back.
    keep(vscode.commands.registerCommand('hcmnj.progress.collapse', () => vscode.commands.executeCommand('workbench.action.closeSidebar')))
    keep(vscode.commands.registerCommand('hcmnj.progress.toggle', () =>
      vscode.commands.executeCommand(provider.view?.visible ? 'workbench.action.closeSidebar' : 'hcmnj.progress.focus'),
    ))
    keep(vscode.commands.registerCommand('hcmnj.progress.expand', () => vscode.commands.executeCommand('hcmnj.progress.focus')))
    keep(vscode.commands.registerCommand('hcmnj.progress.next', () => provider.next()))
    keep(vscode.commands.registerCommand('hcmnj.progress.reload', () => provider.reload()))
    const firstCheck = setTimeout(() => provider.checkUpdate(), 30_000)
    const laterChecks = setInterval(() => provider.checkUpdate(), UPDATE_EVERY_MS)
    const updateWatch = setInterval(() => provider.lookForUpdate(), 60_000)
    keep({ dispose: () => (clearTimeout(firstCheck), clearInterval(laterChecks), clearInterval(updateWatch)) })
    // A button in the bottom bar that's always there: opens the panel, or collapses it if it's showing.
    const button = keep(vscode.window.createStatusBarItem('hcmnj.progress.button', vscode.StatusBarAlignment.Right, 1000))
    button.name = 'Tabs & Progress'
    button.text = '$(list-unordered) Tabs'
    button.tooltip = 'Open or collapse Tabs & Progress'
    button.command = 'hcmnj.progress.toggle'
    button.show()
    provider.button = button
    // The same signal for when the panel is collapsed: nothing when no reload is needed, plain while an update waits, lit when it's time. judgeReload sets the words.
    const reloadLight = keep(vscode.window.createStatusBarItem('hcmnj.progress.reloadLight', vscode.StatusBarAlignment.Right, 1001))
    reloadLight.name = 'Reload to update'
    reloadLight.command = 'hcmnj.progress.reload'
    provider.reloadLight = reloadLight
    provider.postUpdate()
    // A chat's hand-made "Safe to reload?" job card, from before the line at the top of the panel. Its watcher stopped with the reload that started this copy.
    fs.rm(path.join(os.homedir(), '.claude/progress/reload-watch.json'), { force: true }, () => {})
    // Show it the first time only, without taking the keyboard from whatever is being typed. After that it stays as it's left.
    if (!context.globalState.get('shownOnce')) {
      context.globalState.update('shownOnce', true)
      vscode.commands.executeCommand('hcmnj.progress.focus', { preserveFocus: true })
    }
  } catch (error) {
    parts.forEach(part => part.dispose())
    throw error
  }
  return {
    version: provider.running(),
    attach: view => provider.resolveWebviewView(view),
    busy: () => provider.isBusy(),
    stop: () => {
      provider.stop()
      parts.forEach(part => part.dispose())
    },
  }
}

module.exports = { start, use, isNewer, parseDay, Provider, runVisibly, runInTerminal, stopsFor, shapeOf, PYTHON, PYTHON_ARGS, collect }
