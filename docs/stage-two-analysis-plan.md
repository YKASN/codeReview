# 第二阶段：现成静态分析引擎与证据持久化方案

调研日期：2026-10-19。本文是选型与 PoC 方案，未安装或实测这些扫描引擎；不包含准确率、耗时或 token 节省比例的实测结论。依据为下列官方文档及当前项目结构。

## 建议

第一阶段继续提供源码快照、配置、符号定位、语法结构、引用关系和初步候选。第二阶段使用成熟引擎独立扫描同一源码快照，提取规则命中、数据流路径及必要的调用关系；第三阶段 LLM 按需核实证据。

建议组合是：Semgrep CE 作为低成本的模式/局部数据流扫描器；在被分析仓库的许可条件满足时，以 CodeQL 作为跨函数/跨文件数据流主引擎。若 CodeQL 许可不适用而已有 Semgrep Code 权限，则验证 Semgrep Code 的跨文件模式作为替代。SonarQube 暂缓接入，保留其作为质量治理平台的选择。

第二阶段不先建立自研全仓 CFG/DFG/调用图，也不先接入三套完整平台。各引擎保留自己的分析表示，我们负责版本、源码关联、结果归一化和证据保存。

## 需要调整的原始设想

1. 第一阶段候选不是第二阶段的入口白名单。正常被引用、可达的函数同样可能存在注入、路径穿越等问题。第二阶段应独立覆盖受支持的源码和项目上下文；第一阶段候选只影响后续审查优先级。
2. 调用图回答潜在调用对象，数据流回答某个值如何传递，污点分析还考虑拼接、编码等影响传播。仅有调用路径不能证明不可信输入流入危险参数，更不能证明漏洞可利用。
3. 以问题类型限定 source/sink，比求所有变量之间的全局流更合理。CodeQL 官方也指出全局分析更耗时、可能更不精确，通常使用 source/sink 配置限制调查。[Python 数据流](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-python/)、[JS/TS 数据流](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)。
4. 引擎没有报告问题，仅表示本次配置下没有报告，不表示路径安全。提取失败、超时、未识别框架、未覆盖模板均单独记为覆盖信息。
5. Token 节省来自后续只读取聚焦证据，而不是把整张图或所有候选换成另一种格式全部发给 LLM。

## 工具比较

| 工具及版本类型 | 可复用能力 | 对当前项目的定位 | 边界 |
| --- | --- | --- | --- |
| Semgrep CE | 结构模式、常量传播、单函数污点分析、自定义规则、JSON/SARIF | 快速扫描、局部风险与少量项目规则 | CE 的污点分析不是通用跨函数/跨文件分析；不能把它当作第二阶段全部能力 |
| Semgrep Code | 商业分析引擎提供跨函数/跨文件数据流与框架模型 | CodeQL 不适用时的跨文件候选引擎，或可选对比对象 | 需核对账号、产品权限、语言覆盖和规则许可；关闭非本阶段需要的 AI 后处理 |
| CodeQL | Python、JS/TS 的局部/全局数据流、污点跟踪、控制流、调用目标查询及路径查询 | 跨函数深度分析主选 | 建库、查询与模型维护成本高于简单模式匹配；静态目标仍可能不完整或不精确 |
| SonarQube | 质量与可靠性规则、质量门禁；商业版安全污点分析 | 有团队治理需求时再接入，或已有实例时利用现有结果 | Community Build 不能等同于商业 SAST；自定义安全模型的版本和语言范围需要单独核对 |

Semgrep CE 与 Semgrep Code 的能力区别见[官方对照](https://docs.semgrep.dev/semgrep-pro-vs-oss)。CE 支持本地执行与 JSON/SARIF；2025 年官方已发布原生 Windows CE 支持，不能继续依据旧教程断言必须使用 WSL。[Windows 发布说明](https://semgrep.dev/blog/2025/semgrep-community-edition-fall-release-2025/)

Sonar 官方将注入类污点分析列为 Developer Edition 及以上能力；自定义安全引擎配置列为 Enterprise 及以上，当前配置文档列出的语言为 Java/PHP/C#/Python，不能直接承诺等价的 JS/TS 配置方式。[版本能力](https://www.sonarsource.com/products/sonarqube/downloads/)、[自定义安全模型](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/security-engine-custom-configuration)

CodeQL 查询库开源与 CLI 的使用条件是不同问题。官方说明公开仓库可免费使用；组织私有仓库涉及相应产品权限。应核对被分析的 AIQA 仓库，而不是只看本 CodeReview 仓库是否公开。[CLI 说明](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-cli)

Semgrep 的引擎许可和规则许可也需分开处理。官方维护的部分规则受 Semgrep Rules License 约束，不能因为规则可下载就假设可随我们的产品分发或提供服务。PoC 固定规则来源、版本和许可；方案本身不对具体使用方式作许可结论。[规则许可原文](https://semgrep.dev/legal/rules-license/)

## AIQA 的技术栈与覆盖重点

当前基础层覆盖 450 个 Python、254 个 TypeScript、1 个 JavaScript、69 个 Vue 文件的结构。Python 服务中存在 FastAPI；前端服务使用 Nitro/H3 的 defineEventHandler/readBody/getQuery 等接口，并有 attachmentServiceFetch 等自有封装。

CodeQL 官方框架列表包含 FastAPI、httpx、requests、Vue，JavaScript extractor 支持 .vue 文件；这证明有相关能力，不证明当前 Vue 3 script setup、模板与 Nitro/H3 的每种用法都能正确建模。[语言/框架列表](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/)、[Vue 库](https://codeql.github.com/codeql-standard-libraries/javascript/semmle/javascript/frameworks/Vue.qll/module.Vue%24Vue.html)

Semgrep 当前语言页列出 JS/TS/Python，但未据此确认原生 Vue SFC 全覆盖。其官方仓库历史 issue 记录过移除 Vue 支持的计划，必须对所选版本做覆盖探针。现有 @vue/compiler-sfc 可作为脚本提取的后备方案，必须保存原文件映射；脚本扫描成功不能算模板扫描成功。[Semgrep JS](https://docs.semgrep.dev/languages/javascript)、[Vue issue 中的维护者说明](https://github.com/semgrep/semgrep/issues/1751)

第一批检查限定为：

| 检查组 | 关注的关系 | 预期证据 |
| --- | --- | --- |
| 命令/代码注入 | 请求输入经辅助函数进入 shell/动态执行参数 | source 到 sink 的参数路径 |
| 文件路径 | 输入参与文件读写、删除、解压目标 | 路径构造、校验与文件操作位置 |
| SSRF/重定向 | 输入进入 HTTP URL、重定向地址 | 输入来源、封装调用和最终 URL 参数 |
| SQL/模板/XSS | 不可信数据进入对应解释或输出上下文 | 传播路径与具体 sink；区分参数化调用 |
| 可靠性 | 选定的不可达路径、资源/异常处理或异步误用规则 | 引擎提供的位置或控制流证据，不伪装成污点路径 |

以上是拟扫描类别，不是在断言 AIQA 已存在这些问题。访问控制、并发时序、分布式事务、业务不变量等不能仅靠通用污点规则覆盖，后续按具体目标追加规则、测试或 LLM 调查。

## 第二阶段执行方式

### A. 固定输入与原生引擎表示

- 从第一阶段 sources/<hash> 与 files.jsonl 恢复只读源文件树，保存路径映射并核对哈希；配置和有效输入边界一并保存。
- 引擎读取源文件树，不假装能直接消费 SCIP 或我们的 JSONL。CodeQL 原生数据库与现有 Code IR 并存；Python 与 JS/TS 分别建语言数据库，避免简单沿用 14 个索引单元而切断跨目录关系。
- 同一语言内部仍要保留真实项目和解析环境；Python import roots、TS 路径别名等在 PoC 验证，不以全仓根目录代替所有上下文。
- Python、JS/TS 可使用无需应用构建的提取方式；不运行目标应用或以安装全部目标依赖来掩盖配置问题。[CodeQL 建库准备](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/prepare-code-for-analysis)
- 不默认扫描生成物、依赖源码，也不默默吞掉第一阶段清单之外的重要入口；将排除策略保存为输入覆盖边界。

### B. 扫描和少量项目模型

- Semgrep：选定并固定相关规则子集，关闭风格类低价值规则；本地 JSON 与 SARIF 保存。不要在可复现基线里依赖会变化的 auto 规则集。
- CodeQL：先运行高精度 default 套件建立基线，再对相关 CWE 开启扩展查询；可靠性查询单独分组，不直接把所有 security-and-quality 命中加入 LLM 队列。[查询套件区别](https://docs.github.com/en/enterprise-cloud%40latest/code-security/concepts/code-scanning/codeql/codeql-query-suites)
- 在官方模型基础上，优先验证 Nitro/H3 的请求输入、FastAPI 入口、自有 HTTP/文件/数据库封装的参数与返回值传播。必要时仅补少量 source/sink/summary/barrier 模型。[CodeQL JS 模型扩展](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/)
- 校验模型按风险类别区分。类型校验、路径规范化、字符串转义、权限检查不能统一声明为“所有风险已清洗”。
- 保持每个语言引擎的边界。前端 HTTP 调用到 Python 服务不能直接拼成同一条已证明的数据流；接口路径匹配可作为独立候选联系，需另做契约和传播模型。

### C. 统一并持久化结果

拟新增独立的第二阶段产物，而非扩充所有基础 IR 记录：

```text
analysis-<run>/
  manifest.json           # 输入快照、引擎/规则/模型版本、状态、资源、校验和
  coverage.json          # 实际提取/扫描文件、跳过、错误、超时、模型缺口
  findings.jsonl         # 引擎命中，status=candidate，保留原严重程度与置信度
  paths.jsonl            # 引擎提供的有序数据流/污点/控制流路径及其类型
  evidence.jsonl         # 与 Code IR 的 file/structure/occurrence 或源码范围关联
  groups.jsonl           # 去重分组；不删除各引擎原始证据
  raw/                   # 原始 JSON、SARIF、配置及日志
  native/                # CodeQL 数据库等可重用的原生产物
```

findings 至少包含 snapshot_id、engine/version、rule_id/version、model_hash、category/CWE、analysis_scope、flow_kind、primary_location、source/sink（若有）、path_ids、IR 关联、limitations。扫描结果只有位置时标为 location-only，不编造中间数据流。CodeQL 可通过 SARIF codeFlows/threadFlows 保存路径；不同规则并非都产生路径。[CodeQL SARIF](https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-cli/sarif-output)

调用边仅在引擎明确给出时保存，带原始目标、候选集合与不确定性。CodeQL JS 调用图提供不精确/不完整标志，不能把缺边直接变成死代码结论。[JS 调用图](https://codeql.github.com/docs/codeql-language-guides/codeql-library-for-javascript/#call-graph)

所有位置先按引擎编码、1/0 基索引、路径与源码哈希转换，再关联 IR；映射失败写入 unmapped，不能凭函数同名强行合并。SonarQube 若接入，走选定版本支持的 API；SARIF 导入支持不意味着可导出完整内部分析图。[Sonar API](https://docs.sonarsource.com/sonarqube-server/extension-guide/web-api)、[Sonar SARIF 导入](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/importing-external-issues/importing-issues-from-sarif-reports)

### D. 降低后续 LLM 输入量

- 不把所有 1,853 条第一阶段候选送入第二阶段白名单或直接送 LLM；第一阶段无引用候选和第二阶段流分析命中保留各自来源。
- 程序按规则族、风险类别、source/sink、位置和引擎证据分组，保留每条原始命中。不要只按文件/CWE 去重而合并不同路径。
- 单个审查任务先提供规则、source/sink、必要路径步骤、涉及函数和相关校验。源码由哈希与范围引用，共用快照，不复制整仓或整张图。
- 建议首包 3,000–6,000 token 作为工程预算，不是实测收益或固定正确阈值。超出预算保存完整证据，标记未展开部分，让后续按需补读，不因裁剪而声称路径完整。
- 引擎缓存键包含快照、解析配置、引擎、规则和项目模型版本。后续增量必须保留跨文件上下文，不以“只扫描修改行”替代跨过程分析。

## 最小 PoC 与验收

先只做 Semgrep CE 与 CodeQL 的对比接入，CodeQL 以许可适用为前置条件。不部署 SonarQube 平台，不增加 Agent 工具，不自建图数据库。

1. 构建覆盖探针：Python、TS/JS、Vue script setup 和模板、Nitro/H3 source、自有 HTTP/文件封装。记录实际被提取与被规则覆盖的差异。
2. 选 4 类风险，每类准备单函数正例、跨函数正例、跨文件正例和有效防护反例，共 16 个基础样例；再追加 4 个“伪防护/校验结果未使用”样例。样例只做静态扫描，不运行危险操作。
3. 安全反例必须验证有效的参数化 SQL、固定 URL、真正的目录边界检查等，不能只靠增加名称类似 sanitize 的函数让引擎消警。
4. 在 CodeQL default 基线上比较模型补充前后、Semgrep CE 的覆盖边界；引擎不支持某类场景时应显示为能力边界，不能补一个没有程序证据的命中。
5. 对 AIQA 全量扫描，记录耗时、峰值内存、磁盘、提取/扫描覆盖、解析失败、命中分布、去重效果和上下文包大小。当前没有这些引擎的实测值，不给时间或召回率保证。
6. 验证断开原仓库后的产物校验、源码关联和证据包生成；原生数据库在兼容引擎版本下可复查。至少抽查每个规则类别的证据完整性，不能只看报警总量。

进入实现前真正需要确定的只有引擎许可/权限与 PoC 规则名单；其余输入、映射、持久化可以在现有基础层之上逐步实现。业务职责、权限政策是否正确及最终缺陷确认继续属于后续调查。
