# Harness — 横向契约与通用支撑

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

为各模块定义统一契约、执行通用服务、上下文管理与治理约束，不是执行请求逐层经过的中间节点。

## 负责的内容

- Agent、Agent Loop、ModelClient 等跨模块必要契约
- Context、Extension、Execution Services、Governance 等横向通用约定
- 为替换实现提供稳定且最小化的抽象边界

## 不负责的内容

- 自行提供所有实际 Runtime 实现
- 定义巨型万能接口或成为必经转发层

## 当前实现状态

**Phase 0：只有模块文档和目录归属，尚无本模块业务实现。** 本目录出现并不代表功能已实现。

## 后续实现范围

Phase 1：随真实业务调用方引入最小 ModelClient / AgentLoop 契约；其他横向能力后续按需引入。

## 协作与边界

由 Execution 等模块依赖必要契约，Runtime 实现相应契约；契约允许按能力域就近组织。

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
