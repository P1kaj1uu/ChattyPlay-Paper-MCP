import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { VERSION, canonicalPaperId, downloadPaper, getPaper, getRelatedResources, isValidPaperId, readPaper, searchPapers } from './papers.mjs'

const paperId = z.string().trim().min(1).max(200)
  .describe('arXiv ID、arXiv: 前缀或 arxiv.org 的 abs/pdf 链接；支持新版和旧版 ID')
  .refine(isValidPaperId, '请输入有效的 arXiv ID 或链接，例如 2609.12345')
  .transform(canonicalPaperId)
const nullableUrl = z.string().nullable()
const paperSchema = z.object({
  id: z.string(), title: z.string(), authors: z.array(z.string()), publishedAt: z.string(),
  submittedAt: z.string(), submittedBy: z.string().nullable(),
  summary: z.string(), aiSummary: z.string(), keywords: z.array(z.string()),
  source: z.string().nullable(), upvotes: z.number(), comments: z.number(),
  github: nullableUrl, githubStars: z.number(), projectPage: nullableUrl, organization: z.string().nullable(),
  links: z.object({ huggingFace: nullableUrl, arxiv: nullableUrl, pdf: nullableUrl })
})
const resourceSchema = z.object({
  id: z.string(), type: z.string(), author: z.string().nullable(), lastModified: z.string().nullable(),
  downloads: z.number(), likes: z.number(), pipelineTag: z.string().nullable(), url: nullableUrl
})

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function createServer() {
  const server = new McpServer(
    { name: 'chattyplay-paper', version: VERSION },
    {
      instructions: [
        '用于检索论文、读取元数据与正文、查找关联资源，以及把 arXiv PDF 下载到运行本服务的本地电脑。',
        '主源 huggingface.co 不可达时会自动回退到 hf-mirror.com；可用 PAPERS_API_BASE 指定其他镜像或代理。',
        '所有工具同时返回文本结果和 structuredContent，以兼容新旧客户端。'
      ].join(' ')
    }
  )

  server.registerTool('search_papers', {
    title: '搜索论文',
    description: '搜索 Hugging Face 论文；无关键词时浏览 Daily Papers，可按日期、周、月和热度筛选。关键词搜索最多返回前 120 条。',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(250).optional().describe('标题、摘要、作者或关键词'),
      date: z.iso.date().optional().describe('日期，格式 YYYY-MM-DD'),
      week: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/).optional().describe('ISO 周，格式 YYYY-Www'),
      month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional().describe('月份，格式 YYYY-MM'),
      sort: z.enum(['publishedAt', 'trending']).default('publishedAt'),
      limit: z.number().int().min(1).max(100).default(20),
      page: z.number().int().min(0).max(100).default(0).describe('结果页码，从 0 开始；关键词搜索受 120 条上限约束')
    }).refine(({ date, week, month }) => [date, week, month].filter(Boolean).length <= 1, {
      message: 'date、week、month 只能选择一个'
    }),
    outputSchema: z.object({
      papers: z.array(paperSchema), count: z.number().int().nonnegative(),
      source: z.enum(['search', 'daily']), page: z.number().int().nonnegative(), hasMore: z.boolean()
    }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (input) => {
    try { return result(await searchPapers(input)) } catch (error) { return toolError(error) }
  })

  server.registerTool('get_paper', {
    title: '获取论文详情',
    description: '根据 arXiv ID、arXiv: 前缀或 arxiv.org 链接获取标题、作者、摘要、AI 摘要、关键词和相关链接。',
    inputSchema: z.object({ id: paperId }),
    outputSchema: paperSchema,
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ id }) => {
    try { return result(await getPaper(id)) } catch (error) { return toolError(error) }
  })

  server.registerTool('read_paper', {
    title: '读取论文正文',
    description: '以 Markdown 分页读取论文正文；使用 nextStart 继续，避免一次返回过长内容。',
    inputSchema: z.object({
      id: paperId,
      start: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1000).max(50000).default(20000)
    }),
    outputSchema: z.object({
      id: z.string(), content: z.string(), start: z.number().int().nonnegative(),
      nextStart: z.number().int().nonnegative().nullable(),
      totalChars: z.number().int().nonnegative(), truncated: z.boolean()
    }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ id, start, maxChars }) => {
    try { return result(await readPaper(id, { start, maxChars })) } catch (error) { return toolError(error) }
  })

  server.registerTool('get_related_resources', {
    title: '获取论文关联资源',
    description: '查找带有指定 arXiv 标签的 Hugging Face 模型、数据集和 Space；单类请求失败时返回其余结果及 warnings。',
    inputSchema: z.object({ id: paperId, limit: z.number().int().min(1).max(50).default(10) }),
    outputSchema: z.object({
      models: z.array(resourceSchema), datasets: z.array(resourceSchema),
      spaces: z.array(resourceSchema), warnings: z.array(z.string())
    }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ id, limit }) => {
    try { return result(await getRelatedResources(id, limit)) } catch (error) { return toolError(error) }
  })

  server.registerTool('download_paper', {
    title: '下载论文 PDF',
    description: '从 arXiv 流式下载并校验 PDF，保存到运行本服务的本地电脑；默认不覆盖已有文件。',
    inputSchema: z.object({
      id: paperId,
      directory: z.string().trim().min(1).max(4096).optional().describe('目标目录；支持绝对路径、相对启动目录的路径或 ~/...；默认 PAPER_DOWNLOAD_DIR 或 ~/Downloads'),
      filename: z.string().trim().min(1).max(180).optional().describe('单个跨平台文件名；可省略 .pdf'),
      overwrite: z.boolean().default(false).describe('是否覆盖同名文件；默认 false，设为 true 时仍拒绝覆盖符号链接')
    }),
    outputSchema: z.object({
      id: z.string(), path: z.string(), filename: z.string(), bytes: z.number().int().nonnegative(),
      overwritten: z.boolean(), sourceUrl: z.string()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (input) => {
    try { return result(await downloadPaper(input)) } catch (error) { return toolError(error) }
  })

  return server
}

const handle = serveStdio(createServer)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await handle.close()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
