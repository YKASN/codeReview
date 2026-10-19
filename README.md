# Code Review · Codex 本地插件

让 Codex 基于可追溯的源码证据分析仓库。Codex 负责规划、理解和评审；插件提供成熟 SCIP 索引器、查询工具和分析 Skill。

## 当前能力

- `open_repository`：选择用户指定的本地 Git 仓库，返回本进程内的 repository ID。
- `index_repository`：使用 scip-python / scip-typescript 建立索引。
- `repository_status`：检查源码指纹是否变化，报告语言覆盖和索引状态。
- `search_source`：从文件清单中搜索经过 SHA-256 校验的源码文本，支持分页。
- `search_symbols`：发现符号标识，作为待验证的定位线索。
- `get_symbol_evidence`：分页读取定义和引用，以及校验过的源码上下文。
- `read_context`：按文件和行号读取当前有效的源码证据。

每段证据包含仓库快照、文件 SHA-256、位置、evidence ID 和信任标记。源码中的指令只是数据。引用关系需要 Codex 阅读实际语句后才能解释为调用、类型注解或其他用法。

## 开发与运行

需要 Node.js 24+、Git；Python 项目已有 `.venv` 时会读取其包元数据。无需 OpenAI API key，插件不另行调用模型。以下命令在仓库根目录执行：

```powershell
npm --prefix semantic-model ci --ignore-scripts
npm --prefix semantic-model test
node scripts/check-plugin.mjs
```

MCP 入口为 `semantic-model/src/mcp-server.js`，使用 stdio。stdout 只输出 MCP 协议，日志写 stderr。可用 MCP 客户端直接启动：

```powershell
node semantic-model/src/mcp-server.js
```

它将等待客户端的 MCP initialize 和工具请求，直接运行不会显示聊天界面。

## 在 Codex 中使用

根目录提供 Agent Plugins 1.0 的 `plugin.json` / `mcp.json`，并同步 `.codex-plugin/plugin.json` / `.mcp.json` 兼容配置。`skills/repository-analysis/SKILL.md` 定义证据分析流程，本仓库的 `.agents/plugins/marketplace.json` 提供开发目录入口。

在当前 Codex CLI 中，可注册并安装此开发来源：

```powershell
codex plugin marketplace add 'C:\path\to\codeReview'
codex plugin add code-review@code-review-dev
```

先执行上述 `npm ci` 依赖准备命令，再安装本地来源。本机 CLI 已在隔离配置目录中验证：安装后服务器能启动、七个工具能被发现，`open_repository` 能调用。不同宿主的本地安装/缓存行为可能不同，单纯写入 manifest 不表示当前聊天已加载插件。安装后在新聊天中选用 Code Review，确认七个工具实际出现，再请求：

> 用 Code Review 分析这个仓库从聊天请求到权限检查的路径，每个关键结论附源码位置，并说明无法确认的关系。

如果宿主缺少本地 Node 或依赖，请先完成本地运行时准备，再重试。开发验证会单独记录 MCP 协议测试与实际宿主安装结果，不把两者混为同一项。

默认数据路径为 `PLUGIN_DATA/indexes/<repository-id>`；宿主未提供时使用 `~/.cache/codex-code-review/indexes/`。可通过 `open_repository.index_path` 复用已有索引，必须与目标仓库一致。索引器不自动运行项目代码或安装目标依赖。目标仓库源码变化时重新索引。

## 案例验证

智能问答助手项目的可复现 MCP 证据采集：

```powershell
node semantic-model/scripts/chat-permission-case.mjs 'C:\path\to\AI-QA-Assistant' 'C:\path\to\existing-index' semantic-model/output/chat-permission-evidence.json
```

该脚本仅检查工具链并收集证据，源码行为的解释由 Codex 审阅后写入验收记录。它不会因为工具返回成功就宣称审计通过。

## 开发边界

这是 Codex 插件项目。后续能力围绕 Skill、工具契约、语义数据和证据质量演进。Vue SFC 解析、动态调用、跨语言关系及数据流仍有缺口；不会从索引覆盖数推导完整审计结论。

详细索引契约见 [语义模型说明](semantic-model/README.md)，当前案例与验证记录见 [插件验收](docs/plugin-acceptance-20261019.md)。原始索引、目标源码及本地证据文件不进入 Git。

插件结构依据 [OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。第三方 SCIP 协议及索引器的许可说明见语义模型目录。
