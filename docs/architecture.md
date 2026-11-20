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

**当前 Phase 0 只建立工程和目录骨架，图示业务组件均不要求有实际实现。**

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

保留 **Agent Loop（策略）与 Execution Engine（机制）分离**。Loop 决定下一步动作和终止；Engine 负责通用执行生命周期、控制与资源清理。默认 Basic Loop 属于后续 Phase 1。

### 2.4 Harness

提供 Contracts、Context Management、Extension System、Execution Services、Governance 等横向支撑，**不是第五条纵向业务调用链**。契约可以在 Harness 中组织，也可随能力域放置，不强制一个巨型接口包。

### 2.5 Runtime

具体能力按领域划分，例如 Model、Tool、MCP、Skill、Memory、Event、Persistence、Approval、Workspace、Sandbox、Resource。**优先按单项能力替换**；不要求替换模型时重做全部 Runtime。

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

这些概念用于明确后续设计方向，**Phase 0 不实现相关类或状态机**。

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

具体状态机、审批协议、事件事务边界等以后在相应模块开发时讨论，**不在 Phase 0 编写详细实现**。

## 5. Phase 0：当前工程目录

Phase 0 建立 Node.js 26.x / TypeScript / ESM 工程和六个一级职责模块的文档骨架。当前交付结构：

```text
 easy-agent/
 ├── README.md                     # 产品介绍、当前支持情况
 ├── AGENTS.md                     # Codex 等 Coding Agent 规则入口
 ├── .cursor/
 │   └── rules/
 │       └── easy-agent.mdc        # Cursor 引导规则
 ├── docs/
 │   ├── AGENT.md                   # Coding Agent 总指引
 │   ├── architecture.md            # 当前架构及目标目录（本文）
 │   ├── conventions.md             # 技术栈、工程与文档规范
 │   ├── phase-0.md                 # 当前任务范围与验收
 │   ├── phase-1.md                 # 后续最小 Agent 计划
 │   ├── roadmap.md                 # 后续能力规划
 │   └── changes.md                 # 变更历史、原因与时间线
 ├── package.json
 ├── package-lock.json
 ├── tsconfig.json                  # src 与 tests 的统一严格类型检查
 ├── tsconfig.build.json            # 只编译 src 到 dist
 ├── eslint.config.js
 ├── .prettierrc.json
 ├── .prettierignore
 ├── .gitignore
 ├── .nvmrc                         # Node.js 26
 ├── src/
 │   ├── index.ts                   # 最小编译入口，仅 export {}，无业务逻辑
 │   ├── application/              # 用户入口职责模块：仅文档
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── agent/                    # 会话/任务职责模块：仅文档
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── execution/                # 执行机制/策略职责模块：仅文档
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── harness/                  # 横向契约/支撑模块：仅文档
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── runtime/                  # 能力域运行时模块：仅文档
 │   │   ├── README.md
 │   │   └── changes.md
 │   └── composition/              # 组件装配模块：仅文档
 │       ├── README.md
 │       └── changes.md
 └── tests/
     └── smoke.test.ts              # 验证源码 ESM 导入与构建输出的 Node.js 加载
```

说明：

- 此树描述当前工程；`node_modules/` 和 `dist/` 为忽略的生成目录，不是新增业务模块。工具链细则见 [工程规范](conventions.md)。
- **本阶段不需要 ModelClient、Basic Loop、AgentManager 等源码，也不要求有可运行的 Agent。**
- 六个一级职责模块目录在 Phase 0 **实际创建且包含有效的 `README.md` 和 `changes.md`**；这是为了支持 Coding Agent 单模块开发，并非空占位源码。
- 更深一层的能力子模块（如 `src/runtime/model/`）仍遵循按需落地原则：真正开始实现时，**随代码一同创建本地 README 与 changes**，不为所有未来能力提前建立空目录或空 TypeScript 接口。
- `.env.example`、模型配置与 CLI 聊天命令随 Phase 1 实际实现再添加。
- 只有 `src/index.ts` 和最小 smoke test 并不意味着 Agent 核心已经完成；README 必须准确标明状态。

## 6. Phase 1：未来最小 Agent 的建议源码组织

以下是 **Phase 1 业务源码计划结构（一级模块 README/changes 在 Phase 0 已建立），不是 Phase 0 的业务创建任务**：

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
 │       └── model-client.ts
 └── runtime/
     └── model/
         └── openai-compatible.ts
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

## 7. 未来实现中的代码依赖约束

当 Phase 1 真正开始后：

- `application/cli` 应依赖 Agent 公共入口，而不直接访问供应商模型 SDK。
- `agent` 协调 Execution，不把 Loop 的决策策略放进 SessionAgent。
- `execution/loops` 依赖 `ModelClient` 契约，不直接依赖具体 OpenAI-compatible 实现。
- `runtime/model` 实现能力契约，不反向依赖 CLI。
- `composition` 负责集中选择和装配默认实现，可依赖其装配所需的实现。
- 读取环境变量及密钥仅发生在明确的配置边界，核心 Loop 不读取环境配置。

**本章节是后续开发的约束，不要求 Phase 0 写这些依赖的代码。**

## 8. 设计判断与后续更新

如果抽象没有当前使用者、明确契约需求或实际验证依据，优先不实现。如果必须调整已经确认的架构，应先说明为什么调整及影响，再确认方案。

现行架构文档只描述最新有效方案；每次实质性调整的背景、前后差异与时间线单独追加到 [changes.md](changes.md)。

## 9. 模块级文档与源码的组织关系

文档粒度优先采用**职责明确、可以单独开发和维护的模块**，不要求每个源文件都有文档，也不因为独立 npm package 尚未拆分就把所有说明集中到根目录。

- **一级模块**：`src/application`、`src/agent`、`src/execution`、`src/harness`、`src/runtime`、`src/composition` 均必须有自己的 `README.md` 与 `changes.md`，Phase 0 即交付。
- **独立子能力**：例如未来的 `src/runtime/model`、`src/application/cli`、`src/execution/loops`，若已形成独立职责与开发范围，随代码落地本地文档。普通工具代码、组织性目录不必另建两份文档。
- **独立 package**：如果未来真实拆分成 `packages/<name>`，模块文档跟随其 package 根目录；这是**位置变化**，不是必须先上 Monorepo 的理由。
- **文档权威性**：`docs/architecture.md` 管全局职责与依赖，模块 `README.md` 管当前模块实现，模块 `changes.md` 管本模块修改历史，`docs/changes.md` 管全局/跨模块历史。

在某模块实施任务前，Coding Agent 首先读取离该任务最近的模块说明和变更记录，再按需查阅父模块及直接依赖，不必每次把所有文档加载到上下文。
