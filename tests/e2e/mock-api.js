// A stand-in for Claude's API, so a real Claude Code session can run in a test with no account and no network.
// node mock-api.js <port> [log file]. Every request gets one short text answer; the tab-board judge gets "done".
// "Run a long job" runs a busy command for 100 seconds first (what a reload would stop). "Take your time" thinks for 32 seconds and
// then asks something: a turn that long, ending on a question, is what the tab-board plugin sends a notice for when there's no side bar.
const fs = require('fs')
const http = require('http')

const port = Number(process.argv[2] || 8765)
const log = process.argv[3]
const REPLY = 'Hello from the test chat. Everything here is finished.'
const QUESTION = 'Which color should the shop sign be, red or blue?'
const LONG_JOB = 'node -e "const end = Date.now() + 100000; while (Date.now() < end) {}"'

function answer(ask, body) {
  const tools = (ask.tools || []).map(tool => tool.name)
  const said = JSON.stringify(ask.messages || '')
  const isJudge = said.includes('<message>')
  // The side bar's sorter asks about every tab at once and wants a JSON list back, one answer per tab id it named
  const isSorter = JSON.stringify(ask.system || '').includes('busy person')
  const isChat = !isJudge && !isSorter && tools.length > 0
  const ids = [...new Set([...body.matchAll(/tab id=\\*"([0-9a-f-]{36})/g)].map(m => m[1]))]
  const verdicts = ids.map(id => ({ id, who: 'nobody', ask: '', due: null, size: 'quick', stakes: 1, why: 'Test verdict', close: true, close_why: 'It says it is finished' }))
  // A chat asked to ask something ends on a question, which the plugin's judge reads as waiting on the person
  const asks = /Ask me a question|Take your time/.test(said)
  const text = isSorter ? JSON.stringify(verdicts) : isJudge ? (asks ? 'waiting' : 'done') : asks ? QUESTION : REPLY
  let content = [{ type: 'text', text }]
  if (isChat && /Run a long job/.test(said)) {
    content = said.includes('"tool_result"')
      ? [{ type: 'text', text: 'Done with that.' }]
      : [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: LONG_JOB, description: 'Keep busy for 100 seconds', timeout: 300000 } }]
  }
  const message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: ask.model || 'claude-test',
    content,
    stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return { message, tools, wait: isChat && /Take your time/.test(said) ? 32_000 : 0 }
}

function reply(res, ask, message) {
  if (!ask.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(message))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  message.content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  res.end()
}

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let ask = {}
      try {
        ask = JSON.parse(body)
      } catch {}
      if (req.url.startsWith('/v1/messages/count_tokens') || !req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(req.url.startsWith('/v1/messages/count_tokens') ? { input_tokens: 10 } : {}))
      }
      const { message, tools, wait } = answer(ask, body)
      if (log) fs.appendFileSync(log, `${req.method} ${req.url} model=${ask.model || ''} stream=${Boolean(ask.stream)} sorter=${JSON.stringify(ask.system || '').includes('busy person')} tools=${tools.length} reply=${message.content[0].type}${wait ? ' slow' : ''}\n`)
      setTimeout(() => reply(res, ask, message), wait)
    })
  })
  .listen(port, '127.0.0.1', () => console.log(`mock API on ${port}`))
