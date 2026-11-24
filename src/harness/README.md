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

**Phase 1.1–1.4 Model、Tool、AgentLoop、Execution 契约已完成；Phase 1.5 已增加 Agent Management 公共契约。**

- [`contracts/model/index.ts`](contracts/model/index.ts) 提供 ModelClient、消息、统一模型参数、Tool Calling、响应与 Usage、流式事件、调用控制和 ModelError；行为见 [Model Contracts](contracts/model/README.md)。
- [`contracts/tool/index.ts`](contracts/tool/index.ts) 提供 ToolSpec、ToolHandler、ToolRegistry、ToolExecutor、ToolResult，以及执行上下文、选项和 ToolExecutionError；行为见 [Tool Contracts](contracts/tool/README.md)。
- [`contracts/agent-loop/index.ts`](contracts/agent-loop/index.ts) 提供 AgentLoopContext、AgentLoopEvent、AgentLoopResult 和 AgentLoop；使用统一异步事件流，自定义实现无需模型或工具依赖；行为见 [AgentLoop Contracts](contracts/agent-loop/README.md)。
- [`contracts/execution/index.ts`](contracts/execution/index.ts) 提供 ExecutionEngine、Request、Event、Result、Snapshot 与状态/错误类型；规范惰性单次消费、取消请求和内存快照；行为见 [Execution Contracts](contracts/execution/README.md)。
- [`contracts/agent/index.ts`](contracts/agent/index.ts) 提供 AgentManager、SessionAgent、SessionExecution、创建/提交配置和 SessionSummary；规范同步入队、独立观察流、结果 Promise 与 Session 生命周期；行为见 [Agent Contracts](contracts/agent/README.md)。

公共契约不依赖具体 Provider SDK、默认 Loop 算法或实际工具实现，不充当请求代理。既有 Phase 1.1–1.4 协议保持不变；Agent 契约直接引用现有 Context、ExecutionEvent/Result 与 ModelParameters，不向 Engine 增加 QUEUED 或 Session 队列字段。

## 后续实现范围

Context Management、Extension、Execution Services、Governance 尚未实现；随后续阶段的真实需求引入。本次定义内存 Session 管理与提交观察协议，不引入持久化 Inbox、Session Event Log、Recovery 或 Phase 1.6 产品装配接口。

## 协作与边界

Agent 实现 Session 生命周期、FIFO、上下文与结果收敛，并作为 Engine 流的内部唯一消费者；外部观察流不直接暴露 Engine 迭代器。Execution 提供 Loop 策略与 Engine 机制，Runtime Model/Tool 提供具体能力。自定义 Loop 不需要模型或工具，Harness 不执行调度或写入 Session Event Log；未来物理读写仍属于 Runtime/Persistence。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。当前唯一阶段设计是 [`docs/phase-1.5.md`](../../docs/phase-1.5.md)；不进入 Phase 1.6 或持久化，不擅自修改 Phase 1.1–1.4 公共契约。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.5.md)
- [Model Contracts](contracts/model/README.md)
- [Tool Contracts](contracts/tool/README.md)
- [AgentLoop Contracts](contracts/agent-loop/README.md)
- [Execution Contracts](contracts/execution/README.md)
- [Agent Contracts](contracts/agent/README.md)
- [本模块变更时间线](changes.md)
