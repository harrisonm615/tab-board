# Tabs & Progress

One list in the VS Code side bar for every Claude Code chat and long-running job, the same whichever chat you're in. It isn't about any particular kind of work: a chat doing a deploy, a bug fix or a video render all show up the same way.

## What you get

One section is open at a time, so the whole list fits on the screen. A shut section still shows its count and a dot for the most pressing thing in it. The overload warning always shows, and Ready to ship is the first section, in bold green with a green count, and its heading stays on screen as you scroll.

There are seven sections, and every row says what it is, so a chat at work and a job on the Mac can't be mixed up:

- **Ready to ship:** finished work that only needs your OK. See below.
- **On you:** short tiles for what really needs you, with any date first, then the ask and how long it's been sitting. Hover for the whole ask. Claude's order comes first, marked as Claude's, and a star puts your own pick above it.
- **Running:** what's moving now. A failed or stuck job comes first, then anything with a turn number, in turn order, then chats, then jobs. The heading counts chats and jobs apart; with something stuck it shows that and a total, and the split moves to its tip. Turn order for when the Mac overloads is one line at the top, and it opens by itself when jobs are being slowed. It numbers only heavy work, since light work doesn't take turns; light work is listed under the line with nothing to press.
- **Resting:** chats on hold (someone or something else goes first), jobs waiting for their time, chats that have gone quiet (something's still open) and idle chats.
- **Done:** Ready to close?, then chats that look done, then finished jobs.
- **For later:** chats you've shelved on purpose, with their tabs open or closed. They stay until you take them off.
- **Closed:** every chat closed in the last 30 days, newest first.

Nothing is listed twice. A job and its chat count as one thing, and a job's row opens its chat. A finished job only gets a row if its chat isn't listed anywhere, or if it finished after you closed its chat, since you couldn't have seen that in the chat. In Running, Resting and Done, a job still going stands in for its chat. A chat with an ask for you keeps its tile even while its job runs, because the ask and the job are two different things. An open Turn order takes its rows out of the list under it.

Above them:

- **This Mac, under Claude usage:** CPU, GPU and memory meters, your open apps, free space on each drive, then the Wi-Fi signal and what's moving over the network right now. Hover over any of them for more. Colors mean the same thing all over the panel: green is fine or finished, blue is moving right now, orange is your turn or getting tight, red is trouble, and grey is resting. **Test** runs macOS's own speed test, about 45 seconds, and only when you press it. The meters run only while the panel is showing, and they scroll away with the list, so a long section gets the whole panel.

And the rest:

- **Click any chat** to go to it.
- **Ready to close?** Chats Claude suggests you could close, each with what got finished and the last thing you said, so you can check the call at a glance. Claude has to have read the chat and found nothing left for anyone, it has to have sat for at least 6 hours, and no command can still be running under it. It's only ever a suggestion, and it's careful on purpose, so most finished chats won't be on it. **Keep** stops one being suggested.
- **Close from the list:** hover over a chat, press the small **⋯** at its top right, then **Close**. Nothing ever closes on its own, and chats in the middle of something don't offer it. VS Code doesn't say which chat a tab belongs to, so it goes by the tab's name: if that doesn't add up, it opens the tab for you to close with ⌘W instead of guessing. **Closed** keeps every chat you've closed for 30 days, however you closed it, and a click brings it back with its whole history.
- **Updates go live by themselves:** a newly installed version takes over the panel within about 15 seconds, with no reload and no chat stopped. A copy that won't load is skipped. Only a version that changes what VS Code itself reads at startup needs a reload.
- **Reload, first thing in the panel:** three looks you can tell apart at a glance. A faint **No reload needed** when there's nothing new, with a small ↻ that asks first. An amber **Update waiting** box when a new version is ready but a reload would stop work; click its second line to see which chats. A solid green **Time to reload** band with a big **Reload now** button once nothing has been running for 20 seconds, and that one goes straight away. The bottom bar says the same for when the panel is collapsed: nothing, then **Update waiting**, then a lit **Reload now**. It keeps checking while collapsed, once a minute.
- **Time left:** each running job shows about how long it has left, the turn order shows when each job should finish in its current order, and the Running section shows when everything will be done. The times come from the job itself (an upload's own estimate), how fast its meter has moved in the last hour, or what its chat said. A job with none of those says it has no estimate, and the total says what it left out. The order only changes the times while the Mac is overloaded and jobs are taking turns. A job running longer than 12 hours is named rather than added to the total.
- **Same files:** a warning when two chats that are both still working have edited the same file in the last 30 minutes. It goes away by itself once either chat stops working or the edits are over 30 minutes old. It only sees edits made through Claude's edit tools, so a file changed by a script won't show.
- **Next:** press ⌃⌘N or the Next button to go to the next chat waiting on you.
- **Updates:** when a newer version is out, a line with an **Update** button appears at the top.
- **Notices that mean something:** a sound only when a chat stops for your OK or hits an error, a date is close, or a new ask has a client, money or something public riding on it.
- **Search:** type words and press Enter to find the chat where they were said, including closed chats from the last 7 days. Click one to bring it back. The ✕ in the box clears it.
- **For later:** a shelf at the bottom for chats you want to keep but aren't working on. See below.
- **Claude usage:** a bar at the top for how much of your plan's limit is used and when it resets, with a mark for how far through the week you are. It shows only on a Claude plan, not with an API key.
- **Long jobs:** anything that reports itself shows a progress bar. Finished ones fold into one small line and clear themselves after 12 hours. Click one to open the chat it belongs to.
- **A count on its tab** of how many chats are waiting on you, so you can see it even when another panel is showing.
- **A Tabs button in the bottom bar** that brings the panel back if you close it.

## Install

You need a Mac, VS Code with the Claude Code extension, and `python3`. If macOS offers to install developer tools the first time, say yes: that's how it gets `python3`.

1. Open Terminal and paste this line. It installs this side bar and the tab-board plugin, which is how each chat reports what it's doing:
   ```
   curl -fsSL https://raw.githubusercontent.com/harrisonm615/tab-board/main/install.sh | sh
   ```
2. Run **Developer: Reload Window** in VS Code. A reload stops whatever your chats are running, so wait for a quiet moment. **Tabs & Progress** gets an icon on the left edge of the window. Click that icon, press ⌘B, or use the arrow in the panel's header to collapse it; the icon stays with the waiting count.

## Long jobs

Chats started after you install know to do this by themselves when a job will run more than a few minutes. Your own scripts can do it too, by keeping one small file per job at `~/.claude/progress/<name>.json`:

```json
{"name": "Deploy site", "text": "Step 3 of 5", "frac": 0.6, "state": "running", "group": "Builds"}
```

| Field | What it's for |
| --- | --- |
| `name` | Required. What the job is. |
| `state` | `running`, `wait`, `done` or `bad`. |
| `text` | Optional. One short line about where it's at. |
| `frac` | Optional. Progress from 0 to 1, which draws the bar. |
| `mins_left` | Optional. Your best guess at the minutes left, used until the bar has moved enough to measure its speed. |
| `group` | Optional. The heading it goes under. Without one it goes under Jobs. |

A running job with no update for 30 minutes is flagged, in case it stopped without saying so. Files untouched for 7 days are ignored.

Clicking a job opens the chat that last wrote its file. The side bar works that out from the chats' own tool calls (commands that write the file, or a script they wrote that does), remembered in `~/.claude/tab-triage/card-chats.json`. A file written only by something outside Claude has no chat, so its row isn't clickable.

## Checks of your own

If you want a job to show without it reporting itself, put a script at `~/.claude/progress/jobs.py` that prints:

```json
{"groups": [{"name": "Builds", "rows": [{"name": "Nightly", "text": "Running", "frac": null, "state": "running"}]}]}
```

It runs every 15 seconds while the panel is showing, so keep it quick. Add `"chat": "<session id>"` to a row to make clicking it open that chat.

## Where your data goes

To sort the On you list and suggest what could close, it sends the last messages of each chat that says it's waiting on you, or that looks done and has sat for 6 hours, to Claude, through your own Claude Code login, using its smallest model. That's the same place those chats already go. The call has no tools, so it can't change anything. Delete `triage.py` from the installed extension to turn this off: the list then shows every waiting chat, in a plain order.

It reads `~/.claude/tab-board/`, `~/.claude/progress/`, your chat history in `~/.claude/projects/` and VS Code's list of open tabs. It changes only three things: the lists Keep, Later, Remind, Close and the star write to, its notes in `~/.claude/tab-triage/`, and the modified date on the history file of a chat on the shelf (see For later).

It also asks GitHub for the newest version number every 6 hours, as a plain download that says nothing about you. Pressing **Update** downloads the new version from the same place, and updates the tab-board plugin if you installed it as a plugin.

For the usage bar, it asks Claude Code how much of your plan is used, every 5 minutes while the panel is showing. It's the same check `/usage` runs, through your own login. No message goes to a model, so it uses none of your plan. Nothing else goes online.

The tab-board plugin makes one kind of outside call. When a chat finishes a turn, it sends that chat's last reply and your last ask to Claude Haiku on your own Claude account, which decides whether the chat is waiting on you or ready to close. That uses a little of your plan, and goes to the same place your chats already go.

## Ready to ship

When the only thing left in a chat is your OK to put finished work live, it gets a green tile under Ready to ship, the first section in the list, whose heading and green count stay on screen as you scroll, and a count on the button in the bottom bar. Claude's small model spots these from each chat's last message; emails, posts and payments never get one.

- **Ship it** replies "ship it" in that chat for you. It needs the tab-board plugin running in the chat. If the chat doesn't take it, the tab opens with the words on your clipboard.
- **Run it** is for a chat that gave you one command to run yourself. The tile shows the exact command, copied from Claude's message, and it runs in a terminal you can watch, from the folder that chat was working in. Then the chat is told how it ended. A command that uses sudo, deletes files or pipes into a shell gets no button.

After a press you have 5 seconds to undo, and a pressed tile stays out even if you fold the section. Nothing goes without a press. A tile that isn't shipping leaves with **Later** or **Close**, under its **⋯**.

## Keep

Hover over a chat and press the small **⋯** at its top right to see its buttons. A click anywhere else on the chat just opens it. **Keep** on a Ready to close? or Looks done chat stops suggesting it's done, and the chat moves to Idle until something new happens in it. It doesn't close or delete anything.

There's no button that dismisses an ask. A chat stays on On you until you answer it, put it away with **Later** or **Close**, or it goes quiet and moves to Resting.

## For later

Hover over a chat, press **⋯**, then **Later** to put it on the shelf at the bottom of the list. It leaves your counts and stays there even if you close the tab. Click it to bring it back. Once you send it something, it returns to your list by itself, or press **Back** to return it without doing that. A chat still running when you shelve it says so, doesn't offer Close, and still counts as something a reload would stop. Press **Remind** to pick a day for it to come back on its own, with a notice.

Claude Code deletes any chat nothing has written to for 30 days, so while the side bar is running it refreshes the modified date on the history file of each chat on the shelf. That keeps it from being deleted. The list itself is `~/.claude/for-later.json`.

## Remove it

```
claude plugin uninstall tab-board@tab-board
code --uninstall-extension hcmnj.progress-sidebar
```

## Building it

Bump `version` in `package.json`, run `python3 build.py`, then install the `.vsix` it makes.
