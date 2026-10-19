# CodeReview · 代码仓库到持久化 Code IR

当前只实现第一步：**扫描仓库，复用成熟解析器，把代码转换为可保存、可校验、可再次加载的中间文件。**

Agent 推理层以后可以使用 Codex。当前阶段的核心交付是 Code IR 数据及其保存契约。

## 转换流程

```text
代码仓库当前工作区
  → 文件清单与源码指纹
  → 项目配置/环境发现 → scip-python / scip-typescript
  → TypeScript 编译器 AST / Python 标准库 AST 补充结构
  → 原始 SCIP + 规范化 Code IR + 源码快照
  → 写入磁盘，完成版本与校验清单
```

每次转换生成独立的 `scan-*` 目录：

```text
scan-*/
  code-ir/
    manifest.json             # code-ir/2、仓库版本、解析器、覆盖、计数、文件校验
    overview.json             # 可重建的项目概览、语言统计、引用覆盖与缺口
    rule-report.json          # 确定性候选规则版本、适用范围、命中及覆盖
    projects.jsonl            # 解析单元、配置继承、环境、输入文件和缺口
    files.jsonl               # 路径、语言、大小、源码指纹和 source blob 映射
    documents.jsonl           # 解析文档元数据和位置编码
    symbols.jsonl             # 符号信息，保留解析器原始字段
    occurrences.jsonl         # 定义/引用位置、enclosing range 等
    relationships.jsonl       # 解析器明确提供的符号关系
    file-references.jsonl     # 文件间符号引用汇总，逐条保留引用和定义证据
    candidates.jsonl          # 待核实候选：规则、源码位置、证据和限制条件
    diagnostics.jsonl         # 解析器诊断
    external-symbols.jsonl    # 外部符号信息
    structures.jsonl          # 模块、类、函数、参数及源码包含关系
    imports.jsonl             # 导入声明、别名和相对层级
    calls.jsonl               # 调用位置、静态绑定证据和未解析原因
    syntax-diagnostics.jsonl  # 结构解析诊断
    template-expressions.jsonl # Vue 模板组件、指令和插值语法事实
    sources/<sha256>          # 原始文件字节快照，按内容去重
    raw/*.scip                # 保留完整解析器输出
    raw/*.json                # 实际使用的配置适配文件和环境包元数据
  model.sqlite                # 本地索引投影，便于以后消费
  inventory.json              # 扫描清单和排除原因
  projects.json               # 项目发现和输入归属记录
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

`--languages python` 或 `--languages typescript` 可选择语义索引器；源码结构提取仍覆盖清单内的 Python/TS/JS。Python 结构提取需要 Python 3.9+；默认读取目标项目已有 `.venv` 的包元数据，也可通过 `--python ABSOLUTE_PATH` 指定解释器。目标依赖不会自动安装，应用不会被启动。输出路径必须位于目标仓库之外。

TS 配置按实际项目分别处理，未被配置覆盖的文件单独标为推断单元；Python 按源码组件与配置记录解析环境。每个文件保存项目归属、逐单元解析状态和缺口。

只有源码和项目配置指纹稳定、IR 写入完成且内部一致性校验通过的扫描才更新 `latest.json`。部分索引成功标为 `partial`；执行失败和未覆盖语言会被记录。`indexed` 表示所选索引器均产生结果，不代表完整理解所有动态行为。

文件清单排除 Git 忽略路径、常见凭据文件、依赖/构建目录、符号链接、二进制及超过 1 MiB 的文件。源文件内容会保存在本地转换结果中，产物应放在受控的数据目录，默认不提交 Git。

## 本阶段边界

当前聚焦 AIQA 使用的 Python、TS/JS、Vue。Vue 使用官方 SFC 解析器提取脚本结构、导入、调用以及模板组件/指令/插值；模板与符号的语义绑定尚未补齐。动态属性调用、反射和跨语言调用存在缺口。引用不自动转为调用边，不推断污点传播。

调用记录来自 AST；仅在调用名的源码位置与 SCIP 引用精确匹配、且目标是已定义的可调用声明时标记 `resolved-static`。它表示静态声明关联，不保证运行时分派。SQLite 可由保存的 IR 离线重建，示例见契约文档。

文件间关系按源解析项目分别汇总：从符号引用追到快照中已索引的定义文件。多个定义文件保留为候选；没有快照内定义的引用单独统计，区分已识别外部目标与未解析目标，不凭导入字符串推测。概览和文件关系均由底层事实生成，校验时重新计算比对。

SCIP 包标识能够识别标准库和第三方依赖，即使其定义源码未保存也会标为已识别外部符号。无法确认外部身份的目标仍保持未知，不将所有快照外引用视为错误。

第一阶段使用程序规则记录待核实候选：无声明范围外引用的函数、简单 Python 实参数量不匹配、显式相对导入缺少清单内源码目标、索引器错误/警告。规则命中不等于缺陷；导出 API、装饰器、测试入口、动态行为和覆盖缺口保存在候选限制中，供后续 LLM 分析。应用和目标依赖不会因规则扫描而执行。

[当前 Code IR v2 契约](docs/code-ir-v2.md) · [v2 实际验收](docs/code-ir-v2-acceptance-20261019.md) · [历史 v1 契约](docs/code-ir-v1.md) · [解析器与索引说明](semantic-model/README.md)
