# Tab board

See every Claude Code tab in VS Code at once, and find any tab by what was said in it.

If you keep a lot of Claude tabs open, it gets hard to tell which one is waiting on you, which one is finished, and where that conversation about invoices went. This adds a small band above the prompt and a full board you can open from any tab.

## What you get

- **A band above the prompt.** It names the other tabs that want you, with a button that jumps straight to each one, and counts the tabs that are working or ready to close.
- **The board.** Type `/tabs` to see every open tab, sorted into Needs you, Your move, Ready to close, Working, Waiting and Idle. Each one shows what it's doing or what it's waiting on. A tab that's ready to close says whether it's done, parked on something only you can do, or has gone quiet.
- **Search.** Use the box at the top of the board, or type `/tabs some words`, to find the tabs where those words were said, even if the tab's name says nothing about them. Every word has to appear, and "quotes" make a phrase. It looks through every open tab plus any chat from the last 7 days, and Open brings back a tab that isn't open anymore.
- **Mac notifications.** You get one when a tab needs you, stops on an error, or finishes a turn that ran at least 30 seconds.

## Install

Run this in Terminal:

```
claude plugin install tab-board --marketplace harrisonm615/tab-board
```

If Terminal says `claude` isn't found, you're only running Claude Code through the VS Code extension. This uses the extension's copy instead:

```
"$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | sort -V | tail -1)" plugin install tab-board --marketplace harrisonm615/tab-board
```

Then run **Developer: Reload Window** in VS Code so your tabs pick it up.

Clicking a notification only jumps to its tab if you also run `brew install terminal-notifier` and allow it under System Settings → Notifications. Without it, notifications still show up.

## What it needs

- A Mac. Jumping to tabs, notifications and the list of open tabs all rely on macOS.
- VS Code with an up-to-date Claude Code extension. It was built on version 2.1.314.
- `python3` for search. If your Mac doesn't have it, run `xcode-select --install`.

## Where your data goes

Tab states are saved in `~/.claude/tab-board/`, and search reads your chat history in `~/.claude/projects/`. Both stay on your computer.

The one thing sent out: when a turn ends, the tab's name, your last message and Claude's last reply go to Haiku on your own Claude account, which decides whether the tab is waiting on you or ready to close. That uses a small amount of your Claude usage.

The extension has no way to close a tab for you, so Open takes you there and you press ⌘W. **Claude Code: Reopen Closed Session** brings one back.

## Remove it

```
claude plugin uninstall tab-board@tab-board
```
