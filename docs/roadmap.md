# Easy Agent 功能路线图与设计预留

> 路线图记录后续产品方向，**不是当前开发授权**。当前阶段以 [唯一 Phase 1.4 Execution Engine 设计](phase-1.4.md) 为准。

## 一、阶段划分

| 阶段                      | 目标                 | 主要交付                                                              | 状态             |
| ------------------------- | -------------------- | --------------------------------------------------------------------- | ---------------- |
| **Phase 0**               | 工程初始化与架构骨架 | TypeScript/Node.js、质量脚本、目录规范与文档                          | 已完成           |
| **Logging 基线**          | Phase 1 前的统一日志 | Logger、Pino stderr、等级/错误/脱敏与离线测试                         | 已完成           |
| [Phase 1.1](phase-1.1.md) | Model System         | 模型契约、Chat Completions、流式/Tool Calling、并发及日志             | 已完成           |
| [Phase 1.2](phase-1.2.md) | Tool Runtime         | 工具契约、Registry/Executor、严格 Schema、结果与桥接、取消/超时和并发 | 已完成           |
| [Phase 1.3](phase-1.3.md) | Agent Loop           | 通用契约、DefaultAgentLoop、流式模型、串行工具、完整上下文            | 已完成           |
| [Phase 1.4](phase-1.4.md) | Execution Engine     | 任意 Loop 驱动、内存状态/事件/结果、取消及有界快照                    | 已完成；当前基线 |
| **Phase 1.5**             | Agent Management     | Session、输入与 Execution 协调                                        | 待授权           |
| **Phase 1.6**             | Composition + CLI    | 默认装配、CLI 与整体集成验收                                          | 待授权           |
| **Phase 2**               | 基础可用 Agent       | 基础存储与事件、SDK、HTTP/SSE、基础控制                               | 规划             |
| **Phase 3+**              | 扩展与可靠运行能力   | MCP、Skill、Memory、Approval、Sandbox、Recovery、多 Agent、Web UI 等  | 规划             |

当前分期以 [Phase 1 索引](phase-1.md) 为准；2026-11-22 调整依据见 [项目记录](changes.md)。

阶段切换需用户明确决定；不要把未来功能当成“顺手实现”。

## 二、未来能力与边界

| 领域                           | 未来计划                             | 当前 Phase 1.4 的处理                                        |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------ |
| Logging                        | 统一运行日志和按需扩展               | Model/Tool 生命周期复用既有门面；不实现轮转/远端服务/tracing |
| Agent / Session                | 会话管理、交互历史和任务协调         | 仅保留架构定位，不写业务代码                                 |
| Execution                      | Engine / Loop、执行实体与控制        | 已有 Loop 策略；当前实现独立 Engine 内存机制                 |
| Model                          | 统一协议与 OpenAI-compatible 适配    | 实现统一模型契约与 Chat Completions Adapter                  |
| CLI                            | 交互、配置模型、连续问答             | 不实现 CLI 聊天                                              |
| Tool                           | 工具注册、校验、调用、结果处理       | 独立执行能力已完成；由默认 Loop 按批次顺序串行调用           |
| HTTP / SSE / SDK               | 远程调用、流式事件与开发者集成       | 不实现                                                       |
| Context / Memory               | 历史、Token 预算、压缩、记忆         | Loop 复制完整消息历史；预算、压缩和 Memory 未实现            |
| Event / Persistence            | 可靠事实、分发、历史查询、重放与恢复 | 不读写 Session Event Log；无持久化、事务日志或 Event Bus     |
| Inbox / Scheduler              | Follow-up / Steer、串行与排队        | 不实现                                                       |
| MCP / Skill                    | 外部能力接入和 Skill 执行            | 不实现                                                       |
| Workspace / Resource / Sandbox | 持久化空间、资源和隔离环境           | 不实现                                                       |
| Approval / Governance          | 审批、权限、安全与限制               | 不实现                                                       |
| Recovery                       | 执行核实、崩溃恢复与继续推进         | 不实现                                                       |
| Agent Loop 扩展                | Planning Loop、多 Agent 等           | 不实现                                                       |
| Web UI                         | 图形化入口                           | 不实现                                                       |

## 三、已确认、尚待逐步落地的设计方向

以下是后续实现的设计基线，**除本阶段最小 Execution 内存状态外，仍不是当前任务要求创建的实体或状态机**：

- 核心执行概念：Session、Execution、Turn、Step、Attempt；Step 是逻辑步骤，Attempt 是实际尝试。
- 同一 Session 的活动执行串行；不同 Session 的并发策略按后续实现确定。
- Agent Layer 负责任务协调，Loop 负责策略，Execution Engine 负责执行机制，Runtime 提供能力实现。
- Follow-up 进入 Inbox，后续创建新 Execution，同一 Inbox Item 与 Execution 建立幂等关联。
- Steer 作用于正在执行的目标 Execution，在 Step 边界处理，不强制打断正在进行的模型或工具调用。
- Approval 是独立实体，Step 引用 Approval；审批同意不等于操作执行成功。
- Recovery 依据已记录事实恢复，不重写历史执行记录。
- 完整状态机、事务与持久化协议在对应阶段通过代码和测试逐步确定。

如果后续设计改变，遵守 [`conventions.md`](conventions.md) 的文档规则：本模块实现变化更新就近 `README.md` 和 `changes.md`；全局/跨模块决定在 [`docs/changes.md`](changes.md) 追加决策摘要与相关模块链接。
