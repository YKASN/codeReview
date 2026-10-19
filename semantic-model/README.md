# Repository Semantic Model

代码审计的第一步：使用成熟的 SCIP 索引器，把当前工作区转换为可查询、有源码位置和指纹的语义数据。实现位于独立目录，不依赖旧 CodeReview 架构，也不运行智能问答助手应用。

## 使用

需要 Node.js 24+、Git。以下命令在本目录执行：

```powershell
npm ci --ignore-scripts
npm test
node src/cli.js scan --repo 'C:\Users\Hola\Desktop\Q&A\AI-QA-Assistant' --out output/ai-qa-assistant
node src/cli.js summary --db output/ai-qa-assistant
node src/cli.js symbols --db output/ai-qa-assistant --name permission
node src/cli.js uncovered --db output/ai-qa-assistant
node src/cli.js context --db output/ai-qa-assistant --file agent/agent/service/permission_service.py --line 1
```

用 `symbols` 返回的完整 `id` 查询所有定义和引用位置：

```powershell
node src/cli.js refs --db output/ai-qa-assistant --symbol 'COPIED_EXACT_SYMBOL_ID'
```

扫描默认启用 Python 和 TypeScript/JavaScript；可传 `--languages python` 或 `--languages typescript`。Python 默认读取目标仓库 `.venv`，其他环境通过 `--python ABSOLUTE_PATH` 指定。没有虚拟环境时明确使用空依赖清单，报告标注 `empty-no-venv`，第三方依赖解析将不完整。不会自动安装目标依赖。

TS 在输出目录生成 `tsconfig.index.json`，显式纳入文件清单中所有 TS/JS，避免目标工程的 include 配置遗漏服务端路由和测试。基础配置优先根目录，再选择 `frontend/`；该目录有 `tsconfig.app.json` 时继承它，否则继承 `tsconfig.json`。overlay 保留继承的编译选项，并覆盖 `noEmit/allowJs/rootDir/files/include/exclude/references`。扫描报告记录 `inventory-overlay` 模式及基础配置。单一配置不能完全代表复杂 monorepo 各子项目的编译环境：覆盖文件不等于正确解析所有类型，独立项目配置的逐项目调度后续扩展。

## 产物与契约

每次扫描建立独立 `scan-*` 目录，包含：

- `inventory.json`：Git 跟踪和未忽略未跟踪文件的路径、语言、大小、SHA-256，以及排除原因。
- `python.scip` / `typescript.scip`：官方索引器原始输出。
- `model.sqlite`：文件、符号、定义/引用 occurrence、原始关系、索引工具及快照信息。
- `python-environment.json`：传给 Python 索引器的已安装包元数据。
- `tsconfig.index.json`：传给 TypeScript 索引器的输出目录内补充配置。
- `*.log`、`report.json`：索引器日志、执行状态、文档覆盖、诊断数和产物指纹。

输出必须位于分析仓库之外。`latest.json` 只指向源码指纹稳定、至少有一个索引器成功生成非空结果的扫描；部分成功允许发布，状态明确保留 `partial`。`scan` 全部索引器非空返回 0，部分失败、空索引或源码扫描期间变化返回 2，参数或运行错误返回 1。`indexed` 只表示所选索引器生成结果，不表示全文件覆盖或所有符号都解析成功。完整覆盖数字见 `summary`，未覆盖文件见 `uncovered`。

SCIP occurrence 坐标为 **零起点、结束不包含**，`refs/context` 的 occurrence 返回 `position_encoding`，SQLite 的 `documents.encoding` 也保留该值。旧索引器可能未声明编码，值为 0，此时不猜测字符列编码。`context` 接受并返回一起点行号。查询结果为本地 JSON，可供后续分析 Agent 消费。两个固定版本索引器在 Windows 上输出的反斜线相对路径会转换为 `/`，转换数量记入报告；仍拒绝绝对路径、`.`/`..` 和符号链接。

`symbols.id` 保留 SCIP 全局标识；`local N` 则按索引器和文档作用域隔离，防止不同文件局部变量错误合并。定义标志使用 SCIP `SymbolRole.Definition` 位，其他 occurrence 作为引用。保存关系的原始 SCIP 数据，不把引用伪装为调用边，也不推断污点流。

扫描前后校验纳入清单文件的整体指纹；不稳定扫描拒绝证据查询。`context` 读取前逐文件核对 SHA-256，文件变化后要求重新扫描。`refs`/`symbols` 返回历史索引位置，取实际源码证据时必须再调用 `context`。查询当前实现没有自动增量更新或跨提交合并。

## 范围和限制

当前支持 Python、TS/JS 的定义与引用。Vue 单文件组件、SQL、配置、Markdown 等保留清单和指纹，未被 SCIP 索引时会显示为未覆盖。动态导入、运行时路由、反射、跨语言调用和数据流需要后续补充，不属于本阶段已实现能力。`diagnostics` 仅统计索引器输出的诊断，不是独立类型检查或安全审计结果。

文件清单排除 Git 忽略路径、常见依赖/构建目录、符号链接、超过 1 MiB 的文件、二进制及常见凭据文件名。这个策略不是敏感内容识别器；原始 SCIP 可能包含代码文档、符号和本机路径。产物默认留在本地并被本目录 `.gitignore` 忽略，不要上传或提交源代码索引。

本阶段没有问答 UI、模型推理、安全漏洞判定、图谱展示或 Sourcegraph 服务部署。下一阶段可以基于这些证据实现“定位入口 → 找定义与引用 → 读取校验过的上下文”的分析工具。

## 复用来源

- [SCIP protocol](https://github.com/scip-code/scip)，vendored `scip.proto` 固定于 `fcb3cb3c679fe2da18141550f864b9e67afab297`，Apache-2.0 许可见 `vendor/SCIP-LICENSE`。
- [scip-python](https://github.com/sourcegraph/scip-python) 0.6.6，基于 Pyright，MIT 许可。`src/run-python.cjs` 在内存中修复该版本 Windows 正则转义问题，补丁不匹配时立即报错。
- [scip-typescript](https://github.com/sourcegraph/scip-typescript) 0.4.0，Apache-2.0 许可。

依赖版本固定在 `package.json` 和 lockfile；协议用 protobufjs 解码，查询存储用 Node 自带 SQLite。升级索引器时需要复验 Windows 兼容补丁和两种语言的真实跨文件索引测试。
