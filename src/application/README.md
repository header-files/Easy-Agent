# Application — 应用接入层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

向用户和开发者提供 CLI、SDK、HTTP API、Web UI 等入口，并将输入、输出和执行事件适配为各入口需要的形式。

## 负责的内容

- 用户输入、执行控制指令的接收和对外呈现
- 入口协议与用户体验适配（CLI、HTTP 等）
- 在不同入口复用同一套 Agent 核心能力

## 不负责的内容

- 自行决定模型调用、工具调用或任务执行策略
- 复制 Agent 层的任务协调与 Execution 的执行逻辑

## 当前实现状态

**当前 Phase 1.5 不实现本模块业务功能，仍只有模块文档和目录归属。** Model/Tool/Loop/Engine 已完成，Session 管理已由 Agent 目录实现；本目录出现并不代表功能已实现。

## 后续实现范围

Phase 1.6：Composition + CLI 与整体集成验收。Phase 2：SDK、HTTP API 和 SSE；Web UI 留待后续。

## 协作与边界

通过 Agent 对外入口协调任务，订阅或接收执行结果；不直接绑定具体 Provider SDK。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。Phase 1.5 不写本模块的业务类、接口占位或假实现。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.5.md)
- [本模块变更时间线](changes.md)
