# Easy Agent — Phase 1.3 Agent Loop 技术方案与 Coding Agent 开发任务书

> **阶段：Phase 1.3**  
> **前置依赖：Phase 1.1 Model System、Phase 1.2 Tool Runtime**  
> **性质：本阶段唯一有效的设计与开发依据；实际代码中已确认的 Phase 1.1/1.2 公共契约仍是其自身的权威定义。**

## 一、开发目标与边界

Phase 1.3 在 Harness 中定义与具体算法无关的 `AgentLoop` 公共契约，在 Execution 中实现官方默认策略 `DefaultAgentLoop`，形成完整的 **模型流式调用 → 工具调用 → 工具结果回填 → 再次调用模型 → 终止** 闭环。Loop 对外实时输出事件，正常结束时返回最终答案及更新后的上下文。

- **Harness**：定义 `AgentLoopContext`、`AgentLoopEvent`、`AgentLoopResult`、`AgentLoop` 的公共协议。
- **Execution / DefaultAgentLoop**：实现默认循环策略。第三方 Loop 只需实现 Harness 契约，**无须继承、组合或复用** `DefaultAgentLoop`。
- **Runtime / Model**：通过 Phase 1.1 `ModelClient.stream()` 提供模型流式输出和完整 `ModelResponse`；其 `generate()` 能力保持原状，但默认 Loop 不使用。
- **Runtime / Tool**：通过 Phase 1.2 `ToolRegistry`、`ToolExecutor` 提供工具定义和实际执行。
- **Execution Engine（Phase 1.4）**：未来负责 Execution 生命周期、状态、控制以及把 Loop 事件转成上层执行事件；本阶段不实现。

**本阶段不实现** Execution Engine、Session/Execution 调度、Event Bus/SSE、Steer/Follow-up、审批、Recovery、MCP、Skill、工具并行执行或持久化。**不修改 Phase 1.1 与 Phase 1.2 的既有公共契约**，除非发现确实无法接入的阻断问题，先报告差异和最小调整建议。

明确废弃旧版草案中的 `BasicLoop`、`mode: generate | stream`、`loop_result` 独立事件、`requires_tools` 常规终止结果、`maxModelCalls`、`maxToolCalls`、`maxIterations` 及“单次模型调用即结束 Loop”设计。

## 二、架构与依赖

```text
                 Execution Engine（后续）
                        │ run(context)
                        ▼
              Harness AgentLoop 契约
                        ▲
                        │ implements
             Execution / DefaultAgentLoop
                   │              │
                   ▼              ▼
           Harness ModelClient  Harness ToolRegistry/ToolExecutor
                   ▲              ▲
                   │              │
             Runtime Model    Runtime Tool
```

Harness 是横向契约体系，**不是**每次请求必须经过的运行时中转节点。默认 Loop 通过构造函数或工厂注入可复用依赖，不创建 Provider 或 Tool Runtime 实例。`DefaultAgentLoop` 实例可复用；所有可变运行状态只存在于单次 `run()` 内。

## 三、Harness 公共契约（Phase 1.3-A）

### 3.1 AgentLoopContext

```typescript
export interface AgentLoopContext {
  input: {
    content: string;
  };

  context: {
    messages: readonly ModelMessage[];
    data?: Readonly<Record<string, unknown>>;
  };

  config: {
    model?: {
      name: string;
      parameters?: ModelParameters;
    };
    tools?: {
      allowedNames?: readonly string[];
    };
    extensions?: Readonly<Record<string, unknown>>;
  };

  control: {
    signal: AbortSignal;
  };

  metadata?: {
    sessionId?: string;
    executionId?: string;
  };
}
```

其中 `ModelMessage`、`ModelParameters` 直接引用 Phase 1.1 的 Harness Model Contracts。此接口是所有 Loop 都能接收的通用输入容器，但**不要求**自定义 Loop 使用模型或工具：因此 `config.model`、`config.tools` 均可选。官方 `DefaultAgentLoop` 运行时则要求有效的 `config.model.name`。

语义约束：

1. `input.content` 是本次用户输入；`context.messages` 是此前的上下文，**不重复包含本次输入**。
2. `context.messages` 可以包含完整的模型历史，包括先前已闭合的工具调用及工具结果；`context.data` 用于拓展非消息上下文，不规定内部算法。
3. `config` 表示**本次运行最终生效**的配置；`model.parameters` 沿用 Phase 1.1 的统一参数和扩展参数机制。
4. Provider 的 API Key、Base URL 和底层连接配置属于 Runtime/Composition，不进入 Context。
5. `control.signal` 为当前 Loop 运行的取消信号；`metadata` 仅用于关联标识，不赋予 Loop 管理 Session/Execution 生命周期的职责。
6. 输入、历史及配置被视为只读快照；Loop 内部创建独立的可变工作副本，不得修改调用方对象。
7. `extensions` 承载具体 Loop 的专属策略配置，不将默认 Loop 的专属参数强制加到通用 Harness 字段上。

### 3.2 AgentLoopResult

```typescript
export type AgentLoopResult =
  | {
      status: 'completed';
      output: string;
      updatedContext?: AgentLoopContext['context'];
      details?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'stopped';
      reason: string;
      output?: string;
      updatedContext?: AgentLoopContext['context'];
      details?: Readonly<Record<string, unknown>>;
    };
```

- `completed`：Loop 策略正常完成；`output` 是权威最终文本，不强制提供 `ModelResponse`。
- `stopped`：命中可预期的非完成终止条件，例如最后模型响应 `length`、`content_filter`、`other`；`reason` 由具体 Loop 提供。它不是 Execution 的 `FAILED`、`CANCELLED` 等状态。
- `updatedContext` **如提供，必须是执行后完整的上下文快照，而不是增量**；缺省代表未提供上下文更新。`DefaultAgentLoop` 在正常 `loop_end` 时应提供。
- `details` 允许实现输出统计（如 `modelCalls`、`modelRetries`、`toolCalls`），**不强制**自定义 Loop 产生特定统计结构。
- 异常、取消、工具控制错误**不转换成** `completed` 或 `stopped`，而应通过异步迭代传播；这种情况下本阶段不要求返回部分上下文。

### 3.3 AgentLoopEvent

```typescript
export type AgentLoopEvent =
  | { type: 'loop_start' }
  | { type: 'output_delta'; content: string }
  | {
      type: 'model_event';
      modelCallIndex: number;
      event: ModelStreamEvent;
    }
  | {
      type: 'tool_start';
      modelCallIndex: number;
      call: ToolCall;
    }
  | {
      type: 'tool_result';
      modelCallIndex: number;
      result: ToolResult;
    }
  | {
      type: 'custom_event';
      name: string;
      data: unknown;
    }
  | { type: 'loop_end'; result: AgentLoopResult };
```

`ModelStreamEvent` 使用 Phase 1.1 的现有类型，`ToolCall`、`ToolResult` 使用 Phase 1.2 的现有类型。`modelCallIndex` 在一次 `run()` 内从 **1** 开始递增，用于关联本次模型请求与其产生的工具调用；仅默认 Loop 等使用模型的实现需要输出相应事件。自定义 Loop 可以只发出 `loop_start`、自己的 `output_delta`/`custom_event` 与 `loop_end`。

事件语义：

- `loop_start`：正常启动时的第一个事件，**恰好一次**。
- `model_event`：实时、按序转发模型流式事件；一次 Loop 允许多次 `message_start` / `message_end`，但各模型调用独立。
- `output_delta`：Loop 希望面向用户实时展示的文本；与底层模型增量不是同一概念。默认 Loop 可以把模型 `text_delta` 同时转为此事件；UI 不能将 `model_event.text_delta` 和 `output_delta` 当成两份正文重复展示。已展示的中间文本不要求拼接等于最终 `output`。
- `tool_start`、`tool_result`：分别表示一次工具调用开始、以及正常返回 `ToolResult`（包含业务错误结果）；取消/超时通过异常传播，不伪造工具结果。
- `custom_event`：自定义实现的可选事件；`name` 自行命名，但不能冒充统一生命周期事件。
- `loop_end`：**正常终止**时最后一个事件，**恰好一次**，内含最终 `AgentLoopResult`；取代旧版 `loop_result`。在其后不能再输出事件或执行动作。

统一生命周期：

```text
loop_start
    ├── model_event / output_delta / tool_start / tool_result / custom_event ...
    └── loop_end(result)                 # 正常 completed 或 stopped

loop_start → 若干事件 → 抛出异常           # 失败、取消或超时；无 loop_end
```

对于未启动消费的异步迭代器，不应启动实际请求。调用方 `break` 或调用迭代器 `return()`，不视为正常结束，也不补发 `loop_end`。

### 3.4 AgentLoop

```typescript
export interface AgentLoop {
  run(context: AgentLoopContext): AsyncIterable<AgentLoopEvent>;
}
```

统一使用 `AsyncIterable`，**不支持**非流式 Loop 模式，不提供独立 `getResult()`、`subscribe()` 或 `onEvent()`。正常运行的唯一最终结果来自 `loop_end.result`，其他信息经同一流实时输出。外部异常经异步迭代抛出。Harness 只约束对外行为，不要求 Loop 内部必须调用模型、工具或执行特定循环算法。

## 四、DefaultAgentLoop 专属配置（Phase 1.3-B）

```typescript
export interface DefaultAgentLoopOptions {
  maxModelRetries?: number;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
}
```

通过 `context.config.extensions.defaultAgentLoop` 传入本次运行的配置，例如：

```typescript
const context: AgentLoopContext = {
  input: { content: '查询北京和上海的天气' },
  context: { messages: [] },
  config: {
    model: {
      name: 'example-model',
      parameters: { temperature: 0.7, maxOutputTokens: 2048 },
    },
    tools: { allowedNames: ['get_weather'] },
    extensions: {
      defaultAgentLoop: {
        maxModelRetries: 2,
        modelTimeoutMs: 30_000,
        toolTimeoutMs: 10_000,
      },
    },
  },
  control: { signal: new AbortController().signal },
};
```

规则：

1. `maxModelRetries` 是**同一次逻辑模型调用失败后允许额外重试的次数**，默认 **2**，可配置为 0；只对 `ModelError.retryable === true` 的错误重试。
2. **不设置** `maxModelCalls`、`maxToolCalls`、`maxIterations` 或任何总循环上限；正常的“模型→工具→模型”往返**不计入重试**。每次新的逻辑模型调用，重新计算重试次数。
3. 单次模型调用一旦已经对外发送任何当前尝试的 `model_event` 或 `output_delta`，**不得自动重试**，避免重复流式输出；没有向外发送这些事件、错误明确可重试且重试预算充足时才允许重试。`loop_start` 本身不禁止首个模型请求重试。
4. 主动取消不重试；工具调用不自动重试；模型正常返回 `length` 等结束原因不重试。超过重试预算抛出最后一个错误，不生成成功 `loop_end`。
5. `modelTimeoutMs` 和 `toolTimeoutMs` 是**单次**模型/工具调用超时，不是整个 Loop 或 Execution 的超时；未配置时遵循相应 Runtime 现有默认行为。
6. 数值参数在运行前校验：重试次数须为非负整数，显式传入的超时须为正数。不得静默接受无效策略配置。
7. 默认 Loop 的配置由本次 Context 决定；构造阶段仅注入复用依赖。不需要实现新的全局配置加载器。

**风险边界**：无限循环限制是明确的产品选择。只要模型持续请求工具，Loop 可能长时间运行；必须能通过 `AbortSignal` 取消，并将后续 Execution 级运行治理留给 Phase 1.4，不得偷偷加入硬编码最大次数。

## 五、DefaultAgentLoop 内部循环

### 5.1 实例与依赖

```typescript
export class DefaultAgentLoop implements AgentLoop {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
  ) {}

  run(context: AgentLoopContext): AsyncIterable<AgentLoopEvent> {
    // 实际实现可使用 async generator；省略实现细节
    throw new Error('example only');
  }
}
```

以上是形状示例，不要求照抄占位实现。Composition / Bootstrap 将在 Phase 1.6 负责统一装配；本阶段测试可直接实例化。实例保存可复用依赖，不保存当前消息、事件、工具结果或取消状态。

### 5.2 启动及上下文构建

1. 在真正执行时读取 Context，校验默认 Loop 所需的 `config.model.name`、当前输入和专属配置；取消已触发时直接传播取消。
2. 根据 `ToolRegistry.list()` 获取本次允许展示给模型的工具声明，并通过 Phase 1.2 的桥接函数转换为 `ModelToolDefinition[]`。
3. `config.tools.allowedNames`：省略表示使用当前已注册工具；空数组表示没有可用工具；指定数组表示只暴露这些名称。请求中指定不存在的工具名应清晰报配置错误，不擅自扩展到全部工具。
4. **一次 `run()` 固定模型可见的工具声明集合**；运行中 Registry 后续变化不会让新工具自动加入可见集合。ToolExecutor 仍按 Phase 1.2 的现有 Registry 执行语义查找，若工具运行前被注销，允许返回 `tool_not_found` 业务错误；不得声称完成了跨整个 Loop 的注册版本冻结。
5. 复制现有消息历史，追加一条当前 `user` 消息；原始 `context.messages`、`config` 和 `input` 保持不变。
6. 开始输出 `loop_start`，进入模型调用循环。

### 5.3 模型调用及流式输出

每轮通过 `ModelClient.stream()` 发送：当前模型名称、工作消息历史、本次允许工具集合、模型参数；调用选项携带 `control.signal` 和单次 `modelTimeoutMs`。

- 向外按到达顺序转发所有 `ModelStreamEvent`，包装成 `model_event` 并附 `modelCallIndex`。
- 模型返回 `text_delta` 时，默认 Loop 同时输出面向用户的 `output_delta`；这可能是工具调用前的中间说明，**不保证**与最终输出拼接一致。
- 仅以成功流结束时的 `message_end.response` 为该轮权威结果。未收到 `message_end`、收到重复结束或出现不合契约的结果，应报错，不得伪造完成事件。
- ToolCall 参数的分片组装属于 Phase 1.1 Model Runtime，Loop 不重复组装，也**不能在流未正常结束时执行工具**。
- 模型请求失败时仅按第四节规则重试；每个重试尝试仍属于当前逻辑调用，记录统计但不产生重复的已公开输出。

### 5.4 结束原因判定

| 模型响应                                                        | DefaultAgentLoop 行为                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stop` 且无待处理 ToolCall                                      | 追加完整 assistant 消息；`loop_end(completed)`，最终 `output` 使用该次 assistant 文本（无文本时为空字符串） |
| `tool_calls` 且存在完整 ToolCall                                | 按 5.5 执行该批工具并继续下一次模型调用                                                                     |
| `length` / `content_filter` / `other`                           | `loop_end(stopped)`，`reason` 使用对应名称；允许提供部分输出但不可声称任务完成                              |
| `tool_calls` 但无合法 ToolCall，或 `stop` 却携带待处理 ToolCall | 视为无效模型响应，抛出明确错误；不执行工具、不生成 `loop_end`                                               |
| 模型 SDK/Provider 抛错、取消、超时                              | 按统一模型错误及重试规则传播异常                                                                            |

对非正常完成（`length`、`content_filter`、`other`），可供复用的 `updatedContext` 应包含此前完整闭合的交互及本次用户输入，但**不纳入未确认完成的工具调用或不完整的 assistant 工具交互**。

### 5.5 工具调用：只支持串行

本阶段**不修改 Phase 1.2 ToolSpec/ToolExecutor 契约**，不增加 `allowParallel`、工具并行开关、并发调度或队列。

一轮模型输出多个 ToolCall 时：

1. 先验证完整工具列表以及本次允许工具范围。对未允许的工具**拒绝执行**并报告明确的 Loop 运行错误，不借用现有 `ToolResult` 的业务错误码来假装工具未注册；本阶段不扩展 Phase 1.2 错误枚举。
2. 向本次工作消息历史追加**一条**携带该批完整 `toolCalls`（及可能同时存在的文本）的 assistant 消息。
3. **严格按照模型返回的 ToolCall 顺序逐个执行**，每个工具开始前输出 `tool_start`。
4. 使用 `ToolExecutor.execute(call, { signal, timeoutMs })` 执行工具；收到正常 `ToolResult` 后输出 `tool_result`，通过 Phase 1.2 `toToolResultMessage()` 转换为 tool 消息，并追加到工作历史。
5. 工具返回 `ToolResult(status="error")`（包括工具不存在、参数无效、Handler 业务失败）时，**仍继续执行该批剩余工具**；全部结果回填后再次调用模型，由模型决定如何处理错误。
6. 发生取消或工具超时则**终止 Loop 并抛出异常**，不继续其他工具，也不再次请求模型；不生成成功 `loop_end`。取消与超时不等于工具业务错误。
7. 全部工具处理后，带上完整的 assistant tool-call 消息和对应 tool-result 消息进入下一次 `ModelClient.stream()`。
8. 即使模型返回多个 ToolCall，**也不使用 `Promise.all` 并行执行**；结果次序和输入次序一致。

没有工具时，模型请求执行工具属于违反本次可用工具范围的情况，必须拒绝实际执行，不偷偷创建模拟工具。

### 5.6 最终结果与历史

正常 `loop_end` 返回的 `AgentLoopResult`：

- `output` 是最后一次正常完成的助手回答；中间 `output_delta` 已显示的文本不需要成为最终回答的一部分。
- `updatedContext` 是**完整上下文快照**：原历史 + 当前用户输入 + 所有已经确认结束的 assistant 消息 + 配对完成的工具结果 + 最终 assistant 消息。保留原有 `context.data` 的语义，不改变其内容。
- `details` 可包含 `modelCalls`、`modelRetries`、`toolCalls` 等本次统计；这些仅属于默认实现，不加入 Harness 必填字段。
- 结果内容不是 Execution 生命周期状态或事件持久化事实。

### 5.7 伪代码（语义示例）

```typescript
async function* runDefault(
  context: AgentLoopContext,
): AsyncIterable<AgentLoopEvent> {
  const config = parseDefaultOptions(context.config.extensions);
  const allowedTools = resolveAllowedTools(context, toolRegistry);
  const messages = copyMessages(context.context.messages);
  messages.push({ role: 'user', content: context.input.content });

  yield { type: 'loop_start' };
  let modelCallIndex = 0;

  while (true) {
    throwIfAborted(context.control.signal);
    modelCallIndex++;
    const response = yield* callModelAndForwardEvents({
      modelCallIndex,
      model: context.config.model!.name,
      parameters: context.config.model!.parameters,
      messages,
      allowedTools,
      signal: context.control.signal,
      maxModelRetries: config.maxModelRetries,
      timeoutMs: config.modelTimeoutMs,
    });

    if (
      response.finishReason === 'stop' &&
      !response.message.toolCalls?.length
    ) {
      messages.push(response.message);
      yield { type: 'loop_end', result: completedResult(response, messages) };
      return;
    }

    if (
      response.finishReason === 'tool_calls' &&
      response.message.toolCalls?.length
    ) {
      validateAllowedCalls(response.message.toolCalls, allowedTools);
      messages.push(response.message);
      for (const call of response.message.toolCalls) {
        throwIfAborted(context.control.signal);
        yield { type: 'tool_start', modelCallIndex, call };
        const toolResult = await toolExecutor.execute(call, {
          signal: context.control.signal,
          timeoutMs: config.toolTimeoutMs,
        });
        yield { type: 'tool_result', modelCallIndex, result: toolResult };
        messages.push(toToolResultMessage(toolResult));
      }
      continue;
    }

    if (['length', 'content_filter', 'other'].includes(response.finishReason)) {
      yield { type: 'loop_end', result: stoppedResult(response, messages) };
      return;
    }

    throw invalidModelResponse();
  }
}
```

该伪代码不代替异常清理、合法性校验或迭代器关闭实现；`callModelAndForwardEvents` 需处理可重试错误、流式事件透传和最终响应确认。具体辅助函数由 Coding Agent 设计，不要求逐字照抄。

## 六、异常、取消、流清理与并发

1. **正常完成或可预期停止**：`loop_start → ... → loop_end(result)`；`loop_end` 唯一且最后。
2. **模型异常、工具控制异常、无效响应、无效配置或其他失败**：异步迭代抛出错误，**不得**生成正常 `loop_end`。初始输入校验失败时允许在 `loop_start` 之前抛出。
3. **取消**：在开始模型调用、开始各工具调用、准备下一轮循环前检查 `control.signal`；将同一取消信号传递给 ModelClient 和 ToolExecutor。取消传播不是把工具业务错误转成 `stopped`。
4. **消费者提前 `break`/`return()`**：使用异步生成器关闭与 `try/finally` 等机制清理活动模型流；停止后续模型/工具动作，不在后台偷偷继续 Loop。工具 Handler 的取消为协作式，不承诺已经回滚外部副作用。
5. **并发**：单个 DefaultAgentLoop 实例允许多个 `run()` 并发消费，各调用的消息、循环计数、模型事件、取消状态和工具结果完全隔离；不得通过全局锁把所有调用串行化。**同一 Loop 内多 ToolCall 仍按序串行**。
6. **外部能力职责**：Loop 不创建 Execution/Turn/Step/Attempt，不维护持久化日志，不直接发 SSE，不管理 Event Bus，也不做全局限流或 Session 串行调度。

## 七、推荐目录与文档

```text
src/
├── harness/
│   ├── README.md
│   ├── changes.md
│   └── contracts/
│       ├── model/                   # Phase 1.1，直接复用
│       ├── tool/                    # Phase 1.2，直接复用
│       └── agent-loop/
│           ├── README.md
│           ├── changes.md
│           ├── agent-loop.ts
│           ├── agent-loop-context.ts
│           ├── agent-loop-event.ts
│           ├── agent-loop-result.ts
│           └── index.ts
└── execution/
    ├── README.md
    ├── changes.md
    └── loops/
        ├── README.md
        ├── changes.md
        ├── default-agent-loop.ts
        └── index.ts
```

文件名和拆分仅为建议；不要为了目录结构建立空文件或冗余抽象。所有相对路径应与仓库现有结构和导出规范协调。

文档规则：

- 新的 Harness AgentLoop 模块及 Execution Loop 模块各自维护 `README.md`、`changes.md`。
- 根据实际调整更新 `src/harness/README.md`、`src/execution/README.md`，以及 `docs/phase-1.md`、`docs/roadmap.md` 等当前设计文档。
- `changes.md` 真实记录有意义变更的**日期、变更前后、原因、影响范围及验证依据**；对同一能力的多次调整追加时间线，不覆盖旧记录。
- 对跨模块契约或阶段安排变更，按现有项目规范同步 `docs/changes.md`；不虚构实际编码历史。
- 若旧 Phase 1.3 文档仍写有 `BasicLoop`、非流式模式、次数上限等内容，更新现行基线并记载变更原因；不保留相互矛盾的有效规范。

## 八、Coding Agent 开发任务与实施顺序

**任务总要求**：直接实施本方案，先 Harness Contracts，再 DefaultAgentLoop，再测试及文档；只完成 Phase 1.3，不进入 Phase 1.4。

### 8.1 开发前检查

1. 阅读根目录 `AGENTS.md`、`docs/AGENT.md`、`docs/architecture.md`、`docs/conventions.md`、当前 `docs/phase-1.md` 和 `docs/roadmap.md`。
2. 阅读 Harness、Execution、Runtime 模块现有 `README.md`、`changes.md`。
3. 核对 Phase 1.1 的 ModelClient、ModelRequest、ModelResponse、ModelStreamEvent、ModelError，以及 Phase 1.2 的 ToolRegistry、ToolExecutor、ToolResult、Model Bridge 实际代码和导出方式。
4. 本文为 Phase 1.3 **唯一实现依据**；历史草案不再作为同等有效的阶段规范。若发现本方案与已有稳定公共契约存在不兼容，先提交具体差异、影响和最小兼容方案，**不得静默修改 Phase 1.1/1.2 公共契约**。

### 8.2 Phase 1.3-A：Harness Contracts

- 实现第 3 节的 `AgentLoopContext`、`AgentLoopResult`、`AgentLoopEvent`、`AgentLoop`，统一导出。
- 添加类型/契约测试，验证通用的自定义 Loop 无需 ModelClient、ToolExecutor、ModelResponse 仍可实现协议。
- 明确生命周期、异常、终止结果、流消费和自定义事件语义。
- 不把 `DefaultAgentLoopOptions`、模型调用次数或特定工具策略放入 Harness 强制接口。

### 8.3 Phase 1.3-B：DefaultAgentLoop

- 使用注入的 ModelClient、ToolRegistry、ToolExecutor；实现上下文复制、当前用户输入追加、工具集合解析与模型请求构建。
- 只通过 `ModelClient.stream()` 调用模型，实时转发 `model_event`，按约定生成 `output_delta`。
- 正确解析完整 `ModelResponse`，按 `stop`、`tool_calls`、`length`、`content_filter`、`other` 分支处理。
- 实现串行 ToolCall 执行、工具事件输出、ToolResultMessage 回填、下一轮模型调用。
- **不设置总模型调用/工具调用/循环次数上限**。
- 在上下文扩展配置中读取 `maxModelRetries`（默认 2）、可选模型/工具单次超时，按规则只重试未公开输出且 `retryable` 的模型失败。
- 输出唯一 `loop_end(result)`，完整返回最终文本及更新后的上下文快照。

### 8.4 Phase 1.3-C：异常、清理与并发

- 取消、模型异常、工具业务错误/控制错误语义与既有 Runtime 契约一致。
- 实现提前停止 AsyncIterable 消费时的资源清理，避免模型流泄漏和后台继续执行。
- 支持同一 DefaultAgentLoop 实例被多个独立 `run()` 并发消费；请求级可变状态不共享。
- 不自动重试工具调用，不实现并行工具调度。

### 8.5 Phase 1.3-D：测试、文档与验收

- 完成下节离线自动化测试；执行工程已有 `typecheck`、`lint`、`format:check`、`build`、`test` 命令或项目实际等效命令。
- 更新本模块和受影响父模块 README、changes.md；修订旧阶段计划中的错误描述。
- 汇报文件清单、公共契约、默认循环实现、实际测试命令及结果、协议差异和原因、后续未实现能力。

## 九、测试用例与验收标准

以下测试**全部离线可运行**，优先使用 Fake ModelClient、Fake ToolExecutor 与可控 AsyncIterable，不依赖公网、真实模型或密钥。

### 9.1 Harness 契约

- [x] 自定义 Loop 无需模型、工具依赖即可实现 `run(context)`，输出 `loop_start`、自定义事件、`loop_end`。
- [x] Context 包含输入、历史、配置、控制和可选元数据；模型配置对自定义实现不强制。
- [x] `AgentLoopResult` 无必需 `ModelResponse`、模型调用次数等默认实现字段。
- [x] 生命周期事件和最终结果类型正确；无旧 `loop_result` 事件。

### 9.2 默认循环

- [x] 无工具模型正常回复：`loop_start → model_event/output_delta → loop_end(completed)`。
- [x] 至少一轮模型工具调用、工具结果回填、再次模型调用，得到最终回复。
- [x] 多 ToolCall 严格串行，ToolResult 顺序与原调用一致；**没有 Promise.all 并行执行**。
- [x] 业务错误 ToolResult 被正确转成 ToolResultMessage；该批剩余工具仍执行；模型可据此继续。
- [x] 不允许的工具不会被执行；非法响应不伪装为正常完成。
- [x] 仅以完整的 `message_end.response` 判定工具执行；流尚未结束时绝不触发工具。
- [x] `length`、`content_filter`、`other` 产生对应 `loop_end(stopped)`；不把不完整工具调用写入可复用上下文。
- [x] 正常返回的 `updatedContext` 是完整快照，输入历史未被修改，且没有未配对的 ToolCall。
- [x] 使用受控 Fake 演示超过原先 10 次的正常“模型→工具→模型”循环仍可继续，证明**无暗含上限**。

### 9.3 事件协议

- [x] `loop_start` 是第一个事件且只出现一次；正常 `loop_end` 最后且只出现一次。
- [x] 不同 `modelCallIndex` 可正确区分多次模型调用及其工具事件。
- [x] `model_event` 按序、原样传递；`output_delta` 可实时消费，最终 `output` 独立权威。
- [x] 非模型自定义 Loop 仍可输出 `custom_event` 和最终结果。
- [x] 模型流缺少 `message_end`、重复结束或异常终止时不会产生成功 `loop_end`。

### 9.4 重试、取消与异常

- [x] `maxModelRetries` 取自 `config.extensions.defaultAgentLoop`，默认 2；0 表示不重试。
- [x] 只有可重试 ModelError 且尚未输出当前尝试的模型/展示事件时才重试；达到上限抛出最后错误。
- [x] 流式已经产生 `model_event` 后发生错误，不会重新发起模型请求或重复展示。
- [x] 工具调用默认不重试，超时、取消抛出异常，不回填为普通工具业务错误。
- [x] 外部 AbortSignal 可以取消当前模型/工具执行；提前停止迭代能够清理活动模型流。
- [x] 一个 `run()` 失败或取消不影响共享实例上的其他并发 `run()`。
- [x] 无硬编码循环次数上限、隐藏工具数量上限或默认全局执行超时。

### 9.5 工程与文档

- [x] TypeScript 严格类型检查、Lint、格式检查、构建及离线测试全部通过。
- [x] 不修改 Phase 1.1/1.2 的既有契约，不新建无必要的 Runtime/Execution 机制。
- [x] `src/harness/contracts/agent-loop/README.md`、`changes.md` 和 `src/execution/loops/README.md`、`changes.md` 均按实际代码维护。
- [x] 项目阶段文档准确描述最新开发顺序：1.1 Model、1.2 Tool、1.3 Agent Loop、1.4 Execution Engine、1.5 Agent Management、1.6 Composition + CLI。

## 十、完成后的报告格式

Coding Agent 完成后请按以下顺序汇报：

1. **交付内容**：新增/修改文件、Harness 接口和 DefaultAgentLoop 入口。
2. **行为实现**：流式模型事件、工具串行执行、消息回填、最终结果、Context 配置及重试。
3. **测试结果**：实际执行命令、通过/失败项、离线场景、并发与取消资源清理测试。
4. **文档维护**：更新了哪些 README、changes.md 和项目阶段文档。
5. **偏离与问题**：与本方案有无差异、原因及影响；是否发现 Phase 1.1/1.2 的契约阻断。
6. **未实现功能**：Execution Engine、持久化、Steer、工具并行、审批等均标明仍属于后续阶段。

**Phase 1.3 完成后停止，不自动开发 Phase 1.4。**

## 十一、实际交付与验收记录

### 11.1 交付与兼容边界

**2026-11-22 Phase 1.3 已完成实现与离线工程验收。** 已交付 Harness AgentLoop 契约与 Execution DefaultAgentLoop，使用既有 Model/Tool 能力完成流式模型、串行工具、结果回填、完整历史、Context 策略、重试及运行级清理。自定义 Loop 无须使用模型或工具；DefaultAgentLoop 运行时才要求有效模型配置。Execution Engine、Session 调度、Event Bus/SSE、工具并行、审批、持久化及 CLI 仍未实现，不进入 Phase 1.4。

实现边界与既有依赖兼容性如下，详细说明见 [Execution Loops](../src/execution/loops/README.md)：

- 单次 modelTimeoutMs/toolTimeoutMs 沿用既有 Runtime 的 `1..2147483647` 整数范围，启动前校验；未增加全局超时或任何模型/工具/迭代总次数上限。
- 两个依赖使用同一个本次运行有效 signal，它同步调用方取消；提前 return 取消内部控制而不修改调用方 signal。异常或提前停止仅尽力请求底层 return 并接管迟到拒绝，不无限等待不合作的 finalizer；不强制终止任意依赖或承诺副作用回滚。正常模型成功仍要求完整 EOF 确认。
- context.data 作为不透明只读值原样保留，不遍历或序列化其成员；消息和模型配置使用独立工作副本。
- 空 assistant 的 content=null 保留在调用方历史、Loop 内部历史和最终 updatedContext；仅在发送给既有 ModelClient 的独立请求副本中转为 content=''，以兼容已有请求校验。不修改 Phase 1.1/1.2 的公共接口或源码；离线真实 Adapter 回归验证了此路径。

### 11.2 实际检查

**2026-11-22 实际验收环境：Node.js `v26.8.2`、npm `11.19.1`。** 以下五项命令均实际执行成功，测试 146 项通过、0 失败、0 跳过；本阶段停止于 Phase 1.3，不自动进入 Phase 1.4。

| 命令                   | 当前实际结果                                   |
| ---------------------- | ---------------------------------------------- |
| `npm run typecheck`    | 通过；源码及测试严格类型检查                   |
| `npm run lint`         | 通过；0 错误、0 警告                           |
| `npm run format:check` | 通过；全仓格式检查                             |
| `npm run build`        | 通过；源码构建到 `dist/`                       |
| `npm test`             | 通过；146 项通过、0 失败、0 跳过（含自动构建） |

本次测试构成：既有回归 109 项，加 AgentLoop 契约 6 项、默认循环 11 项、执行控制/并发 9 项、边界回归 4 项、Model/Tool 真实实现离线集成 7 项，共新增 37 项，总计 146 项。覆盖无模型自定义实现、多工具串行屏障、错误回填、流末尾验证、公开输出后的重试禁止、超过 10 轮继续运行、对象隔离、取消/提前 return、超时与共享实例并发。新增清理回归覆盖消费者暂停在 model_event 后遇到不合作 finalizer，以及验证失败后的清理不会无限阻塞；同步抛错或拒绝不能覆盖原始模型错误或产生新的重试来源。

文档交付包括两个新能力域各自的 README/changes 共 **4 份**、Harness/Execution 父模块 README/changes 共 **4 份**，以及项目入口、架构、规范和阶段索引的同步更新。当前设计只在本文件维护，旧路径 `phase-1.3.md` 仅保留导航；Phase 1.1/1.2 历史验收分别保留。

集成验证使用真实 Model/Tool 实现及注入的 fetch、Response/ReadableStream，不访问真实模型/API、公网服务或密钥；不将离线成功当作真实服务互通验收。模块和项目记录见 [Harness AgentLoop](../src/harness/contracts/agent-loop/changes.md)、[Execution Loops](../src/execution/loops/changes.md)、[项目变更记录](changes.md)。
