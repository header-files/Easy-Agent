# Easy Agent

> 一个开箱即用、灵活可扩展的通用 Agent。

**项目状态：Phase 1（Phase 1.1～1.6）MVP 已完成，里程碑版本 `v0.1.0`，本地 CLI 可运行。**

Easy Agent 已完成 Phase 0 工程基线、统一 Logging 以及 Phase 1.1～1.6（Model、Tool、DefaultAgentLoop、DefaultExecutionEngine、Agent Management、统一 Application Service、Composition / Bootstrap 与本地 CLI），形成完整的模型—串行工具—模型闭环、内存多轮 Session、同 Session FIFO、跨 Session 并发、协作式取消与独立事件/结果观察。详细发布说明见 [v0.1.0 Release Notes](docs/releases/v0.1.0.md)。

2026-11-24 里程碑验收中，五项工程检查全部通过，**256 项离线测试通过、0 失败、0 跳过**（在 Phase 1.6 交付的 254 项基础上，含 2 项 Model Runtime `null` 占位兼容回归用例）；各子阶段的历史验收记录（76 / 109 / 146→151 / 187 / 216 / 254）保留于对应阶段文档，汇总见 [Phase 1 索引](docs/phase-1.md)。

**当前尚未实现的能力（留待 Phase 2+）**：HTTP Server / REST / SSE、远程 CLI、Web UI、正式 npm SDK 发布、Session Event Log JSONL 读写与持久化/重放/恢复、Transaction Journal、Event Bus、持久化 Inbox、Steer / Follow-up、Approval / HITL、MCP / Skill / Memory / 上下文压缩 / Workspace / Sandbox、工具并行执行，以及日志轮转与分布式 Tracing。本地 `npm link` 安装与真实在线模型烟测均不属于自动化验收前置条件。

## 产品定位

Easy Agent 首先是一个能够直接使用的 Agent 产品，同时为开发者提供灵活的组件定制与扩展能力。它面向两类用户：

- **普通用户**：可通过本地 CLI 使用默认 Agent，无需自行组装内部组件；HTTP API 与 Web UI 留待后续。
- **开发者**：未来可通过 SDK、配置和统一契约接入模型、工具、Skill，按需替换 Agent Loop 和具体 Runtime 能力，不必修改框架核心代码。

核心理念：

- **Easy to Use**：优先让默认 Agent 可直接运行，减少前置配置和工程工作。
- **Easy to Extend**：在提供默认实现的同时，支持按能力域扩展、定制和局部替换。

产品目标包括开箱即用、灵活定制、能力扩展、组件可替换和可靠运行。上述能力按阶段交付，不代表当前已全部实现。

## 使用方式与交付阶段

| 使用方式 | 目标能力                                         | 预计阶段         |
| -------- | ------------------------------------------------ | ---------------- |
| CLI      | 配置模型、多轮对话、流式输出、Session 切换与取消 | Phase 1.6 已完成 |
| SDK      | 开发者在应用中调用 Agent                         | Phase 2 逐步完善 |
| HTTP API | 远程交互及 SSE 流式输出                          | Phase 2          |
| Web UI   | 可视化交互                                       | 后续阶段         |

## 工程使用

开发环境使用 **Node.js 26.x LTS 与 npm**；`.nvmrc` 指定 Node.js 26，`package.json` 限定 `>=26.0.0 <27`。工程为单一私有 npm 包，采用 ESM；Logging 使用 Pino、Tool Schema 校验使用 Ajv 运行时依赖，工程工具保留为开发依赖。

使用锁文件安装并执行工程检查：

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

| 命令                             | 作用                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `npm run chat -- --model <name>` | 启动本地聊天，模型连接信息由统一配置边界读取                 |
| `npm run typecheck`              | 严格检查 `src/` 与 `tests/` 的 TypeScript 类型，不生成文件   |
| `npm run lint`                   | 使用 ESLint 检查 TypeScript 源码、测试与 JavaScript 工程配置 |
| `npm run format:check`           | 使用 Prettier 检查代码、配置与文档格式                       |
| `npm run format`                 | 使用 Prettier 修复格式                                       |
| `npm run build`                  | 仅将 `src/` 编译到 `dist/`，不输出测试文件                   |
| `npm test`                       | 自动先构建，再使用 Node.js 内置测试运行器执行全部离线测试    |

`src/index.ts` 导出 Logger/createLogger、Model/Tool 公共契约、OpenAICompatibleModelClient、DefaultToolRegistry/DefaultToolExecutor、两个 Model Bridge、AgentLoop/Execution/Agent 契约、DefaultAgentLoop、DefaultExecutionEngine、DefaultAgentManager、SessionEventBufferOverflowError、统一 AgentApplicationService、配置解析和 bootstrap。测试保留源码/构建入口 ESM smoke test，并覆盖 Logging、公共模型契约、Adapter 映射、流式工具组装、取消/超时、并发隔离、Tool Runtime、Model Bridge、Loop 闭环/事件/重试/清理、Engine 生命周期/取消/快照、Session FIFO/上下文/取消、观察流与独立结果、配置/装配/CLI、端到端模型工具闭环及日志安全。该私有包尚未作为 Agent SDK 发布。

安装依赖需要访问 npm 源；安装后，上述检查、构建和测试均不需要模型 API Key、网络模型服务或数据库。低层 ModelClient 仍通过构造参数接收 Provider 配置；本地应用在 Composition 配置边界读取 CLI/环境/显式 JSON 文件，不自动加载 `.env`。

Git 主分支为 `main`，远程 `origin` 为 `git@github.com:header-files/Easy-Agent.git`。工程版本与配置细则见 [工程规范](docs/conventions.md)。

## 本地 CLI

依赖安装后，在仓库根目录启动：

```bash
npm run chat -- --model your-model-id
# 或显式读取无密钥的示例配置；需将模型名/地址改为可用服务
npm run chat -- --config easy-agent.config.example.json
npm run chat -- --help
node src/application/cli/bin.ts --version
```

构建后的入口不需要 TypeScript 运行支持：

```bash
npm run build
node dist/application/cli/bin.js chat --model your-model-id
node dist/application/cli/bin.js --help
node dist/application/cli/bin.js --version
```

包的 `bin` 名称为 `easy-agent`；完成本地包链接后对应命令为 `easy-agent chat`。仓库直接运行方式为上述 npm/Node 命令，本次未将 `npm link` 作为安装或验收前置步骤。

API Key 使用 `OPENAI_API_KEY`，不提供密钥命令行选项。配置优先级为 **CLI 显式选项 > 环境变量 > 显式 JSON 文件 > 内置默认值**；不自动读取 `.env` 或查找用户配置文件。

| 配置                 | CLI 选项                      | 环境变量                       | 默认值                         |
| -------------------- | ----------------------------- | ------------------------------ | ------------------------------ |
| 模型名称             | `--model <name>`              | `EASY_AGENT_MODEL`             | 必填                           |
| Provider 地址        | `--base-url <url>`            | `EASY_AGENT_BASE_URL`          | Adapter 默认 OpenAI `/v1` 地址 |
| API Key              | —                             | `OPENAI_API_KEY`               | 可选，允许无认证本地服务       |
| 模型失败后的额外重试 | `--max-model-retries <count>` | `EASY_AGENT_MAX_MODEL_RETRIES` | `2`                            |
| 实时正文             | `--no-stream` 关闭            | `EASY_AGENT_STREAM`            | `true`                         |
| 日志级别             | —                             | `LOG_LEVEL`                    | `info`                         |
| JSON 配置路径        | `--config <path>`             | —                              | 不自动读取文件                 |

[示例配置](easy-agent.config.example.json) 使用无认证本地服务占位地址和示例模型名；[环境变量示例](.env.example) 仅供参考，不会自动加载。模型参数在 JSON 的 `model.parameters` 中设置。地址、凭据、非法重试次数等由统一配置入口安全校验；连接配置不放入多轮消息历史。

每轮输入等待独立最终结果后再处理下一行。`/new` 创建并切换到新的空 Session，旧 Session 仍留在当前进程；`/exit` 正常清理退出。执行期间 Ctrl+C 显式请求取消当前任务，等待实际终态后可继续输入；空闲时 Ctrl+C 退出。EOF 处理完已接收输入后清理。Session 仅在内存中，退出后不恢复。

正文只根据 `output_delta` 实时输出，不重复打印模型事件或工具结果。最终结果是权威答案；观察流异常仍等待最终结果，必要时补足或明确替换此前预览。失败会显示清晰错误，不透传原始堆栈/敏感配置；`--no-stream` 只显示最终答案。详细交互与限制见 [CLI README](src/application/cli/README.md)。

## 统一应用服务与装配

CLI 与未来 HTTP 适配器共用 `AgentApplicationService`。它委托现有 Manager/SessionAgent，不维护第二份队列、历史或事件缓存；Composition 负责统一配置、依赖装配和资源所有权。

```javascript
import { bootstrap, loadConfig } from './dist/index.js';

const config = await loadConfig({
  filePath: './easy-agent.config.example.json',
});
const app = await bootstrap(config);
try {
  const { sessionId } = app.service.createSession();
  const execution = app.service.submit(sessionId, '请计算 2 加 3');
  const result = await execution.result; // 不观察 events 也会执行
  if (result.status === 'COMPLETED') {
    process.stdout.write(`${result.loopResult.output ?? ''}\n`);
  }
} finally {
  await app.dispose();
}
```

默认装配复用已有模型、工具、Loop、Engine 和 Manager，注册无外部副作用的 `add({a,b})` 工具；多工具仍由既有 Loop 串行执行。可通过 `bootstrap(config, { modelClient: mock })` 注入离线模型，也可替换 Loop/Engine/Manager；外部共享依赖仍归调用方所有。自有模型工厂可返回 `{client, dispose?}`，由 Bootstrap 管理回滚与释放。

`dispose()` 幂等：先关闭提交入口，取消并等待经本应用 Service 提交的未结算任务，再逆序释放自有资源。取消/清理保持协作边界，不设置隐藏超时或假称任意底层副作用已停止。准确 API、配置和所有权见 [Application](src/application/README.md) 与 [Composition](src/composition/README.md)。

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

## ModelClient 使用

构建后可在 Node.js ESM 中导入组件。在调用方初始化边界读取配置；model 由每次请求指定，实例可以复用：

```javascript
import { createLogger, OpenAICompatibleModelClient } from './dist/index.js';

const logger = createLogger({ module: 'example' });
const client = new OpenAICompatibleModelClient({
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  baseURL: 'https://api.openai.com/v1',
  logger,
});

const request = {
  model: 'your-model-id',
  messages: [{ role: 'user', content: '你好' }],
  parameters: { temperature: 0.7, maxOutputTokens: 256, top_p: 0.9 },
};

const response = await client.generate(request, { timeoutMs: 30_000 });
process.stdout.write(`${response.message.content ?? ''}\n`);

for await (const event of client.stream(request, { timeoutMs: 30_000 })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'message_end') process.stdout.write('\n');
}
```

ModelClient 默认使用统一 Logger，也可以通过 `logger` 配置注入同一门面的自定义实现；运行日志走 stderr。生命周期日志仅记录诊断元数据，不记录消息、工具参数、请求/响应正文或认证配置。

示例中的模型标识需替换为目标 Provider 支持的值；真实调用需要相应服务配置。常规测试无需 API Key 或外部模型连接。

生成参数统一位于 `parameters`：maxOutputTokens 默认映射 max_completion_tokens，可通过实例配置 maxTokensField 选择 max_tokens；其他扩展字段保留原名和值。核心字段覆盖、重复 token 限制配置和已知不支持的能力会明确报错。

同一实例可并发调用 generate/stream；每个调用独立处理取消、超时、文本和工具增量。Tool Calling 只返回模型提出的调用数据，参数保留原始字符串；工具实际执行由独立 ToolExecutor 负责，模型—工具循环策略由 DefaultAgentLoop 负责。接口细则见 [模型公共契约](src/harness/contracts/model/README.md)，配置、错误、工具结果表示与兼容边界见 [Runtime Model](src/runtime/model/README.md)。

## Tool Runtime 使用

工具声明与函数分开注册；可复用 Registry/Executor 处理多个调用：

```javascript
import {
  DefaultToolRegistry,
  DefaultToolExecutor,
  toModelToolDefinition,
  toToolResultMessage,
} from './dist/index.js';

const registry = new DefaultToolRegistry();
registry.register(
  {
    name: 'greet',
    description: 'Return a greeting',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  (args) => ({ content: `Hello, ${args.name}` }),
);

const definitions = registry.list().map(toModelToolDefinition);
const executor = new DefaultToolExecutor(registry);
const result = await executor.execute({
  id: 'call_001',
  name: 'greet',
  argumentsJson: '{"name":"Easy Agent"}',
});
const message = toToolResultMessage(result);
```

Schema 校验不补默认值、不转换类型、不删除字段；失败时 Handler 不执行。业务错误返回 ToolResult，取消/超时抛出 ToolExecutionError。注销工具只影响后续查找，已开始调用继续使用其快照；Executor 不自动重试，也不承诺取消后回滚副作用。

`definitions` 和 `message` 可由后续调用方组织为模型数据，本示例不调用模型或实现 Loop。配置、Schema 支持、日志与并发边界见 [Runtime Tool](src/runtime/tool/README.md)，接口细则见 [Tool Contracts](src/harness/contracts/tool/README.md)。

## Agent Loop 使用

沿用前面创建的 client、registry 和 executor，默认策略通过依赖注入复用它们：

```javascript
import { DefaultAgentLoop } from './dist/index.js';

const loop = new DefaultAgentLoop(client, registry, executor);
const controller = new AbortController();
let finalResult;

for await (const event of loop.run({
  input: { content: '向 Easy Agent 问好' },
  context: { messages: [] },
  config: {
    model: { name: 'your-model-id' },
    tools: { allowedNames: ['greet'] },
    extensions: { defaultAgentLoop: { maxModelRetries: 2 } },
  },
  control: { signal: controller.signal },
})) {
  if (event.type === 'output_delta') process.stdout.write(event.content);
  if (event.type === 'loop_end') finalResult = event.result;
}
```

面向用户展示 output_delta，避免再次渲染 model_event 中同一文本。唯一最终结果来自 loop_end.result；finalResult.output 是权威最终文本，updatedContext 是完整已确认历史，中间展示增量不保证拼接等于最终答案。

AgentLoopContext 的 model 配置对自定义 Loop 可选；DefaultAgentLoop 运行时才要求有效模型名。默认只用 stream()，同一批工具严格串行；业务错误回填后继续，控制异常通过迭代抛出。模型额外重试默认 2，仅允许在当前尝试尚未公开模型/展示事件且错误明确可重试时发生；工具不重试。

没有总模型调用、工具调用或迭代次数上限，也没有默认全局超时；可配置单次模型/工具超时，通过 signal 取消运行。完整设计只以 [Phase 1.3 Agent Loop](docs/phase-1.3.md) 为准，具体使用、清理与错误边界见 [Execution Loops](src/execution/loops/README.md)。

## Execution Engine 使用

Engine 驱动任意 AgentLoop，不要求其内部使用模型或工具。以下沿用前面创建的 loop：

```javascript
import { DefaultExecutionEngine } from './dist/index.js';

const engine = new DefaultExecutionEngine();
const executionId = 'execution-example';
let finalExecutionResult;

for await (const event of engine.execute({
  executionId,
  loop,
  context: {
    input: { content: '向 Easy Agent 问好' },
    context: { messages: [] },
    config: { model: { name: 'your-model-id' } },
    control: { signal: new AbortController().signal },
  },
})) {
  if (event.type === 'loop_event' && event.event.type === 'output_delta') {
    process.stdout.write(event.event.content);
  }
  if (event.type === 'execution_end') finalExecutionResult = event.result;
}

const snapshot = engine.getSnapshot(executionId);
```

execute 是惰性、单次消费的事件流，Execution ID 由调用方分配。Engine 在合法 loop_end 之后继续确认自然 EOF：completed 映射 COMPLETED，stopped 映射 FAILED/loop_stopped；运行异常转成安全的 FAILED 结果。

`engine.cancel(id)` 返回 true 只表示取消请求已接受；清理前快照可以仍为 RUNNING。消费者 break/return 会取消本次执行，但不能保证该消费者收到 execution_end。清理只承诺公开 Loop 边界和 Engine 自有资源，不强制停止任意下游操作或回滚副作用。

终态快照有界保留，默认最多 1000 条，可通过 maxRetainedSnapshots 配置为 0；RUNNING 不会被淘汰。快照隔离 Engine 自有状态与可复制数据图，外部函数/闭包/有私有状态对象保留能力引用，其内部状态不承诺隔离。具体范围和选项见 [Execution Engine](src/execution/engine/README.md)。

ExecutionEvent 只是内存实时通知。Engine 组件不负责 Session 队列或调度，也不读写 Session Event Log；其既有规则以 [Phase 1.4](docs/phase-1.4.md) 为准。当前 Agent Management 按下一节所述在上层消费 Engine。

## Agent Management 使用

沿用前面创建的 engine 和 loop，Manager 返回 SessionAgent；调用方无需直接构造 Session 实现：

```javascript
import { DefaultAgentManager } from './dist/index.js';

const manager = new DefaultAgentManager(engine, loop, {
  eventBufferCapacity: 512,
});
const session = manager.createSession({
  config: {
    model: { name: 'your-model-id' },
    tools: { allowedNames: ['greet'] },
  },
});

const first = session.submit('向 Easy Agent 问好');
const second = session.submit('上一轮我们说了什么？', {
  config: { model: { parameters: { temperature: 0.2 } } },
});

// 不消费 events，两项也会按提交顺序执行并结算。
const [firstResult, secondResult] = await Promise.all([
  first.result,
  second.result,
]);
const context = session.getContext();
```

submit 同步入队，内部主动消费 Engine；同 Session FIFO、不同 Session 允许并发。任务实际开始时读取最新历史，仅成功且有完整 updatedContext 时替换已提交上下文。result 独立 resolve 标准 ExecutionResult；失败/取消不更新历史，排队取消不会调用 Engine 或伪造生命周期事件。

也可独立遍历句柄的 events 观察 Engine 原始事件。该流仅支持一个消费者和一次遍历；提前退出只停止观察。未消费事件超过 eventBufferCapacity（默认 512，正安全整数）时，观察流抛出 SessionEventBufferOverflowError 并停止缓存，执行、结果与后续队列仍继续。正常结束且未溢出时，缓存事件仍可晚读。要取消执行，调用 session.cancel(executionId)。

这一层观察流与直接消费 Engine 不同：直接退出 Engine 流会请求取消。Session 运行取消必须等协作收尾才放行下一项；不合作的依赖可能使任务持续活动，不设隐藏清理超时。Manager 只删除空闲 Session，删除后的旧 Session 引用拒绝 submit。

自定义 Loop 可以不配置模型；仅覆盖 model.parameters 时须有可继承或显式提供的模型名。配置合并、上下文隔离与 opaque 能力引用限制、ID 工厂及统一日志边界见 [Agent 模块](src/agent/README.md)，公共接口见 [Agent Contracts](src/harness/contracts/agent/README.md)。Agent 模块不读写 Session Event Log JSONL，不实现持久化、恢复、持久化 Inbox 或 Runtime 广播；其完整设计只在 [Phase 1.5](docs/phase-1.5.md) 维护。当前 Phase 1.6 在上层通过统一 Service 与 Bootstrap 复用这些能力。

## 当前目录

```text
easy-agent/
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.build.json
├── eslint.config.js / .prettierrc.json / .prettierignore
├── .gitignore / .nvmrc
├── AGENTS.md / .cursor/rules/easy-agent.mdc
├── README.md / docs/
├── src/
│   ├── index.ts
│   ├── application/               # 统一 AgentApplicationService
│   │   └── cli/                   # 本地交互、输出与可执行入口
│   ├── agent/                     # Session 管理、FIFO、上下文与观察流
│   ├── execution/
│   │   ├── loops/                 # 已有 DefaultAgentLoop
│   │   └── engine/                # DefaultExecutionEngine 与就近文档
│   ├── harness/contracts/
│   │   ├── model/                 # 公共模型契约与就近文档
│   │   ├── tool/                  # 公共工具契约与就近文档
│   │   ├── agent-loop/            # 通用 AgentLoop 契约与就近文档
│   │   ├── execution/             # Execution 契约与就近文档
│   │   └── agent/                 # Agent Management 契约与就近文档
│   ├── runtime/
│   │   ├── logging/               # Logger 门面、Pino 适配与就近文档
│   │   ├── model/                 # Chat Completions Adapter 与就近文档
│   │   └── tool/                  # Registry/Executor、Schema 校验和桥接
│   └── composition/               # 配置、Bootstrap、生命周期和安全演示工具
└── tests/                         # 工程与所有已实现能力的离线验证
```

六个一级模块均有 README/changes。安装目录 `node_modules/` 和构建输出 `dist/` 已忽略，不纳入版本控制；未来能力随实际开发创建。

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
- [Phase 0：已完成的工程基线与验收](docs/phase-0.md)
- [Runtime Logging：统一日志基础设施](src/runtime/logging/README.md)
- [Phase 1：MVP 阶段索引与整体验收（v0.1.0）](docs/phase-1.md)
- [Phase 1.1：已完成 Model System 与历史验收](docs/phase-1.1.md)
- [Phase 1.2：已完成 Tool Runtime 与历史验收](docs/phase-1.2.md)
- [Phase 1.3：已完成 Agent Loop 设计与历史验收](docs/phase-1.3.md)
- [Phase 1.4：Execution Engine 设计与历史验收](docs/phase-1.4.md)
- [Phase 1.5：已完成 Agent Management 与历史验收](docs/phase-1.5.md)
- [Phase 1.6：已完成 Application Service / Composition / CLI 验收](docs/phase-1.6.md)
- [v0.1.0 Release Notes](docs/releases/v0.1.0.md)
- [后续功能路线图](docs/roadmap.md)
- [项目级变更记录](docs/changes.md)
- 模块就近文档：[Application](src/application/README.md) · [Agent](src/agent/README.md) · [Execution](src/execution/README.md) · [Harness](src/harness/README.md) · [Runtime](src/runtime/README.md) · [Composition](src/composition/README.md)

**Phase 1（Phase 1.1～1.6）MVP `v0.1.0` 已收尾完成。** 后续 Phase 2（持久化、HTTP/SSE、SDK 等）需经明确授权后再启动，`docs/roadmap.md` 不作为自动接续开发清单。

## 文档维护原则

项目文档采用**项目级 + 模块级**分层：项目级文档规定全局架构和工程规范；每个一级职责模块在 `src/<module>/README.md` 描述当前有效定位与实现，在 `src/<module>/changes.md` 保存本模块的完整演进时间线。新建具有独立职责的子模块时，随代码建立对应文档；不按每个源文件机械建文档。

发生实质性变更时，更新受影响模块的现行说明并追加其变更记录；**影响全局架构、公共规范或多个模块的决策**另在 [`docs/changes.md`](docs/changes.md) 记录摘要和链接。历史只追加不覆盖，跨层日志避免复制相同全文。

项目主要通过 Codex 和 Cursor 进行开发，统一遵循仓库文档，不为不同工具复制互相冲突的规范。
