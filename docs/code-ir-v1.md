# Code IR 保存契约 · code-ir/1

当前阶段的交付单位是一份持久化的仓库快照，而不是 Agent 工具接口。

## 标识与版本

`manifest.json.schema_version` 固定为 `code-ir/1`。不兼容的字段语义变化必须使用新版本；未来消费者应拒绝未知版本。

manifest 保存输入仓库提交、工作区 dirty 标记、文件清单指纹、创建时间、解析器版本/配置、覆盖统计，以及每个 IR 文件和源文件 blob 的 SHA-256 与字节数。原仓库绝对路径仅作出处记录，离线校验不会访问它。

每轮产物目录独立。manifest 先标记 `pending-validation`，扫描前后指纹确认后标记为 `indexed` 或 `partial`；未完成、源码变化或持久化失败的快照不作为完成产物发布。`latest.json` 只更新到通过发布条件的扫描。

## 文件格式

JSONL 使用 UTF-8，每行一个对象。允许空数据集，但对应 JSONL 文件仍存在。manifest 的 `counts` 是各数据集记录数，不是推断的唯一业务实体数。

| 数据集 | 主要内容 |
| --- | --- |
| files | 仓库相对路径、language、bytes、sha256、source blob 相对路径 |
| documents | indexer、file、source_sha256、原始文档元数据，包括 positionEncoding |
| symbols | indexer、file、source_sha256、规范化 id、raw SymbolInformation |
| occurrences | indexer、file、source_sha256、symbol_id、规范化 range、role、raw Occurrence |
| relationships | 来源符号、目标符号、文件和解析器出处、raw Relationship |
| diagnostics | 文件和源码指纹、位置、可选符号、raw Diagnostic |
| external-symbols | indexer、id、raw 外部 SymbolInformation |

`raw` 保留当前固定协议描述能解码的解析器字段，包括文档、关系标志、enclosing range、诊断和位标记。协议未来新增而当前描述无法解码的内容仍保留在原始 SCIP 中，不宣称规范化层无损解码未知字段。

## 源码与位置

`sources/<sha256>` 保存输入文件原始字节，不重新编码或改换行。不同路径内容相同时复用同一个 blob。包括清单中尚无语义解析能力的文件；这些文件只有源码与清单信息，不能宣称已经产生语义事实。

符号的全局标识保留 SCIP 原值；`local N` 使用 `[indexer, file, rawSymbol]` 的 JSON 字符串隔离文档作用域。Occurrence 的 symbol_id 可以为空，表示该条记录没有已关联符号。

规范化 range 为 `[startLine,startColumn,endLine,endColumn]`，零起点、结束不包含。原始 range 和 enclosing range 仍在 raw 中。字符列采用文档的原始 positionEncoding；解析器未声明时保留未声明状态，不猜测 Unicode 编码。Windows 输出路径分隔符统一为 `/`，目录穿越和符号链接仍被拒绝。

关系只记录解析器提供的事实。reference 不是 call，role 不用于证明可达性或运行时行为。

## SQLite 与加载

`model.sqlite` 是派生投影，包含 metadata/files/documents/symbols/occurrences，metadata 记录 `code_ir` 版本及目录。它不替代原始字段齐全的 IR 文件。未来可从持久化 IR/SCIP 重新建立消费侧数据库，无须重新执行目标应用。

`verify --ir DIRECTORY` 在新进程中检查 schema、完成状态、文件 SHA-256/大小、JSONL 计数和源文件映射。它验证产物完整性，不证明解析器语义正确或配置完备。

当前没有增量合并、自动垃圾回收、调用图补全或问答能力；先确保每份转换结果可保存和独立校验。
