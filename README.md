# Tabs & Progress

One list in the VS Code side bar for every Claude Code chat: which ones need you, which are still working, and which look done. A search box finds a chat by what was said in it, even when its name says nothing about it.

It comes in two parts. The **side bar** is a VS Code extension, and the **tab-board plugin** is how each chat reports what it's doing. See [sidebar/README.md](sidebar/README.md) for everything the side bar does.

## Install

**On a Mac,** open Terminal and paste this line:

```
curl -fsSL https://raw.githubusercontent.com/harrisonm615/tab-board/main/install.sh | sh
```

Then press ⌘⇧P in VS Code and run **Developer: Reload Window**.

**On a Windows PC,** open PowerShell (press the Windows key, type PowerShell, press Enter) and paste this line:

```
irm https://raw.githubusercontent.com/harrisonm615/tab-board/main/install.ps1 | iex
```

Then press Ctrl+Shift+P in VS Code and run **Developer: Reload Window**.

Neither asks for a password, and neither needs admin rights. To read them first, open [install.sh](install.sh) or [install.ps1](install.ps1). A reload stops whatever your chats are running, so wait for a quiet moment. **Tabs & Progress** shows up as an icon on the left edge of the window.

## What it needs

- A Mac or a Windows PC.
- VS Code with an up-to-date Claude Code extension.
- Python. If your Mac doesn't have it, the installer opens Apple's box for the free developer tools; press Install. If your PC doesn't have it, the installer gets python.org's own copy (about 25 MB), checks it's signed by the Python Software Foundation, and puts it in your own Programs folder, just for you.

On Windows, everything works except the network speed test, since Windows has no speed test of its own. Notices are Windows notifications, and Open apps closes an app the way clicking its X does. The Wi-Fi line shows signal strength but not the band, because Windows only says which band through its Location permission, which the side bar never asks for.

## Updates

The side bar checks GitHub for a new version every 6 hours, and a line with an **Update** button appears at the top when there is one. That button updates the plugin too. You can also paste the install line again at any time.

## Where your data goes

Your chats are read on your computer. The one thing sent out goes to Haiku, Claude's smallest model, on your own Claude account: the last messages of a chat, to work out whether it's waiting on you or looks done. That uses a little of your plan and goes to the same place your chats already go. The full details are in [sidebar/README.md](sidebar/README.md#where-your-data-goes).

## Without the side bar

The plugin works alone. It adds a band above the prompt naming the tabs that want you, and `/tabs` opens a full board with search. To install only that:

```
claude plugin marketplace add harrisonm615/tab-board
claude plugin install tab-board@tab-board
```

If Terminal says `claude` isn't found, you're running Claude Code only through the VS Code extension, so use the install line above instead.

## Remove it

```
claude plugin uninstall tab-board@tab-board
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --uninstall-extension hcmnj.progress-sidebar
```

If `claude` isn't found, replace it with the extension's copy:

```
"$(ls -t ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | head -n 1)" plugin uninstall tab-board@tab-board
```
