// 离线单元测试：全部通过 mock fetch 运行，不发真实网络请求（因此可在 CI / 无网环境跑）。
// 需要真实网络 + 实际下载 PDF 的冒烟测试见 e2e.test.mjs（npm run test:e2e）。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  canonicalPaperId, checkedPaperId, downloadPaper, getPaper, getRelatedResources, isValidPaperId,
  matchesQuery, normalizePaper, outputDirectory, portableFilename, readPaper, resetApiBaseCache, searchPapers
} from './dist/papers.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const temporaryDirectories = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetApiBaseCache()
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'chattyplay-paper-'))
  temporaryDirectories.push(directory)
  return directory
}

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), init)
}

test('normalizes daily and search response fields', () => {
  const paper = normalizePaper({
    arxiv_id: '2609.12345v2',
    title: 'Small Vision Models',
    authors: [{ fullname: 'Ada' }],
    abstract: 'Efficient multimodal inference',
    ai_keywords: ['vision']
  })
  assert.equal(paper.id, '2609.12345')
  assert.equal(paper.links.pdf, 'https://arxiv.org/pdf/2609.12345.pdf')
  assert.equal(matchesQuery(paper, 'vision Ada'), true)
  assert.equal(matchesQuery(paper, 'diffusion'), false)

  const malformedCounts = normalizePaper({ id: '2609.12345', upvotes: 'unknown', githubStars: null })
  assert.equal(malformedCounts.upvotes, 0)
  assert.equal(malformedCounts.githubStars, 0)
})

test('uses the official search endpoint and accepts the papers envelope', async () => {
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return jsonResponse({ papers: [{ arxiv_id: '2609.12345', title: 'MCP Research' }] })
  }
  const result = await searchPapers({ query: 'MCP', sort: 'publishedAt', limit: 5 })
  // 多取一条用于判断 hasMore（/papers/search 没有 offset 参数）。
  assert.match(requestedUrl, /\/papers\/search\?q=MCP&limit=6$/)
  assert.equal(result.source, 'search')
  assert.equal(result.papers[0].id, '2609.12345')
  assert.equal(result.hasMore, false)
})

test('requests one extra record to detect hasMore', async () => {
  const papers = Array.from({ length: 6 }, (_, index) => ({ arxiv_id: `2609.0000${index}`, title: 'Paper' }))
  globalThis.fetch = async () => jsonResponse(papers)

  const more = await searchPapers({ query: 'paper', limit: 5 })
  assert.equal(more.papers.length, 5)
  assert.equal(more.hasMore, true)

  globalThis.fetch = async () => jsonResponse(papers.slice(0, 5))
  const last = await searchPapers({ query: 'paper', limit: 5 })
  assert.equal(last.papers.length, 5)
  assert.equal(last.hasMore, false)
})

test('caps the search limit at the documented 120 records', async () => {
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return jsonResponse(Array.from({ length: 120 }, (_, index) => ({ arxiv_id: `2609.0000${index}`, title: 'Paper' })))
  }

  // 最后一页可命中的位置：start=100，最多只能请求到 120。
  await searchPapers({ query: 'paper', limit: 20, page: 5 })
  assert.match(requestedUrl, /limit=120$/)

  // 再往后翻没有意义，应当直接报错而不是发出一个必然 400 的请求。
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return jsonResponse([])
  }
  await assert.rejects(() => searchPapers({ query: 'paper', limit: 20, page: 6 }), /最多返回前 120 条/)
  assert.equal(called, 0)
})

test('uses Daily Papers for period filters and local keyword matching', async () => {
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return jsonResponse([
      { paper: { id: '2609.00001', title: 'Vision Agent' } },
      { paper: { id: '2609.00002', title: 'Audio Agent' } }
    ])
  }
  const result = await searchPapers({ query: 'vision', month: '2026-09', sort: 'trending', limit: 10, page: 1 })
  assert.match(requestedUrl, /\/daily_papers\?p=1&limit=100&month=2026-09&sort=trending$/)
  assert.deepEqual(result.papers.map(({ id }) => id), ['2609.00001'])
})

test('reports another filtered Daily Papers result on the same page', async () => {
  globalThis.fetch = async () => jsonResponse([
    { paper: { id: '2609.00001', title: 'Vision One' } },
    { paper: { id: '2609.00002', title: 'Vision Two' } },
    { paper: { id: '2609.00003', title: 'Audio' } }
  ])

  const result = await searchPapers({ query: 'vision', month: '2026-09', limit: 1 })
  assert.equal(result.papers.length, 1)
  assert.equal(result.hasMore, true)
})

test('falls back to the mirror when the primary API is unreachable', async () => {
  const hosts = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).host
    hosts.push(host)
    if (host === 'huggingface.co') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    return jsonResponse({ papers: [{ arxiv_id: '2609.12345', title: 'Mirror Research' }] })
  }

  const result = await searchPapers({ query: 'MCP', limit: 5 })

  assert.deepEqual(hosts, ['huggingface.co', 'hf-mirror.com'])
  assert.equal(result.papers[0].title, 'Mirror Research')
})

test('honours an explicit PAPERS_API_BASE without probing other sources', async () => {
  process.env.PAPERS_API_BASE = 'https://example.test/api'
  const hosts = []
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).host)
    return jsonResponse({ papers: [] })
  }

  await searchPapers({ query: 'MCP', limit: 5 })

  assert.deepEqual(hosts, ['example.test'])
})

test('reuses the mirror that answered last time', async () => {
  const hosts = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).host
    hosts.push(host)
    if (host === 'huggingface.co') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    return jsonResponse({ papers: [] })
  }

  await searchPapers({ query: 'MCP', limit: 5 })
  await searchPapers({ query: 'MCP', limit: 5 })

  // 第二次调用直接命中可用镜像，不再先等一次主源超时。
  assert.deepEqual(hosts, ['huggingface.co', 'hf-mirror.com', 'hf-mirror.com'])
})

test('surfaces the API error body instead of a bare status code', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return jsonResponse({ error: '✖ Too big: expected number to be <=120\n  → at limit' }, {
      status: 400,
      statusText: 'Bad Request'
    })
  }

  await assert.rejects(() => searchPapers({ query: 'MCP', limit: 5 }), /Too big: expected number to be <=120/)
  // 参数错误换镜像没有意义，只请求一次。
  assert.equal(calls, 1)
})

test('gets a paper and strips an arXiv version suffix', async () => {
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return jsonResponse({ id: '2609.12345', title: 'Paper details' })
  }
  const paper = await getPaper('2609.12345v2')
  assert.match(requestedUrl, /\/papers\/2609\.12345$/)
  assert.equal(paper.title, 'Paper details')
})

test('accepts arXiv URLs and legacy identifiers', () => {
  assert.equal(canonicalPaperId('https://arxiv.org/pdf/2609.12345v2.pdf'), '2609.12345')
  assert.equal(canonicalPaperId('arXiv:hep-th/9901001v3'), 'hep-th/9901001')
  assert.equal(isValidPaperId('https://example.com/paper.pdf'), false)
  assert.equal(checkedPaperId('arXiv:hep-th/9901001v3'), 'hep-th/9901001')
  assert.throws(() => checkedPaperId('https://example.com/paper.pdf'), /有效的 arXiv ID/)
})

test('reads paper markdown in bounded pages', async () => {
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return new Response('0123456789'.repeat(200))
  }
  const result = await readPaper('2609.12345', { start: 100, maxChars: 1000 })
  assert.match(requestedUrl, /\/papers\/2609\.12345\.md$/)
  assert.equal(result.content.length, 1000)
  assert.equal(result.nextStart, 1100)
  assert.equal(result.truncated, true)

  const clamped = await readPaper('2609.12345', { start: -50, maxChars: 1000 })
  assert.equal(clamped.start, 0)
})

test('does not return an HTML error page as paper content', async () => {
  globalThis.fetch = async () => new Response('<html>blocked</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
  await assert.rejects(() => readPaper('2609.12345'), /返回了 HTML 页面/)
})

test('keeps related resources when one category fails', async () => {
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/datasets')) return new Response('unavailable', { status: 503, statusText: 'Unavailable' })
    return jsonResponse([{ id: pathname.endsWith('/models') ? 'org/model' : 'org/space', likes: 2 }])
  }
  const result = await getRelatedResources('2609.12345', 5)
  assert.equal(result.models[0].url, 'https://huggingface.co/org/model')
  assert.equal(result.spaces[0].url, 'https://huggingface.co/spaces/org/space')
  assert.equal(result.datasets.length, 0)
  assert.match(result.warnings[0], /^datasets:/)
})

test('reports when every related-resources category fails', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 502, statusText: 'Bad Gateway' })
  await assert.rejects(() => getRelatedResources('2609.12345', 5), /关联资源查询全部失败/)
})

test('reports invalid JSON clearly', async () => {
  globalThis.fetch = async () => new Response('<html>not json</html>')
  await assert.rejects(() => searchPapers({ sort: 'publishedAt', limit: 1 }), /无效的 JSON/)
})

test('downloads a validated PDF without buffering it in memory', async () => {
  const directory = await temporaryDirectory()
  globalThis.fetch = async () => new Response('%PDF-1.7\nmock paper')

  const result = await downloadPaper({ id: '2609.12345v2', directory, filename: 'paper.pdf' })

  assert.equal(result.path, path.join(directory, 'paper.pdf'))
  assert.equal(await readFile(result.path, 'utf8'), '%PDF-1.7\nmock paper')
  assert.equal(result.bytes, 19)
  assert.equal(result.overwritten, false)
  assert.equal(result.sourceUrl, 'https://arxiv.org/pdf/2609.12345.pdf')
})

test('rejects non-PDF responses, path-like filenames, and accidental overwrite', async () => {
  const directory = await temporaryDirectory()
  globalThis.fetch = async () => new Response('<html>blocked</html>')
  await assert.rejects(() => downloadPaper({ id: '2609.12345', directory }), /不是有效的 PDF/)
  await assert.rejects(() => downloadPaper({ id: '2609.12345', directory, filename: '../paper.pdf' }), /单个 PDF 文件名/)

  const target = path.join(directory, 'paper.pdf')
  await writeFile(target, 'keep me')
  globalThis.fetch = async () => new Response('%PDF-1.7\nreplacement')
  await assert.rejects(() => downloadPaper({ id: '2609.12345', directory, filename: 'paper.pdf' }), /文件已存在/)
  assert.equal(await readFile(target, 'utf8'), 'keep me')

  // 临时文件不能留在目标目录里。
  assert.deepEqual((await readdir(directory)).sort(), ['paper.pdf'])
})

test('overwrites an existing file only when explicitly asked', async () => {
  const directory = await temporaryDirectory()
  const target = path.join(directory, 'paper.pdf')
  await writeFile(target, 'keep me')
  globalThis.fetch = async () => new Response('%PDF-1.7\nreplacement')

  const result = await downloadPaper({ id: '2609.12345', directory, filename: 'paper.pdf', overwrite: true })

  assert.equal(result.overwritten, true)
  assert.equal(await readFile(target, 'utf8'), '%PDF-1.7\nreplacement')
})

test('reports overwrite only when a file was actually replaced', async () => {
  const directory = await temporaryDirectory()
  globalThis.fetch = async () => new Response('%PDF-1.7\nnew')

  const result = await downloadPaper({ id: '2609.12345', directory, filename: 'paper.pdf', overwrite: true })

  assert.equal(result.overwritten, false)
})

test('never follows a target symlink when overwrite is enabled', { skip: process.platform === 'win32' }, async () => {
  const directory = await temporaryDirectory()
  const protectedFile = path.join(directory, 'protected.txt')
  const target = path.join(directory, 'paper.pdf')
  await writeFile(protectedFile, 'keep me')
  await symlink(protectedFile, target)
  globalThis.fetch = async () => new Response('%PDF-1.7\nreplacement')

  await assert.rejects(
    () => downloadPaper({ id: '2609.12345', directory, filename: 'paper.pdf', overwrite: true }),
    /拒绝覆盖符号链接/
  )
  assert.equal(await readFile(protectedFile, 'utf8'), 'keep me')
})

test('falls back to the next PDF source before giving up', async () => {
  const directory = await temporaryDirectory()
  const hosts = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).host
    hosts.push(host)
    if (host === 'arxiv.org') return new Response('<html>rate limited</html>')
    return new Response('%PDF-1.7\nok')
  }

  const result = await downloadPaper({ id: '2609.12345', directory })

  assert.deepEqual(hosts, ['arxiv.org', 'export.arxiv.org'])
  assert.equal(result.sourceUrl, 'https://export.arxiv.org/pdf/2609.12345.pdf')
  assert.equal(result.bytes, 11)
  assert.equal(await readFile(result.path, 'utf8'), '%PDF-1.7\nok')
})

test('reports an HTML response as a missing PDF', async () => {
  const directory = await temporaryDirectory()
  globalThis.fetch = async () => new Response('<html>404</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })

  await assert.rejects(() => downloadPaper({ id: '2609.12345', directory }), /没有可下载的 PDF/)
})

test('removes every temporary file when all PDF sources fail', async () => {
  const directory = await temporaryDirectory()
  globalThis.fetch = async () => new Response('<html>nope</html>', { status: 503, statusText: 'Unavailable' })

  await assert.rejects(() => downloadPaper({ id: '2609.12345', directory }), /PDF 下载失败/)
  assert.deepEqual(await readdir(directory), [])
})

test('rejects filenames that are invalid on Windows', async () => {
  const directory = path.join(tmpdir(), 'whatever')
  for (const filename of [
    'a/b.pdf', 'a\\b.pdf', 'con.pdf', 'lpt1.pdf', 'aux.pdf', 'bad?.pdf', 'bad*.pdf', 'bad|.pdf',
    'bad<>.pdf', 'bad:.pdf', 'bad\u0000.pdf', `${'x'.repeat(200)}.pdf`
  ]) {
    await assert.rejects(() => downloadPaper({ id: '2609.12345', directory, filename }), /filename/)
  }
})

test('builds portable filenames and expands ~ paths', () => {
  assert.equal(portableFilename('attention', '2609.12345'), 'attention.pdf')
  assert.equal(portableFilename(' attention.pdf ', '2609.12345'), 'attention.pdf')
  assert.equal(portableFilename(undefined, 'hep-th/9901001'), 'hep-th_9901001.pdf')

  delete process.env.PAPER_DOWNLOAD_DIR
  assert.equal(outputDirectory(), path.join(homedir(), 'Downloads'))
  assert.equal(outputDirectory('~'), homedir())
  assert.equal(outputDirectory('~/papers'), path.join(homedir(), 'papers'))
  assert.equal(outputDirectory(path.join(tmpdir(), 'papers')), path.join(tmpdir(), 'papers'))
  assert.throws(() => outputDirectory('~someone/papers'), /~ 路径/)
  assert.throws(() => outputDirectory('bad\0dir'), /空字符/)

  process.env.PAPER_DOWNLOAD_DIR = path.join(tmpdir(), 'from-env')
  assert.equal(outputDirectory(), path.join(tmpdir(), 'from-env'))
})
