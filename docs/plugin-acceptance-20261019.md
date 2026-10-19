# Codex 插件第一轮验收 · 2026-10-19

版本：`code-review` 0.2.0。交付是本地 Codex 插件，包括一份分析 Skill、七个 stdio MCP 工具和现有 SCIP 语义模型。分析由 Codex 完成，没有独立模型调用或另建 Agent 调度系统。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm --prefix semantic-model test` | 15 项通过 |
| 插件清单、兼容配置、Skill YAML、MCP 入口一致性 | 通过 |
| 官方 MCP SDK 客户端连接真实 stdio 子进程 | 初始化、7 工具发现和调用通过 |
| Codex CLI 安装到隔离的临时 CODEX_HOME | marketplace 注册、插件安装、enabled 状态通过 |
| 已安装路径的 MCP 入口 | 7 工具发现、`open_repository` 调用通过 |
| 智能问答助手业务案例 | 使用真实 MCP 工具收集并由 Codex 审阅源码证据 |

隔离安装测试没有改动用户配置或安装列表，完成后清理临时测试目录。它验证了当前 CLI 的本地安装及安装后服务器启动，没有宣称当前桌面聊天已经加载此插件。

工具测试涵盖仓库隔离、索引归属检查、分页、非法参数、未知仓库和符号、源码变更后的证据拒绝、字面量搜索及源码信任标记。原有测试继续验证 Python/TS 真实跨文件索引和 Windows 兼容。

## 案例：聊天请求到权限检查

目标项目：AI-QA-Assistant，提交 `44a78f363f5ed983115f1bfbdea24029e68fe455`。采集前后状态为 fresh。此处记录源码审阅结论，不是运行应用、权限穿透测试或完整安全审计的结论。

已确认的源码序列：

1. `frontend/server/routes/api/chats/[id].post.ts:147` 的 POST handler 调用 `requireCsrf`，随后调用 `requireOwnedChat(event, id, 'editor')`。读取到的 `chatAccess.ts:70` 实现会解析启用的 actor、查询 chat，并在存在 topic 时校验相应角色；完整所有权与 actor helper 的所有分支未在本案例展开。
2. 同一 POST 文件 `:255` 调用 `/api/internal/chat/retrieval/stream`，服务端设置 `X-User-ID`、内部 token 及 request body 的 user/session 信息。此处确认实际调用语句，不只是同名字符串。
3. `agent/agent/api/internal_memory_routes.py:203` 的内部流式路由声明内部 token 和 user ID 依赖；`:212` 检查 request actor 一致性，`:216` 先调用 `resolve_access(agent, user_id, [])`，再在 `:219` 调用 `agent.stream_chat(request)`。
4. `agent/agent/api/access_routes.py:22` 的 `resolve_access` 调用 `permission_service.get_accessible_doc_ids_strict`，并把权限异常转换为 HTTP 异常。
5. `agent/agent/service/permission_service.py:85` 实现中，空身份导致 401，未知或禁用用户导致 403；取得候选文档后在 `:109` 继续调用 `source_provider.filter_allowed`，异常路径包含 503。管理员分支仍经过该 filter 调用。`doc_ids=[]` 这一次调用主要验证 actor；不据此宣称它已检查后续所有检索文档。
6. 已读取 `agent/agent/agent.py:603`：内部 Chat 请求经 `chat_with_memory`，后者在 `:650` 调用常规 `chat`。本案例没有继续证明全部模型调用、检索过滤及最终答案释放路径。

语义索引为 `get_accessible_doc_ids_strict` 返回 4 处已关联 occurrence。字面量搜索另外定位到 `AccessGuard.allowed_documents` 中经 `self.permissions` 的调用。由此确认：静态索引没有关联到的动态属性调用仍需源码搜索补充，不能把引用数量当成完整调用数量。

证据文件保存在本地 `semantic-model/output/chat-permission-evidence.json`，包含每次工具请求、片段、SHA-256、snapshot fingerprint 和 evidence ID，不进入 Git。示例文件指纹：

- Web POST handler：`920ebd2d174457b3c259ff29c1271b5a494f331de9bc4211a7015bdc6dcabd91`
- 内部流式路由：`3f6d6f095fdfbbad32df1e51a9200d24e85695a5935c65bea819bc87282de419`
- 权限服务：`19c0afecf6cff8b11455424a7c6e8506c47141fba9897124edd06e70f4857d3a`

## 限制与后续

- Vue SFC、运行时注入、动态调用和跨语言跳转没有完整语义关联。
- TS 单一补充配置扩大覆盖，但不能代替各子项目的真实编译配置。
- 当前没有执行独立漏洞规则、模型评审 API 或应用的端到端权限测试。
- 检索返回可以分页或截断；消费者必须读取相关标志。源码和注释始终按不可信数据处理。
- 下一个适合扩展的方向是保留 SCIP 的 enclosing range、补充按符号组织的上下文预算，并用更多真实问题测量证据检索的遗漏，而不是直接堆叠漏洞规则。
