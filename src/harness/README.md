# Harness — 横向契约与通用支撑

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

为各模块定义统一契约、执行通用服务、上下文管理与治理约束，不是执行请求逐层经过的中间节点。

## 负责的内容

- Agent、ExecutionEngine、AgentLoop、ModelClient、ToolExecutor 等跨模块必要契约
- Context、Extension、Execution Services、Governance 等横向通用约定
- 为替换实现提供稳定且最小化的抽象边界

## 不负责的内容

- 自行提供所有实际 Runtime 实现
- 定义巨型万能接口或成为必经转发层

## 当前实现状态

**Phase 1.1–1.3 Model、Tool、AgentLoop 契约已完成；Phase 1.4 已增加 Execution 公共契约。**

- [`contracts/model/index.ts`](contracts/model/index.ts) 提供 ModelClient、消息、统一模型参数、Tool Calling、响应与 Usage、流式事件、调用控制和 ModelError；行为见 [Model Contracts](contracts/model/README.md)。
- [`contracts/tool/index.ts`](contracts/tool/index.ts) 提供 ToolSpec、ToolHandler、ToolRegistry、ToolExecutor、ToolResult，以及执行上下文、选项和 ToolExecutionError；行为见 [Tool Contracts](contracts/tool/README.md)。
- [`contracts/agent-loop/index.ts`](contracts/agent-loop/index.ts) 提供 AgentLoopContext、AgentLoopEvent、AgentLoopResult 和 AgentLoop；使用统一异步事件流，自定义实现无需模型或工具依赖；行为见 [AgentLoop Contracts](contracts/agent-loop/README.md)。
- [`contracts/execution/index.ts`](contracts/execution/index.ts) 提供 ExecutionEngine、Request、Event、Result、Snapshot 与状态/错误类型；规范惰性单次消费、取消请求和内存快照；行为见 [Execution Contracts](contracts/execution/README.md)。

公共契约不依赖具体 Provider SDK、默认 Loop 算法或实际工具实现，不充当请求代理。既有 Model、Tool、AgentLoop 公共契约保持不变；Execution 直接引用既有 AgentLoop 输入、事件与结果，不将 Execution 状态反向加入 Loop。

## 后续实现范围

Context Management、Extension、Execution Services、Governance 尚未实现；随后续阶段的真实需求引入。本次仅定义内存 Execution 运行边界，不实现 Session 调度、持久化接口或 Phase 1.5 Agent Management。

## 协作与边界

Execution 提供 Loop 策略与 Engine 机制实现，二者通过独立契约协作；Runtime Model/Tool 提供具体能力。Engine 接收任意 AgentLoop，自定义 Loop 不需要模型、工具或默认策略。Harness 不负责驱动事件流、执行算法或写入 Session Event Log，持久化的物理读写留给未来 Runtime/Persistence。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。当前唯一阶段设计是 [`docs/phase-1.4.md`](../../docs/phase-1.4.md)；不进入 Session/持久化或 Phase 1.5，不擅自修改 Phase 1.1–1.3 公共契约。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.4.md)
- [Model Contracts](contracts/model/README.md)
- [Tool Contracts](contracts/tool/README.md)
- [AgentLoop Contracts](contracts/agent-loop/README.md)
- [Execution Contracts](contracts/execution/README.md)
- [本模块变更时间线](changes.md)
