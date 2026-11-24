# Coding Agent 项目工作说明

> 本文指导 Codex、Cursor 等 Coding Agent。**当前任务为 Phase 1.5 Agent Management，唯一阶段依据为 `docs/phase-1.5.md`；不自动接续 Phase 1.6 Composition + CLI。**

## 1. 产品目标与优先级

Easy Agent 定位为**开箱即用、灵活可扩展的通用 Agent**，优先交付默认可用的产品，并保留按需扩展与组件替换能力。

理念：**Easy to Use** 与 **Easy to Extend**。它不是要求用户先搭建各种组件的开发框架，也不定位为大而全的平台。

发生要求冲突时，按以下顺序判断：

1. 用户在当前开发任务中的明确要求。
2. `docs/architecture.md`：当前有效架构基线。
3. **`docs/phase-1.5.md`：当前唯一有效的阶段设计、任务与验收依据；Phase 0、1.1–1.4 保留各自基线与历史验收。**
4. `docs/conventions.md`：工程、测试与文档规范。
5. `docs/roadmap.md`：未来计划，**不是本次任务授权**。
6. `src/<module>/README.md`：本次修改涉及的模块现行说明（必须先读）；`src/<module>/changes.md`：本模块的历史决策与演进时间线。
7. `docs/changes.md`：项目级架构、公共规范与跨模块决策的历史摘要；当前设计始终以现行文档为准。

## 2. 已确认的整体架构

- **Application**：对外入口（CLI / SDK / HTTP API / Web UI）。
- **Agent**：Session、输入和 Execution 的协调管理。
- **Execution**：Execution Engine 负责机制；Agent Loop 负责策略，默认实现为 DefaultAgentLoop。
- **Runtime**：提供 Model、Tool、MCP、Skill 等具体能力，按能力域划分，可局部替换。
- **Harness**：横向契约、Context、Extension、Governance、Execution Services，不是每次调用的中间层。
- **Composition / Bootstrap**：组件选择和装配入口，不是额外业务运行层。

职责分层不等于固定调用链。不要建立万能 Runtime/Harness 接口，也不要提前实现复杂插件容器。职责和目录设计以 [architecture.md](architecture.md) 为准。

## 3. 当前阶段应该做什么：Phase 1.5

在已有 Logging、Model、Tool、[Agent Loop](phase-1.3.md) 和 [Execution Engine](phase-1.4.md) 基线上，严格执行 [Phase 1.5 唯一设计](phase-1.5.md)：

- Harness 定义 AgentManager、SessionAgent、SessionExecution、创建/提交配置和摘要；直接引用已有 Context、ModelParameters 和 Execution 协议，不复制平行类型。
- Agent 实现默认 Manager 和 SessionAgent：内存 Session 创建、稳定获取/列表、空闲删除；删除后的旧引用拒绝 submit，不强制删除或丢弃活跃任务。
- submit 同步登记 FIFO 并返回句柄，每 Session 只有一个调度泵、至多一个活动执行；不同 Session 允许并发，ID 由 Agent 层分配。
- 在任务实际启动时读取最新已提交上下文和本次配置快照；仅 COMPLETED 且 updatedContext 存在时整体替换上下文。失败、取消和 stopped 不提交；缺少更新不猜测历史。
- 按模型名/参数、工具名单和 extensions 命名空间规则合并配置，不修改默认配置或调用方参数；不强制自定义 Loop 使用模型。
- 内部唯一消费 Engine 的惰性事件流，先确认收尾、提交上下文，再 resolve result，之后启动下一项；错误不能令结果 Promise 永久悬挂或形成未处理拒绝。
- events 是有界、单消费者、单次遍历的观察流。无人读取、观察者退出或溢出均不取消/阻塞 Execution；溢出明确使观察流失败，result 与上下文提交保持独立。
- 区分排队与运行取消：排队取消不调用 Engine、也不伪造生命周期事件；运行取消使用独立 signal，等待 Engine 的协作收尾，不提前放行同 Session 下一项。

当前只授权 Phase 1.5；整体顺序仍为 1.1 Model → 1.2 Tool → 1.3 Loop → 1.4 Engine → **1.5 Agent Management** → 1.6 Composition + CLI。

## 4. 不在本次阶段实现的功能

- **Session Event Log 的 JSONL 读取和写入**、Session Write Coordinator、Transaction Journal、持久化事件投影、重放或崩溃恢复。
- Runtime Event Bus、SSE、多订阅者广播；观察流和 ExecutionEvent 仍是内存通知，不是持久化事实。
- 持久化 Inbox、Steer/Follow-up、Approval/HITL、Pause/Resume、Session Tree、Workspace、Memory、上下文压缩或复杂优先级/全局调度。
- 完整 Turn/Step/Attempt 状态机、工具并行、Composition/Bootstrap 装配或 CLI/HTTP/Web UI。
- 修改 Phase 1.1–1.4 公共协议或默认 Loop 策略；不向 Engine ExecutionStatus 加 QUEUED。

Session 的进程内 FIFO 属于本次 Agent 职责，未来 Session Event Log 的物理读写仍归 Runtime/Persistence；不创建 JSONL 文件、假存储或占位持久化接口。

## 5. 推荐开发顺序

严格按 A → B → C → D → E 推进；每一步完成对应验证后再开展下一步：

1. A：先核对旧契约兼容性，完成 Harness Agent Management 契约、公共导出和契约用例。
2. B：默认 Manager 的依赖注入、Session 创建/注册/查询/稳定摘要/空闲删除与 ID。
3. C：上下文安全快照、配置覆盖和仅成功提交规则，证明多轮获取最新历史。
4. D：FIFO 内部调度、排队/运行取消、独立观察流、有界溢出和结果结算，验证并发与失败恢复。
5. E：补齐离线单元/集成测试与模块/项目文档，执行五项工程检查并报告真实结果。

完成后停止，不自动进入 Phase 1.6；不把内存历史或观察事件直接写成 Session Event Log。

## 6. 开发与验证约束

- TypeScript `strict`；Node.js ESM；统一 npm 锁文件；使用一致的格式化与静态检查工具。
- 测试必须离线运行，不依赖外部服务、模型密钥或数据库。
- 开发时同步补充单元测试，优先覆盖已落地的配置解析、错误归一、日志上下文和核心业务。交付前执行当前阶段要求的全部检查，并报告实际结果。
- 不伪造 Agent 业务能力以凑测试；smoke test 只用于验证项目入口和测试基础设施。
- 不为未来接口提前设计函数签名、状态机、事务边界或存储格式。
- 开始某模块的开发前只需按需阅读其 `README.md`、`changes.md` 及直接关联模块文档，不必每次加载所有模块或全仓历史。
- 不引入不必要的依赖、脚手架生成器、发布系统或 Monorepo。
- 命令只有实际配置并运行验证后，才能在 README 中标注为可用。

## 7. 未确定问题与架构变更

- 重大方案先与用户对齐，确认后再展开实现。改动以当次任务授权为准，避免无关重构和未请求的文档扩张。
- 局部工程细节：采用简单、通行、可测试的默认实现，并在适当文档记录选择。
- 已确认架构边界：如遇实际冲突，应说明问题、可行替代、影响范围及验证依据，再寻求用户确认。
- 不将“为了将来可能扩展”作为增加大量抽象的理由。
- 当前方案与历史决策有疑问时，先阅读变更记录，不自行覆盖已确认选择。

## 8. 文档与变更记录：必须执行

文档角色：

| 文档                            | 作用                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `README.md`                     | 面向使用者，产品定位、真实可用的命令、阶段状态与索引                             |
| `AGENTS.md`                     | 仓库根目录 Coding Agent 自动发现入口                                             |
| `.cursor/rules/easy-agent.mdc`  | Cursor 引导规则，引用统一文档                                                    |
| `docs/AGENT.md`                 | 开发范围、执行规范与交付要求                                                     |
| `docs/architecture.md`          | **当前有效**架构、职责、目标目录结构                                             |
| `docs/conventions.md`           | 技术、代码、安全、测试及文档规范                                                 |
| `docs/phase-0.md`               | 已完成的工程初始化基线和历史验收                                                 |
| `docs/phase-1.1.md`             | 已完成 Model System 基线与历史验收                                               |
| `docs/phase-1.2.md`             | 已完成 Tool Runtime 基线与历史验收                                               |
| `docs/phase-1.3.md`             | 已完成 Agent Loop 设计与历史验收                                                 |
| `docs/phase-1.4.md`             | 已完成 Execution Engine 设计与历史验收                                           |
| `docs/phase-1.5.md`             | **当前唯一** Agent Management 设计、任务与验收依据                               |
| `docs/phase-1.md`               | Phase 1 阶段顺序索引                                                             |
| `src/runtime/logging/README.md` | 已完成 Logging 的接口、配置与安全边界                                            |
| `docs/roadmap.md`               | 后续能力范围，不是本期待办                                                       |
| `docs/changes.md`               | 项目级架构、公共规范及跨模块决策的**可追溯时间线**                               |
| `src/<module>/README.md`        | **模块级现行说明**：背景、职责、边界、实现状态、入口与验证方式（功能实现后补充） |
| `src/<module>/changes.md`       | **模块级变更时间线**：本模块每次实质性调整的前后差异、原因、影响与依据           |

**双轨维护原则：**

1. **项目级 / 模块级两级文档**：项目级说明全局；六个一级职责模块均维护就近 `README.md`、`changes.md`。独立子模块在实际创建时遵循同一规范，不对每个 `.ts` 文件建文档。
2. **现行说明只写当前有效方案和真实实现**；模块开发前先阅读其 README 和变更记录，不用遍历整个仓库。
3. **模块级实质性变更**：更新对应 `README.md` 并追加本模块 `changes.md`，保留时间、主题、修改前后、原因、影响及依据。同一主题多次变更只追加不覆盖。
4. **全局或跨模块变更**：同时更新受影响的模块说明；在 `docs/changes.md` 保留项目级决策摘要并链接相关模块记录，避免两套完全重复的历史。
5. 创建新职责独立的模块/能力域时，随真实代码创建对应说明与日志；Phase 0 六个主模块的文档本身属于工程骨架，不意味着业务已实现。
6. 历史记录不能覆盖现行规范；简单格式、拼写修复不需要详细记录。用户要求“只输出、不要写入文件”时，禁止修改仓库。

变更记录格式见 [changes.md](changes.md)，规范细则见 [conventions.md](conventions.md)。

## 9. 版本控制

- 主分支使用 `main`。远程仓库和操作分支以用户指定为准，保留现有 Git 配置。
- 仅在用户明确要求时执行 `commit`、`push`、合并或改写历史。合并多个提交或改写历史前，确认相关提交尚未推送，或已取得相应授权。操作受保护分支须取得用户授权。
- 提交使用 Conventional Commits，类型前缀用英文，如 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`。提交说明用中文，可保留必要的英文专有名词，重点写清修改原因。

## 10. 交付前检查

按本次改动和当前阶段核对：

- Git 操作符合用户授权。若有提交，核对英文类型前缀和中文说明。
- 涉及日志时，核对统一门面、级别开关、stderr、结构化模块字段及敏感信息保护；文件轮转和 trace 系统尚未实现，不作为当前已支持能力。
- 涉及配置时，在公共配置层集中管理，确认敏感配置文件已被忽略，并提供无真实密钥的示例。
- 核对公共基础设施与业务域的职责边界，并为本次涉及的关键能力补充单元测试。
- 核对项目级和模块级现行文档是否准确反映当前实现，变更记录只追加，跨层通过链接关联。

## 11. 任务完成汇报

报告至少说明：

1. 创建或修改了哪些文件，项目骨架实际完成到什么程度。
2. 运行过的 `typecheck`、`lint`、`format:check`、`build`、`test` 命令及**真实结果**。
3. 当前未实现的功能（尤其是 Session 日志读写、恢复、持久化 Inbox、工具并行和 CLI 交互）；本次影响的模块说明文件与本地变更日志。
4. 是否涉及实质性设计/实现变更，变更记录是否已追加。
5. 需要用户决策的架构偏离或阻塞，不自行扩大任务范围。
