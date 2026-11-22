# Execution — 执行机制与策略层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

组织单次 Agent 任务的执行过程，区分 Execution Engine（执行机制）与 Agent Loop（执行策略）。

## 负责的内容

- Execution Engine：执行生命周期、启动与控制
- Agent Loop：根据输入、上下文与执行结果决定下一步动作
- 后续 Session / Execution / Turn / Step / Attempt 执行语义的落地

## 不负责的内容

- 将具体 Model Provider 或 Tool 的 SDK 写死在 Loop 中
- 负责用户入口和整体组件装配

## 当前实现状态

**Phase 1.3 已提供 DefaultAgentLoop 默认策略**，入口为 [`loops/index.ts`](loops/index.ts)。它实现 Harness AgentLoop，注入既有 ModelClient、ToolRegistry 和 ToolExecutor，通过流式事件完成模型—串行工具—模型闭环，并返回完整上下文快照。具体配置、重试、取消与资源行为见 [Loop README](loops/README.md)。

Execution Engine、执行实体、Session 调度和持久化仍未实现。第三方 Loop 仅需满足公共契约，不要求复用默认算法。

## 后续实现范围

Phase 1.4：Execution Engine；Phase 1.5：Agent Management；Phase 1.6：Composition + CLI。审批、Recovery、持久化和完整执行实体状态机按后续授权开发。当前不提供 BasicLoop 旧别名或工具并行。

## 协作与边界

未来由 Agent/Execution Engine 协调执行；当前 Loop 依赖 Harness 的模型/工具公共契约使用 Runtime，不直接创建 Provider、Registry 或 Executor，不强制调用穿过 Harness。每次 run 的配置与控制来自 Context，实例可复用并发。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。当前只完成 Phase 1.3 Agent Loop，不提前实现 Engine、Session 或执行状态机。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段唯一依据](../../docs/phase-1.3-agent-loop.md)
- [本模块变更时间线](changes.md)

## 入口与验证

- [DefaultAgentLoop 使用与边界](loops/README.md) / [本地时间线](loops/changes.md)
- [Harness AgentLoop 契约](../harness/contracts/agent-loop/README.md)
- `npm test` 执行 Loop 算法、取消/并发、真实 Runtime 离线链路和已有工程回归；完整检查见 [工程规范](../../docs/conventions.md)。
