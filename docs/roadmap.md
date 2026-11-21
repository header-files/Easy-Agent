# Easy Agent 功能路线图与设计预留

> 路线图记录后续产品方向，**不是当前开发授权**。Phase 0 已完成；当前仅补充 [Logging 基础设施](../src/runtime/logging/README.md)，Phase 1 业务尚未启用。当前范围见 [Coding Agent 工作说明](AGENT.md)。

## 一、阶段划分

| 阶段         | 目标                         | 主要交付                                                                                    | 状态     |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| **Phase 0**  | 工程初始化与整体架构骨架     | TypeScript / Node.js、工程检查、目录规范、基础离线 smoke test、文档                         | 已完成   |
| **Logging**  | Phase 1 前的公共日志基础设施 | 统一 Logger、Pino 结构化 stderr、级别配置、模块子日志、敏感信息处理与离线测试               | **当前** |
| **Phase 1**  | 最小可运行 Agent             | Bootstrap、AgentManager/SessionAgent、Engine/Basic Loop、ModelClient/Provider、CLI 多轮交互 | 待启动   |
| **Phase 2**  | 基础可用 Agent               | Tool Calling、基础存储与事件、SDK、HTTP / SSE、基础控制                                     | 规划     |
| **Phase 3+** | 扩展与可靠运行能力           | MCP、Skill、Memory、Approval、Workspace/Sandbox、Recovery、多 Agent、Web UI 等              | 规划     |

阶段切换需用户明确决定；不要把未来功能当成“顺手实现”。

## 二、未来能力与边界

| 领域                           | 未来计划                          | 当前处理                                           |
| ------------------------------ | --------------------------------- | -------------------------------------------------- |
| Logging                        | 统一运行日志与后续按需扩展        | 当前仅做基础日志；不做文件轮转、远端服务或 tracing |
| Agent / Session                | 会话管理、交互历史和任务协调      | 仅保留架构定位，不写业务代码                       |
| Execution                      | Engine / Loop、执行实体与控制     | 仅保留职责分离原则                                 |
| Model                          | 统一协议与 OpenAI-compatible 适配 | 不建 ModelClient/Provider                          |
| CLI                            | 交互、配置模型、连续问答          | 不实现 CLI 聊天                                    |
| Tool                           | 工具注册、校验、调用、结果处理    | 不实现                                             |
| HTTP / SSE / SDK               | 远程调用、流式事件与开发者集成    | 不实现                                             |
| Context / Memory               | 历史、Token 预算、压缩、记忆      | 不实现                                             |
| Event / Persistence            | 记录、订阅、回放、状态持久化      | 不实现                                             |
| Inbox / Scheduler              | Follow-up / Steer、串行与排队     | 不实现                                             |
| MCP / Skill                    | 外部能力接入和 Skill 执行         | 不实现                                             |
| Workspace / Resource / Sandbox | 持久化空间、资源和隔离环境        | 不实现                                             |
| Approval / Governance          | 审批、权限、安全与限制            | 不实现                                             |
| Recovery                       | 执行核实、崩溃恢复与继续推进      | 不实现                                             |
| Agent Loop 扩展                | Planning Loop、多 Agent 等        | 不实现                                             |
| Web UI                         | 图形化入口                        | 不实现                                             |

## 三、已确认、尚待逐步落地的设计方向

以下是后续实现的设计基线，**不是当前 Logging 任务要求创建的实体或状态机**：

- 核心执行概念：Session、Execution、Turn、Step、Attempt；Step 是逻辑步骤，Attempt 是实际尝试。
- 同一 Session 的活动执行串行；不同 Session 的并发策略按后续实现确定。
- Agent Layer 负责任务协调，Loop 负责策略，Execution Engine 负责执行机制，Runtime 提供能力实现。
- Follow-up 进入 Inbox，后续创建新 Execution，同一 Inbox Item 与 Execution 建立幂等关联。
- Steer 作用于正在执行的目标 Execution，在 Step 边界处理，不强制打断正在进行的模型或工具调用。
- Approval 是独立实体，Step 引用 Approval；审批同意不等于操作执行成功。
- Recovery 依据已记录事实恢复，不重写历史执行记录。
- 完整状态机、事务与持久化协议在对应阶段通过代码和测试逐步确定。

如果后续设计改变，遵守 [`conventions.md`](conventions.md) 的文档规则：本模块实现变化更新就近 `README.md` 和 `changes.md`；全局/跨模块决定在 [`docs/changes.md`](changes.md) 追加决策摘要与相关模块链接。
