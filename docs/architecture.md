# Easy Agent 系统架构与项目骨架

> 本文是**当前有效架构基线**，只规定职责划分、边界和目录组织方向，不提前定义所有组件接口、状态机、事务协议或实现方式。项目级历史见 [变更记录](changes.md)；模块现行说明及局部历史见 `src/<module>/README.md`、`src/<module>/changes.md`。

## 1. 整体架构

Easy Agent 是**开箱即用、灵活可扩展的通用 Agent**，采用：

**四个核心运行职责层 + 横向 Harness 支撑 + Composition / Bootstrap 装配入口。**

```text
                     Composition / Bootstrap
                       配置、选择、装配、初始化
                                │
                                ▼
 ┌────────────────────────────────────────────────┐
 │ Application                                    │
 │ CLI / SDK / HTTP API / Web UI                  │
 ├────────────────────────────────────────────────┤
 │ Agent                                          │
 │ AgentManager / SessionAgent / Inbox / Scheduler│
 ├────────────────────────────────────────────────┤
 │ Execution                                      │
 │ Execution Engine（执行机制）                   │
 │ Agent Loop（执行策略）                         │
 ├────────────────────────────────────────────────┤
 │ Runtime                                        │
 │ Model / Tool / MCP / Skill / Memory            │
 │ Event / Persistence / Approval                 │
 │ Workspace / Sandbox / Resource                 │
 └────────────────────────────────────────────────┘

      Harness：横向提供 Contracts / Context / Extension
               Governance / Execution Services
```

这张图是**职责组织图，不是执行请求调用链**。Harness 不是 Execution 与 Runtime 之间的必经中间件；Composition / Bootstrap 负责装配，不负责运行用户任务。各模块通过必要的契约直接协作。

**Phase 0 与 Logging 基线已完成；当前 Phase 1.1 落地 Harness Model Contracts 与带统一生命周期日志的 Runtime Model System，其他业务组件仍为后续设计。** 工程基线与历史验收见 [Phase 0](phase-0.md)，当前范围见 [Phase 1.1](phase-1.1.md)。

## 2. 核心模块职责

| 模块                    | 核心职责                                                                | 不是它的职责                           |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| Composition / Bootstrap | 读取配置、选择组件、依赖装配及初始化                                    | 调度用户任务、作出模型决策             |
| Application             | 提供 CLI、SDK、HTTP API、Web UI 等交互入口                              | 实现 Agent Loop 或直接承担模型执行策略 |
| Agent                   | Session、用户输入、任务与 Execution 协调                                | 决定模型选什么工具、执行底层 Tool      |
| Execution Engine        | 启动/管理 Loop、执行生命周期、执行控制                                  | 决定下一步模型行为                     |
| Agent Loop              | 根据上下文和结果决定执行步骤与停止条件                                  | 组件装配、服务提供商生命周期管理       |
| Harness                 | 统一契约、Context、Extension、Governance、Execution Services 等横向支撑 | 强制充当每次调用的中间节点             |
| Runtime                 | 模型、工具、存储、资源、运行环境等实际能力                              | 决定全局 Agent 执行策略                |

### 2.1 Application

提供用户和开发者入口：CLI、SDK、HTTP API、Web UI。交互适配应当复用 Agent 核心能力，不复制业务执行逻辑。

### 2.2 Agent

负责 Session 管理、输入接收及 Execution 协调。目标模块包括 `AgentManager`、`SessionAgent`、`Inbox` 和 `ExecutionScheduler`。它们是职责模块，不要求一开始就是四个复杂服务。

### 2.3 Execution

保留 **Agent Loop（策略）与 Execution Engine（机制）分离**。Loop 决定下一步动作和终止；Engine 负责通用执行生命周期、控制与资源清理。默认 Basic Loop 属于后续 Phase 1.2，当前不实现。

### 2.4 Harness

提供 Contracts、Context Management、Extension System、Execution Services、Governance 等横向支撑，**不是第五条纵向业务调用链**。当前模型契约集中在 `src/harness/contracts/model/`；其他契约随真实能力落地，不建立巨型接口包。

### 2.5 Runtime

具体能力按领域划分，例如 Model、Tool、MCP、Skill、Memory、Event、Persistence、Approval、Workspace、Sandbox、Resource。**优先按单项能力替换**；不要求替换模型时重做全部 Runtime。`src/runtime/logging/` 已提供供应商无关的 Logger 门面。当前 `src/runtime/model/` 通过 Harness 的 ModelClient 契约提供 OpenAI-compatible Chat Completions，并复用 Logger 记录生命周期元数据，调用方可直接使用该实例。

### 2.6 Composition / Bootstrap

提供统一装配入口：解析配置、选择默认组件和自定义实现、连接依赖、初始化与释放。无需第一阶段就建立复杂 DI 容器、全生命周期插件管理或热更新系统。

## 3. 核心设计原则

1. **职责分层不等于严格调用分层**：不强制运行请求顺次经过所有层。
2. **策略与机制分离**：Agent Loop 与 Execution Engine 不混合职责。
3. **依赖契约而不是默认实现**：Loop 不直接依赖特定模型 Provider，Runtime 实现对应能力契约。
4. **默认能力与扩展能力平衡**：先提供可运行的默认 Agent，再按真实需求开放替换点。
5. **避免过度设计**：不建立万能 Runtime、过度复杂的抽象、全组件插件化。
6. **组件架构不等于文件夹模板**：有业务代码时才创建相应源码；不为未来能力批量占位。

## 4. 执行实体与控制模型（未来设计基线）

这些概念用于明确后续设计方向，**Phase 1.1 不实现相关类或状态机**。

| 概念      | 定位                               |
| --------- | ---------------------------------- |
| Session   | 持续交互上下文、执行记录和相关数据 |
| Execution | 一次完整执行生命周期               |
| Turn      | 一次 Agent 对输入的响应和处理      |
| Step      | Turn 内的逻辑执行步骤              |
| Attempt   | Step 的一次实际执行尝试            |

后续统一使用 Attempt 表示实际尝试，不把 Step 与 Retry 混在一起。

已确认的控制语义：

- **Follow-up**：进入 Inbox，后续创建新的 Execution；同一 Inbox Item 只关联一个创建的 Execution。
- **Steer**：针对正在执行的目标 Execution，在 Step 边界处理，不强制中断正在进行的模型请求和 Tool 调用。
- **Cancel**：与执行实体生命周期一致的取消控制。
- **Approval**：独立实体，通过引用关联 Step，审批通过不代表操作已成功执行。
- **Recovery**：基于已有事实核实和恢复，不改写已经发生的历史记录。

具体状态机、审批协议、事件事务边界等以后在相应模块开发时讨论，**不在 Phase 1.1 编写详细实现**。

## 5. Phase 1.1：当前工程目录与模型边界

Phase 0 已建立 Node.js 26.x / TypeScript / ESM 工程和六个一级职责模块的文档骨架。在既有 Runtime Logging 基础上，当前在 Harness 与 Runtime 中落地 Model System：

```text
easy-agent/
├── AGENTS.md / .cursor/rules/easy-agent.mdc
├── README.md
├── docs/
│   ├── AGENT.md / architecture.md / conventions.md
│   ├── phase-0.md                 # 已完成的工程基线与历史验收
│   ├── phase-1.1.md               # 当前 Model System 范围与验收
│   └── roadmap.md / changes.md
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.build.json
├── eslint.config.js / .prettierrc.json / .prettierignore
├── .gitignore / .nvmrc
├── src/
│   ├── index.ts                   # Logger 门面、公共模型契约和 Adapter 导出
│   ├── application/               # 仅 README.md / changes.md
│   ├── agent/                     # 仅 README.md / changes.md
│   ├── execution/                 # 仅 README.md / changes.md
│   ├── harness/
│   │   ├── README.md / changes.md
│   │   └── contracts/model/       # 公共契约、README.md / changes.md
│   ├── runtime/
│   │   ├── README.md / changes.md
│   │   ├── logging/               # 既有 Logger 门面、Pino 适配及就近文档
│   │   └── model/                 # Adapter、README.md / changes.md
│   └── composition/               # 仅 README.md / changes.md
└── tests/                         # ESM smoke、Logging、契约、Adapter、并发及日志集成
```

- `ModelClient.generate()` 返回完整响应，`stream()` 返回异步事件流。公共契约不依赖 OpenAI SDK，不引入 Session、Turn 或执行实体。
- `ModelRequest.parameters` 统一承载标准参数和扩展参数。Adapter 做协议映射、冲突校验及错误归一，不执行工具或维护消息历史。
- ModelClient 是可复用实例。只共享固定配置及 HTTP 能力；每次调用独立持有响应、文本/工具增量缓存、AbortController 与超时状态，不使用全局锁串行化请求。
- ModelClient 使用既有 Logger 门面，默认提供统一日志并支持构造时注入。生命周期日志只记录诊断元数据，日志不成为响应事件或消息历史，也不泄露模型消息、工具参数和认证配置。
- 模型取消与超时属于单次模型请求；不等同于 Agent Execution 的取消、排队或恢复。
- 当前允许直接创建 Adapter 进行调用，不实现完整 Composition/Bootstrap。后续 Loop 依赖 ModelClient 契约，由装配边界选择具体实现。
- `node_modules/` 和 `dist/` 为忽略的生成目录；私有单包结构、ESM 与工程工具链保持不变。没有 CLI 聊天、默认 Agent 或工具实际执行。
- 能力子模块随真实实现创建本地 README/changes，不为其他未来能力建立空目录或占位接口。

Logging 配置与安全规则见 [Runtime Logging](../src/runtime/logging/README.md)。具体模型协议和使用以 [Harness Model Contracts](../src/harness/contracts/model/README.md)、[Runtime Model](../src/runtime/model/README.md) 为准。

## 6. Phase 1.2 及后续：未来最小 Agent 的建议源码组织

以下是 **未来 Agent 闭环的建议源码组织，不是 Phase 1.1 的创建任务**。已有模型模块沿用上一节结构，其余路径随实际需求确认：

```text
 src/
 ├── index.ts
 ├── config/
 │   └── load-config.ts
 ├── composition/
 │   └── create-agent.ts
 ├── application/
 │   └── cli/
 │       └── main.ts
 ├── agent/
 │   ├── agent-manager.ts
 │   └── session-agent.ts
 ├── execution/
 │   ├── execution-engine.ts
 │   └── loops/
 │       └── basic-loop.ts
 ├── harness/
 │   └── contracts/
 │       ├── agent-loop.ts
 │       └── model/               # Phase 1.1 已有公共模型契约
 └── runtime/
     └── model/
         └── providers/          # Phase 1.1 已有 Adapter
```

此目录仅示意组件归属，并非所有文件都已经确定必须采用这些名称。测试按真实代码添加，不提前定义大批接口。

未来调用关系可概念性表示为：

```text
CLI ──► AgentManager / SessionAgent ──► Execution Engine
                                             │
                                             ▼
                                         Basic Loop
                                             │ ModelClient 契约
                                             ▼
                                   Runtime / Model Provider

Composition / Bootstrap：装配以上组件。
Harness：提供统一契约与横向支撑，而非强制转发。
```

### 后续扩展目录方向（Phase 2/3+）

```text
 src/
   application/http/             # HTTP / SSE
   application/sdk/              # SDK 入口
   agent/inbox/                  # Follow-up / Steer
   agent/scheduler/              # 排队与调度
   execution/recovery/           # 恢复
   harness/context/              # Context Management
   harness/extension/            # Extension System
   harness/governance/           # Governance
   runtime/tool/
   runtime/mcp/
   runtime/skill/
   runtime/memory/
   runtime/event/
   runtime/persistence/
   runtime/approval/
   runtime/workspace/
   runtime/sandbox/
   runtime/resource/
```

Persistence、Event、Extension、Governance 为跨模块能力或能力域，不需要额外提升为新的顶级产品层。

## 7. 代码依赖约束

当前模型实现与后续功能开发均遵循：

- `application/cli` 应依赖 Agent 公共入口，而不直接访问供应商模型 SDK。
- `agent` 协调 Execution，不把 Loop 的决策策略放进 SessionAgent。
- `execution/loops` 依赖 `ModelClient` 契约，不直接依赖具体 OpenAI-compatible 实现。
- `runtime/model` 实现能力契约，不反向依赖 CLI。
- `composition` 负责集中选择和装配默认实现，可依赖其装配所需的实现。
- 读取环境变量及密钥仅发生在明确的配置边界，核心 Loop 不读取环境配置。

**除当前已实现的模型契约与 Adapter 外，本章节不授权创建后续组件。**

## 8. 设计判断与后续更新

如果抽象没有当前使用者、明确契约需求或实际验证依据，优先不实现。如果必须调整已经确认的架构，应先说明为什么调整及影响，再确认方案。

现行架构文档只描述最新有效方案；每次实质性调整的背景、前后差异与时间线单独追加到 [changes.md](changes.md)。

## 9. 模块级文档与源码的组织关系

文档粒度优先采用**职责明确、可以单独开发和维护的模块**，不要求每个源文件都有文档，也不因为独立 npm package 尚未拆分就把所有说明集中到根目录。

- **一级模块**：`src/application`、`src/agent`、`src/execution`、`src/harness`、`src/runtime`、`src/composition` 均必须有自己的 `README.md` 与 `changes.md`，Phase 0 即交付。
- **独立子能力**：例如当前的 `src/runtime/model`、后续的 `src/application/cli`、`src/execution/loops`，若已形成独立职责与开发范围，随代码落地本地文档。普通工具代码、组织性目录不必另建两份文档。
- **独立 package**：如果未来真实拆分成 `packages/<name>`，模块文档跟随其 package 根目录；这是**位置变化**，不是必须先上 Monorepo 的理由。
- **文档权威性**：`docs/architecture.md` 管全局职责与依赖，模块 `README.md` 管当前模块实现，模块 `changes.md` 管本模块修改历史，`docs/changes.md` 管全局/跨模块历史。

在某模块实施任务前，Coding Agent 首先读取离该任务最近的模块说明和变更记录，再按需查阅父模块及直接依赖，不必每次把所有文档加载到上下文。
