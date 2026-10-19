# 解析与持久化实现

第一阶段只负责把仓库转换为持久化 Code IR。运行命令和产物布局见根目录 README，数据字段见 `../docs/code-ir-v2.md`。

- Python 复用 `@sourcegraph/scip-python` 0.6.6（基于 Pyright，MIT）。Windows 正则转义兼容补丁仅在内存中应用，补丁不匹配时拒绝继续。
- TS/JS 复用 `@sourcegraph/scip-typescript` 0.4.0（Apache-2.0）。TypeScript 5.9.3 的配置 API 发现 JSONC、extends 和 references，每个配置独立生成适配文件；未归属文件建立明确标注的 inferred 单元。
- TypeScript 编译器 AST 与 Python 3.9+ 标准库 AST 提取源码结构、签名、导入和调用位置。Python 在隔离模式下读取保存的源码，不导入应用。`@iarna/toml` 2.2.5 读取 Python 项目 TOML。
- SCIP 协议固定于 `fcb3cb3c679fe2da18141550f864b9e67afab297`，许可见 `vendor/SCIP-LICENSE`。
- protobufjs 解码原始 SCIP；`ir.js` 写出规范化 JSONL、源码 blob、解析配置/环境元数据和 manifest；`verify-ir.js` 校验内部关联；`projection.js` 仅从保存的 IR 原子重建 SQLite。
- `relations.js` 从已有定义/引用生成带逐条证据的文件关系与项目概览；不推断业务职责，不把普通引用改写为调用，未解析与多定义目标单独记录。
- `symbols.js` 读取 SCIP 协议包头区分已识别标准库/依赖与未知目标；`rules.js` 通过固定版本的程序规则保存候选与限制，不调用 LLM。Vue 使用官方 `@vue/compiler-sfc` 3.5.38 补充脚本与模板事实。

依赖固定在 package.json 与 lockfile。Python 按组件寻找最近祖先 `.venv`，或使用指定解释器；找不到时使用空包清单并保存环境缺口，第三方包解析可能不完整。原始 SCIP 和覆盖报告一并保存，不能把文件覆盖数当成语义正确率。

此前加入的插件、MCP、Skill 和业务分析工具已移除。后续 Agent 层可以由 Codex 消费这里保存的 IR，但不属于当前阶段。
