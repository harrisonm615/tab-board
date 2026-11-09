// A stand-in for Claude's API, so a real Claude Code session can run in a test with no account and no network.
// node mock-api.js <port> [log file]. Every request gets one short text answer; the tab-board judge gets "done".
const fs = require('fs')
const http = require('http')

const port = Number(process.argv[2] || 8765)
const log = process.argv[3]
const REPLY = 'Hello from the test chat. Everything here is finished.'

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let ask = {}
      try {
        ask = JSON.parse(body)
      } catch {}
      if (log) fs.appendFileSync(log, `${req.method} ${req.url} model=${ask.model || ''} stream=${Boolean(ask.stream)}\n`)
      const json = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 10 })
      if (!req.url.startsWith('/v1/messages')) return json(200, {})
      const isJudge = JSON.stringify(ask.messages || '').includes('<message>')
      const text = isJudge ? 'done' : REPLY
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
