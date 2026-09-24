import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { constants as fsConstants, copyFile, lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const VERSION = '1.2.0'

const DEFAULT_API_BASE = 'https://huggingface.co/api'
// huggingface.co 在部分网络下不可直连（超时/被阻断），此时自动回退到镜像。
const FALLBACK_API_BASE = 'https://hf-mirror.com/api'
// GET /api/papers/search 的 limit 硬上限（实测 120 可用、121 直接 400）。
const MAX_SEARCH_LIMIT = 120
// GET /api/daily_papers 单页上限。
const MAX_DAILY_LIMIT = 100
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_FILENAME_LENGTH = 180
const DEFAULT_TIMEOUT_MS = 15_000
const PDF_TIMEOUT_MS = 120_000
// PDF 主源与备用源；可用 ARXIV_BASE_URL 指定单一源。
const DEFAULT_PDF_BASES = Object.freeze(['https://arxiv.org', 'https://export.arxiv.org'])
// 这些状态码说明请求本身有问题，换镜像源没有意义，直接报错。
const FATAL_STATUSES = new Set([400, 401, 404, 422])
const TARGET_EXISTS = 'PAPER_TARGET_EXISTS'

let preferredApiBase = null
let preferredHubBase = null

/** 清空进程内的镜像源优选缓存（测试用）。 */
export function resetApiBaseCache() {
  preferredApiBase = null
  preferredHubBase = null
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function apiTimeout() {
  return positiveNumber(process.env.PAPERS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
}

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function apiBaseCandidates() {
  const explicit = trimBase(process.env.PAPERS_API_BASE)
  if (explicit) return [explicit]
  return [DEFAULT_API_BASE, FALLBACK_API_BASE]
}

function hubBaseCandidates() {
  const explicit = trimBase(process.env.PAPERS_HUB_BASE)
  if (explicit) return [explicit]
  const api = trimBase(process.env.PAPERS_API_BASE)
  if (api) return [api.replace(/\/api$/, '')]
  return [DEFAULT_API_BASE.replace(/\/api$/, ''), FALLBACK_API_BASE.replace(/\/api$/, '')]
}

function pdfBaseCandidates() {
  const explicit = trimBase(process.env.ARXIV_BASE_URL)
  return explicit ? [explicit] : [...DEFAULT_PDF_BASES]
}

/** 把上次成功的源排到最前；只影响顺序，不影响可用性。 */
function orderedBases(candidates, preferred) {
  if (candidates.length < 2 || !preferred || !candidates.includes(preferred)) return candidates
  return [preferred, ...candidates.filter((base) => base !== preferred)]
}

function apiUrl(base, pathname, params = {}) {
  const url = new URL(`${base}${pathname}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}

function requestHeaders(accept, authenticated = true) {
  const headers = { Accept: accept, 'User-Agent': `chattyplay-paper-mcp/${VERSION}` }
  if (authenticated && process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`
  return headers
}

function fetchWithTimeout(url, { headers, timeout = apiTimeout(), redirect } = {}) {
  return fetch(url, { headers, redirect, signal: AbortSignal.timeout(timeout) })
}

function describeFetchFailure(url, error) {
  const code = error?.cause?.code || error?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析域名 ${url.hostname}`
  if (code === 'ECONNREFUSED') return `连接被拒绝 ${url.hostname}`
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `连接被重置 ${url.hostname}，可能被网络拦截`
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `请求超时（${url.hostname}）`
  return `无法连接 ${url.hostname}：${error?.message || error}`
}

/** 取出响应体里的 error 字段，避免 400/404 的真实原因被丢掉。 */
async function apiErrorMessage(response) {
  let text
  try {
    text = await response.text()
  } catch {
    return ''
  }
  const body = text.trim()
  if (!body) return ''
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error || parsed?.message || parsed?.detail
    if (message) return String(message).replace(/\s+/g, ' ').slice(0, 300)
  } catch {}
  if (body.startsWith('<')) return ''
  return body.replace(/\s+/g, ' ').slice(0, 300)
}

async function readJson(response, url) {
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`论文 API 返回了无效的 JSON（${url.origin}${url.pathname}）`, { cause: error })
  }
}

/**
 * 依次尝试候选 API 源：网络层失败、限流或服务端错误时切换到镜像。
 * 参数错误（400/401/404/422）直接抛出，避免把一个真实错误重复三遍。
 */
async function getJson(pathname, params = {}) {
  const bases = orderedBases(apiBaseCandidates(), preferredApiBase)
  let lastError

  for (const base of bases) {
    const url = apiUrl(base, pathname, params)
    let response
    try {
      response = await fetchWithTimeout(url, { headers: requestHeaders('application/json') })
    } catch (error) {
      lastError = new Error(describeFetchFailure(url, error), { cause: error })
      continue
    }

    if (response.ok) {
      try {
        const data = await readJson(response, url)
        preferredApiBase = base
        return data
      } catch (error) {
        lastError = error
        continue
      }
    }

    const detail = await apiErrorMessage(response)
    const message = `论文 API 请求失败：${response.status} ${response.statusText}${detail ? `（${detail}）` : ''}`
    if (FATAL_STATUSES.has(response.status)) throw new Error(message)
    lastError = new Error(message)
  }

  if (lastError) {
    const hint = bases.length > 1 ? '；已尝试所有候选源，可用 PAPERS_API_BASE 指定可访问的镜像或代理' : ''
    throw new Error(`${lastError.message}${hint}`, { cause: lastError })
  }
  throw new Error('论文 API 请求失败：没有可用的 API 源')
}

async function getText(pathname) {
  const bases = orderedBases(hubBaseCandidates(), preferredHubBase)
  let lastError

  for (const base of bases) {
    const url = new URL(`${base}${pathname}`)
    let response
    try {
      response = await fetchWithTimeout(url, { headers: requestHeaders('text/markdown, text/plain;q=0.9') })
    } catch (error) {
      lastError = new Error(describeFetchFailure(url, error), { cause: error })
      continue
    }

    if (response.ok) {
      if (/text\/html/i.test(response.headers.get('content-type') || '')) {
        lastError = new Error(`论文正文请求失败：${url.hostname} 返回了 HTML 页面`)
        continue
      }
      const text = await response.text()
      preferredHubBase = base
      return text
    }

    const detail = await apiErrorMessage(response)
    const message = `论文正文请求失败：${response.status} ${response.statusText}${detail ? `（${detail}）` : ''}`
    if (FATAL_STATUSES.has(response.status)) throw new Error(message)
    lastError = new Error(message)
  }

  throw lastError || new Error('论文正文请求失败：没有可用的源')
}

/** 去掉 `arXiv:` 前缀、从 arxiv.org 链接里取出 ID，并移除版本后缀。纯函数，不做校验。 */
export function canonicalPaperId(value) {
  let id = String(value ?? '').trim().replace(/^arxiv:\s*/i, '')
  try {
    const url = new URL(id)
    if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') {
      id = decodeURIComponent(url.pathname.replace(/^\/(?:abs|pdf)\//, ''))
    }
  } catch {}
  return id.replace(/^\/+|\/+$/g, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '')
}

export function isValidPaperId(value) {
  const id = canonicalPaperId(value)
  return /^\d{4}\.\d{4,5}$/.test(id) || /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}$/i.test(id)
}

/** 校验并归一化 arXiv ID；不合法时抛错。 */
export function checkedPaperId(value) {
  const id = canonicalPaperId(value)
  if (!isValidPaperId(id)) throw new Error(`请输入有效的 arXiv ID 或链接：${String(value ?? '').trim() || '(空)'}`)
  return id
}

function encodedPaperId(value) {
  return checkedPaperId(value).split('/').map(encodeURIComponent).join('/')
}

function authorName(author) {
  if (typeof author === 'string') return author
  return author?.name || author?.fullname || ''
}

function keywordList(item, paper) {
  const value = item?.ai_keywords || item?.aiKeywords || paper.ai_keywords || paper.aiKeywords
  return Array.isArray(value) ? value.filter((word) => typeof word === 'string') : []
}

export function normalizePaper(item) {
  const paper = item?.paper || item || {}
  const id = canonicalPaperId(paper.id || paper.arxiv_id || paper.arxivId || item?.id)
  return {
    id,
    title: paper.title || '',
    authors: Array.isArray(paper.authors) ? paper.authors.map(authorName).filter(Boolean) : [],
    publishedAt: paper.publishedAt || paper.published_at || paper.published || item?.publishedAt || '',
    submittedAt: item?.submittedOnDailyAt || item?.publishedAt || '',
    submittedBy: item?.submittedOnDailyBy?.fullname || item?.submittedBy?.fullname || null,
    summary: paper.summary || paper.abstract || '',
    aiSummary: item?.ai_summary || item?.aiSummary || paper.ai_summary || paper.aiSummary || '',
    keywords: keywordList(item, paper),
    source: item?.source || paper.source || null,
    upvotes: finiteNumber(paper.upvotes ?? item?.upvotes),
    comments: finiteNumber(item?.numComments ?? paper.numComments),
    github: item?.githubRepo || paper.githubRepo || paper.github || null,
    githubStars: finiteNumber(item?.githubStars ?? paper.githubStars),
    projectPage: item?.projectPage || paper.projectPage || null,
    organization: item?.organization?.fullname || item?.organization?.name || null,
    links: {
      huggingFace: id ? `https://huggingface.co/papers/${id}` : null,
      arxiv: id ? `https://arxiv.org/abs/${id}` : null,
      pdf: id ? `https://arxiv.org/pdf/${id}.pdf` : null
    }
  }
}

export function matchesQuery(paper, query) {
  const words = query?.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean) || []
  if (!words.length) return true
  const haystack = [paper.id, paper.title, paper.summary, paper.aiSummary, ...paper.authors, ...paper.keywords]
    .join(' ')
    .toLocaleLowerCase()
  return words.every((word) => haystack.includes(word))
}

function paperList(data) {
  const items = Array.isArray(data) ? data : data?.papers
  if (!Array.isArray(items)) throw new Error('论文 API 返回了无法识别的论文列表')
  return items
}

/**
 * 关键词搜索走 /papers/search（该端点没有 offset，且 limit 上限为 120），
 * 因此多取一条用于判断 hasMore；带日期/周/月筛选时走 Daily Papers。
 */
export async function searchPapers({ query, date, week, month, sort = 'publishedAt', limit = 20, page = 0 } = {}) {
  const normalizedQuery = query?.trim()
  const hasPeriod = Boolean(date || week || month)
  if (normalizedQuery && !hasPeriod) return searchByQuery(normalizedQuery, { limit, page })
  return browseDailyPapers({ query: normalizedQuery, date, week, month, sort, limit, page })
}

async function searchByQuery(query, { limit, page }) {
  const start = page * limit
  if (start >= MAX_SEARCH_LIMIT) {
    throw new Error(
      `关键词搜索最多返回前 ${MAX_SEARCH_LIMIT} 条结果，page=${page}、limit=${limit} 已超出范围；` +
      '请减小 page 或 limit，或改用 date/week/month 浏览 Daily Papers'
    )
  }
  const want = Math.min(start + limit + 1, MAX_SEARCH_LIMIT)
  const all = paperList(await getJson('/papers/search', { q: query, limit: want })).map(normalizePaper)
  const papers = all.slice(start, start + limit)
  return { papers, count: papers.length, source: 'search', page, hasMore: all.length > start + limit }
}

async function browseDailyPapers({ query, date, week, month, sort, limit, page }) {
  const requestLimit = query ? MAX_DAILY_LIMIT : limit
  const items = paperList(await getJson('/daily_papers', { p: page, limit: requestLimit, date, week, month, sort }))
  const matches = items.map(normalizePaper).filter((paper) => matchesQuery(paper, query))
  const papers = matches.slice(0, limit)
  return { papers, count: papers.length, source: 'daily', page, hasMore: matches.length > limit || items.length >= requestLimit }
}

export async function getPaper(id) {
  const paper = normalizePaper(await getJson(`/papers/${encodedPaperId(id)}`))
  if (!paper.id || !paper.title) throw new Error('论文 API 返回的详情缺少 id 或 title')
  return paper
}

export async function readPaper(id, { start = 0, maxChars = 20_000 } = {}) {
  const paperId = checkedPaperId(id)
  const safeStart = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0
  const markdown = await getText(`/papers/${encodedPaperId(paperId)}.md`)
  const content = markdown.slice(safeStart, safeStart + maxChars)
  const nextStart = safeStart + content.length < markdown.length ? safeStart + content.length : null
  return { id: paperId, content, start: safeStart, nextStart, totalChars: markdown.length, truncated: nextStart !== null }
}

function normalizeResource(item, type) {
  const id = item?.id || item?.modelId || ''
  const resourcePath = type === 'models' ? id : `${type}/${id}`
  return {
    id,
    type: type.slice(0, -1),
    author: item?.author || (id.includes('/') ? id.split('/')[0] : null),
    lastModified: item?.lastModified || null,
    downloads: finiteNumber(item?.downloads),
    likes: finiteNumber(item?.likes),
    pipelineTag: item?.pipeline_tag || null,
    url: id ? `https://huggingface.co/${resourcePath}` : null
  }
}

/** 三类资源并行查询，单类失败时保留其余结果并在 warnings 里说明原因。 */
export async function getRelatedResources(id, limit = 10) {
  const paperId = checkedPaperId(id)
  const types = ['models', 'datasets', 'spaces']
  const settled = await Promise.allSettled(
    types.map((type) => getJson(`/${type}`, { filter: `arxiv:${paperId}`, limit }))
  )
  const output = { models: [], datasets: [], spaces: [], warnings: [] }

  settled.forEach((result, index) => {
    const type = types[index]
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      output[type] = result.value.map((item) => normalizeResource(item, type))
    } else {
      const reason = result.status === 'rejected' ? result.reason : new Error('返回格式不是数组')
      output.warnings.push(`${type}: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  })

  if (output.warnings.length === types.length) throw new Error(`关联资源查询全部失败：${output.warnings.join('; ')}`)
  return output
}

/** 只接受单个可跨平台文件系统的文件名：不含路径分隔符、Windows 保留字符与保留名。 */
export function portableFilename(value, paperId) {
  let filename = value?.trim() || `${String(paperId).replaceAll('/', '_')}.pdf`
  if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf'
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new Error(`filename 过长（最多 ${MAX_FILENAME_LENGTH} 个字符）`)
  }
  const invalid = filename !== path.basename(filename) || filename !== path.win32.basename(filename) ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(filename) || /^\.+$/.test(filename) || /[. ]$/.test(filename) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
  if (invalid) throw new Error('filename 必须是可跨平台使用的单个 PDF 文件名，不能包含路径或特殊字符')
  return filename
}

/** 支持绝对路径、相对启动目录的路径和 ~ 展开；默认写入当前用户的 Downloads。 */
export function outputDirectory(value) {
  const supplied = value?.trim() || process.env.PAPER_DOWNLOAD_DIR?.trim()
  if (!supplied) return path.join(homedir(), 'Downloads')
  if (supplied.includes('\0')) throw new Error('directory 不能包含空字符')
  if (supplied === '~') return homedir()
  if (/^~[\\/]/.test(supplied)) return path.resolve(homedir(), supplied.slice(2))
  if (supplied.startsWith('~')) throw new Error('directory 仅支持当前用户的 ~ 路径，例如 ~/Downloads')
  return path.resolve(supplied)
}

function pdfValidator() {
  let bytes = 0
  let prefix = Buffer.alloc(0)
  let validated = false
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_PDF_BYTES) return callback(new Error('PDF 超过 100 MiB 安全上限'))
      if (!validated) {
        prefix = Buffer.concat([prefix, buffer.subarray(0, 5 - prefix.length)])
        if (prefix.length === 5) {
          if (prefix.toString('ascii') !== '%PDF-') return callback(new Error('下载内容不是有效的 PDF'))
          validated = true
        }
      }
      callback(null, buffer)
    },
    flush(callback) {
      callback(validated ? undefined : new Error('下载内容不是有效的 PDF'))
    }
  })
  return { stream, bytes: () => bytes }
}

async function fetchPdfTo(url, temporary) {
  const target = new URL(url)
  let response
  try {
    response = await fetchWithTimeout(target, {
      headers: requestHeaders('application/pdf', false),
      redirect: 'follow',
      timeout: positiveNumber(process.env.PAPERS_PDF_TIMEOUT_MS, PDF_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(describeFetchFailure(target, error), { cause: error })
  }

  if (!response.ok) throw new Error(`PDF 下载失败：${response.status} ${response.statusText}`)
  const contentType = response.headers.get('content-type') || ''
  if (/text\/html/i.test(contentType)) {
    throw new Error('该 ID 没有可下载的 PDF（服务端返回了 HTML 页面），请确认 arXiv ID 是否正确')
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    throw new Error('PDF 超过 100 MiB 安全上限')
  }
  if (!response.body) throw new Error('PDF 下载响应没有内容')

  const validator = pdfValidator()
  await pipeline(
    Readable.fromWeb(response.body),
    validator.stream,
    createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  )
  return validator.bytes()
}

async function commitPdf(temporary, target, overwrite) {
  try {
    if (!overwrite) {
      await copyFile(temporary, target, fsConstants.COPYFILE_EXCL)
      return false
    }

    let replaced = false
    try {
      const existing = await lstat(target)
      if (existing.isSymbolicLink()) throw new Error('拒绝覆盖符号链接')
      replaced = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    // rename 会替换目录项本身而不会跟随符号链接，并避免暴露部分写入的最终文件。
    await rename(temporary, target)
    return replaced
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error(`文件已存在，未覆盖：${target}；如需替换请设置 overwrite=true`)
      conflict.code = TARGET_EXISTS
      throw conflict
    }
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * 下载 arXiv PDF 到本机。按候选源依次尝试，先写入临时文件校验，再复制到目标路径；
 * 默认不覆盖已有文件，任何失败都会清理临时文件。
 */
export async function downloadPaper({ id: value, directory, filename, overwrite = false }) {
  const id = checkedPaperId(value)
  const targetDirectory = outputDirectory(directory)
  const target = path.join(targetDirectory, portableFilename(filename, id))
  const sources = pdfBaseCandidates().map((base) => `${base}/pdf/${encodedPaperId(id)}.pdf`)

  await mkdir(targetDirectory, { recursive: true })

  const failures = []
  for (const sourceUrl of sources) {
    const temporary = path.join(targetDirectory, `.${path.basename(target)}.${randomUUID()}.tmp`)
    try {
      const bytes = await fetchPdfTo(sourceUrl, temporary)
      const overwritten = await commitPdf(temporary, target, overwrite)
      return { id, path: target, filename: path.basename(target), bytes, overwritten, sourceUrl }
    } catch (error) {
      if (error?.code === TARGET_EXISTS) throw error
      await unlink(temporary).catch(() => {})
      failures.push(`${sourceUrl}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`PDF 下载失败：${failures.join(' | ')}`)
}
