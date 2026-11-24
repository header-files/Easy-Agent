# Agent Contracts — Session 管理与提交协议

## 定位与当前状态

**Phase 1.5 已定义公共契约。** 本模块定义 AgentManager、SessionAgent 及单次提交句柄，不实现队列、模型调用或事件缓存。唯一阶段设计见 [`docs/phase-1.5.md`](../../../../docs/phase-1.5.md)。公共入口为 [`index.ts`](index.ts)。

| 文件                                           | 公共接口                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| [`agent-manager.ts`](agent-manager.ts)         | AgentManager：createSession、getSession、listSessions、deleteSession    |
| [`session-agent.ts`](session-agent.ts)         | SessionAgent：sessionId、submit、getContext、getModel、setModel、cancel |
| [`session-execution.ts`](session-execution.ts) | SessionExecution：只读 executionId、events、result                      |
| [`session-options.ts`](session-options.ts)     | CreateSessionOptions、SessionSubmitOptions                              |
| [`session-summary.ts`](session-summary.ts)     | SessionSummary：ID、创建时间、可选运行 ID、有效排队数量                 |

类型直接引用已有 AgentLoop、AgentLoopContext、ExecutionEvent、ExecutionResult 和 ModelParameters，不复制旧定义，不依赖默认 Loop、具体 Engine 实现或 Provider SDK。Phase 1.1–1.4 公共契约保持不变。

## Session 生命周期

Manager 同步创建并注册 Session，生成 Session ID；getSession 返回同一个存活实例，listSessions 按创建顺序返回摘要快照，不暴露内部 Map 或队列。每次 Execution ID 由 Agent 层生成，满足 Engine 的唯一性规则。

deleteSession 是异步布尔操作：有运行中或有效排队任务时返回 false，不自动取消或丢弃工作；空闲时删除并释放管理引用，不存在也返回 false。删除后 Manager 不再返回该 Session；默认实现关闭已删除对象，外部持有的旧引用继续 submit 时同步拒绝。已结算句柄的 result 不受删除影响。

公共接口不引入 Session 文件、持久化日志、Workspace、全局调度器或强制删除操作。

## 同步提交、FIFO 与取消

`submit(input, options?)` 在返回前同步校验输入、生成 executionId、完成 FIFO 入队登记并返回 SessionExecution。非法输入可同步 throw；不能把 submit 变成等待执行的 Promise，也不能等外部开始消费事件才入队。

同 Session 以成功入队登记顺序执行，至多一项运行；不同 Session 可以并发。SessionAgent 必须内部主动消费 Engine 的惰性事件流，直到确认结果和 Engine 迭代结束。先收敛终态、提交上下文，再 resolve result，之后才放行下一项。观察者行为不决定任务何时执行。

`cancel(executionId)` 仅受理当前 Session 的排队或运行任务，其他 Session、不存在或已结束 ID 返回 false；true 只表示请求被受理，重复活动取消可幂等返回 true。排队取消不调用 Engine，result resolve 为 CANCELLED / cancelled_while_queued，观察流可直接结束，不伪造 Engine 事件。运行取消应传递独立 signal，并等 Engine 收尾再结算，不能因 Engine 惰性启动时暂时查不到 ID 而漏取消。

取消是协作机制，不承诺立即停止底层操作或回滚副作用；上一项未完成收尾前不启动同 Session 下一项。QUEUED 属于 Agent 内部调度，不添加到既有 ExecutionStatus。

## 独立观察流与最终结果

SessionExecution.events 是**单消费者、单次遍历的观察流**，复用已有 ExecutionEvent；它不是 Engine 迭代器。外部不消费、很晚才消费或提前 break/return，都不能取消或阻塞内部执行。要取消任务必须显式调用 SessionAgent.cancel。

SessionExecution.result 与观察完全独立，始终 resolve 为标准 ExecutionResult，包括 FAILED/CANCELLED；正常执行失败不作为该 Promise 的 rejection。Engine 异常、自然结束缺少终态或重复终止不能让 result 悬挂，应安全收敛为 FAILED/internal_error，不能伪造并非来自 Engine 的生命周期事件。

默认实现使用可配置的有界事件缓存，容量不属于 Harness 强制配置。溢出须有可识别的观察流错误，释放缓冲并停止后续缓存；仅观察流失败，不能阻塞、取消或改变执行结果及上下文提交。关闭观察流释放缓存，正常结束且未溢出时允许读完剩余事件。这不是多订阅者广播、可靠事件重放或 Session Event Log。

## 上下文与配置

CreateSessionOptions 可选择固定的 Loop、初始 context 与 Session 默认 config；省略时沿用 Manager 注入的默认 Loop、空消息历史和默认配置。自定义 Loop 不要求模型或工具，不能在 Agent 层强制所有 Session 使用默认模型策略。

Session 在**任务实际开始时**取得最新已提交上下文，不能在 submit 时捕获旧历史。只有 COMPLETED 且 loopResult.updatedContext 存在时整体替换上下文；没有更新则保留旧值。FAILED/CANCELLED 不提交，stopped 对应的 FAILED 即使带 updatedContext 也不能污染 Session。

getContext、创建输入和执行输入之间必须隔离常见可变数据，至少防御复制标准消息、工具调用、参数数组与 JSON-like data；不改变旧 Context 的 unknown 扩展边界，不宣称任意函数、闭包或外部私有对象都能绝对深复制。具体 opaque 引用限制由默认实现说明。

SessionSubmitOptions 仅覆盖 config，不临时替换 Loop。优先级为本次覆盖 > Session 默认值：model.name 覆盖名称，model.parameters 按参数键合并，tools.allowedNames 整组替换（[] 禁用本次工具），extensions 按命名空间键合并、同名命名空间的值整体替换，不做不透明策略内部的递归合并。默认实现应在 submit 时固化有效配置，使之后的 Session 模型切换不影响已排队任务。默认值、提交对象和最终配置不能通过共享普通对象被相互改写。`getModel` / `setModel` 仅管理 Session 默认模型。

仅参数的模型覆盖需要可继承的默认名称，或同时提供 name；最终 Context 如包含 model，仍必须满足既有类型。Loop 专属策略由对应 Loop 校验，Agent 不添加模型、工具或循环次数上限。

## 无模型自定义 Loop 示例

```typescript
import type { AgentManager } from './src/harness/contracts/agent/index.ts';
import type { AgentLoop } from './src/harness/contracts/agent-loop/index.ts';

const localLoop: AgentLoop = {
  run: async function* (context) {
    context.control.signal.throwIfAborted();
    yield { type: 'loop_start' };
    yield {
      type: 'loop_end',
      result: { status: 'completed', output: context.input.content },
    };
  },
};

async function submitLocally(manager: AgentManager) {
  const session = manager.createSession({ loop: localLoop, config: {} });
  const execution = session.submit('hello');
  // 没有事件消费者，执行仍由 SessionAgent 内部驱动。
  return execution.result;
}
```

实际实例化、队列和缓存实现见 [Agent 模块](../../../agent/README.md)，不在 Harness 提供占位管理服务。

## 验证与非目标

`tests/agent-management-contracts.test.ts` 验证六接口、只读句柄、同步 submit 返回形态、结果与事件的独立类型、部分配置以及无模型/工具的 CustomLoop。类型/契约测试不替代 Agent 实现的 FIFO、并发和缓冲验收。

```bash
npm run typecheck
node --test tests/agent-management-contracts.test.ts
```

不实现 Session Event Log JSONL、Transaction Journal、Session Write Coordinator、持久化 Inbox、Memory、压缩、Recovery、Steer、Follow-up、审批或 Session Tree。不自动进入 Phase 1.6 Composition + CLI，也不增加 HTTP/SSE/Web UI。

相关资料：[Harness](../../README.md)、[AgentLoop](../agent-loop/README.md)、[Execution](../execution/README.md)、[唯一阶段设计](../../../../docs/phase-1.5.md)、[本模块时间线](changes.md)。
