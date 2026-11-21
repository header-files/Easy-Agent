# Tool Contracts — 工具注册与执行公共契约

## 定位与当前状态

**Phase 1.2 已实现工具公共契约。** 本模块定义可替换的本地 TypeScript 工具调用接口，由 Runtime 提供具体注册、参数校验和执行实现；不依赖 Provider SDK、Agent Loop、具体工具或日志后端。

公共入口为 [`index.ts`](index.ts)。Phase 1.1 的 [Model Contracts](../model/README.md) 保持不变；工具执行与模型访问是独立能力，不在本模块形成模型—工具—模型循环。

## 五组核心契约

| 契约与文件                         | 字段及行为                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`ToolSpec`](tool-spec.ts)         | name、description、parameters；仅工具元数据和对象型 JSON Schema，不包含执行函数或 MCP/Skill/Sandbox 来源字段 |
| [`ToolHandler`](tool-handler.ts)   | 函数，接收已解析并通过 Schema 校验的对象与 ToolExecutionContext，同步或异步返回 `{ content: string }`        |
| [`ToolRegistry`](tool-registry.ts) | register、unregister、get、list；RegisteredTool 包含 spec 与 handler                                         |
| [`ToolExecutor`](tool-executor.ts) | 可复用组件，execute(call, options?) 返回 Promise<ToolResult>；ToolCall 包含 id、name、argumentsJson          |
| [`ToolResult`](tool-result.ts)     | 通过 status 区分 success/error；两者都保留 toolCallId、name、content，error 分支额外包含 ToolErrorInfo       |

ToolExecutionContext 包含当前 `toolCallId` 与有效 `AbortSignal`；每次调用都有自己的上下文。ToolExecutionOptions 包含可选 signal 与 timeoutMs，用于执行控制，不属于工具业务参数。

## 注册与执行约定

Registry 注册时校验声明与 Schema，重复名称必须明确报错，不能静默覆盖。注册参数、get 和 list 返回的声明不应允许外部修改影响内部状态。执行器获取注册信息后保留该次执行所需的稳定引用，随后 unregister 不得中断在途调用；注销之后的新调用不能继续取得该工具。

Executor 负责查找工具、解析 argumentsJson、Schema 校验、创建上下文、调用 Handler 和转换结果。校验遵循严格输入语义：不补默认值、不转换类型、不删除字段；是否接受额外字段由工具 Schema 决定。解析结果必须是符合声明的参数对象，校验失败不得调用 Handler。

Handler 不负责注册、参数校验或错误映射，只提供实际工具函数。输出当前仅支持文本 content；不提前加入多模态或工具调度接口。注册无效输入或重复名称的具体异常实现属于 Runtime，本契约不额外定义注册错误类。

## 业务错误与执行控制

普通失败返回 `status: 'error'` 的 ToolResult，并包含可理解的 content 与 error.message：

| ToolErrorCode     | 语义                            |
| ----------------- | ------------------------------- |
| tool_not_found    | 找不到当前工具                  |
| invalid_arguments | 调用参数无法解析或不满足 Schema |
| execution_failed  | Handler 的业务执行失败          |

取消与超时通过 [`ToolExecutionError`](tool-execution-error.ts) 异常传播，构造方式为 `new ToolExecutionError(code, message)`，code 仅为 aborted 或 timeout。它们不是普通 ToolResult，不伪装为工具业务错误。构造器使用显式 readonly code 字段赋值，保持与 Node.js 原生 TypeScript 擦除及工程 `erasableSyntaxOnly` 兼容。

AbortSignal 是协作式取消：执行器应及时停止调用方等待并尽可能通知 Handler，但不能保证不合作的 Handler 立即停止，也不能宣称已回滚副作用。每次调用独立管理取消、超时和清理；不自动重试。

## 实例复用与并发

Registry 与 Executor 是可复用组件。一个 Executor 必须支持同工具或不同工具的自然并发，不通过全局锁强制串行，也不在实例上保存当前调用的可变参数、结果或取消状态。一个请求取消或失败不影响其他请求。

Executor 的并发隔离不等于任意 Handler 自动线程安全；Handler 访问共享资源时自行遵守并发约束。工具执行控制不承担 Session 调度、全局并发队列、资源锁、自动重试或事务补偿。

## 与 Model System 的关系

ToolCall 与 ModelToolCall 的字段一致，ModelToolCall 可以直接传入 ToolExecutor，不修改或重新定义模型契约。Runtime 的轻量桥接将 ToolSpec 转换为既有 ModelToolDefinition，将 ToolResult 转换为 ToolResultMessage；失败结果通过 isError 保留语义。

这些转换不调用 ModelClient，也不负责决定何时执行工具。只有后续 Agent Loop 才组织完整循环。Runtime 实现与配置见 [Tool Runtime](../../../runtime/tool/README.md)。

## 使用示例

```typescript
import type {
  ToolExecutor,
  ToolHandler,
  ToolRegistry,
  ToolSpec,
} from './src/harness/contracts/tool/index.ts';

const spec: ToolSpec = {
  name: 'echo',
  description: 'Return the supplied text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

const handler: ToolHandler = (args, context) => ({
  content: `${context.toolCallId}: ${String(args.text)}`,
});

function registerEcho(registry: ToolRegistry): void {
  registry.register(spec, handler);
}

async function invokeEcho(executor: ToolExecutor) {
  return executor.execute({
    id: 'call_echo',
    name: 'echo',
    argumentsJson: '{"text":"hello"}',
  });
}
```

Registry 与 Executor 的实际实例由调用方创建并注入；Harness 不提供占位执行实现。

## 验证与非目标

`tests/tool-contracts.test.ts` 验证模型调用结构兼容、同步/异步 Handler、Registry 方法形态、结果联合收窄、类/对象 Executor 替换以及 ToolExecutionError。公共契约基础验证先于 Runtime 开发完成：

```bash
npm run typecheck
node --test tests/tool-contracts.test.ts
```

不实现 Agent Loop、Execution Engine、Session、CLI、MCP、Skill、Sandbox、Approval、持久化、复杂调度或完整插件框架。完成 Phase 1.2 后不自动进入 Phase 1.3。

相关资料：[Harness](../../README.md)、[阶段范围](../../../../docs/phase-1.2.md)、[架构](../../../../docs/architecture.md)、[本模块变更记录](changes.md)。
