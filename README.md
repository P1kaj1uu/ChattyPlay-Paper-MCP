# ChattyPlay Paper MCP

独立的 stdio MCP 服务，把论文检索、正文阅读、关联资源和 PDF 下载交给任意 MCP 客户端。

| 工具                    | 作用                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `search_papers`         | 关键词搜索论文，或按日期 / ISO 周 / 月份浏览 Daily Papers，支持热度排序与分页          |
| `get_paper`             | 按 arXiv ID、`arXiv:` 标识或 arXiv 链接获取标题、作者、摘要、AI 摘要、关键词与相关链接 |
| `read_paper`            | 分页读取论文 Markdown 正文，用 `nextStart` 续读                                        |
| `get_related_resources` | 查找带该 arXiv 标签的 HF 模型、数据集和 Space；单类失败时保留其余结果并给出 `warnings` |
| `download_paper`        | 从 arXiv 流式下载并校验 PDF 到本机，默认不覆盖已有文件                                 |

所有工具同时返回文本结果和 `structuredContent`，以兼容新旧客户端。

## 环境要求

- Node.js 20 或更高（`engines` 已声明）。`node --version` 能跑通即可，无需全局安装依赖之外的东西。
- 无需 Python、无需 Docker、无需浏览器。

## 安装与启动

```bash
cd /path/to/ChattyPlay-Paper-MCP
npm install
npm start
```

`npm start` 会在当前进程里以 stdio 方式启动服务 —— 手工运行它会看到服务在等待 stdin 上的 JSON-RPC 消息，这是正常现象，通常不需要手工启动，交给 MCP 客户端拉起即可。

## 环境变量

| 变量                    | 默认值                       | 说明                                         |
| ----------------------- | ---------------------------- | -------------------------------------------- |
| `HF_TOKEN`              | 空                           | Hugging Face Token；遇到限流或受限内容时使用 |
| `PAPERS_API_BASE`       | `https://huggingface.co/api` | API 根地址。**显式设置后不再自动回退镜像**   |
| `PAPERS_HUB_BASE`       | 由 `PAPERS_API_BASE` 推导    | 论文 Markdown 站点地址                       |
| `ARXIV_BASE_URL`        | `https://arxiv.org`          | PDF 下载站点。设置后只使用该单一源           |
| `PAPER_DOWNLOAD_DIR`    | 当前用户的 `Downloads`       | `download_paper` 的默认目录                  |
| `PAPERS_TIMEOUT_MS`     | `15000`                      | 单次 API 请求超时                            |
| `PAPERS_PDF_TIMEOUT_MS` | `120000`                     | 单次 PDF 下载超时                            |

## 网络与镜像

服务默认先请求 `huggingface.co`，在**网络层失败**（DNS 解析不了、连接被重置、超时）或遇到 `403/408/429/5xx` 时，自动回退到 `https://hf-mirror.com`。参数错误（`400/401/404/422`）不会重试，直接返回服务端给出的原因 —— 换镜像对这类错误没有意义。

进程内会记住上次成功的源，后续请求直接命中，不会每次都先等一次超时。

内网或自建代理请在客户端配置里显式设置 `PAPERS_API_BASE`（例如公司镜像或 `https://hf-mirror.com/api`）；一旦显式设置，服务就只走你指定的地址，不再自动探测。

## MCP 客户端配置

服务使用标准 `stdio` 传输。下面把 `/abs/path/to/ChattyPlay-Paper-MCP/index.mjs` 换成你机器上 `index.mjs` 的**绝对路径**。

> Windows：JSON 里反斜杠要转义成 `\\`，例如 `C:\\Users\\me\\ChattyPlay-Paper-MCP\\index.mjs`；也可以统一写成正斜杠 `C:/Users/me/...`。macOS/Linux 用 `/Users/...` 或 `/home/...`。
> 始终把 `node` 和脚本路径拆成两个数组元素，不要拼成一条命令 —— 这样带空格的路径（`C:\Program Files\...`）也不会出问题。

### Claude Desktop

配置文件：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`，Windows `%APPDATA%\Claude\claude_desktop_config.json`，Linux `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`（未设置 `XDG_CONFIG_HOME` 时为 `~/.config/Claude/claude_desktop_config.json`）。

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add chattyplay-paper -- node /abs/path/to/ChattyPlay-Paper-MCP/index.mjs
```

也可以写进项目根目录的 `.mcp.json`，结构同上面的 `mcpServers`。

### Cursor

全局配置 `~/.cursor/mcp.json`，或项目内的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
    }
  }
}
```

### VS Code（Copilot Chat）

项目内的 `.vscode/mcp.json`。需要同时用于 VS Code Agent Host / GitHub Copilot CLI 时，可改放项目根目录 `.mcp.json`；用户级配置可放 `~/.copilot/mcp-config.json`。注意这里用的键是 `servers`（不是 `mcpServers`），且需要 `type`：

```json
{
  "servers": {
    "chattyplay-paper": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
    }
  }
}
```

### Windsurf

配置文件 `~/.codeium/windsurf/mcp_config.json`：

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
    }
  }
}
```

### Cline

在 Cline 面板里打开 MCP Settings（`cline_mcp_settings.json`），加入：

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Codex CLI

```bash
codex mcp add chattyplay-paper -- node /abs/path/to/ChattyPlay-Paper-MCP/index.mjs
```

或写进 `~/.codex/config.toml`：

```toml
[mcp_servers.chattyplay-paper]
command = "node"
args = ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
```

TOML 里不要转义反斜杠以外的字符；Windows 路径同样建议写正斜杠。

### Gemini CLI

配置文件 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"]
    }
  }
}
```

### 通用模板

只认标准 `mcpServers` 的客户端（Zed、Continue、Goose、JetBrains AI 等）直接用：

```json
{
  "mcpServers": {
    "chattyplay-paper": {
      "command": "node",
      "args": ["/abs/path/to/ChattyPlay-Paper-MCP/index.mjs"],
      "env": {
        "HF_TOKEN": "hf_xxx"
      }
    }
  }
}
```

`env` 只在需要时添加。**不要填 `"可选"` 之类的占位字符串** —— 那会被当成真实 Token 发出去。用版本管理器安装 Node 的机器如果客户端找不到 `node`，把 `command` 换成 `node` 的绝对路径（macOS/Linux 用 `command -v node`，Windows 用 `where.exe node` 查询）。

## 工具参数

### search_papers

- `query`：标题 / 摘要 / 作者 / 关键词，可省略
- `date` (`YYYY-MM-DD`)、`week` (`YYYY-Www`)、`month` (`YYYY-MM`)：三者只能选一个
- `sort`：`publishedAt` 或 `trending`
- `limit`、`page`：分页

带 `date` / `week` / `month` 时走 Daily Papers 并在本地按 `query` 过滤。纯关键词搜索走 `/papers/search`：该端点**没有 offset 参数**，且 `limit` 硬上限是 **120**，所以最多只能翻到前 120 条。服务会在请求前拦下越界的分页，而不是发出一个必然 400 的请求。

`hasMore` 通过多取一条记录判断，可以安全地用它决定要不要继续翻页。

### download_paper

```json
{
  "id": "https://arxiv.org/abs/1706.03762",
  "directory": "~/Downloads",
  "filename": "attention-is-all-you-need.pdf",
  "overwrite": false
}
```

- `id`：arXiv ID、`arXiv:` 前缀或 `arxiv.org` 的 `abs`/`pdf` 链接，可带版本号（`v2`），会自动归一化
- `directory`：绝对路径、相对启动目录的路径或 `~/...`；省略时用 `PAPER_DOWNLOAD_DIR`
- `filename`：只允许单个跨平台文件名，省略 `.pdf` 时自动补全
- `overwrite`：默认 `false`；设为 `true` 时仍拒绝覆盖符号链接

下载流程：先流式写入目标目录下的临时文件并校验 `%PDF-` 文件头；覆盖时原子替换目标目录项，不覆盖时使用排他创建，任何失败都会清理临时文件。单文件上限 100 MiB。`arxiv.org` 不可用时会自动尝试 `export.arxiv.org`。

返回值里的 `bytes` 是**实际写入的字节数**，`sourceUrl` 是本次真正生效的源。

`path` 是运行本服务的这台电脑上的绝对路径。stdio 模式下服务就在你本机，所以就是你的电脑；如果你把服务托管在远程机器上，文件会落在**那台**机器上，而不是调用者的电脑。

`overwritten` 只有在本次确实替换了已有普通文件时才为 `true`；仅仅传入 `overwrite: true` 但目标原本不存在时仍为 `false`。

## 已知限制

- `/papers/search` 无分页游标，关键词搜索最多返回前 120 条；需要更大范围时请用日期 / 周 / 月浏览。
- 正文来自 Hugging Face 的论文 Markdown（本质是 arXiv HTML 的转换结果），并非每一篇论文都有。
- 关联资源只覆盖 Hugging Face 上带 `arxiv:<id>` 标签的模型 / 数据集 / Space。
