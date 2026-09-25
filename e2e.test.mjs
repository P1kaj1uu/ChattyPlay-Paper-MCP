// 真实网络端到端冒烟测试：验证编译后的 stdio MCP 层、各工具与 PDF 下载。
// 默认 npm test 不包含它，因为需要联网；单独跑：npm run test:e2e
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist/index.js')

function connect(env) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env }
  })
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  let nextId = 0
  return {
    child,
    send(method, params) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        setTimeout(() => reject(new Error(`timeout: ${method}`)), 240_000).unref()
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    close() {
      child.stdin.end()
      child.kill()
    }
  }
}

async function callTool(client, name, args) {
  const message = await client.send('tools/call', { name, arguments: args })
  if (message.error) return { transportError: message.error }
  const payload = message.result
  if (payload?.isError) return { toolError: payload.content?.[0]?.text }
  return { value: payload?.structuredContent, text: payload?.content?.[0]?.text }
}

function failure(result) {
  return result.transportError ? JSON.stringify(result.transportError) : result.toolError
}

test('serves every tool over stdio against the live API', { timeout: 280_000 }, async () => {
  // 继承外部环境变量：不设 PAPERS_API_BASE 时走默认源（并顺带验证失败后能自动回退到镜像）；
  // 设置后固定使用该源，例如：PAPERS_API_BASE=https://hf-mirror.com/api npm run test:e2e
  console.log(`PAPERS_API_BASE=${process.env.PAPERS_API_BASE ?? '(未设置 → huggingface.co，失败时回退 hf-mirror.com)'}`)
  const client = connect({})
  let downloadDirectory
  try {
    const init = await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'paper-probe', version: '1.0.0' }
    })
    assert.equal(init.error, undefined)
    assert.equal(init.result.serverInfo.name, 'chattyplay-paper')
    assert.equal(init.result.serverInfo.version, '1.2.0')
    client.notify('notifications/initialized')

    const tools = await client.send('tools/list', {})
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name).sort(),
      ['download_paper', 'get_paper', 'get_related_resources', 'read_paper', 'search_papers']
    )
    for (const tool of tools.result.tools) {
      assert.ok(tool.description, `${tool.name} needs a description`)
      assert.ok(tool.inputSchema, `${tool.name} needs an inputSchema`)
    }

    // 非法 arXiv ID 必须在到达网络前就被拒绝。
    const invalid = await callTool(client, 'get_paper', { id: 'https://example.com/paper.pdf' })
    assert.ok(failure(invalid), 'invalid id must be rejected, not silently accepted')

    const search = await callTool(client, 'search_papers', { query: 'attention is all you need', limit: 3 })
    assert.ok(!failure(search), `search_papers failed: ${failure(search)}`)
    assert.equal(search.value.papers.length, 3)
    assert.equal(search.value.source, 'search')
    assert.equal(search.text, JSON.stringify(search.value, null, 2))

    const detail = await callTool(client, 'get_paper', { id: 'https://arxiv.org/abs/1706.03762' })
    assert.ok(!failure(detail), `get_paper failed: ${failure(detail)}`)
    assert.equal(detail.value.id, '1706.03762')
    assert.match(detail.value.title, /Attention Is All You Need/i)
    assert.ok(detail.value.authors.length > 0)

    const related = await callTool(client, 'get_related_resources', { id: '1706.03762', limit: 3 })
    assert.ok(!failure(related), `get_related_resources failed: ${failure(related)}`)
    assert.ok(Array.isArray(related.value.models) && Array.isArray(related.value.spaces))

    const body = await callTool(client, 'read_paper', { id: '1706.03762', maxChars: 5000 })
    assert.ok(!failure(body), `read_paper failed: ${failure(body)}`)
    assert.ok(body.value.totalChars > 1000)
    assert.ok(body.value.content.length > 0)

    // PDF 下载进系统临时目录，避免污染用户的 ~/Downloads；跑完在 finally 里删掉。
    downloadDirectory = await mkdtemp(path.join(tmpdir(), 'paper-e2e-'))
    console.log(`PDF 下载到临时目录（跑完即删除）: ${downloadDirectory}`)
    const target = path.join(downloadDirectory, 'attention is all you need.pdf')
    const download = await callTool(client, 'download_paper', {
      id: '1706.03762',
      directory: downloadDirectory,
      filename: 'attention is all you need.pdf'
    })
    assert.ok(!failure(download), `download_paper failed: ${failure(download)}`)
    assert.equal(download.value.path, target)
    const info = await stat(target)
    assert.equal(download.value.bytes, info.size)
    assert.ok(info.size > 100_000, `downloaded file looks too small: ${info.size}`)

    const handle = await open(target, 'r')
    const header = Buffer.alloc(5)
    await handle.read(header, 0, 5, 0)
    await handle.close()
    assert.equal(header.toString('ascii'), '%PDF-')

    const again = await callTool(client, 'download_paper', {
      id: '1706.03762',
      directory: downloadDirectory,
      filename: 'attention is all you need.pdf'
    })
    assert.match(failure(again) ?? '', /文件已存在/)

    const overwritten = await callTool(client, 'download_paper', {
      id: '1706.03762',
      directory: downloadDirectory,
      filename: 'attention is all you need.pdf',
      overwrite: true
    })
    assert.ok(!failure(overwritten), `overwrite failed: ${failure(overwritten)}`)
    assert.equal(overwritten.value.overwritten, true)
  } finally {
    client.close()
    if (downloadDirectory) await rm(downloadDirectory, { recursive: true, force: true })
  }
})
