// Tabs & Progress starts here, and this is all VS Code has to load. Everything else is in core.js, and this swaps that for the newest installed copy as soon as
// one appears, so a new version goes live in seconds with no reload, and no chat stops. Only a change to this file, or to what package.json tells VS Code, needs a
// reload: core.js notices that and lights the reload line. Keep this file small and rarely changed for that reason. It holds nothing about what the panel does.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

const COPY = /^hcmnj\.progress-sidebar-(\d+)\.(\d+)\.(\d+)$/ // VS Code unpacks a new copy under a dotted name and renames it when it's whole, so a match is a finished copy
const LOOK_EVERY_MS = 15_000

const versionOf = name => {
  const found = COPY.exec(name)
  return found ? found.slice(1).map(Number) : undefined
}

const isAhead = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// Every copy that can run this way, newest first. A copy older than the one VS Code started is only ever a way back from a copy that won't run.
function copies(own) {
  if (!versionOf(path.basename(own))) return [own] // not an installed copy
  let names = []
  try {
    names = fs.readdirSync(path.dirname(own))
  } catch {}
  const found = names
    .filter(name => versionOf(name) && fs.existsSync(path.join(path.dirname(own), name, 'core.js')))
    .sort((a, b) => (isAhead(versionOf(a), versionOf(b)) ? -1 : 1))
    .map(name => path.join(path.dirname(own), name))
  return found.length ? found : [own]
}

const newestFolder = (own, refused) => copies(own).find(folder => !refused.has(folder))

function activate(context) {
  const own = context.extensionPath
  const refused = new Set() // a copy that wouldn't start isn't tried again until the next reload
  const begin = folder => require(path.join(folder, 'core.js')).start({ vscode, context, folder, loaderFolder: own })
  let folder
  let live
  let view
  for (const copy of copies(own)) {
    try {
      live = begin(copy)
      folder = copy
      break
    } catch (error) {
      console.error(`Tabs & Progress: ${copy} wouldn't start`, error)
      refused.add(copy)
    }
  }
  if (!live) throw new Error('Tabs & Progress: no installed copy would start')

  const swap = () => {
    if (live.busy()) return // it'll still be there at the next look
    const target = newestFolder(own, refused)
    if (!target || target === folder) return
    try {
      require(path.join(target, 'core.js')) // a copy that won't even load stops here, with the running one untouched
    } catch (error) {
      console.error(`Tabs & Progress: ${target} wouldn't load`, error)
      refused.add(target)
      return
    }
    const before = folder
    live.stop()
    try {
      live = begin(target)
      folder = target
      if (view) live.attach(view)
    } catch (error) {
      console.error(`Tabs & Progress: ${target} wouldn't start`, error)
      refused.add(target)
      try {
        live.stop()
      } catch {}
      folder = before
      live = begin(before)
      if (view) live.attach(view)
    }
  }

  // Registered once and for good: VS Code holds on to the panel, and each copy just takes it over.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'hcmnj.progress',
      {
        resolveWebviewView(resolved) {
          view = resolved
          resolved.onDidDispose(() => {
            if (view === resolved) view = undefined
          })
          live.attach(resolved)
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  )
  const watch = setInterval(swap, LOOK_EVERY_MS)
  context.subscriptions.push({
    dispose: () => {
      clearInterval(watch)
      live.stop()
    },
  })
}

module.exports = { activate, newestFolder }
