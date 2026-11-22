# Composition / Bootstrap — 装配与启动入口

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

读取配置、选择默认或自定义组件、建立依赖并初始化可运行 Agent；它是装配入口，不是独立业务运行层。

## 负责的内容

- 配置加载与组件选择（在功能实际需要时实现）
- 默认实现、自定义实现的装配和初始化
- 必要资源的初始化及生命周期收尾

## 不负责的内容

- 用户任务调度或模型执行决策
- 为了扩展性提前设计复杂 DI 容器或插件管理器

## 当前实现状态

**当前 Phase 1.3 不实现本模块业务功能，仍只有模块文档和目录归属。** Model/Tool System 和 DefaultAgentLoop 在各自职责域中实现，本目录出现并不代表功能已实现。

## 后续实现范围

Phase 1.6：最小 Factory / 装配入口、CLI 与整体集成验收；当前只允许调用方独立创建 ModelClient、Registry/Executor 和 DefaultAgentLoop，不实现完整 Agent 装配。

## 协作与边界

组合 Application、Agent、Execution 与 Runtime 具体实现，并遵循 Harness 中约定的必要契约。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。Phase 1.3 不写本模块的业务类、接口占位或假实现。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.3-agent-loop.md)
- [本模块变更时间线](changes.md)
