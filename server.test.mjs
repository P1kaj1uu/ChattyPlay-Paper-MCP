import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs')

test('serves tools and validation errors over stdio without network access', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())

  const messages = []
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)))
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' }
  } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_paper', arguments: { id: 'invalid' } } })

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(interval)
      reject(new Error('stdio response timeout'))
    }, 5_000)
    const interval = setInterval(() => {
      if (messages.length < 3) return
      clearTimeout(deadline)
      clearInterval(interval)
      resolve()
    }, 10)
  })

  assert.equal(messages[0].result.serverInfo.name, 'chattyplay-paper')
  assert.deepEqual(messages[1].result.tools.map(({ name }) => name).sort(), [
    'download_paper', 'get_paper', 'get_related_resources', 'read_paper', 'search_papers'
  ])
  const downloadTool = messages[1].result.tools.find(({ name }) => name === 'download_paper')
  assert.equal(downloadTool.annotations.readOnlyHint, false)
  assert.equal(downloadTool.annotations.destructiveHint, true)
  assert.equal(messages[2].result.isError, true)
  assert.match(messages[2].result.content[0].text, /有效的 arXiv ID/)
})
