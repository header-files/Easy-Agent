# Execution Contracts — 执行生命周期公共契约

## 定位与当前状态

**Phase 1.4 已定义公共契约。** 本模块规范执行请求、内存事件流、取消请求和运行快照；实际驱动由 Execution Engine 实现。唯一阶段设计是 [`docs/phase-1.4.md`](../../../../docs/phase-1.4.md)。

公共入口为 [`index.ts`](index.ts)。本模块直接引用 Phase 1.3 AgentLoop、AgentLoopContext、AgentLoopEvent 和 AgentLoopResult，不依赖 DefaultAgentLoop、ModelClient、ToolExecutor、Provider SDK、日志后端或持久化技术，不修改 Phase 1.1–1.3 公共契约。

| 文件                                             | 公共类型                                                   |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [`execution-engine.ts`](execution-engine.ts)     | ExecutionEngine：execute / cancel / getSnapshot            |
| [`execution-request.ts`](execution-request.ts)   | ExecutionRequest：executionId、loop、context               |
| [`execution-event.ts`](execution-event.ts)       | ExecutionEvent：execution_start、loop_event、execution_end |
| [`execution-result.ts`](execution-result.ts)     | ExecutionResult、ExecutionErrorCode、ExecutionErrorInfo    |
| [`execution-snapshot.ts`](execution-snapshot.ts) | ExecutionStatus、ExecutionSnapshot                         |

## 启动与单次消费

`execute(request)` 返回惰性、单消费者、单次消费的 AsyncIterable。仅创建事件流不调用 Loop，也不建立 RUNNING 快照；输入校验、ID 唯一性检查和注册都在首次消费时发生。同一 Iterable 不能再次遍历并启动另一任务，也不支持同时驱动多个 next 请求；具体实现应明确拒绝或序列化并发 next。

executionId 由上层分配，必须是非空有效字符串。`request.loop` 可以是任意 AgentLoop，自定义实现不必调用模型或工具。context 直接复用旧类型，model/tools 仍可选；Session ID 不是本阶段内存执行的前置条件。

`context.metadata.executionId` 如存在必须与请求 ID 一致；缺省时 Engine 可以在传给 Loop 的新 Context 中补充，不能修改调用方对象。已有活动记录或保留快照的 ID 必须拒绝再次启动；当前内存接口不承诺跨进程去重，上层应持续使用唯一 ID。

输入错误、元数据冲突或重复 ID 是启动前错误：首次迭代抛出，不产生开始/结束事件，也不注册新快照。

## 事件与结果

成功启动先产生一次 execution_start；Loop 事件按原有内容包装为 loop_event，不拆分、重组或重复展示模型文本，也不创建额外 Loop 事件。正常消费至终点时，execution_end 恰好一次并且最后输出，携带唯一 ExecutionResult。

Engine 验证 Loop 的生命周期：一次 loop_start 首先出现，一次 loop_end 最后出现，而且必须确认 Loop 迭代正常结束后才能提交终态。loop_end 后继续输出或抛异常不能被当作成功。未知事件、无效结果及缺失生命周期事件属于协议错误；Loop 在首个事件前抛异常仍是 Loop 异常。

| 情况                           | ExecutionResult                        |
| ------------------------------ | -------------------------------------- |
| Loop completed 且自然结束      | COMPLETED，保留 loopResult             |
| Loop stopped 且自然结束        | FAILED / loop_stopped，保留 loopResult |
| Loop 运行异常                  | FAILED / loop_error，不伪造 LoopResult |
| Loop 生命周期协议错误          | FAILED / loop_protocol_error           |
| Engine 自身内部错误            | FAILED / internal_error                |
| 已接受取消请求，且执行收尾完成 | CANCELLED，可附安全 reason             |

stopped 是 Loop 的正常非完成结果，FAILED 是 Execution 没有达成成功条件，两者属于不同职责。仅模型或工具自身 timeout、或仅错误名为 AbortError，不代表 Engine 已接受取消请求；没有实际 Execution 取消时仍判 FAILED。

ExecutionErrorInfo 只含稳定 code 和安全 message，不直接暴露异常对象、原始响应、密钥或机密路径。已经启动后的普通失败由 execution_end 表达，不向持续消费的调用方再次抛同一个业务错误而丢失终止事件。

这些事件是内存实时通知，不是已持久化事实。timestamp 使用 ISO 8601 UTC，不能将其解释为未来日志事务的提交时间。

## 取消、退出与清理

`cancel(id)` 只向活动任务发出取消请求。true 不代表收尾完成；不存在、未启动或已结束的 ID 返回 false，重复请求保持幂等，不创建新任务。取消已接受但未收尾时，查询仍可看到 RUNNING。

Engine 为每次运行建立独立取消控制，关联已有 `context.control.signal`，用新 Context 传给 Loop，不反向修改调用方对象或其他 Execution。合法输入的原 signal 已取消时，首次消费允许产生 execution_start 后结束为 CANCELLED，不触发 Loop 的实际模型/工具动作。

终态确定前已接受取消的执行，收尾后判 CANCELLED；已经提交的终态不被后到的 cancel 改写。消费者 break/return 代表取消本次 Execution：应通知 Loop、请求关闭迭代器并清理监听器；清理完成后维护 CANCELLED 快照，不能向已退出的消费者强行补发 execution_end。

取消是协作式机制。不合作的 Loop 或挂起的清理不能被宣称已经结束，Engine 不保证强制终止任意同步代码或回滚工具副作用。清理失败不能覆盖已有关键失败，也不能把失败执行改成成功。

## 内存快照与保留策略

成功启动后为 RUNNING，省略 endedAt/result；终态必须有 endedAt/result，提交后结果不可改变。startedAt/endedAt 为 ISO UTC；durationMs 使用适当的单调耗时来源。公共状态只有 RUNNING、COMPLETED、FAILED、CANCELLED，不引入 QUEUED、CANCELLING 或 WAITING_APPROVAL。

`getSnapshot(id)` 不暴露 Engine 私有运行记录、控制器、迭代器或内部捕获的底层错误。嵌套 LoopResult/updatedContext 中常见的可复制数据需要必要的防御复制或不可变处理；既有 context.data/details 仍是 unknown 扩展数据，公共契约没有新增 JSON 限制。

函数、闭包以及依赖私有状态的外部对象可以作为 opaque 值保留引用；不能承诺对任意 unknown 的绝对深隔离。具体支持的数据、复制方式和 opaque 引用限制由 Engine 实现说明，不将这些外部对象当作 Engine 私有状态暴露问题。

默认 Engine 应有有界终态保留策略；具体参数属于默认实现，不是 Harness 的强制配置。运行中快照不能被淘汰，已淘汰 ID 可查不到快照；未来历史查询应由 Persistence 能力补充，本接口不是 Session 历史数据库。

## 自定义 Loop 请求示例

```typescript
import type { AgentLoop } from './src/harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEngine,
  ExecutionRequest,
} from './src/harness/contracts/execution/index.ts';

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

const request: ExecutionRequest = {
  executionId: 'execution_example',
  loop: localLoop,
  context: {
    input: { content: 'hello' },
    context: { messages: [] },
    config: {},
    control: { signal: new AbortController().signal },
  },
};

async function consume(engine: ExecutionEngine) {
  for await (const event of engine.execute(request)) {
    // 最终结果从 execution_end.result 读取，运行状态通过 getSnapshot 查询。
  }
}
```

实例与保留配置属于 Execution Engine 实现，Harness 不提供占位运行服务。

## 验证与非目标

`tests/execution-contracts.test.ts` 验证无模型/工具的自定义 Loop 请求、旧 Loop 事件和结果载荷、Execution 结果联合、状态/错误代码与接口返回类型；不以类型测试冒充实际引擎行为验收。

```bash
npm run typecheck
node --test tests/execution-contracts.test.ts
```

本阶段不定义 Session Event Log、JSONL 读写、Transaction Journal、Event Bus/SSE、历史重放或恢复接口，也不实现 Session 队列、Steer、审批或 Phase 1.5。Runtime/Persistence 是未来持久化物理读写的唯一归属，Engine 不直接写事件文件。

相关资料：[Harness](../../README.md)、[既有 AgentLoop](../agent-loop/README.md)、[唯一阶段设计](../../../../docs/phase-1.4.md)、[本模块时间线](changes.md)。
