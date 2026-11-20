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

**Phase 0：只有模块文档和目录归属，尚无本模块业务实现。** 本目录出现并不代表功能已实现。

## 后续实现范围

Phase 1：基础 Execution Engine 与可替换 Basic Loop；后续按需实现 Cancel、Approval、Recovery 和完整执行实体状态机。

## 协作与边界

由 Agent 协调执行；Loop 依赖 Harness/能力域契约使用 Runtime，不强制所有调用穿过 Harness。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。Phase 0 不写本模块的业务类、接口占位或假实现。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-0.md)
- [本模块变更时间线](changes.md)
