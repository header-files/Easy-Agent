# Easy Agent 技术栈、工程与文档规范

> 当前阶段：**Phase 1.4（Execution Engine）**。Phase 0 与统一 Logging 基线继续适用；Phase 1.1–1.3 的 Model/Tool/Loop 基线继续适用，当前唯一阶段依据见 [Execution Engine 技术方案](phase-1.4.md)，不自动进入后续阶段。

## 1. 技术基线

| 项目         | 约定                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| 主要语言     | TypeScript                                                                                 |
| 运行环境     | Node.js 26.x LTS；`engines.node` 为 `>=26.0.0 <27`，`.nvmrc` 为 `26`                       |
| 模块系统     | ESM，不混用 CommonJS                                                                       |
| 包管理       | npm 单包；保留 `package-lock.json`，使用 `npm ci` 复现依赖；`private: true`                |
| TypeScript   | 6.0.3；`strict: true`、NodeNext、ES2024，统一配置编译和类型检查                            |
| 工程质量     | ESLint 10.15.0、`@eslint/js` 10.0.1、typescript-eslint 8.73.0、Prettier 3.10.1             |
| Node.js 类型 | `@types/node` 26.6.6，与运行环境主版本一致                                                 |
| 构建         | `npm run build`，仅将 `src/` 编译到 `dist/`，输出原生 ESM JavaScript                       |
| 检查         | `npm run typecheck`、`npm run lint`、`npm run format:check`                                |
| 格式修复     | `npm run format`；检查代码、工程配置和 Markdown 文档                                       |
| 测试         | `npm test`；`pretest` 自动构建，Node.js 内置 `node:test` 执行 `tests/*.test.ts`            |
| 交互入口     | CLI、Agent SDK、HTTP API、Web UI 等为未来规划；当前提供模型、工具、Loop 与 Engine 组件入口 |
| 模型         | Phase 1.1 实现 ModelClient 与 OpenAI-compatible Chat Completions Adapter                   |
| 工具         | Phase 1.2 ToolRegistry/ToolExecutor，Ajv 8 的 draft-07 严格输入校验                        |
| Loop         | Harness 通用 AgentLoop 契约；Execution DefaultAgentLoop 的 AsyncIterable 流式策略          |
| Engine       | Harness Execution 契约；DefaultExecutionEngine 的内存生命周期、事件、控制与快照            |
| 日志         | Runtime Logging 统一门面，Pino 10.4.0 输出结构化 JSON 到 stderr                            |
| 数据存储     | 当前无业务持久化；未来依需求采用简单本地方案起步                                           |

本阶段不要为了未来扩展引入数据库、Redis、消息队列、分布式调度、复杂 DI 容器、微服务或 Monorepo。

### 1.1 工具链配置与执行范围

- Node.js 26 的 LTS 状态依据 [Node.js 官方发布计划](https://github.com/nodejs/Release#release-schedule)。当前只声明支持 26.x，不将其他主版本的兼容性视为已验收。
- Pino 为日志、Ajv 为 Tool JSON Schema 校验的运行时依赖，其余工程工具为开发依赖；直接依赖固定具体版本，传递依赖由 npm 锁文件固定。TypeScript 6.0.3 位于当前 typescript-eslint 支持范围内，不单独追随 TypeScript 最新主版本。
- `tsconfig.json` 对 `src/**/*.ts`、`tests/**/*.ts` 统一启用严格检查且默认不输出文件。`tsconfig.build.json` 继承同一基线，仅构建源码；`rootDir` 为 `src`，`outDir` 为 `dist`。
- `erasableSyntaxOnly` 限制为 Node.js 原生类型擦除可处理的 TypeScript 语法；测试由 Node.js 直接运行，类型正确性仍由 `npm run typecheck` 验证。
- ESM 相对导入使用显式扩展名；源码或测试引用 TypeScript 文件时使用 `.ts`，编译通过 `rewriteRelativeImportExtensions` 将输出中的相对 TypeScript 扩展名改写为 JavaScript 扩展名。不引入路径别名或额外运行加载器。
- ESLint 配置位于 `eslint.config.js`；Prettier 配置位于 `.prettierrc.json`，生成目录由 `.prettierignore` 排除。格式检查失败时先运行 `npm run format`，再重新检查。
- 安装依赖需要访问 npm 源；依赖安装完成后的类型检查、lint、格式检查、构建和测试均可离线执行。

## 2. 源码组织与依赖规则

1. **职责优先**：Application、Agent、Execution、Runtime 为核心运行职责层；Harness 横向支撑，Composition 装配。
2. **按一级职责模块落地文档骨架**：Phase 0 建立六个一级模块目录，各有有意义的 `README.md` 和 `changes.md`。业务代码仍按实际功能逐步落地，未实现的子能力不建空源码。
3. **避免无用抽象**：ModelClient 与 ToolExecutor/Registry 由当前 Runtime 实现并通过离线测试验证；当前 Engine 通过通用 AgentLoop 契约驱动策略，不提前创建 Session 管理、万能 Runtime、伪 DI 容器或基础类层级。
4. **尽量少的入口文件**：`src/index.ts` 导出 Logger 门面、公共模型/工具/Loop/Execution 契约和已实现组件；保留模块边界，不把模型组件调用等同于可运行 Agent。
5. **避免机械 barrel 导出**：不是每个目录都必须有 `index.ts`。
6. **保持内部边界清晰**：Harness 定义模型/工具/Loop/Execution 公共契约，Runtime 实现模型/工具，Execution 实现默认 Loop 与 Engine；公共契约不暴露具体 Provider SDK 类型。
7. **不提前规定内部状态机/持久化协议**：以对应功能阶段的代码和测试为依据。

## 3. 工程安全与配置

- 使用 `.gitignore` 排除 `node_modules/`、构建产物、开发临时文件、`.env` 和其他密钥文件。
- 不将 API Key、Token、个人敏感信息写入源码、日志、异常消息、测试快照或示例配置。
- Phase 1.1 通过构造参数显式传入 Provider 配置，不自动读取 `.env` 或环境变量；调用方在初始化边界提供 API Key 与 baseURL。
- Logging 在 createLogger 初始化边界解析 LOG_LEVEL；后续若引入业务配置加载模块，应统一读取、解析和验证环境变量，核心 Loop 不直接读取 `process.env`。
- 生成的构建产物、自动化缓存及临时文件不纳入版本控制（除非仓库明确另有要求）。

### 3.1 统一日志规范

- 项目运行日志统一使用 `src/runtime/logging` 的 Logger 门面。调用方不直接依赖 Pino，也不散落 `console.log` / `console.error`；未来 CLI 的正常输出由 Application 单独负责。
- 默认输出结构化 JSON 到 stderr，使用 `debug`、`info`、`warn`、`error` 表达严重程度；通过显式配置或初始化边界的 `LOG_LEVEL` 控制过滤。配置优先级为显式 level → LOG_LEVEL → info，环境值忽略大小写并去除首尾空白；空值或未知值安全报错。完整规则见 [Runtime Logging](../src/runtime/logging/README.md)。
- 消息文本描述发生了什么，动态数据放入结构化 fields，模块归属通过 module/child logger 表达。避免将大对象、完整请求或原始业务载荷拼进文本。
- 错误放在结构化字段中，由日志实现归一并处理；不把原始 Provider 正文、认证头、环境配置或完整错误载荷作为安全日志。
- 敏感字段和显式配置的敏感值通过日志实现处理，但自动处理不替代调用方最小化记录的责任。禁止主动记录密钥、Token、密码、认证信息或敏感输入正文；不宣称能识别任意文本中所有未知秘密。
- child bindings 可承载未来调用方提供的关联标识，当前不定义 trace/span 传播协议，也不借日志引入 Session 或 Execution 实体。
- ModelClient/ToolExecutor 生命周期日志复用此门面，只记录白名单诊断元数据和归一错误分类；不记录完整 messages、ToolCall arguments、请求/响应正文、Header、URL、密钥或原始网络错误。具体事件与字段见 [Runtime Model](../src/runtime/model/README.md) 和 [Runtime Tool](../src/runtime/tool/README.md)。
- 当前不提供文件轮转、远端采集、独立日志服务、Session 事件存储或完整 tracing；需要这些能力时另行设计和授权。

### 3.2 Tool 参数与执行规范

- 注册时校验工具 Schema，执行时解析 argumentsJson 并确认参数为对象，再按该工具 Schema 校验；失败不得调用 Handler。
- 严格输入不自动填默认值、不转换类型、不移除字段；额外字段是否允许由 Schema 决定。当前方言与限制见 [Runtime Tool](../src/runtime/tool/README.md)。
- 业务错误返回统一 ToolResult；取消/超时抛出 ToolExecutionError，不伪装成功，不自动重试含潜在副作用的工具。
- 工具声明使用防御性复制，在途调用固定本次注册快照；实例级不保存“当前调用”可变状态，不用全局锁串行化。
- AbortSignal 是协作机制；Executor 停止等待不代表底层操作已终止或副作用已回滚。本阶段不实现进程隔离、Sandbox、资源锁或补偿事务。
- Model Bridge 复用已有模型公共契约，本身不调用 ModelClient；默认 Loop 通过既有桥接函数组织工具声明与结果。

### 3.3 Agent Loop 规范

- 通用 AgentLoop 契约只约束输入、事件与结果，不强制自定义实现使用模型、工具或默认算法；config.model 可选。DefaultAgentLoop 才要求有效模型名。
- 默认实现只使用 ModelClient.stream()，确认完整 message_end 后才执行工具；同一批工具按模型返回顺序严格串行，业务错误仍回填并继续该批调用。
- 正常结果只在最后且唯一的 loop_end.result 中返回；完整 updatedContext 与最终 output 是权威结果，展示增量不能作为第二份正文重复累加。
- 专属策略仅位于 extensions.defaultAgentLoop；maxModelRetries 默认 2，仅对尚未公开当前尝试事件且明确 retryable 的模型错误重试。工具不自动重试，正常往返不消耗重试次数。
- 不添加模型调用、工具调用或迭代总次数上限，不设置默认全局执行超时；可选超时只控制单次模型/工具调用，沿用既有 Runtime 支持范围。
- 取消和异常通过异步迭代传播，提前结束消费清理活动流并停止后续动作；多 run 状态隔离。当前 Engine 在独立机制层承接运行控制；Session 调度、Event Bus、SSE、工具并行和持久化留待后续阶段。
- 依赖兼容性转换只作用于独立请求副本，不能改写调用方历史、最终上下文或既有公共契约。
- 完整规则只在 [唯一阶段设计](phase-1.3.md) 维护；默认实现的具体清理与快照边界见 [Execution Loops](../src/execution/loops/README.md)。

### 3.4 Execution Engine 规范

- Engine 驱动任意 AgentLoop，不依赖 DefaultAgentLoop、ModelClient 或 ToolExecutor 的专有构造方式；复用既有 Context 类型，配置不必包含模型。
- execute 惰性启动、单消费者、单次消费；启动前无效 ID/metadata/重复记录直接抛错且不注册新快照。成功启动后维护 RUNNING 并发布 execution_start。
- 逐项校验 Loop 生命周期，原语义包装 loop_event；loop_end 后仍确认自然 EOF，再提交唯一终态及 execution_end。stopped 映射 FAILED/loop_stopped，普通异常/协议违例使用安全错误分类。
- cancel(true) 只表示取消请求被接受，收尾前状态可以仍为 RUNNING；已提交终态不能被后到取消倒转。单次模型/工具超时不等于 Execution 主动取消。
- 消费者提前退出时请求取消并关闭公开 Loop 迭代器，完成该边界清理后维护 CANCELLED；不能向已退出消费者承诺末尾事件，也不声称强制结束更底层的资源或副作用。
- 终态快照有界保留，运行中记录不能被淘汰；DefaultExecutionEngine 的 maxRetainedSnapshots 默认 1000、可为 0。这不是 Loop 次数上限或 Session 队列。
- Engine 自有状态与可复制数据图提供快照隔离。函数/闭包/有私有状态的外部对象保留能力引用，其内部状态不承诺强隔离；不收窄既有 Loop 数据类型。具体支持范围见 [Engine 模块](../src/execution/engine/README.md)。
- ExecutionEvent 是内存实时通知，不是持久化事实。本阶段不读写 Session Event Log JSONL，不创建事务日志、历史读取/回放/恢复、Session 调度或 Event Bus/SSE。
- 完整阶段规则以 [唯一设计](phase-1.4.md) 为准，不通过工程规范暗加 Session/持久化接口或重写 Loop 策略。

## 4. 测试与验收规范

- 当前阶段必须实际运行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test`。
- 测试应验证真实工程配置、模块导入、日志输出或 Adapter 行为；Logging 覆盖字段、过滤、子日志、配置、错误与敏感信息处理，不使用永远通过的伪测试。
- 当前 `tests/smoke.test.ts` 验证 `src/index.ts` 的 ESM 导入，以及 `dist/index.js` 能在 Node.js `--no-strip-types` 模式加载；后者检查构建结果无需 TypeScript 运行支持。`npm test` 通过 `pretest` 先构建，避免依赖手动准备的旧产物。
- 测试不得依赖模型 API Key、公网、数据库或后台服务。
- Phase 1.1 增加契约、协议映射、流式组装、错误/取消/超时、并发隔离及生命周期日志安全测试；必须验证真实 Adapter 逻辑。Fake ModelClient 仅用于公共契约替换验证，不为未实现的 Loop 编造测试。
- Phase 1.2 增加工具契约、注册/注销、Schema 严格校验、同步/异步执行、取消/超时、并发和在途快照隔离、Model Bridge 与日志安全测试；通过可控异步屏障验证真实交错。
- Phase 1.3 增加无模型/工具的自定义 Loop 契约、流式循环、事件时序、串行工具、完整历史、重试边界、无暗含上限、取消/流清理和并发测试；使用可控离线 Fake 与实际 Runtime 协作验证。
- Phase 1.4 覆盖惰性单次消费、CustomLoop、事件/结果映射、协议违例、取消竞态、提前退出、清理、并发、快照隔离/保留，以及无 Session 日志读写边界的离线验证。
- 如果命令由于客观限制没有执行，应在交付说明中明确列出，而非宣称通过。
- 后续业务开发应为有意义的逻辑提供相应离线单元或集成测试，真实模型烟测只能作为可选验证。

## 5. 代码质量约定

- 启用 TypeScript 严格类型检查，不滥用 `any`、类型断言或忽略编译错误。
- 文件、函数、模块职责明确，避免循环依赖及单体文件。
- 保持代码格式统一，安装与执行命令尽可能简单。
- 不增加没有当前需求支撑的外部依赖、生成器、测试框架组合或部署链路。
- 统一脚本名称；如调整公开脚本，必须同步更新 README，并按变更级别记录修改原因。

## 6. 文档职责

| 文件                            | 内容范围                                                 |
| ------------------------------- | -------------------------------------------------------- |
| `README.md`                     | 产品定位、实际已支持的用法、工程启动、文档索引           |
| `AGENTS.md`                     | Codex 等 Coding Agent 的仓库入口规则                     |
| `.cursor/rules/easy-agent.mdc`  | Cursor 规则，引用统一规范                                |
| `docs/AGENT.md`                 | Coding Agent 开发指南和决策边界                          |
| `docs/architecture.md`          | **现行有效**架构、职责、目录组织                         |
| `docs/conventions.md`           | 技术栈、测试、安全、文档与变更规范                       |
| `docs/phase-0.md`               | 已完成的工程初始化基线与历史验收                         |
| `docs/phase-1.1.md`             | 已完成 Model System 基线与历史验收                       |
| `docs/phase-1.2.md`             | 已完成 Tool Runtime 基线与历史验收                       |
| `docs/phase-1.3.md`             | 已完成 Agent Loop 设计与历史验收                         |
| `docs/phase-1.4.md`             | **当前唯一** Execution Engine 设计、任务与验收依据       |
| `docs/phase-1.md`               | Phase 1 阶段顺序索引                                     |
| `src/runtime/logging/README.md` | 已完成 Logging 接口、配置与安全边界                      |
| `docs/roadmap.md`               | 后续扩展目标，非当前任务清单                             |
| `docs/changes.md`               | **项目级**历史：整体架构、共享约定与跨模块决定           |
| `src/<module>/README.md`        | **模块级**现行说明：背景、职责、边界、当前实现与关键入口 |
| `src/<module>/changes.md`       | **模块级**修改时间线：本模块变更前后、原因、影响、依据   |

**模块文档默认就近放在代码目录**，例如 `src/agent/README.md` 与 `src/agent/changes.md`。如果未来形成独立发布的 `packages/<name>/`，则文档跟随该 package 的实际根目录；但“package”并非唯一文档粒度，重点是职责和开发边界。

推荐以**能够独立理解、开发、验证和维护的职责域**作为最小文档单元：六个一级模块必须有文档，未来的 `src/runtime/model/`、`src/application/cli/` 等若形成独立维护的能力域，随实际实现补充本地 `README.md` / `changes.md`。普通工具函数、单个 `.ts` 文件、纯粹的组织性子目录不要求建文档，避免碎片化。

## 7. 文档写作规范（现行方案与历史记录双轨）

**原则：现行设计准确、历史变更可追溯，两者不得混淆。**

### 7.1 文档粒度与现行说明

1. **粒度以模块的独立职责为准，而不是机械按照文件或 package 划分。** 一级模块必须有文档；当真实存在职责独立、需单独开发的子模块时，再进一步拆出本地文档。
2. 每个模块的 `README.md` 至少说明：**背景/目标、负责与不负责的内容、当前实现状态、计划与非目标、对外入口或关键文件（如果已实现）、依赖/协作边界、测试与验证方式（如果已实现）、相关文档链接**。
3. `README.md` 仅描述**当前有效设计及已验证实现**，区分“已实现”“计划”“未实现”；实现发生变化时必须同步更新。
4. 项目级架构和通用规则只在权威文件维护，模块 README 引用它们，不复制全局方案；同一具体能力的说明以离实现最近的模块文档为准。
5. 子模块的文档靠近其源码，例如 `src/runtime/model/README.md`；如果是独立 package，则放在该 package 根目录。不要因为文件数量多就自动拆文档。
6. 现行说明不堆叠历史叙事，需要解释演变时链接同目录 `changes.md`。用中文解释设计，英文技术术语、代码标识符与文件名保持一致。

### 7.2 何时、在哪里记录变更

**当已确认的功能设计、实际实现、外部行为、接口契约、模块边界、工程选型或阶段范围发生实质性修改时：**

- **模块内部的变更**：更新该模块 `README.md`，在**本模块 `changes.md`** 追加真实日期、稳定主题 ID、变更前后、修改原因、影响范围、相关验证；对已有行为的重要 Bug 修复也需写出触发问题和修复原因。
- **影响多个模块的变更**：更新每个受影响模块的现行说明，在真正涉及实现或契约调整的模块日志中记录具体变化；并在**项目级 `docs/changes.md`** 留下跨模块决策摘要及模块日志链接。
- **只涉及项目公共规则或全局架构的变更**：更新项目级现行文档，在 `docs/changes.md` 保留记录；只有实质影响到某模块时才在对应模块同步记录。
- **同一主题多次修改**：在同一个日志中持续追加，沿用稳定主题 ID，不覆盖旧记录；前后记录可形成时间线。日期采用实际确认/实施日期，不得编造。
- **避免历史重复**：项目级记录强调为什么作出全局决策及受影响模块；模块级记录强调本模块怎么变、为何变、如何验证。互相链接，不重复复制整段历史。
- **建立新模块时**：必须同时建立 README 和 changes；首次现行设计是一份基线，不必伪造“从无到有”的功能修改历史。
- **已确认的整体架构变更**需事先取得用户确认；记录不能代替批准。

**例子**：`execution.cancel-semantics` 从 A→B→C，每次在 `src/execution/changes.md` 追加，`src/execution/README.md` 只写当前方案 C。如果调整了 Agent 和 Execution 之间的公共控制契约，则再在 `docs/changes.md` 记一次跨模块决策摘要。

**无需详尽变更记录**：纯拼写修复、格式整理、不会改变行为或决策的编辑。

### 7.3 当文档、代码与历史不一致时

- 已实现的行为以已验证代码事实为依据，但不能据此擅自覆盖明确确认的产品/架构约束；应说明冲突并请求决策。
- 新的确认决策在**现行文档**生效；旧决策作为历史保留在**变更日志**。
- 如果还没有实现，文档必须标示为“计划/待实现”，不能伪装已经完成。
- 用户要求“仅输出、不要写入文件”时，禁止擅自修改仓库文档。

详见 [项目级变更记录](changes.md) 与各模块 `src/<module>/changes.md` 中的本地模板。

## 8. Codex / Cursor 协作规范

- 两种工具统一使用 `AGENTS.md`、`docs/AGENT.md`、阶段文件和架构文件，不维护互相冲突的独立业务规范。
- 接到模块级开发任务后，应**先定位模块，再读取最接近该模块的 `README.md` 和 `changes.md`**；只有跨模块需求才扩大阅读范围。
- 开始工作前先读 `docs/phase-1.4.md`，并按需参考 Phase 0、Logging、Model、Tool 与 Loop 基线；只有用户明确切换阶段，才能开展 Phase 1.5 等后续任务。
- 一个任务只做已授权的变更，实际运行对应验证命令，不虚报结果。
- 因真实代码问题必须改变设计时，说明原因、影响、备选方案和验证依据；确认后**同步更新模块级现行文档与本地历史记录**，全局/跨模块问题再维护项目级记录。
