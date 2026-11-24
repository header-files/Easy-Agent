# Easy Agent 设计与实现变更记录

> **目的：保留项目级架构、公共规范、阶段范围及跨模块决策的依据与时间线。** 具体模块的功能/实现修改记录位于 `src/<module>/changes.md`。本文件是历史摘要，不取代现行规范或模块 README。

## 记录规则

- 本文件记录**项目级或跨模块**的实质性修改；单一模块内部功能、Bug 修复、局部接口与实现取舍优先记入该模块 `changes.md`，除非其影响公共行为。
- 纯拼写和格式化调整无需记录。
- 每条记录至少包括：**日期/时间、主题 ID、变更前、变更后、修改原因、影响范围**；必要时补充验证依据、方案取舍或关联讨论。
- 同一功能或模块多次修改时，复用稳定的**主题 ID**，按时间持续**追加**记录，不删除历史决定，也不将旧方案伪装成当前方案。
- 日期使用实际发生或确认的时间；不得编造时间。仅知道日期时记录日期即可。记录同日多个变更时可使用顺序编号。
- 对影响多个模块的决策，本文件写**简要原因、取舍、模块范围**并引用各模块变更记录，避免项目级与模块级完整重复。
- 历史记录用于解释「为什么改」；**实际应该怎么开发，以对应的现行文档为准**。
- 若用户尚未批准对已确认整体架构的实质性修改，先说明影响并征求确认，不得将提议直接当作已生效决策。

## 记录模板

```markdown
### YYYY-MM-DD — <变更标题>

- 主题 ID：`module.feature-or-decision`
- 变更前：...
- 变更后：...
- 修改原因：...（触发问题、反馈、约束或收益）
- 影响范围：...（目录、模块、外部用法、阶段任务、测试、文档）
- 验证或依据：...（可选：测试、讨论结论、代码事实）
- 现行规范：...（链接到最新设计文档）
```

## 历史时间线

### 2026-11-20 — 调整首期实施范围：将工程骨架与 Agent 业务实现拆分

- 主题 ID：`delivery.phase-scope`
- 变更前：原项目文档将工程初始化、Session、Execution Engine、Basic Loop、ModelClient、OpenAI-compatible 适配器和 CLI 交互都列为当前「第一阶段」任务。
- 变更后：**Phase 0** 专注工程初始化、源码目录约定、质量工具与最小离线 smoke test；原最小可运行 Agent 闭环转为后续 **Phase 1**，其余能力继续顺延。
- 修改原因：原阶段任务过多，容易让 Coding Agent 在尚未建立工程骨架时同时设计并实现多个组件，违背当前「先确立整体架构，再逐步编码」的目标。
- 影响范围：README、Coding Agent 入口、架构目标树、工程规范、`phase-0.md`、`phase-1.md`、`roadmap.md`、Cursor 规则和阶段验收。
- 依据：用户确认先完成工程目录和规范，不在当前阶段开展 Agent 业务实现。
- 现行规范：[Phase 0](phase-0.md)、[后续路线图](roadmap.md)、[架构设计](architecture.md)。

### 2026-11-20 — 增加设计与实现的变更追踪要求

- 主题 ID：`docs.change-tracking`
- 变更前：项目仅要求文档说明当前有效设计，且不采用时间线叙事。
- 变更后：**现行设计文档**继续描述最新有效方案；另设**独立变更记录**，保留每次实质性修改的日期、变更前后差异、修改原因与影响范围。多次修改使用同一主题 ID，持续追加形成时间线。
- 修改原因：便于人类开发者和 Coding Agent 理解每次调整的背景、约束和取舍，避免反复采纳已被否定的方案，也避免将历史叙事混入现行规范。
- 影响范围：`docs/conventions.md`、`docs/AGENT.md`、`AGENTS.md`、Cursor 规则及后续所有实质性设计/功能变更。
- 依据：用户新增明确文档维护要求。
- 现行规范：[文档规范](conventions.md)、[Coding Agent 工作说明](AGENT.md)。

### 2026-11-20 — 确认整体架构基线（此前讨论成果，首次纳入本变更记录）

- 主题 ID：`architecture.layers-and-composition`
- 变更前：最初使用 Application、Agent、Execution、Harness、Runtime 五个纵向职责层表示整体架构。
- 变更后：改为 **Application / Agent / Execution / Runtime 四个运行职责层 + 横向 Harness 支撑 + Composition / Bootstrap 统一装配**；Runtime 按能力域组织，优先支持单能力替换。
- 修改原因：职责架构不等于调用链；横向契约/治理不应被误解为每次执行的必经中间节点，并需要明确默认组件的装配入口。
- 影响范围：系统架构示意、各组件职责、目录规划和后续扩展方式。
- 依据：此前与用户讨论并确认的整体架构方案；这是已生效基线的追溯记录，不表示今天再次调整架构。
- 现行规范：[架构设计](architecture.md)。

### 2026-11-20 — 将文档结构调整为项目级与模块级两级维护

- 主题 ID：`docs.module-local-documentation`
- 变更前：项目主要依赖根目录 README 与 `docs/` 中的架构、规范和单一 `changes.md`；模块缺少就近背景说明和单独修改时间线。
- 变更后：每个一级职责模块使用本地 `README.md`（当前有效背景、职责、边界和实现状态）及 `changes.md`（该模块的独立修改时间线）。真正形成独立能力域的子模块随实际代码增加文档；项目级 `docs/changes.md` 保留全局与跨模块决策摘要。
- 修改原因：Coding Agent 应能快速获取**当前开发模块**所需的背景及历史，而不用阅读整仓库；同时避免不同模块的修改记录混在单一长日志中。
- 影响范围：项目文档规范、Coding Agent 阅读与维护顺序、Phase 0 工程骨架、六个一级职责模块的本地文档。
- 依据：用户新增的模块化文档与模块独立变更日志要求。
- 现行规范：[文档规范](conventions.md)、[架构与目录](architecture.md)、[Phase 0](phase-0.md)。

### 2026-11-20 — 固化开发协作与交付原则

- 主题 ID：`workflow.development-principles`
- 变更摘要：在 Coding Agent 工作说明中明确 Git 授权、提交规范、重大方案确认、单元测试和交付检查要求。
- 修改原因：让同一仓库的新会话也能读取用户确认的开发原则。
- 影响范围：项目级开发协作规范。
- 现行规范：[Coding Agent 工作说明](AGENT.md)。

### 2026-11-20 — 落地 Phase 0 工程工具链与最小离线验证

- 主题 ID：`engineering.phase-0-toolchain`
- 变更前：仓库已有架构、阶段规范及六个职责模块的本地文档，尚无 npm 工程、TypeScript 配置、可执行质量脚本或 smoke test；目录尚未初始化 Git。
- 变更后：采用 Node.js 26.x LTS、npm 单包、私有 ESM 工程；加入固定版本的 TypeScript、ESLint、typescript-eslint、Prettier 和 Node.js 类型依赖及锁文件。统一严格检查源码和测试，独立构建配置只输出源码到 `dist/`；配置类型检查、lint、格式检查/修复、构建和测试脚本。入口仅用于编译与导入检查，没有 Agent 业务导出。
- 修改原因：将已确认的工程骨架变为可安装和可执行的基础工具链；利用 Node.js 自带测试运行器与类型擦除减少额外依赖。TypeScript 采用 6.0.3，以满足 typescript-eslint 8.73.0 的支持范围，避免工具版本不兼容。
- 验证范围：smoke test 检查源码 ESM 导入和构建输出在 Node.js `--no-strip-types` 模式下加载；不调用外部服务、不读取模型密钥、不模拟 Agent 对话。实际验收结果见 [Phase 0](phase-0.md)。
- Git 配置：初始化 `main`，按用户指定绑定 `origin` 为 `git@github.com:header-files/Easy-Agent.git`；锁文件作为交付文件保留，本次未执行 commit 或 push。
- 授权边界：阶段文档将锁文件交付与 Git commit / push 区分，沿用既有的明确授权规则，避免将工程初始化误解为自动提交或推送。
- 影响范围：根目录工程配置、`src/index.ts`、`tests/smoke.test.ts`、README、工程规范、当前目录说明及阶段验收。整体架构、模块边界和后续阶段范围保持原有确认基线。
- 模块关联：六个模块仍只有文档，没有实质性设计或实现调整，因此不追加虚构模块历史；现行说明与原有日志分别见 [Application](../src/application/README.md) / [changes](../src/application/changes.md)、[Agent](../src/agent/README.md) / [changes](../src/agent/changes.md)、[Execution](../src/execution/README.md) / [changes](../src/execution/changes.md)、[Harness](../src/harness/README.md) / [changes](../src/harness/changes.md)、[Runtime](../src/runtime/README.md) / [changes](../src/runtime/changes.md)、[Composition](../src/composition/README.md) / [changes](../src/composition/changes.md)。
- 依据：[Node.js 官方发布计划](https://github.com/nodejs/Release#release-schedule)、本次用户授权的 Phase 0 范围及实际工程配置。
- 现行规范：[工程规范](conventions.md)、[实际目录与架构](architecture.md)、[Phase 0](phase-0.md)。

### 2026-11-21 — 在 Phase 1 业务前补充统一 Logging 基础设施

- 主题 ID：`infrastructure.logging`
- 变更前：Phase 0 已完成工程工具链与文档骨架，项目无统一日志门面；业务能力仍未实现。
- 变更后：当前只补充 `src/runtime/logging/`：以 Logger 门面隔离 Pino 10.4.0，提供结构化 JSON、默认 stderr、日志级别/LOG_LEVEL 配置、模块 child logger、结构化错误和敏感信息处理。后续模块统一依赖该门面，避免散落 console 调用或直接依赖日志后端。
- 修改原因：在 Phase 1 业务开发前统一运行日志入口和输出约定，减少后续业务重复接入，同时保留模块关联字段的扩展空间。
- 范围与取舍：不改变现有架构层级，不开启 ModelClient、Provider、Loop、Engine、Session、Tool 或 CLI。当前不实现文件轮转、远端日志服务、Session 事件或 trace 系统；child bindings 可携带后续关联字段，不提前定义追踪抽象。
- 影响范围：Runtime Logging 与公共导出、依赖与锁文件、离线测试、README/AGENTS/Cursor、现行架构和日志规范。Phase 0 原验收作为历史保留，当前 Logging 的最终验证以真实执行结果交付。
- 模块记录：[Runtime 变更](../src/runtime/changes.md)、[Logging 变更](../src/runtime/logging/changes.md)；具体接口、配置优先级和脱敏边界由 [Logging README](../src/runtime/logging/README.md) 维护。
- 实际验收：2026-11-21，Node.js `v26.8.2` / npm `11.19.1`；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test` 全部通过。20 项离线测试通过、0 失败、0 跳过（日志行为 11 项、脱敏 7 项、源码/构建导入 2 项）；包含真实子进程 stderr/stdout 隔离及替代 Logger 契约验证，无需模型密钥或外部服务。
- 现行规范：[工程与统一日志规范](conventions.md)、[当前任务范围](AGENT.md)、[架构](architecture.md)。

### 2026-11-21 — 按用户授权进入 Phase 1.1 Model System

- 主题 ID：`delivery.phase-scope`
- 变更前：Phase 0 工程与统一 Logging 基础设施已完成；模型契约、Provider 和 CLI 等为后续业务计划。
- 变更后：用户明确授权单独实施 Phase 1.1 Model System；当前范围为 Harness Model Contracts、复用既有 Logger 的 Runtime OpenAI-compatible Chat Completions 及离线验证。Phase 0 保留工程基线与历史验收；不自动进入 Phase 1.2，也不实现 Session、Engine、Loop、Tool Runtime 或 CLI。
- 修改原因：将用户确认的模型系统 V1.1 技术方案变为可供后续 Loop 依赖的独立能力，避免一次扩展到完整 Agent 闭环。
- 影响范围：README、AGENTS/Cursor 入口、阶段文件、全局架构/工程规范、路线图，以及六个模块的真实阶段说明。Application、Agent、Execution、Composition 仅同步当前未实现状态，没有追加虚构实现日志。
- 依据：用户提供的《Phase 1.1 Model System 技术方案 V1.1》及明确执行要求。
- 现行规范：[Phase 1.1](phase-1.1.md)、[架构](architecture.md)、[工程规范](conventions.md)、[路线图](roadmap.md)。

### 2026-11-21 — 确立模型公共契约与可复用并发实例

- 主题 ID：`model.contracts-and-concurrency`
- 变更前：Harness 尚无模型契约；Runtime 已有 Logging 基础设施，尚无公共模型接口实现或具体 Provider。
- 变更后：Harness 提供统一 ModelClient、消息、请求/响应、工具、事件及错误协议；Runtime 在既有 Logger 基线上实现 generate/stream、映射、工具增量组装、取消、超时及生命周期日志。生成参数统一由 parameters 承载，扩展参数保留原名并拒绝核心字段覆盖与等价参数冲突。单实例复用固定配置，各调用独立持有可变状态，通过隔离支持并发。
- 修改原因：使后续 Loop 依赖 Provider 无关契约，同时正确处理自然并发、请求取消和多个工具调用的增量状态，避免 Harness 成为必经转发层或引入全局串行锁。
- 实现取舍：采用 Node.js 内置 fetch，沿用既有 Pino Logging，不增加模型 SDK 运行时依赖。Provider 配置支持 Logger/fetch 注入与 maxTokensField，以支持离线测试和显式选择 token 限制字段；公共契约保持用户方案。模型能力只产生工具调用，不负责工具执行或参数 JSON 校验；日志仅记录白名单诊断元数据，拒绝消息、工具参数和凭据进入生命周期记录。
- 影响范围：公共入口、Harness Model Contracts、Runtime Model、离线契约/映射/流式/错误/并发测试和模块就近文档；整体架构层级保持原基线。
- 模块记录：[Harness](../src/harness/changes.md)、[Model Contracts](../src/harness/contracts/model/changes.md)、[Runtime](../src/runtime/changes.md)、[Runtime Model](../src/runtime/model/changes.md)。具体行为与验证由模块记录和阶段实际验收维护，不在此重复全文。
- 实际验收：2026-11-21，类型检查、lint、全仓格式检查、构建及全部离线测试通过；75 项通过、0 失败、0 跳过。命令、测试构成与真实 API 未验证的边界见 [Phase 1.1 实际验收](phase-1.1.md#实际验收记录)。
- 现行规范：[Phase 1.1](phase-1.1.md)、[模型公共契约](../src/harness/contracts/model/README.md)、[Runtime Model](../src/runtime/model/README.md)。

### 2026-11-22 — 将 Tool Runtime 确认为 Phase 1.2 并细化后续实施顺序

- 主题 ID：`delivery.phase-scope`
- 变更前：Phase 1.1 Model System 已完成；现行路线图将 Agent Loop 列为 Phase 1.2，Tool Runtime/工具执行仍在更后阶段，后续 Engine/Agent/Composition 的细分顺序尚未统一。
- 变更后：按用户当前任务书确定 **1.1 Model（已完成）→ 1.2 Tool（当前）→ 1.3 Loop → 1.4 Engine → 1.5 Agent Management → 1.6 Composition + CLI**。当前仅授权独立 Tool Runtime；不实现完整模型—工具—模型循环，也不自动接续 Phase 1.3。
- 修改原因：Agent Loop 需要真实、可替换且可验证的 ToolExecutor；先建立工具注册、校验、执行与结果能力，再实现循环策略，保持 Loop/Engine 以及能力实现的职责分离。
- 影响范围：当前阶段入口、Phase 1 索引、路线图、架构当前目录、工程规范、README 和未实现模块的阶段说明。新增 `docs/phase-1.md` 仅作为用户要求维护的阶段顺序索引，不复制完整方案；Phase 1.1 的 76 项历史验收原样保留。
- 依据：用户于 2026-11-22 提供的《Phase 1.2 Tool Runtime 开发任务书》及明确实施要求；本次未改变整体架构层级。
- 现行规范：[Phase 1 索引](phase-1.md)、[Phase 1.2](phase-1.2.md)、[路线图](roadmap.md)、[架构](architecture.md)。

### 2026-11-22 — 建立工具公共契约、严格执行与轻量模型桥接

- 主题 ID：`tool.contracts-and-execution`
- 变更前：Model System 已能生成工具调用、传递工具结果，但模型模块不负责参数 Schema 校验或工具实际执行；尚无独立 Registry/Executor。
- 变更后：Harness 定义工具声明、Handler、Registry、Executor、结果与执行控制异常；Runtime 提供进程内 DefaultToolRegistry/DefaultToolExecutor、Ajv 8 的 draft-07 严格输入校验、稳定注册快照、并发隔离和两个轻量 Model Bridge。Schema 不补默认值、不转换类型、不删除字段，业务错误返回 ToolResult，取消/超时抛出 ToolExecutionError。
- 修改原因：复用已完成的 Model 和 Logging 基线，为下一阶段 Loop 提供可直接使用的工具执行机制，同时明确注册变化、取消和潜在副作用的边界。
- 设计取舍：声明防御性复制、执行时固定一次快照；协作式取消不承诺强制终止或副作用回滚，无自动重试、全局队列、资源锁或 Sandbox。模型桥接复用实际 ModelToolDefinition、ModelToolCall、ToolResultMessage，不修改 ModelClient 公共契约，不调用模型或执行循环。
- 影响范围：Harness Tool Contracts、Runtime Tool、公共导出、Schema 依赖、离线契约/注册/校验/执行/并发/桥接测试、统一日志和模块文档；其他业务模块仍未实现。
- 模块记录：[Harness](../src/harness/changes.md)、[Tool Contracts](../src/harness/contracts/tool/changes.md)、[Runtime](../src/runtime/changes.md)、[Runtime Tool](../src/runtime/tool/changes.md)。
- 实际验收：2026-11-22，类型检查、lint（0 警告）、全仓格式检查、构建及离线测试全部通过；109 项通过、0 失败、0 跳过（既有 76 项 + Tool 33 项）。Model 源码与公共契约未改的差异检查通过；命令、构成和验证边界见 [Phase 1.2 验收记录](phase-1.2.md#实际验收记录)。
- 现行规范：[Tool Contracts](../src/harness/contracts/tool/README.md)、[Runtime Tool](../src/runtime/tool/README.md)、[工程规范](conventions.md)。

### 2026-11-22 — 确认 Phase 1.3 唯一 Agent Loop 设计基线

- 主题 ID：`delivery.phase-scope`
- 变更前：Phase 1.2 Tool Runtime 已完成；Agent Loop 尚无代码实现，架构和阶段索引保留下一阶段的建议定位，部分职责说明使用 Basic Loop 名称。
- 变更后：用户授权以 [Phase 1.3 Agent Loop 技术方案](phase-1.3.md) 为唯一阶段依据：Harness 定义算法无关协议，Execution 实现 DefaultAgentLoop；统一异步事件流、默认模型流式调用、串行工具、消息回填和完整上下文。自定义实现不必使用模型或工具，不要求复用默认实现。
- 修改原因：先明确通用 Loop 与默认策略的边界，再形成已有 Model/Tool 能力上的完整循环；避免把旧草案或建议命名与本次已确认设计并列使用。
- 影响范围：阶段入口、架构、工程规范、README、阶段索引/路线图、Harness AgentLoop 与 Execution Loops 文档；Application、Agent、Composition 仅同步当前未实现状态，无虚构业务变更日志。
- 授权范围：只完成 Phase 1.3；Engine 仍属 Phase 1.4，Session 调度、SSE/Event Bus、工具并行、审批与持久化均未实现。Phase 1.1/1.2 历史验收分别保留，不以原 109 项测试代替当前验收。
- 模块记录：[Harness](../src/harness/changes.md)、[AgentLoop Contracts](../src/harness/contracts/agent-loop/changes.md)、[Execution](../src/execution/changes.md)、[Execution Loops](../src/execution/loops/changes.md)。
- 现行依据：[唯一阶段设计](phase-1.3.md)、[架构](architecture.md)、[阶段索引](phase-1.md)。

### 2026-11-22 — 分离通用 Loop 协议与默认循环策略

- 主题 ID：`execution.agent-loop-baseline`
- 变更前：已有 ModelClient、ToolRegistry/Executor 和桥接数据类型，但尚无串联策略或统一 Loop 输入/事件/结果；早期草案中的 BasicLoop、模式切换和次数限制并未形成已实现行为。
- 变更后：AgentLoopContext 将输入、历史、配置、控制与可选元数据分开；通用 model 配置可选，DefaultAgentLoop 才要求模型名。正常结果仅由最后的 loop_end 携带，默认返回权威文本及完整已确认历史；异常/取消通过迭代抛出。每个 run 的工作消息、模型事件与工具结果独立，同一 run 内多工具严格串行。
- 策略取舍：只使用 ModelClient.stream()；专属选项放在 Context 的 extensions.defaultAgentLoop，模型额外重试默认 2，只有未公开当前尝试的模型/展示事件且错误明确可重试时允许。正常往返不计重试，工具不重试；不设模型调用、工具调用或迭代总上限，不设默认全局超时。
- 资源与依赖：运行使用同步调用方取消状态的有效 signal，传递给两个依赖；提前结束迭代取消内部控制，尽力请求活动模型流关闭并接管迟到拒绝，不无限等待不合作的 finalizer，不修改调用方 signal。单次超时沿用既有 Model/Tool 支持的正整数范围，完整 data 作为不透明只读上下文保留；具体边界见模块说明。
- 兼容处理：已确认的空 assistant 文本可在历史中保留 null；仅传给 ModelClient 的独立请求副本将此空文本转换为空字符串，以兼容已有 Model 请求校验。内部历史、最终 updatedContext 和调用方输入保持原语义，不修改 Phase 1.1/1.2 公共契约。
- 修改原因：使自定义算法保持独立，默认策略可真实验证完整闭环，同时保证流式输出不重复、工具错误语义一致、取消/清理可靠且无隐藏次数上限。
- 影响范围：AgentLoop Contracts、DefaultAgentLoop、离线契约/循环/事件/重试/取消/清理/并发及真实 Adapter 兼容测试；模块细节见 [AgentLoop Contracts](../src/harness/contracts/agent-loop/README.md) 和 [Execution Loops](../src/execution/loops/README.md)。
- 实际验收：2026-11-22，typecheck、lint（0 警告）、全仓格式检查、build 和 test 全部通过；146 项通过、0 失败、0 跳过（既有 109 项 + Agent Loop 37 项）。包含暂停事件后的不合作 finalizer、验证失败清理、原错误保留与真实 Runtime 离线兼容回归；完整构成和能力边界见 [唯一阶段文档的实际验收记录](phase-1.3.md#十一实际交付与验收记录)。

### 2026-11-22 — 流式工具片段的空白标识视为尚未提供

- 主题 ID：`runtime.model-system`
- 变更前：OpenAI-compatible 流式解析把工具片段中的 `null`、空字符串或空白 `id` / `function.name` 直接判为 `invalid_response`。
- 变更后：这些空白值不进入增量事件，也不覆盖同一 index 已确定的 id/name。真正冲突的非空值、结束时缺失字段和重复调用 ID 仍拒绝。
- 修改原因：真实兼容服务会在后续工具片段重复空标识，`qwen-max` 的流式工具调用因此无法进入 Agent Loop 的工具执行。
- 影响范围：Runtime Model 的流式组装；Harness 公共契约、非流式映射、Tool Runtime 和 Agent Loop 策略不变。
- 模块记录：[Runtime Model](../src/runtime/model/changes.md)、[Runtime](../src/runtime/changes.md)。
- 审查验证（2026-11-22）：修复后全仓 `npm test` 147 项通过；此前 Phase 1.3 的 146 项交付验收继续保留。
- 验证追记（2026-11-23）：补齐仓库单元测试与真实 Runtime + Loop 离线链路回归，五项工程检查全部成功；全仓 151 项通过、0 失败、0 跳过（既有 147 项 + 单元 3 项 + 集成 1 项）。具体边界、命令与结果见 [Model 修复验证时间线](../src/runtime/model/changes.md)，本轮不新增协议或生产功能。
- 现行规范：[Runtime Model](../src/runtime/model/README.md)、[Phase 1.1](phase-1.1.md)。

### 2026-11-23 — 进入 Phase 1.4 并限定 Execution 的内存机制

- 主题 ID：`execution.engine-baseline`
- 变更前：Model、Tool 和 AgentLoop 已形成独立基线；Execution Engine 仍属后续机制，Session 和持久化未实现。
- 变更后：用户授权以 [Phase 1.4](phase-1.4.md) 为唯一阶段依据，Harness 定义通用 Execution 协议，Execution 提供驱动任意 AgentLoop 的默认 Engine。execute 惰性且单次消费，启动前错误直接拒绝；启动后包装 Loop 事件，在确认合法结束及 EOF 后发布安全终态，并维护内存快照和取消控制。不修改 Model/Tool/AgentLoop 既有公共契约或默认循环策略。
- 取消与清理边界：接受取消请求不等于执行已终止；仅在公开 Loop 迭代器和 Engine 自身资源完成收尾后确定终态，不承诺强制结束任意更底层能力或回滚副作用。DefaultAgentLoop 既有 best-effort 清理保持原语义；不合作的 CustomLoop.return 不能被伪装为清理成功。
- 用户确认的快照取舍：Engine 自身状态及支持复制的数据图隔离保存，涵盖普通对象/数组、循环引用和受支持内建数据值；外部函数、闭包及带私有状态对象保留引用，其内部状态不属于隔离承诺。不冻结外部能力，也不收窄 Phase 1.3 的不透明数据类型；准确支持范围和默认实现选项由 [Engine README](../src/execution/engine/README.md) 维护。
- 阶段边界：ExecutionEvent 仅为内存实时通知。当前不读取或写入 Session Event Log JSONL，不创建 Transaction Journal、事件重放、恢复、Event Bus/SSE、Session 队列/调度或 Phase 1.5 占位能力。未来日志物理读写归 Runtime/Persistence，可靠提交与事务协议留待后续授权。
- 影响范围：新增 Harness Execution / Execution Engine 及其离线验证；同步项目入口、现行规范、阶段索引和模块说明。Phase 1.3 的设计与历史验收统一位于 [phase-1.3.md](phase-1.3.md)，既有 146 项阶段验收和后续 Model 修复 147/151 项验证均保留。
- 模块记录：[Harness Execution](../src/harness/contracts/execution/changes.md)、[Harness](../src/harness/changes.md)、[Execution Engine](../src/execution/engine/changes.md)、[Execution](../src/execution/changes.md)。实际验收见 [Phase 1.4](phase-1.4.md#103-实际验收记录)。
- 实际验收：2026-11-23，typecheck、lint、全仓格式检查、build 和 test 全部通过；187 项通过、0 失败、0 跳过（既有 151 项 + Execution 契约 5 项 + Engine 31 项）。包括无 return 钩子/继续 yield 时的真正 EOF、可移除 cancelWaiter、512 事件背压、取消与有界快照、opaque 能力引用及既有 DefaultAgentLoop 离线集成；Phase 1.1–1.3 生产源码和公共契约差异检查为空。原 146/147/151 项历史验证保留，完整命令及边界由阶段验收维护。

### 2026-11-24 — 进入 Phase 1.5 并解耦 Session 执行与事件观察

- 主题 ID：`agent.management-baseline`
- 变更前：Model、Tool、Loop 与 Engine 已完成，187 项历史验收保留；尚无进程内 Session 管理或多轮 FIFO 协调。
- 变更后：用户授权以 [Phase 1.5](phase-1.5.md) 为唯一依据，严格按 A 契约 → B Manager → C 上下文/配置 → D 调度/取消/观察 → E 验收推进。当前实施 Harness Agent 管理契约与默认 Agent 实现，复用既有 Engine/Loop，不修改 Phase 1.1–1.4 公共协议或默认策略。
- 跨模块边界：submit 同步登记每 Session FIFO，Agent 内部唯一主动消费惰性 Engine 流；同 Session 串行、不同 Session 可并发。任务实际启动时读取最新上下文，仅 COMPLETED 且 updatedContext 存在时整体提交；先确认 Engine 收尾、提交上下文，再结算 result，之后放行下一项。
- 观察与取消：SessionExecution.events 是有界单消费者观察流，提前退出或溢出不取消/阻塞 Execution，result 独立结算；溢出明确使观察流失败。排队取消不启动 Engine、不伪造事件；运行取消使用独立 signal 并等待协作收尾，不将队列状态添加到 Engine ExecutionStatus。
- 范围与取舍：仅实现内存 Session/上下文及必要 FIFO，不接入 Session Event Log JSONL、Transaction Journal、Write Coordinator、恢复、持久化 Inbox、Runtime Event/SSE、Steer/Follow-up、审批或 Phase 1.6 装配/CLI。未来持久化职责仍归 Runtime/Persistence。
- 影响范围：阶段入口、架构/工程规范、阶段索引和路线图；Application/Composition 仅修正阶段提示，Execution 父文档说明原始消费与 Agent 观察的区别，没有新增底层能力或虚构模块日志。1.3/1.4 技术设计及 146/147/151/187 项历史验证保留。
- 模块记录：[Agent Contracts](../src/harness/contracts/agent/changes.md)、[Harness](../src/harness/changes.md)、[Agent](../src/agent/changes.md)。本阶段实际验收见 [Phase 1.5](phase-1.5.md#13-实际交付与验收记录)，187 项仍保留为此前基线。
- 内部兼容修复：真实 Agent/Engine 整链路的 typed array、DataView、Buffer 回归发现，实例覆盖的原生槽属性 getter 可能被快照读取触发；Agent 与 Engine 私有 helper 改用内建原型 getter，四个 shadow getter 保持 0 调用，不改变旧公共契约。记录见 [Engine 2026-11-24 时间线](../src/execution/engine/changes.md) 与 [Agent 时间线](../src/agent/changes.md)。
- 实际验收：2026-11-24，`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test` 均退出码 0；216 项通过、0 失败、0 跳过（既有 187 项 + 新增 29 项：契约 6、Manager 4、真实 Engine 集成 5、错误流边界 4、取消/观察流 9、原生 view 快照 1）。旧 Phase 1.1–1.4 公共契约差异检查为空；保留 146/147/151/187 历史记录，完成后未进入 Phase 1.6。

### 2026-11-24 — 进入 Phase 1.6 并统一应用交互与装配边界

- 主题 ID：`application.composition-cli-baseline`
- 变更前：Model、Tool、Loop、Engine 与内存 Agent Management 已完成，216 项历史验收保留；调用方分别构造依赖，尚无共享应用操作门面、默认 Bootstrap 或本地 CLI。
- 变更后：用户授权以 [Phase 1.6](phase-1.6.md) 为唯一阶段依据，按 A 应用服务 → B 配置/装配 → C CLI → D 端到端 → E 验收实施。Application Service 统一委托 Agent 公共能力；Composition 集中配置解析、依赖选择及资源生命周期；CLI 本地通过 Service 交互，未来 HTTP 可复用同一应用实例，不强制 CLI 经 HTTP。
- 修改原因：将已有可替换组件组合成可运行产品，同时避免终端/未来 HTTP 各自复制 Session 调度、上下文、Loop 或工具执行。
- 跨模块决定：配置优先级为 CLI 显式选项 > 环境变量 > 显式配置文件 > 默认值，配置在初始化边界集中解析；Provider 连接信息不进入 Loop 普通上下文。复用 Phase 1.1～1.5 公共契约、串行工具策略与独立 events/result，不增加总调用上限、第二套 FIFO 或事件缓存。
- 生命周期边界：Bootstrap 先取消并等待既有任务协作收尾，再按依赖逆序释放自有资源；初始化中途失败回滚。外部注入共享组件的资源归调用方，dispose 幂等，不把观察结束或取消已受理冒充执行结束。
- 范围限制：本阶段不实现 HTTP Server、Session Event Log、事务、持久化 Inbox、恢复、远程 CLI、正式 SDK、复杂 DI/插件管理或工具并行。旧阶段技术设计与 146/147/151/187/216 项历史验收保留；阶段启动指令中误写的 `phase-1.6-composition-cli.md` 按用户指定统一为 `phase-1.6.md`。
- 影响与模块记录：[Application](../src/application/changes.md)、[CLI](../src/application/cli/changes.md)、[Composition](../src/composition/changes.md)；同步项目入口、架构/工程规范、阶段索引及路线图。Harness/Agent/Execution/Runtime 父说明只同步当前装配关系，没有为未改变的实现追加虚构历史。
- 实际验收：2026-11-24，`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test` 全部退出码 0。254 项通过、0 失败、0 跳过（既有 216 项 + 新增 38：Service 7、配置 3、Bootstrap 6、CLI 12、端到端 9、编译后 CLI smoke 1）。`npm run chat -- --help` 与构建 bin 的帮助/版本/无副作用导入也已通过；未执行 npm link 或真实 Provider/API 烟测。完整 AC-01～18 证据见 [阶段验收](phase-1.6.md#17-实际交付与验收记录)。
- 兼容与停止点：旧 Harness/Agent/Execution/Runtime 下所有 TypeScript 公共契约与既有实现差异为空，没有重大接口冲突。CLI 按 §6.5 单轮等待，排队的 /exit 在该轮收尾后处理，Ctrl+C 即时请求取消；统一日志配置新增 logging.level，安全启动错误用固定分类和阶段追溯。Phase 1.6 完成后停止，未进入 HTTP/Persistence。
- 现行依据：[Phase 1.6](phase-1.6.md)、[架构](architecture.md)、[工程规范](conventions.md)。

### 2026-11-24 — 工具调用中的 null 占位视为尚未提供

- 主题 ID：`runtime.model-system`
- 变更前：兼容适配器遇到 `tool_calls: null`、空白 `type`、`function: null` 或 `arguments: null` 即返回 `invalid_response`。
- 变更后：这些值只表示当前片段没有对应字段。结束时缺少有效 id、name 或 arguments 字符串，以及非数组工具列表和对象形式参数，仍然拒绝。
- 修改原因：通义兼容流用 `null` 占位，真实 `qwen-max` 在调用 Phase 1.6 的 `add` 工具前解析失败。
- 影响范围：Runtime Model 的流式与非流式映射；Harness 公共契约和 Loop 策略不变。
- 模块记录：[Runtime Model](../src/runtime/model/changes.md)、[Runtime](../src/runtime/changes.md)。
- 现行规范：[Runtime Model](../src/runtime/model/README.md)、[Phase 1.1](phase-1.1.md)。

### 2026-11-24 — Phase 1 MVP 里程碑收尾并定版 v0.1.0

- 主题 ID：`delivery.phase-1-mvp`
- 变更前：Phase 1.1～1.6 已全部实现并通过各子阶段验收，但包版本仍为 `0.0.0`，项目首页、路线图和 Phase 1 索引仍停留在 Phase 1.6 开发态，缺少 `v0.1.0` Release Notes。
- 变更后：正式将 Phase 1（Phase 1.1～1.6）MVP 里程碑定版为 `v0.1.0`；将 `package.json`、`package-lock.json` 与编译后 CLI `--version` 烟测同步为 `0.1.0`；新增 [v0.1.0 Release Notes](releases/v0.1.0.md)，并更新 `README.md`、`docs/roadmap.md`、`docs/phase-1.md` 明确已完成能力与 Phase 2+ 未实现边界。同步修正 `src/composition/changes.md` 过时占位语句并补记 `src/runtime/model/changes.md` 2026-11-24 验证结果。
- 修改原因：Phase 1 全部子阶段与真实模型兼容修复已就绪，需要形成版本一致、文档准确且可追溯的首个 MVP 里程碑基线，为后续打 `v0.1.0` Git Tag 与发布 GitHub Release 做准备。
- 影响范围：版本元数据、里程碑发布说明、项目级文档与 CLI 版本 smoke test；不改动既有架构、公共契约或业务行为，不启动 Phase 2 开发。
- 实际验证：2026-11-24，`npm run typecheck`、`npm run lint`（0 警告）、`npm run format:check`、`npm run build`、`npm test` 全部退出码 0，**256 项离线测试通过、0 失败、0 跳过**（Phase 1.6 254 项 + Model `null` 占位回归 2 项）；源码及构建后 CLI `--help` / `--version`（`easy-agent 0.1.0`）验证通过。
- 现行规范：[README](../README.md)、[Phase 1 索引与总验收](phase-1.md)、[v0.1.0 Release Notes](releases/v0.1.0.md)、[路线图](roadmap.md)。

### 2026-11-24 — Phase 2.1：从单模型装配迁移到多模型 Registry/Router

- 主题 ID：`runtime.multi-model-routing`
- 变更前：Composition 使用 Phase 1 单 `model` 配置与单 Provider Bootstrap；Session/CLI 不能在已注册模型间切换；仅有 OpenAI-compatible Adapter。
- 变更后：统一 `providers` / `models` / `defaultModel` 配置；静态 `Provider Type → Factory` 创建独立 Provider 实例；新增 Model Registry、Model Router、OpenAI Responses Provider；Application/Session 在提交时按 Execution > Session > Application 固化模型；CLI 增加 `/model`。删除旧单模型配置与 `--base-url` / `EASY_AGENT_MODEL` 入口，不保留兼容层。
- 修改原因：用户授权 Phase 2.1，要求显式多模型管理、按类型装配 Provider，并接入 Responses 协议，同时保持既有 Loop/Engine/FIFO 语义。
- 影响范围：Runtime Model、Composition、Harness Model Catalog、Agent Session 模型字段、Application Service、CLI、示例配置与离线测试；不进入 Phase 2.2。
- 模块记录：[Runtime Model](../src/runtime/model/changes.md)、[Composition](../src/composition/changes.md)、[Application](../src/application/changes.md)、[CLI](../src/application/cli/changes.md)、[Agent](../src/agent/changes.md)、[Model Contracts](../src/harness/contracts/model/changes.md)、[Agent Contracts](../src/harness/contracts/agent/changes.md)。
- 实际验证：2026-11-24，`npm run typecheck` / `lint` / `format:check` / `build` / `test` 全部通过，**266** 项离线测试通过；真实远程 API 待手动验证。
- 现行规范：[Phase 2.1](phase-2.1.md)、[Runtime Model](../src/runtime/model/README.md)、[Composition](../src/composition/README.md)、[路线图](roadmap.md)。

### 2026-11-24 — 增加 OpenAI / Qwen / DeepSeek OpenAI-compatible 厂商预设

- 主题 ID：`runtime.vendor-compatible-presets`
- 变更前：多模型装配只有通用 Compatible 与 Responses 两类 type。
- 变更后：新增 `openai` / `qwen` / `deepseek` Provider Type，默认分别对接官方 Chat Completions 兼容端点；仍由 type→factory 选择实现，Provider ID 保持自由命名。
- 修改原因：用户要求查询三家官方文档并落地 OpenAI-compatible Providers。
- 影响范围：Composition 配置/Bootstrap、Runtime presets、示例配置与离线测试。
- 模块记录：[Composition](../src/composition/changes.md)、[Runtime Model](../src/runtime/model/changes.md)。
- 现行规范：[Composition README](../src/composition/README.md)、[Runtime Model README](../src/runtime/model/README.md)。

### 2026-11-24 — Provider 配置收敛为协议 type + 用户 baseURL

- 主题 ID：`runtime.protocol-only-providers`
- 变更前：短暂引入过 `openai` / `qwen` / `deepseek` 厂商预设 type 与默认端点。
- 变更后：仅 `openai-compatible` / `openai-responses`；配置与 Adapter 均要求显式 `baseURL`，不再在代码中预设厂商地址。
- 修改原因：用户反馈厂商预设 type/默认 URL 逻辑混乱。
- 影响范围：Composition、Runtime Model Adapters、示例配置、阶段文档示例。
- 模块记录：[Composition](../src/composition/changes.md)、[Runtime Model](../src/runtime/model/changes.md)。

### 2026-11-24 — 删除 .env.example 并同步规范文档

- 主题 ID：`docs.remove-env-example`
- 变更前：仓库保留 `.env.example`，README / Composition / 阶段文档将其当作环境变量清单。
- 变更后：删除该文件；现行文档改为只说明 JSON 示例、`${ENV}` 与进程环境变量；明确不提供也不自动加载 `.env` 模板。
- 修改原因：运行时从不读取该文件，用户要求删除后补齐文档一致。
- 影响范围：根 README、Composition / CLI 说明、`docs/conventions.md`、`docs/phase-0.md`、`docs/phase-2.1.md`。
- 模块记录：[Composition](../src/composition/changes.md)。
