# Code IR 保存契约 · code-ir/2

本版本将解析器输出整理为明确的实体、项目上下文、源码结构与关联状态。交付范围仍是仓库到中间文件；后续 Agent 可直接读取这些持久化事实。

旧 `code-ir/1` 的格式说明保留在 `code-ir-v1.md`。`verify` 同时支持 v1/v2，读取旧产物不修改文件，也不伪装成完成了升级。

## 数据集与关联

| 数据集 | 规范化字段与含义 |
| --- | --- |
| projects | id、language、root、kind、configuration、environment、input_file_ids、run_status、limitations |
| files | id、path、language、sha256、bytes、source、project_ids、document_ids、analysis_status、parse_results |
| documents | id、project_id、producer_id、file_id、source_sha256、language、position_encoding、parse_status、raw |
| symbols | id、producer_symbol、scope、name、kind、documentation、origins、definition_ids、project_ids、resolution_status、raw |
| occurrences | id、出处字段、symbol_id、range、enclosing_range、role、roles、resolution_status、raw |
| relationships | id、出处字段、source_symbol_id、target_symbol_id、kinds、resolution_status、raw |
| diagnostics | id、出处字段、occurrence_id、range、severity、message、code、raw |
| external-symbols | id、symbol_id、producer_symbol、project_id、producer_id、raw |
| structures | id、file_id、source_sha256、parser、position_encoding、kind、name、range、name_range、parent_id、symbol_id，以及 parameters/signature/returns 等适用字段 |
| imports | id、file_id、source_sha256、parser、range、enclosing_structure_id、module、names（name/alias）、relative_level、resolution_status |
| calls | id、file_id、source_sha256、parser、range、callee_range/name/expression、enclosing_structure_id、candidate_symbol_ids、binding_occurrence_ids、target_symbol_id、resolution_status、unresolved_reason |
| syntax-diagnostics | id、file_id、source_sha256、parser、message，以及解析器提供的 code/line |

“出处字段”是 project_id、producer_id、document_id、file_id、source_sha256。manifest 的 producers 保存解析器名称、版本、原始文件和执行配置；每条事实都能关联到它。

### ID 与符号状态

ID 使用类型前缀与确定性摘要，在快照内唯一。file 根据仓库相对路径标识；document 根据项目和文件标识；occurrence 根据文档与原始顺序标识。全局符号按原始 SCIP 标识归并，本地符号还带项目和文件作用域。原始 SCIP 标识单独保留在 producer_symbol。该规则不承诺跨提交或重命名后的逻辑身份一致。

符号状态为 defined（有定义位置）、declared（只有符号信息）、external（有外部信息）或 unresolved（只有引用线索）。name 缺失时为 null，kind 缺失时为 unknown，不从 SCIP 字符串猜名称或类型。AST 声明名与 SCIP 定义位置唯一匹配时补充名称和种类，保存 name_origin/kind_origin 与 structure_ids；缺失量写入覆盖报告。

Occurrence 的 producer-linked 只说明解析器提供了一个符号关联，不证明目标运行时可调用。空 symbol_id 明确保留为 unresolved。原始角色位集合展开到 roles，原始值仍保存在 raw 中。

### 项目识别与配置

TS/JS 用固定版本 TypeScript 编译器的配置 API 读取 JSONC、extends、include/files/exclude 和 project references。配置继承文件的路径与哈希、声明选项、解析后的有效选项及配置诊断均保存。solution/configuration 描述不独立运行索引。

各有效配置建立独立解析单元；输出目录中的适配配置仅覆盖明确的输入文件、noEmit、allowJs、rootDir、include/exclude/references，原配置其余选项保持继承。覆盖行为与适配配置保留在执行记录中。没有被任何配置选中的 TS/JS 文件按包及源码目录分组为 inferred 单元，使用编译器默认值，明确标记配置缺口，不套用客户端配置。

Python 识别 pyproject.toml、pyrightconfig.json、requirements 与 setup 文件，以及仓库顶层源码组件。TOML/JSONC 由成熟解析器读取。保存显式 import path、包声明、配置诊断及最近祖先虚拟环境；不存在静态配置的组件标为 inferred。setup.py 和应用入口都不执行，不据此推断运行时 sys.path。配置无效时保留失败原因，不静默降级为正确配置。

scip-python 的目录扫描可能覆盖嵌套组件，规范化导入只纳入该 Python 单元的输入文件，原始 SCIP 全量保留。TypeScript 单元可能产生输入之外的依赖文档，文件记录也会保存实际观察到的项目上下文。

文件 parse_results 逐项目区分 indexed、failed、empty、not-emitted、not-requested；同一文件有多个上下文时不相互覆盖。没有语义解析器的文件保持 source-only，并记录原因。

## 持久化与校验

`sources/<sha256>` 保存原始字节。manifest 除文件哈希和计数外，还记录项目配置指纹及配置缺口、未知名称/类型、未解析符号数量。完成状态仍为 indexed/partial；它表示运行结果，不表示配置完备或语义正确率。

转换结束时检查输入文件和已发现配置是否变化，再验证持久化文件的内部关联。校验失败不会更新 latest 指针。离线 verify 不访问原仓库，检查：文件哈希、记录计数、实体 ID、文件/项目/文档关系、符号定义位置、关系端点和来源哈希、源码行范围。列编码已知时检查列边界，未声明时只检查行与范围顺序，并报告未校验列的范围数量。

SQLite 使用 `code-ir-sqlite/2` 派生投影：`ir_records(dataset,id,payload)` 完整保存所有规范化记录，符号与 occurrence 使用 v2 实体 ID。兼容索引表只保留便于定位的列，符号种类等完整字段以 payload 为准。先验证 IR，再写临时数据库，关闭后替换目标数据库。重建不运行解析器，也不访问原仓库。

在仓库根目录可调用现有模块重建，无需额外服务：

```powershell
node --input-type=module -e "import {rebuildSQLite} from './semantic-model/src/projection.js'; console.log(rebuildSQLite(process.argv[1], process.argv[2]));" 'D:\saved\code-ir' 'D:\saved\model.sqlite'
```

结构记录还校验来源、源码位置、父实体及符号端点；调用记录校验候选符号、绑定 occurrence、目标状态与未解析原因。校验表示结构自洽，不是解析器语义正确性的证明。

## 源码结构与调用绑定

TypeScript 5.9.3 编译器 API 与 Python 标准库 AST 提取模块、类、函数/方法、参数、部分变量声明、签名、返回类型、导入和调用位置。每条记录保存实际 parser 版本。Python 以隔离进程读取保存的源码，不导入目标模块；AST 失败产生逐文件诊断。文件的 `structure_result` 与 SCIP `parse_results` 分开记录，语法解析成功不等于语义索引成功。

`parent_id` 和 `enclosing_structure_id` 表示源码语法包含关系；装饰器、默认参数和类体的运行时求值归属不能直接由它们推断。导入声明当前为 `syntax-only`，保留名称、别名、相对层级，尚未生成模块依赖解析图。Python 签名由 AST 规范化，原始格式仍可由源码恢复；长签名截断时带标记。

调用位置必须来自 AST；普通引用不升级为调用。调用名位置与 SCIP reference 精确匹配后，只对唯一、已定义的 Function/Method/Class/Constructor 保存静态目标和 occurrence 证据。`resolved-static` 表示静态声明关联，不能据此断言运行时调用链。其余保留 unresolved 与原因：动态调用表达式、候选不唯一、可调用定义未建立、无兼容绑定。生产者未声明列编码且定位前缀含非 ASCII 字符时，不冒险跨编码关联。

当前未做跨语言/运行时分派、反射展开、数据流、增量合并；Vue SFC 保留源码。函数变量、部分赋值/解构、继承与重导出没有完整归一化；外部依赖仅基于已有环境。coverage 分别报告结构解析、静态绑定、未知字段和配置缺口，不能作为语义准确率。
