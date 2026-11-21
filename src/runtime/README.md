# Runtime — 实际能力运行时层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

按能力域提供模型、工具、MCP、Skill、Memory、Event、Persistence、Sandbox 等实际运行能力，优先支持独立替换。

## 负责的内容

- Model Runtime：模型适配、调用与 Provider 实现
- Tool / MCP / Skill 等运行能力（在对应阶段开发）
- Persistence、Event、Resource、Workspace、Sandbox、Approval 等实际服务

## 不负责的内容

- 决定全局 Agent 执行策略
- 要求开发者替换整个 Runtime 才能替换单个 Provider

## 当前实现状态

**Phase 0 工程基线上已增加 Logging 基础设施**，见 [`logging/README.md`](logging/README.md)。公共入口为 `logging/index.ts`，提供供应商无关的 Logger 和基于 Pino 的实现，支持四级结构化日志、错误信息、子 logger、环境级别、stderr 与脱敏。Model、Tool、MCP 等 Agent 业务能力尚未实现。

## 后续实现范围

Model 等业务能力等待后续阶段明确授权；当前只完成 Logging，不开启 Phase 1 或提前建立业务组件。

## 协作与边界

通过所实现的能力契约为 Loop、Agent、Execution 等提供基础服务；具体业务接口待对应功能阶段确定。Logging 是横向基础设施，调用方显式传入 Logger，不依赖全局容器。

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

## Logging 入口与验证

- [Logging 当前实现、配置与用法](logging/README.md)
- [Logging 变更时间线](logging/changes.md)
- `npm test` 执行 Logging 和工程 smoke 离线测试；完整检查命令见 [工程规范](../../docs/conventions.md)。
