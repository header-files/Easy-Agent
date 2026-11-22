# Execution Loops — DefaultAgentLoop

## 定位与当前实现

Phase 1.3 的唯一设计依据是 [Agent Loop 技术方案](../../../docs/phase-1.3-agent-loop.md)。本模块实现默认策略 `DefaultAgentLoop`：模型流式请求、按序执行工具、结果回填、继续请求模型，直到正常完成或可预期停止。

对外实现 [Harness AgentLoop](../../harness/contracts/agent-loop/README.md)，依赖 Phase 1.1 的 ModelClient 和 Phase 1.2 的 ToolRegistry / ToolExecutor 契约。第三方 Loop 只需满足公共协议，无须继承或复用本实现。当前没有 BasicLoop 别名、generate/stream 模式开关或独立 loop_result 事件。

本模块不创建 Provider、Tool Runtime、Session、Execution/Turn/Step/Attempt，不实现 Execution Engine、持久化、SSE/Event Bus、Steer、审批、Recovery、工具并行或全局限流。不自动进入 Phase 1.4。

## 入口与依赖注入

```typescript
import { DefaultAgentLoop } from './src/execution/loops/index.ts';
import type {
  AgentLoopContext,
  AgentLoopResult,
} from './src/harness/contracts/agent-loop/index.ts';

// modelClient、toolRegistry、toolExecutor 是调用方已创建的能力实例。
const loop = new DefaultAgentLoop(modelClient, toolRegistry, toolExecutor);
const context: AgentLoopContext = {
  input: { content: '查询天气' },
  context: { messages: [] },
  config: {
    model: { name: 'example-model', parameters: { maxOutputTokens: 2048 } },
    tools: { allowedNames: ['get_weather'] },
    extensions: {
      defaultAgentLoop: { maxModelRetries: 2, modelTimeoutMs: 30000 },
    },
  },
  control: { signal: new AbortController().signal },
};

let result: AgentLoopResult | undefined;
for await (const event of loop.run(context)) {
  // output_delta 可交给展示层；model_event 是独立的底层事件，避免重复展示正文。
  if (event.type === 'loop_end') result = event.result;
}
```

构造阶段只注入三个可复用依赖，专属策略来自本次 Context。`run()` 返回惰性 AsyncIterable，创建但未消费时不会读取注册表、发请求或执行工具；启动前直接 return 也没有这些副作用。

## 本次运行的配置与工具集合

默认实现要求有效的 `config.model.name`，虽然通用 AgentLoopContext 的 model 对自定义 Loop 可选。input.content 必须是字符串；传入历史视为此前完整上下文，不应重复本次用户输入。

`context.config.extensions.defaultAgentLoop` 支持：

| 字段                       | 默认与校验                                  |
| -------------------------- | ------------------------------------------- |
| `maxModelRetries?: number` | 默认 2；非负安全整数；0 禁止自动重试        |
| `modelTimeoutMs?: number`  | 不设置默认值；如提供为 1..2147483647 的整数 |
| `toolTimeoutMs?: number`   | 不设置默认值；如提供为 1..2147483647 的整数 |

唯一方案使用“正数”描述 timeout；实际实现沿用 Phase 1.1/1.2 已有 Runtime 的整数范围，运行前清晰拒绝不兼容数值，保持既有接口和行为。安全整数检查用于避免数字精度问题，不引入额外的业务次数上限。

每次 run 只调用一次 ToolRegistry.list，通过现有 toModelToolDefinition 生成工具声明快照。allowedNames 省略表示当时所有工具，空数组表示没有工具，显式名单只暴露对应声明；未知名称在首次模型调用前报错，不退回全部工具。运行中新增工具不会自动进入模型可见集合。

这只是**可见定义集合**固定，并不冻结 Registry 的跨轮版本。若工具执行前被注销，ToolExecutor 仍可按 Phase 1.2 语义返回 tool_not_found。Loop 不重新实现 Registry 或 Handler 管理。

## 模型事件、完整流确认与重试

每轮只调用 ModelClient.stream，传入消息、模型参数、固定工具定义，以及当前有效取消信号和可选的单次 timeout。

- loop_start 在校验成功后首先且只输出一次。
- 所有 ModelStreamEvent 按序复制为 model_event，modelCallIndex 从 1 开始，每次新的逻辑调用递增。
- text_delta 另产生 output_delta。已展示的中间说明不要求拼接等于最终 output；最终文本取自最后完成响应。
- 必须先收到唯一合法 message_start、随后唯一 message_end，并确认迭代器正常 EOF，才使用该轮完整响应。结束后继续事件、重复结束、缺少结束或后续异常都会失败，绝不提前执行工具。
- ToolCall 由 Model Runtime 组装；Loop 不解析、拼接或修复 argumentsJson，仅检查完整调用列表和本次允许范围。

模型失败只有同时满足 ModelError、retryable=true、不是 aborted、当前尝试尚未向外发送任何 model_event/output_delta、且预算未耗尽时重试。loop_start 不阻止首次模型请求重试。一次尝试即使只公开了 message_start，也禁止重试。

重试不改变当前逻辑 modelCallIndex；下一次正常模型—工具往返重新计算预算。超过预算传播最后一个原错误，不转为正常终止。工具从不自动重试，length 等正常结束原因也不重试。模型 iterator.return 的抛错或拒绝不能覆盖已有模型失败，清理错误本身不成为重试来源。

没有 maxModelCalls、maxToolCalls、maxIterations、硬编码最大往返次数、工具批次大小限制或默认全局运行超时；只要模型持续提出工具调用，Loop 就可能持续运行，由取消信号和后续 Execution 层治理。

## 串行工具批次与终止

| 最终模型响应                                      | 默认策略                                                   |
| ------------------------------------------------- | ---------------------------------------------------------- |
| stop 且无待执行工具                               | 追加完整 assistant，completed，output 为助手文本或空字符串 |
| tool_calls 且有完整工具列表                       | 整批范围检查后追加一条 assistant，按返回顺序逐项执行并回填 |
| length / content_filter / other                   | stopped，reason 为相应名称，output 可携带部分文本          |
| stop 携带工具、tool_calls 没有工具，或无效流/结果 | 抛出明确错误，不执行该批工具，不发 loop_end                |

每批先验证**全部**调用及允许范围，再执行第一项。未允许的工具是 Loop 运行错误，不假造 Phase 1.2 业务错误码。工具逐个输出 tool_start、等待 execute、输出 tool_result，再将 toToolResultMessage 结果写入历史；没有 Promise.all 并行执行。

普通 ToolResult.status=error 仍回填 isError=true，并继续该批剩余工具；整批完成后再请求模型。ToolExecutionError（取消/超时）或其他异常直接终止，不回填虚假结果，不执行后续工具，不发 loop_end。

正常 loop_end 是最后且唯一的正常终态，包含 completed 或 stopped。异常、取消、提前 break/return 没有 loop_end，也不转换为 Execution 生命周期状态。

## 快照、完整历史与兼容边界

消息和模型参数在启动时复制，模型请求、模型事件、工具事件、能力调用参数及最终结果之间不共享可变消息/工具对象。输入、依赖或消费者修改自己的对象，不能篡改 Loop 工作历史或下一轮请求。参数只复制 JSON 数据，不执行自定义 toJSON 或参数 getter。

原历史必须保持工具调用与结果闭合；新的当前 user 只追加一次。completed 的 updatedContext 是原历史、本次用户输入、所有完整 assistant/成对工具结果和最终 assistant 的完整快照。stopped 返回此前已闭合历史及本次用户输入，保留之前完成的工具往返，不把本次截断 assistant/工具交互写进可复用历史。

context.data 是不透明 readonly 数据：原样携带引用，不遍历、序列化、改写或传给模型/工具，不要求它只能包含 JSON。此字段没有被扩充为执行实体或持久化协议。

Phase 1.1 ModelMessage 类型允许 assistant.content=null，但其既有请求映射拒绝“null 且无工具”的 assistant 历史。本实现仅在独立的 **ModelRequest 消息副本**里将该情形转为空字符串，兼容真实 Runtime 的下一次请求；原历史、内部权威消息和 updatedContext 保留原 null。有工具调用的 null 不变，工具参数及其他正文不修复，不修改任何 Phase 1.1/1.2 源码或契约。

details 是默认实现的可选统计：modelCalls 计物理 stream 尝试（含重试），modelRetries 计额外重试，toolCalls 计实际 execute 调用。它们不加入公共 AgentLoop 契约必填字段。

## 取消、清理与同实例并发

每次消费 run 创建独立的 linked AbortController，跟随 Context 的原 signal；ModelClient 与 ToolExecutor 收到同一个本次运行的有效 signal。外部原 signal 不被 Loop 修改，也不会因消费者 return 而被反向 abort。

使用内部有效信号是为了满足提前关闭异步迭代的资源要求：普通 async generator 的 return 会排在 pending next 后面；本实现的惰性包装器会立即取消内部信号，再关闭内层 generator。Model.next 和 Tool.execute 同时观察取消竞态；即使替代能力忽略 signal，Loop 也及时结束等待并接管迟到 Promise 拒绝。

在启动模型、每个工具、进入下一轮等边界检查取消。预先取消不会查询注册表或输出 loop_start。取消沿模型/工具控制异常传播，不声称停止结果。所有正常/异常退出移除外部监听；正常 loop_end 前清理自身控制资源。

活动模型迭代器会收到 return 请求。异常、取消或消费者提前停止时，不无限等待底层 return/finally：无论 next 是否仍 pending，不合作的 finalizer 都不能阻止 Loop 结束或遮盖原错误，其迟到拒绝会被接管。正常成功仍必须等待模型迭代 EOF；提前停止只是请求能力清理，不保证任意自定义 iterator 的 finally 已完成。实际 Runtime 的 signal/资源语义保持原状。Handler 仍为协作式取消，不能承诺回滚副作用。

同一个 DefaultAgentLoop 可并发消费多个 run，消息、计数、工具结果、事件、可见定义和控制各自独立。没有全局锁；同一次 run 的多个工具始终串行。

## 文件、验证与协作

| 文件                    | 职责                                             |
| ----------------------- | ------------------------------------------------ |
| `default-agent-loop.ts` | 默认模型/工具往返策略、事件、结果与重试          |
| `prepare.ts`            | Context 运行配置及可见工具快照                   |
| `snapshots.ts`          | Model/Tool 契约验证、独立消息/事件复制           |
| `control.ts`            | 惰性消费、linked signal、取消竞态和提前 return   |
| `index.ts`              | DefaultAgentLoop 与 DefaultAgentLoopOptions 导出 |

运行 `node --test tests/default-agent-loop.test.ts tests/agent-loop-control.test.ts tests/agent-loop-boundaries.test.ts tests/agent-loop-integration.test.ts` 覆盖算法、重试、控制、并发、边界和真实 Runtime 的离线链路。测试不需要网络或模型密钥，完整质量命令见 [工程规范](../../../docs/conventions.md)。实际通过数量以阶段验收记录为准。

Loop 本身没有增加日志构造策略或内容日志；现有 Runtime 能力继续通过统一 Logger 输出诊断到 stderr。Loop 的对外事件是公共调用协议，不是日志或持久化事实。

相关文档：[公共 AgentLoop](../../harness/contracts/agent-loop/README.md)、[Execution](../README.md)、[唯一阶段依据](../../../docs/phase-1.3-agent-loop.md)、[变更时间线](changes.md)。
