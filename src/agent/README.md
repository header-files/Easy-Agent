# Agent — 会话与任务管理层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

管理 Session、用户输入与任务协调，确定输入归属与 Execution 调度时机，不承担任务内部的模型决策。

## 负责的内容

- SessionAgent 的会话生命周期与交互协调
- AgentManager 的会话创建、获取与释放
- 后续 Inbox 的 Follow-up / Steer 输入管理与 ExecutionScheduler 的排队调度

## 不负责的内容

- 决定 Agent Loop 的下一步推理或工具调用
- 执行模型、工具或持久化底层实现

## 当前实现状态

**当前 Phase 1.4 不实现本模块业务功能，仍只有模块文档和目录归属。** Model/Tool/Loop 已完成，Engine 在独立机制模块中实现，本目录出现并不代表功能已实现。

## 后续实现范围

Phase 1.5：最小 AgentManager、SessionAgent 和进程内会话历史；Phase 2/3+：逐步完善 Inbox、Scheduler 与持久化。

## 协作与边界

向 Execution 发起与协调任务；通过必要契约使用 Runtime 基础能力。Follow-up 创建新的 Execution，Steer 作用于目标 Execution。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。Phase 1.4 不写本模块的业务类、接口占位或假实现。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.4.md)
- [本模块变更时间线](changes.md)
