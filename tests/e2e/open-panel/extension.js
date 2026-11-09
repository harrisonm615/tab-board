// Test helper only: opens the Tabs & Progress side bar as a person would by clicking its icon, so a screenshot can show it.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

exports.activate = async () => {
  const out = process.env.PANEL_REPORT
  const note = text => out && fs.appendFileSync(out, `${new Date().toISOString()} ${text}\n`)
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.commands.executeCommand('workbench.view.extension.hcmnj-progress')
    note('opened the Tabs & Progress view')
    const own = vscode.extensions.getExtension('hcmnj.progress-sidebar')
    note(`side bar extension: ${own ? `${own.id} ${own.packageJSON.version} active=${own.isActive}` : 'not found'}`)
    setTimeout(() => {
      const again = vscode.extensions.getExtension('hcmnj.progress-sidebar')
      note(`after 15 s: active=${again && again.isActive}`)
    }, 15_000)
  } catch (error) {
    note(`failed: ${error && error.stack}`)
  }
}
