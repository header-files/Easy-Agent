# Harness — 横向契约与通用支撑

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

为各模块定义统一契约、执行通用服务、上下文管理与治理约束，不是执行请求逐层经过的中间节点。

## 负责的内容

- Agent、Agent Loop、ModelClient、ToolExecutor 等跨模块必要契约
- Context、Extension、Execution Services、Governance 等横向通用约定
- 为替换实现提供稳定且最小化的抽象边界

## 不负责的内容

- 自行提供所有实际 Runtime 实现
- 定义巨型万能接口或成为必经转发层

## 当前实现状态

**Phase 1.1 Model Contracts、Phase 1.2 Tool Contracts 已完成；Phase 1.3 已增加与算法无关的 AgentLoop 契约。**

- [`contracts/model/index.ts`](contracts/model/index.ts) 提供 ModelClient、消息、统一模型参数、Tool Calling、响应与 Usage、流式事件、调用控制和 ModelError；行为见 [Model Contracts](contracts/model/README.md)。
- [`contracts/tool/index.ts`](contracts/tool/index.ts) 提供 ToolSpec、ToolHandler、ToolRegistry、ToolExecutor、ToolResult，以及执行上下文、选项和 ToolExecutionError；行为见 [Tool Contracts](contracts/tool/README.md)。
- [`contracts/agent-loop/index.ts`](contracts/agent-loop/index.ts) 提供 AgentLoopContext、AgentLoopEvent、AgentLoopResult 和 AgentLoop；使用统一异步事件流，自定义实现无需模型或工具依赖；行为见 [AgentLoop Contracts](contracts/agent-loop/README.md)。

公共契约不依赖具体 Provider SDK、默认 Loop 算法或实际工具实现，不充当请求代理。既有 Model/Tool Contracts 保持不变；Loop 事件直接引用既有 ModelStreamEvent、ToolCall 和 ToolResult。

## 后续实现范围

Context Management、Extension、Execution Services、Governance 尚未实现；随后续阶段的真实需求引入。执行器机制、Execution 生命周期和 Session 管理不属于本次 Loop 公共契约，不进入 Phase 1.4。

## 协作与边界

Execution 提供 AgentLoop 的具体策略实现；Runtime Model 实现 ModelClient，Runtime Tool 实现 ToolRegistry 与 ToolExecutor。默认循环可依赖这些契约，但第三方 Loop 不需要继承或组合默认实现。实例可由调用方直接使用，不要求经过 Harness 中间代理；Harness 不实现模型—工具循环算法。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。当前范围为 Phase 1.3 Agent Loop，唯一有效阶段设计是 [`docs/phase-1.3-agent-loop.md`](../../docs/phase-1.3-agent-loop.md)；不提前引入 Execution Engine，不擅自修改 Phase 1.1/1.2 公共契约。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.3-agent-loop.md)
- [Model Contracts](contracts/model/README.md)
- [Tool Contracts](contracts/tool/README.md)
- [AgentLoop Contracts](contracts/agent-loop/README.md)
- [本模块变更时间线](changes.md)
