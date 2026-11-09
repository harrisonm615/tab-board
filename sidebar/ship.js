// How a press of Ship it reaches a chat. The press leaves a small note named for that chat; the tab-board plugin running in it
// picks the note up and sends the reply as the person. A note only says which reply: the plugin holds the words.
const fs = require('fs')
const os = require('os')
const path = require('path')

const SESSION_ID = /^[0-9a-f-]{36}$/
const LOOK_EVERY_MS = 500

function leaveNote(id, since, kind, code, home = os.homedir()) {
  if (!SESSION_ID.test(id)) throw new Error('not a chat id')
  const folder = path.join(home, '.claude/tab-triage/send')
  fs.mkdirSync(folder, { recursive: true })
  const note = path.join(folder, `${id}.json`)
  const draft = `${note}.${process.pid}.tmp`
  fs.writeFileSync(draft, JSON.stringify({ kind, since, code, at: Date.now() }))
  fs.renameSync(draft, note) // all at once, so the chat can't read half of it
  return note
}

// Never leave one lying around: a reply that went in minutes after the press would be a surprise.
const takeBack = note => fs.rmSync(note, { force: true })

// The plugin removes a note only once it has taken it. One that's still there at the end wasn't.
const wasTaken = (note, withinMs) =>
  new Promise(resolve => {
    const start = Date.now()
    const look = setInterval(() => {
      const taken = !fs.existsSync(note)
      if (!taken && Date.now() - start < withinMs) return
      clearInterval(look)
      resolve(taken)
    }, LOOK_EVERY_MS)
  })

module.exports = { leaveNote, takeBack, wasTaken }
