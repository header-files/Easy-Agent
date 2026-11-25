# Runtime — 实际能力运行时层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

按能力域提供模型、工具、MCP、Skill、Memory、Event、Persistence、Sandbox 等实际运行能力，优先支持独立替换。

## 负责的内容

- Logging：统一 Logger 门面、结构化输出、模块与子日志、环境级别和安全序列化。
- Model Runtime：模型适配、调用与 Provider 实现，通过既有 Logger 门面记录请求生命周期。
- Tool Runtime：本地工具注册、参数校验、执行控制和 Model 数据桥接。
- Workspace / Approval：进程内 Workspace 管理、读写锁、UNSAFE 与审批门控（Phase 2.2）。
- MCP / Skill，以及 Persistence、Event、Resource、Sandbox 等实际服务，在后续对应阶段开发。

## 不负责的内容

- 决定全局 Agent 执行策略。
- 要求开发者替换整个 Runtime 才能替换单个 Provider。
- 提供全局 DI、完整 tracing 或分布式调度。

## 当前实现状态

**Logging、Model System（含 Registry/Router 与 Responses）、Tool Runtime、Workspace 与 Approval 已完成，由 Composition 统一装配。**

- [`logging/index.ts`](logging/index.ts) 提供供应商无关的 Logger 与 Pino 实现，支持四级结构化日志、错误信息、子 logger、环境级别、stderr 和脱敏，行为详见 [Logging README](logging/README.md)。
- [`model/index.ts`](model/index.ts) 提供 `OpenAICompatibleModelClient`、`OpenAIResponsesModelClient`、`DefaultModelRegistry` 与 `ModelRouter`，行为详见 [Model README](model/README.md)。
- [`tool/index.ts`](tool/index.ts) 提供 DefaultToolRegistry、DefaultToolExecutor、`GuardedToolExecutor`、内置 FileSystem/Terminal 工具与 Model Bridge；行为详见 [Tool README](tool/README.md)。
- [`workspace/index.ts`](workspace/index.ts) 提供 WorkspaceManager、AccessCoordinator、PathResolver；详见 [Workspace README](workspace/README.md)。
- [`approval/index.ts`](approval/index.ts) 提供进程内 ApprovalService；详见 [Approval README](approval/README.md)。
- Model 与 Tool 复用既有 Logger，默认提供生命周期日志并允许构造时注入。日志只记录可诊断的白名单元数据；日志故障不改变结果或清理语义。

不新增 Persistence、Event Bus、Docker/OS 沙箱或 Session 日志读写能力。

## 后续实现范围

按后续授权逐步增加其他模型协议、MCP / Skill 等能力；本模块不提供队列、自动重试、热更新或智能 Fallback。模型—工具—模型策略已由 Execution 的 DefaultAgentLoop 实现，Engine 负责独立运行机制，均不下沉到 Runtime。

## 协作与边界

Model 与 Tool 分别通过 Harness 的 ModelClient / ToolRegistry / ToolExecutor 契约提供服务，不依赖 Agent Loop 或 Execution；调用方可以直接复用实例；Loop 使用这些契约，Engine 通过通用 AgentLoop 驱动策略，不要求 Runtime 反向依赖上层。Tool Bridge 只转换数据，不请求模型。Logging 是横向基础设施，调用方显式传入 Logger，不依赖全局容器，也不进入模型消息或流式事件协议。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅子能力域说明。
2. 仅在用户授权的阶段实现功能，不提前创建无用业务接口或占位类。
3. 功能落地时，更新真实实现状态、入口、使用及测试方式。
4. 实质性变更同步更新就近 README 与 changes；全局或跨模块决策再关联 [`docs/changes.md`](../../docs/changes.md)。

## 验证与相关资料

`npm test` 执行 Logging、Model/Tool 公共契约、Adapter、Schema、工具执行、并发隔离、生命周期日志及工程 smoke 离线测试，不需要真实密钥或外部服务。完整质量命令见 [工程规范](../../docs/conventions.md)。

- [全局架构](../../docs/architecture.md)
- [当前阶段范围](../../docs/phase-2.2.md)
- [Logging 说明](logging/README.md) / [时间线](logging/changes.md)
- [Model 说明](model/README.md) / [时间线](model/changes.md)
- [Tool 说明](tool/README.md) / [时间线](tool/changes.md)
- [Workspace 说明](workspace/README.md) / [时间线](workspace/changes.md)
- [Approval 说明](approval/README.md) / [时间线](approval/changes.md)
- [Runtime 变更时间线](changes.md)
