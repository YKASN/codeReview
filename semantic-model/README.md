# 解析与持久化实现

第一阶段只负责把仓库转换为持久化 Code IR。运行命令和产物布局见根目录 README，数据字段见 `docs/code-ir-v1.md`。

- Python 复用 `@sourcegraph/scip-python` 0.6.6（基于 Pyright，MIT）。Windows 正则转义兼容补丁仅在内存中应用，补丁不匹配时拒绝继续。
- TS/JS 复用 `@sourcegraph/scip-typescript` 0.4.0（Apache-2.0）。在输出目录生成补充 tsconfig，纳入清单中的 TS/JS，继承根或 frontend 下的应用配置。单份补充配置不能完全代表多子项目的编译环境，配置假设和诊断写入产物。
- SCIP 协议固定于 `fcb3cb3c679fe2da18141550f864b9e67afab297`，许可见 `vendor/SCIP-LICENSE`。
- protobufjs 解码原始 SCIP；`ir.js` 写出 JSONL、源码 blob 和 manifest；SQLite 保留本地索引投影。

依赖固定在 package.json 与 lockfile。没有虚拟环境时，Python 使用空包清单并记录 `empty-no-venv`，第三方包解析可能不完整。原始 SCIP 和覆盖报告一并保存，不能把文件覆盖数当成语义正确率。

此前加入的插件、MCP、Skill 和业务分析工具已移除。后续 Agent 层可以由 Codex 消费这里保存的 IR，但不属于当前阶段。
