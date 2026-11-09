// A stand-in for Claude's API, so a real Claude Code session can run in a test with no account and no network.
// node mock-api.js <port> [log file]. Every request gets one short text answer; the tab-board judge gets "done".
const fs = require('fs')
const http = require('http')

const port = Number(process.argv[2] || 8765)
const log = process.argv[3]
const REPLY = 'Hello from the test chat. Everything here is finished.'
const QUESTION = 'Which color should the shop sign be, red or blue?'

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let ask = {}
      try {
        ask = JSON.parse(body)
      } catch {}
      if (log) fs.appendFileSync(log, `${req.method} ${req.url} model=${ask.model || ''} stream=${Boolean(ask.stream)} sorter=${JSON.stringify(ask.system || '').includes('busy person')}\n`)
      const json = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 10 })
      if (!req.url.startsWith('/v1/messages')) return json(200, {})
      const isJudge = JSON.stringify(ask.messages || '').includes('<message>')
      // The side bar's sorter asks about every tab at once and wants a JSON list back, one answer per tab id it named
      const isSorter = JSON.stringify(ask.system || '').includes('busy person')
      const ids = [...new Set([...body.matchAll(/tab id=\\*"([0-9a-f-]{36})/g)].map(m => m[1]))]
      const verdicts = ids.map(id => ({ id, who: 'nobody', ask: '', due: null, size: 'quick', stakes: 1, why: 'Test verdict', close: true, close_why: 'It says it is finished' }))
      // A chat asked to ask something ends on a question, which the plugin's judge reads as waiting on the person
      const asks = /Ask me a question/.test(JSON.stringify(ask.messages || ''))
      const text = isSorter ? JSON.stringify(verdicts) : isJudge ? (asks ? 'waiting' : 'done') : asks ? QUESTION : REPLY
      const message = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: ask.model || 'claude-test',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      if (!ask.stream) return json(200, message)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
      send('message_stop', {})
      res.end()
    })
  })
  .listen(port, '127.0.0.1', () => console.log(`mock API on ${port}`))
