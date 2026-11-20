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
- 现行规范：[Phase 0](phase-0.md)、[Phase 1](phase-1.md)、[架构设计](architecture.md)。

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
