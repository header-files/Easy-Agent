# Easy Agent

> 一个开箱即用、灵活可扩展的通用 Agent。

**项目状态：Phase 0 工程基线已完成；当前补充 Logging 基础设施，尚未启用 Phase 1 业务开发。**

当前已建立 TypeScript / Node.js 工程、六个职责模块的文档骨架和基础离线验证；本次增加统一 Logger 门面与结构化日志能力，**尚不提供可对话的 Agent、模型调用或 CLI 交互**。工程历史验收见 [Phase 0](docs/phase-0.md)，当前范围见 [Coding Agent 工作说明](docs/AGENT.md)，日志接口与配置见 [Runtime Logging](src/runtime/logging/README.md)。

## 产品定位

Easy Agent 首先是一个能够直接使用的 Agent 产品，同时为开发者提供灵活的组件定制与扩展能力。它面向两类用户：

- **普通用户**：未来可通过 CLI、HTTP API 或 Web UI 使用默认 Agent，无需自行组装内部组件。
- **开发者**：未来可通过 SDK、配置和统一契约接入模型、工具、Skill，按需替换 Agent Loop 和具体 Runtime 能力，不必修改框架核心代码。

核心理念：

- **Easy to Use**：优先让默认 Agent 可直接运行，减少前置配置和工程工作。
- **Easy to Extend**：在提供默认实现的同时，支持按能力域扩展、定制和局部替换。

产品目标包括开箱即用、灵活定制、能力扩展、组件可替换和可靠运行。上述能力按阶段交付，不代表当前已全部实现。

## 使用方式与交付阶段

| 使用方式 | 目标能力                     | 预计阶段         |
| -------- | ---------------------------- | ---------------- |
| CLI      | 配置模型、连续输入、接收回复 | Phase 1          |
| SDK      | 开发者在应用中调用 Agent     | Phase 2 逐步完善 |
| HTTP API | 远程交互及 SSE 流式输出      | Phase 2          |
| Web UI   | 可视化交互                   | 后续阶段         |

## 当前阶段：仅面向开发的工程使用

开发环境使用 **Node.js 26.x LTS 与 npm**；`.nvmrc` 指定 Node.js 26，`package.json` 限定 `>=26.0.0 <27`。工程为单一私有 npm 包，采用 ESM；Logging 使用 Pino 运行时依赖，工程工具保留为开发依赖。

使用锁文件安装并执行工程检查：

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

| 命令                   | 作用                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `npm run typecheck`    | 严格检查 `src/` 与 `tests/` 的 TypeScript 类型，不生成文件   |
| `npm run lint`         | 使用 ESLint 检查 TypeScript 源码、测试与 JavaScript 工程配置 |
| `npm run format:check` | 使用 Prettier 检查代码、配置与文档格式                       |
| `npm run format`       | 使用 Prettier 修复格式                                       |
| `npm run build`        | 仅将 `src/` 编译到 `dist/`，不输出测试文件                   |
| `npm test`             | 自动先构建，再使用 Node.js 内置测试运行器执行全部离线测试    |

smoke test 验证源码入口的 ESM 导入和构建入口 `dist/index.js` 的原生 JavaScript 加载。Logging 测试覆盖真实日志输出、级别过滤、模块子日志、错误与敏感信息处理；这些验证不代表 Agent 业务已经实现。

安装依赖需要访问 npm 源；安装后，上述检查、构建和测试均不需要模型 API Key、网络模型服务或数据库。当前没有 `.env`、模型配置或 CLI 对话命令。

Git 主分支为 `main`，远程 `origin` 为 `git@github.com:header-files/Easy-Agent.git`。工程版本与配置细则见 [工程规范](docs/conventions.md)。

## Logging 使用

构建后可从统一入口使用 Logger；运行日志默认以 JSON 输出到 stderr：

```javascript
import { createLogger } from './dist/index.js';

const logger = createLogger({ module: 'application' });
logger.info('组件已初始化', { component: 'example' });

const workerLogger = logger.child('worker', { workerId: 'example' });
workerLogger.debug('准备处理任务');
```

通过 `LOG_LEVEL` 或显式初始化配置控制日志级别；配置优先级、结构化错误与敏感信息处理规则见 [Runtime Logging](src/runtime/logging/README.md)。当前没有文件轮转、远端日志服务或 trace 系统。

## 当前目录

```text
easy-agent/
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.build.json
├── eslint.config.js
├── .prettierrc.json / .prettierignore
├── .gitignore / .nvmrc
├── AGENTS.md / .cursor/rules/easy-agent.mdc
├── README.md / docs/
├── src/
│   ├── index.ts
│   ├── application/   # 除 Runtime Logging 外，职责模块目前均仅有文档
│   ├── agent/
│   ├── execution/
│   ├── harness/
│   ├── runtime/
│   │   └── logging/   # 统一 Logger、Pino 适配与就近 README/changes
│   └── composition/
└── tests/             # 工程 smoke 和 Logging 离线测试
```

安装目录 `node_modules/` 和构建输出 `dist/` 均由工具生成，已忽略，不纳入版本控制。未来能力的子目录随实际实现创建。

## 整体架构

采用 **四个核心运行职责层 + 横向 Harness + Composition / Bootstrap**：

1. **Application**：CLI、SDK、HTTP API、Web UI 等用户入口。
2. **Agent**：Session、用户输入和 Execution 的管理协调。
3. **Execution**：Execution Engine（执行机制）与 Agent Loop（执行策略）。
4. **Runtime**：Model、Tool、MCP、Skill、Memory、Event、Persistence 等能力域。
5. **Harness（横向）**：Contracts、Context、Extension、Governance、Execution Services。
6. **Composition / Bootstrap（装配）**：选择、连接、初始化实际组件。

以上是职责划分，不是强制逐层调用链。Harness 不作为每次运行的必经中间节点；Runtime 按能力域组织，优先支持单项能力替换。

## 项目文档导航

- [Coding Agent 统一入口](AGENTS.md)
- [Coding Agent 工作规范](docs/AGENT.md)
- [系统架构与目标目录结构](docs/architecture.md)
- [技术栈、代码与文档规范](docs/conventions.md)
- [Phase 0：已完成的工程基线与历史验收](docs/phase-0.md)
- [Runtime Logging：当前日志能力](src/runtime/logging/README.md)
- [后续功能路线图](docs/roadmap.md)
- [项目级变更记录](docs/changes.md)
- 模块就近文档：[Application](src/application/README.md) · [Agent](src/agent/README.md) · [Execution](src/execution/README.md) · [Harness](src/harness/README.md) · [Runtime](src/runtime/README.md) · [Composition](src/composition/README.md)

**当前只补充 Logging 基础设施，不自动进入 Phase 1。** 范围以 `docs/AGENT.md` 和 Logging 就近说明为准；`docs/phase-0.md` 保留工程基线，`docs/roadmap.md` 不是自动接续开发清单。

## 文档维护原则

项目文档采用**项目级 + 模块级**分层：项目级文档规定全局架构和工程规范；每个一级职责模块在 `src/<module>/README.md` 描述当前有效定位与实现，在 `src/<module>/changes.md` 保存本模块的完整演进时间线。新建具有独立职责的子模块时，随代码建立对应文档；不按每个源文件机械建文档。

发生实质性变更时，更新受影响模块的现行说明并追加其变更记录；**影响全局架构、公共规范或多个模块的决策**另在 [`docs/changes.md`](docs/changes.md) 记录摘要和链接。历史只追加不覆盖，跨层日志避免复制相同全文。

项目主要通过 Codex 和 Cursor 进行开发，统一遵循仓库文档，不为不同工具复制互相冲突的规范。
