// Test helper only: opens the Tabs & Progress side bar as a person would by clicking its icon, so a screenshot can show it.
// With TEST_CLAUDE set, it also starts a chat inside VS Code that runs a long job, as a Claude tab would, so the side bar has
// something a reload would stop. That chat talks to the stand-in API at TEST_API.
const vscode = require('vscode')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

exports.activate = async () => {
  const out = process.env.PANEL_REPORT
  const note = text => out && fs.appendFileSync(out, `${new Date().toISOString()} ${text}\n`)
  if (process.env.TEST_CLAUDE) {
    const env = { ...process.env, ANTHROPIC_BASE_URL: process.env.TEST_API, ANTHROPIC_API_KEY: 'test-key-not-real', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const chat = childProcess.spawn(process.env.TEST_CLAUDE, ['-p', 'Run a long job', '--allowedTools', 'Bash'], { cwd: process.env.TEST_PROJECT, env, windowsHide: true, stdio: 'ignore' })
    chat.on('error', error => note(`the long-job chat didn't start: ${error.message}`))
    chat.on('exit', code => note(`the long-job chat ended with ${code}`))
    note(`started the long-job chat, pid ${chat.pid}`)
  }
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.commands.executeCommand('workbench.view.extension.hcmnj-progress')
    note('opened the Tabs & Progress view')
    const own = vscode.extensions.getExtension('hcmnj.progress-sidebar')
    note(`side bar extension: ${own ? `${own.id} ${own.packageJSON.version} active=${own.isActive}` : 'not found'}`)
    // Again a little later, in case a first-run box took the focus
    for (const wait of [15_000, 45_000]) {
      setTimeout(async () => {
        await vscode.commands.executeCommand('workbench.view.extension.hcmnj-progress')
        const again = vscode.extensions.getExtension('hcmnj.progress-sidebar')
        note(`after ${wait / 1000} s: active=${again && again.isActive}, view opened again`)
      }, wait)
    }
  } catch (error) {
    note(`failed: ${error && error.stack}`)
  }
}
