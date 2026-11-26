# Application — 应用接入层

> 模块级现行说明。只描述本模块的职责、现状、约束与相关计划；全局架构请见 [`docs/architecture.md`](../../docs/architecture.md)。

## 模块定位

向用户和开发者提供 CLI、SDK、HTTP API、Web UI 等入口，并将输入、输出和执行事件适配为各入口需要的形式。

## 负责的内容

- 用户输入、执行控制指令的接收和对外呈现
- 入口协议与用户体验适配（CLI、HTTP 等）
- 在不同入口复用同一套 Agent 核心能力

## 不负责的内容

- 自行决定模型调用、工具调用或任务执行策略
- 复制 Agent 层的任务协调与 Execution 的执行逻辑

## 当前实现状态

Phase 1.6 已实现统一的 `AgentApplicationService`、默认轻量实现及本地 CLI；Phase 2.1 增加已注册模型目录与 Session 模型切换；Phase 2.2 增加 Workspace CRUD/状态/recover、审批 list/decide/订阅，以及创建 Session 时绑定 Workspace；Phase 2.4 可选 PersistenceBridge：Workspace 注册/删除/恢复走 Registry 事务，`recoverWorkspace` / `removeWorkspace` 为 async；`recoverWorkspace` 在本进程仍有 live Terminal 活动时拒绝，不得提前覆盖未结束 intent。CLI 通过 Composition 获取同一个 Service 门面；HTTP、SDK 和 Web UI 尚未实现。

公共入口为 [`index.ts`](index.ts)：

- [`agent-application-service.ts`](agent-application-service.ts)：Service 契约、只读 `SessionInfo`、模型列表/切换与稳定应用错误。
- [`default-agent-application-service.ts`](default-agent-application-service.ts)：依赖 Harness `AgentManager` / `SessionAgent` 与只读 `ModelCatalog`，不创建 Model/Tool/Loop/Engine。
- [`cli/index.ts`](cli/index.ts)：可注入 IO、信号、配置加载和 Bootstrap 的 `runCli`；[`cli/bin.ts`](cli/bin.ts) 是无导入执行副作用的命令入口。完整交互与输出规则见 [CLI README](cli/README.md)。

```typescript
import { DefaultAgentApplicationService } from './src/application/index.ts';

// manager / modelCatalog 由 Composition 创建；service 本身不创建 Model/Tool/Loop/Engine。
const service = new DefaultAgentApplicationService(manager, {
  modelCatalog,
  defaultSessionOptions: {
    config: {
      model: { name: 'local/example-model' },
      extensions: { defaultAgentLoop: { maxModelRetries: 2 } },
    },
  },
});
const { sessionId } = await service.createSession();
service.listModels();
await service.setSessionModel(sessionId, 'local/example-model');
const execution = service.submit(sessionId, '你好');
const result = await execution.result;
// execution.events 可独立观察；不观察也会由 Agent 内部执行。
```

`createSession()` 只返回冻结的身份对象，不向传输适配器暴露 SessionAgent。`submit()` 原样返回 SessionExecution，不存储第二份上下文、队列、事件缓存或执行状态。输入必须为非空白字符串；这一限制属于交互入口，不改变自定义 Loop 可以通过底层 Session 提交空串的契约。启用 Persistence 时，`listSessionExecutions` / `getExecution` 从 Projection 查询历史 Execution；CLI 可用 `/sessions`、`/session <id>`、`/executions` 继续已恢复会话。

构造必须提供 `modelCatalog`。`defaultSessionOptions` 由 Bootstrap 持有，服务生命周期内不应变更。创建 Session 时，显式 loop/context 覆盖默认值；模型名覆盖、模型参数按键合并、工具 `allowedNames` 整组替换（包括 `[]`）、extensions 按命名空间整体替换，不做递归深合并。默认模型、创建覆盖与 Execution 覆盖均需已注册；无效切换在改写 Session 前拒绝。最终合法性和 Session 快照仍由 Manager 负责；每轮覆盖直接交给既有 Session.submit 处理，由 Session 在提交时固化。

`AgentApplicationError.code` 是应用层稳定分类：`invalid_input`、`session_not_found`、`operation_failed`、`application_disposed`（供 Bootstrap 生命周期包装使用）。消息固定，不拼接输入、配置或底层异常，也不附带原始 cause。查询不存在 Session 时不自动创建；提交、取消和删除均明确报错。忙碌删除仍返回 `false`；未知、其他 Session 或已经结算的 executionId 取消返回 `false`。取消 `true` 只是请求受理，实际终态仍以 result 为准。

Service 无终端、HTTP、环境读取或资源释放逻辑。应用关闭及资源所有权由 Composition 管理；单独实例化的默认 Service 不自行维护 disposed 状态。

## 本地 CLI

```bash
npm run chat -- --config easy-agent.config.example.json
node src/application/cli/bin.ts --help
npm run build
node dist/application/cli/bin.js chat --config easy-agent.config.example.json
```

CLI 支持多轮输入、`/model` 查看与切换模型、`/workspace status|list|recover`、`/new` 新建并切换 Session、`/exit` 顺序退出，以及 Ctrl+C 显式取消当前 Execution。启动时展示 OS 与默认 Shell。写工具/Terminal 审批通过同一输入通道（`ask`）完成，避免嵌套 readline。每轮等待独立最终结果后处理下一条输入，保留管道多行和 EOF；不复制 Agent FIFO。观察流失败不会取消执行，结果完成前不会释放应用。

仅打印 `output_delta` 作为实时正文，模型原始 text_delta 不重印；模型工具往返按 message_start 划分预览，最终回答一致时不重复打印、缺少后缀时补足。非一致最终结果明确标为替换预览。配置统一由 [Composition](../composition/README.md) 解析，Provider 密钥不进入 Session config 或错误输出。

## 验证

`node --test tests/agent-application-service.test.ts` 覆盖共享非 CLI 调用、句柄透传、FIFO 与最新上下文、跨 Session 取消隔离、忙碌删除、应用错误安全、默认配置覆盖及模型优先级/固化。使用 Fake Manager 和真实 DefaultAgentManager/DefaultExecutionEngine 的离线协作；无网络或密钥依赖。

`node --test tests/cli.test.ts` 覆盖参数映射、帮助/版本、`/model`、顺序输入、新 Session、实时输出与模型往返去重、权威结果补足、观察错误、最终结果拒绝、Ctrl+C、初始化退出和清理。

`node --test tests/phase-2.2-application.test.ts` 覆盖 Workspace 绑定、写文件批准/拒绝与 CLI `/workspace` + 审批交互。完整工程与端到端实测见 [Phase 2.2](../../docs/phase-2.2.md)。

## 后续实现范围

HTTP API、SDK、SSE、Web UI 不属于本阶段，后续需单独授权。Session Event Log、Transaction Journal 与冷启动恢复已在 [Phase 2.4](../../docs/phase-2.4.md) 落地（配置 `persistence.dataDir`）。

## 协作与边界

通过 Agent 公共契约协调任务，订阅或接收执行结果；不直接绑定具体 Provider SDK。Agent 层负责 FIFO 和上下文提交；启用 Persistence 时另有 Session Event Log 事实。ExecutionEvent 仍为内存实时通知；观察中断不代表执行取消。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。当前阶段依据见 [`docs/phase-2.4.md`](../../docs/phase-2.4.md)；Phase 2.3 HTTP/SSE 仍暂缓；未获明确授权不进入下一阶段。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-2.4.md)
- [本模块变更时间线](changes.md)
