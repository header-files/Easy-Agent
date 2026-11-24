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

Phase 1.6 已实现统一的 `AgentApplicationService`、默认轻量实现及本地 CLI。CLI 通过 Composition 获取同一个 Service 门面；HTTP、SDK 和 Web UI 尚未实现。

公共入口为 [`index.ts`](index.ts)：

- [`agent-application-service.ts`](agent-application-service.ts)：Service 契约、只读 `SessionInfo` 与稳定应用错误。
- [`default-agent-application-service.ts`](default-agent-application-service.ts)：仅依赖 Harness `AgentManager` / `SessionAgent` 公共能力，不依赖模型、工具或默认执行策略。
- [`cli/index.ts`](cli/index.ts)：可注入 IO、信号、配置加载和 Bootstrap 的 `runCli`；[`cli/bin.ts`](cli/bin.ts) 是无导入执行副作用的命令入口。完整交互与输出规则见 [CLI README](cli/README.md)。

```typescript
import { DefaultAgentApplicationService } from './src/application/index.ts';

// manager 由 Composition 创建；service 本身不创建 Model/Tool/Loop/Engine。
const service = new DefaultAgentApplicationService(manager, {
  defaultSessionOptions: {
    config: {
      model: { name: 'example-model' },
      extensions: { defaultAgentLoop: { maxModelRetries: 2 } },
    },
  },
});
const { sessionId } = service.createSession();
const execution = service.submit(sessionId, '你好');
const result = await execution.result;
// execution.events 可独立观察；不观察也会由 Agent 内部执行。
```

`createSession()` 只返回冻结的身份对象，不向传输适配器暴露 SessionAgent。`submit()` 原样返回 SessionExecution，不存储第二份上下文、队列、事件缓存或执行状态。输入必须为非空白字符串；这一限制属于交互入口，不改变自定义 Loop 可以通过底层 Session 提交空串的契约。

构造选项 `defaultSessionOptions` 由 Bootstrap 持有，服务生命周期内不应变更。创建 Session 时，显式 loop/context 覆盖默认值；模型名覆盖、模型参数按键合并、工具 `allowedNames` 整组替换（包括 `[]`）、extensions 按命名空间整体替换，不做递归深合并。最终合法性和 Session 快照仍由 Manager 负责；每轮覆盖直接交给既有 Session.submit 处理。

`AgentApplicationError.code` 是应用层稳定分类：`invalid_input`、`session_not_found`、`operation_failed`、`application_disposed`（供 Bootstrap 生命周期包装使用）。消息固定，不拼接输入、配置或底层异常，也不附带原始 cause。查询不存在 Session 时不自动创建；提交、取消和删除均明确报错。忙碌删除仍返回 `false`；未知、其他 Session 或已经结算的 executionId 取消返回 `false`。取消 `true` 只是请求受理，实际终态仍以 result 为准。

Service 无终端、HTTP、环境读取或资源释放逻辑。应用关闭及资源所有权由 Composition 管理；单独实例化的默认 Service 不自行维护 disposed 状态。

## 本地 CLI

```bash
npm run chat -- --model example-model
node src/application/cli/bin.ts --help
npm run build
node dist/application/cli/bin.js chat --model example-model
```

CLI 支持多轮输入、`/new` 新建并切换 Session、`/exit` 顺序退出，以及 Ctrl+C 显式取消当前 Execution。每轮等待独立最终结果后处理下一条输入，保留管道多行和 EOF；不复制 Agent FIFO。观察流失败不会取消执行，结果完成前不会释放应用。

仅打印 `output_delta` 作为实时正文，模型原始 text_delta 不重印；模型工具往返按 message_start 划分预览，最终回答一致时不重复打印、缺少后缀时补足。非一致最终结果明确标为替换预览。配置统一由 [Composition](../composition/README.md) 解析，Provider 密钥不进入 Session config 或错误输出。

## 验证

`node --test tests/agent-application-service.test.ts` 覆盖共享非 CLI 调用、句柄透传、FIFO 与最新上下文、跨 Session 取消隔离、忙碌删除、应用错误安全及默认配置覆盖。使用 Fake Manager 和真实 DefaultAgentManager/DefaultExecutionEngine 的离线协作；无模型、工具、网络或密钥依赖。

`node --test tests/cli.test.ts` 的 12 项 CLI 测试覆盖参数映射、帮助/版本、顺序输入、新 Session、实时输出与模型往返去重、权威结果补足、观察错误、最终结果拒绝、Ctrl+C、初始化退出和清理。完整工程与端到端实测见 [Phase 1.6](../../docs/phase-1.6.md)。

## 后续实现范围

HTTP API、SDK、SSE、Web UI、Session Event Log 与持久化恢复不属于本阶段，后续需单独授权。

## 协作与边界

通过 Agent 公共契约协调任务，订阅或接收执行结果；不直接绑定具体 Provider SDK。Agent 层负责 FIFO 和上下文提交，ExecutionEvent 仍为内存通知，不是持久化事实；观察中断不代表执行取消。

## Coding Agent 开发须知

1. 开发前先阅读仓库根目录 `AGENTS.md`、[`docs/AGENT.md`](../../docs/AGENT.md)、本文件及本目录 [`changes.md`](changes.md)，并按需查阅相邻模块说明。
2. 仅在用户授权的阶段实现功能。本阶段以 [`docs/phase-1.6.md`](../../docs/phase-1.6.md) 为唯一阶段依据，按 A→B→C→D→E 实施，不实现 HTTP 或持久化恢复。
3. 功能落地时，更新本文件的真实实现状态、入口/关键文件、使用及测试方式；不猜测未来接口签名。
4. 本模块发生实质性设计或实现变化时，先更新本文件，再追加本目录 `changes.md`；跨模块/全局变化同时更新受影响模块及 [`docs/changes.md`](../../docs/changes.md)（如涉及全局决策）。

## 相关资料

- [全局架构](../../docs/architecture.md)
- [工程与文档规范](../../docs/conventions.md)
- [当前阶段范围](../../docs/phase-1.6.md)
- [本模块变更时间线](changes.md)
