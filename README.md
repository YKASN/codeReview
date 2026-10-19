# CodeReview · 代码仓库到持久化 Code IR

当前只实现第一步：**扫描仓库，复用成熟解析器，把代码转换为可保存、可校验、可再次加载的中间文件。**

Agent 推理层以后可以使用 Codex。当前阶段的核心交付是 Code IR 数据及其保存契约。

## 转换流程

```text
代码仓库当前工作区
  → 文件清单与源码指纹
  → scip-python / scip-typescript
  → 原始 SCIP + 规范化 Code IR + 源码快照
  → 写入磁盘，完成版本与校验清单
```

每次转换生成独立的 `scan-*` 目录：

```text
scan-*/
  code-ir/
    manifest.json             # code-ir/1、仓库版本、解析器、覆盖、计数、文件校验
    files.jsonl               # 路径、语言、大小、源码指纹和 source blob 映射
    documents.jsonl           # 解析文档元数据和位置编码
    symbols.jsonl             # 符号信息，保留解析器原始字段
    occurrences.jsonl         # 定义/引用位置、enclosing range 等
    relationships.jsonl       # 解析器明确提供的符号关系
    diagnostics.jsonl         # 解析器诊断
    external-symbols.jsonl    # 外部符号信息
    sources/<sha256>          # 原始文件字节快照，按内容去重
    raw/*.scip                # 保留完整解析器输出
  model.sqlite                # 本地索引投影，便于以后消费
  inventory.json              # 扫描清单和排除原因
  report.json                 # 本次转换状态与覆盖
  *.scip / *.log              # 原始执行产物和日志
```

`code-ir/` 可以独立保存和迁移。读取及完整性校验无需原仓库在线；原仓库后续修改不会改变已保存的源码快照。SQLite 是派生索引，规范化 JSONL、原始 SCIP 与源码快照共同组成持久化交付。

## 执行

需要 Node.js 24+、Git。在本仓库根目录运行：

```powershell
npm --prefix semantic-model ci --ignore-scripts
npm --prefix semantic-model test
node semantic-model/src/cli.js scan --repo 'C:\path\to\repository' --out 'D:\code-ir-data\repository'
node semantic-model/src/cli.js verify --ir 'D:\code-ir-data\repository\scan-XXXXXX\code-ir'
```

`--languages python` 或 `--languages typescript` 可选择索引器。Python 默认读取目标项目已有 `.venv` 的包元数据，也可通过 `--python ABSOLUTE_PATH` 指定解释器。目标依赖不会自动安装，应用不会被启动。输出路径必须位于目标仓库之外。

只有源码指纹稳定、IR 写入完成的扫描才更新 `latest.json`。部分索引成功标为 `partial`；执行失败和未覆盖语言会被记录。`indexed` 表示所选索引器均产生结果，不代表完整理解所有动态行为。

文件清单排除 Git 忽略路径、常见凭据文件、依赖/构建目录、符号链接、二进制及超过 1 MiB 的文件。源文件内容会保存在本地转换结果中，产物应放在受控的数据目录，默认不提交 Git。

## 本阶段边界

当前保留 Python、TS/JS 的静态语义事实。Vue SFC、动态属性调用、反射和跨语言调用存在缺口。引用不自动转为调用边，不推断污点传播。诊断原样保留，不等同于安全审计结果。

[Code IR 保存契约](docs/code-ir-v1.md) · [解析器与索引说明](semantic-model/README.md)
