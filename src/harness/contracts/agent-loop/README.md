# AgentLoop Contracts — 算法无关的循环协议

## 定位与当前状态

**Phase 1.3 已实现公共契约。** 本模块定义 Loop 可接收的输入、实时事件和正常终止结果；不包含默认循环算法，不依赖 Runtime、Provider SDK、Execution Engine 或具体工具实现。

唯一阶段设计见 [`docs/phase-1.3-agent-loop.md`](../../../../docs/phase-1.3-agent-loop.md)。公共入口为 [`index.ts`](index.ts)，精确定义以下四组类型：

| 文件与类型                                  | 主要行为                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`AgentLoopContext`](agent-loop-context.ts) | input、历史 context、当前 config、取消 control 及可选关联 metadata                     |
| [`AgentLoopResult`](agent-loop-result.ts)   | completed 或 stopped 的联合类型；正常终止时的最终文本及可选完整上下文和 details        |
| [`AgentLoopEvent`](agent-loop-event.ts)     | loop_start、output_delta、model_event、tool_start、tool_result、custom_event、loop_end |
| [`AgentLoop`](agent-loop.ts)                | run(context): AsyncIterable<AgentLoopEvent>                                            |

## 通用输入与实现边界

`input.content` 是本次用户输入；`context.messages` 为此前的只读模型消息历史，不重复包含当前输入，可包含已经闭合的工具调用和结果。`context.data` 可携带非消息上下文。

`config` 表示本次运行的生效配置。`config.model` 和 `config.tools` 都可选，自定义 Loop 可以完全不调用模型或工具。使用模型的实现通过 `model.name` 和现有 ModelParameters 传入请求参数；`tools.allowedNames` 可表达可用工具选择，具体运行策略由实现定义。`config.extensions` 承载具体算法自己的策略配置，不将默认实现的专属选项加入 Harness 必填字段。

`control.signal` 是本次运行的取消信号；`metadata.sessionId/executionId` 只用于关联，不赋予 Loop 管理 Session 或 Execution 生命周期的职责。API Key、Base URL 等固定 Provider 配置不进入公共 Context。

输入、历史与配置作为只读快照使用。实现应创建自己的工作副本，不能修改调用方对象；可复用实例的消息、计数、取消状态等只能属于单次 run。字段只读不等于要求自定义 Loop 使用某种内部算法。

## 最终结果

- completed 要求 `output: string`，它是权威最终文本，不要求携带 ModelResponse。
- stopped 要求实现定义的 `reason: string`，可附部分 output；它不是 Execution 的 FAILED 或 CANCELLED 状态。
- `updatedContext` 可选；如提供，必须是执行后**完整的上下文快照**，不能只返回新增消息。缺省表示未提供上下文更新。
- `details` 可选，允许实现提供自定义信息；不强制 modelCalls、modelRetries 或 toolCalls 等统计。

失败、取消和工具执行控制异常通过异步迭代传播，不转换成 completed/stopped，也不要求返回部分上下文。

## 事件与生命周期

正常启动的第一个事件是一次 loop_start；正常终止的最后一个事件是一次 loop_end，最终结果只来自 `loop_end.result`。loop_end 后不能再产出事件或执行动作，不另设 loop_result 或 getResult。

model_event 直接包装已有 ModelStreamEvent；tool_start/tool_result 直接使用已有 ToolCall/ToolResult，不重新定义协议。使用模型的实现通过从 1 开始的 modelCallIndex 关联当前运行内的逻辑模型请求和工具调用；自定义 Loop 不必发出这些事件。

output_delta 是 Loop 面向用户的实时文本，与模型原始增量是不同语义。UI 不应把 model_event 中的 text_delta 与 output_delta 重复展示；中间输出的拼接不要求等于最终 output。custom_event 可输出实现自己的事件，name 不应冒充统一生命周期事件。

未开始消费的迭代器不应发起实际请求。异常传播或调用方 break/return 都不视为正常结束，不补发 loop_end。取消与超时不伪造 tool_result。协议只支持统一异步事件流，不增加非流式模式、订阅 API 或独立结果通道。

## 无模型依赖的自定义 Loop 示例

```typescript
import type { AgentLoop } from './src/harness/contracts/agent-loop/index.ts';

const localLoop: AgentLoop = {
  run: async function* (context) {
    context.control.signal.throwIfAborted();
    yield { type: 'loop_start' };
    context.control.signal.throwIfAborted();
    yield {
      type: 'loop_end',
      result: { status: 'completed', output: context.input.content },
    };
  },
};

for await (const event of localLoop.run({
  input: { content: 'hello' },
  context: { messages: [] },
  config: {},
  control: { signal: new AbortController().signal },
})) {
  // 正常最终结果只从 loop_end.result 读取。
}
```

第三方实现无需继承、组合或复用 DefaultAgentLoop，也无需构造 ModelClient、ToolRegistry 或 ToolExecutor。Execution 中的默认策略可以要求有效模型配置；这是默认实现的要求，不属于公共 Loop 协议的必需能力。

## 验证、协作与非目标

`tests/agent-loop-contracts.test.ts` 覆盖无模型/工具的类与对象实现、可选配置和统计、结果联合、既有模型/工具事件载荷，以及异常无 loop_end。基础契约类型检查和 6 项测试先于默认策略编码完成。

```bash
npm run typecheck
node --test tests/agent-loop-contracts.test.ts
```

本模块只依赖 [Model Contracts](../model/README.md) 的类型和 [Tool Contracts](../tool/README.md) 的类型，不改动 Phase 1.1/1.2 接口。默认循环策略属于 Execution；Execution Engine、Session、持久化、SSE/Event Bus、Steer/Follow-up、审批、Recovery、MCP、Skill 或并行工具调度均不在本契约实现范围。

相关资料：[Harness](../../README.md)、[唯一阶段设计](../../../../docs/phase-1.3-agent-loop.md)、[本模块时间线](changes.md)。
