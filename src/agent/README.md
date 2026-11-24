# Agent — 会话与任务管理层

> 模块级现行说明。全局架构见 [`docs/architecture.md`](../../docs/architecture.md)，当前任务依据为 [`docs/phase-1.5.md`](../../docs/phase-1.5.md)。

## 职责与入口

本模块已实现 Phase 1.5 的进程内 Agent Management。`DefaultAgentManager` 注入共享 `ExecutionEngine` 和默认 `AgentLoop`，管理 Session 的创建、查询、稳定列表及空闲删除；Session 管理输入、FIFO、已提交上下文、配置覆盖、取消和独立结果。

公共入口为 [`index.ts`](index.ts)，导出 `DefaultAgentManager`、`DefaultAgentManagerOptions` 和 `SessionEventBufferOverflowError`。`AgentManager`、`SessionAgent`、`SessionExecution`、创建/提交选项与摘要类型由 [Harness Agent Contracts](../harness/contracts/agent/README.md) 定义。内部 `DefaultSessionAgent` 无需由调用方直接构造。

```typescript
import { DefaultAgentManager } from './src/agent/index.ts';

// engine、loop 是符合 Harness 契约的共享实例。
const manager = new DefaultAgentManager(engine, loop, {
  eventBufferCapacity: 512,
});
const session = manager.createSession();
const execution = session.submit('你好');
const result = await execution.result;
// 可独立观察 execution.events；不读取事件也会执行并得到 result。
```

构造选项：

| 选项                  | 默认值与语义                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `eventBufferCapacity` | `512`，每提交尚未消费的事件条数上限；接受大于等于 1 的安全整数          |
| `sessionIdFactory`    | `randomUUID`；同步返回非空字符串                                        |
| `executionIdFactory`  | `randomUUID`；同步返回非空字符串                                        |
| `logger`              | 统一 Logger 门面的 `agent.session` 子 Logger；省略时创建同名默认 Logger |

Manager 在本实例内保留已发放 ID 的字符串集合，拒绝重复 ID，删除 Session 后也不复用旧值；不保留已结算的内部任务。自定义 ID 工厂须由调用方保证跨 Manager、跨共享 Engine 的唯一性；默认 UUID 不引入额外的全局注册状态。工厂失败或返回非法/重复值时同步抛出固定错误，不将任务入队。

## Session 生命周期与 FIFO

- `createSession()` 同步注册 Session；`getSession()` 对存活 ID 返回同一实例。创建时可固定自定义 Loop、上下文和默认配置；未指定上下文为 `{ messages: [] }`。
- `listSessions()` 返回按创建顺序排列的独立摘要，包含创建时间、队列长度及当前运行 ID。摘要不暴露内部 Map 或队列。
- `submit()` 同步校验、生成 ID、入队并返回冻结的句柄。Session 自己启动单个调度泵，唯一地持续消费 Engine；外部何时读取事件或等待结果均不改变 FIFO。
- 同 Session 仅有一个执行中的任务，不同 Session 的泵可并发。每个任务真正出队时才读取最新已提交上下文，构建独立输入、配置、signal 和 `{ sessionId, executionId }` 元数据。
- 有运行中或排队任务时，`deleteSession()` 返回 `false`。空闲删除后返回 `true`，Manager 释放管理引用；仍被外部持有的旧 Session 拒绝新的提交，已结算句柄不受影响。

Agent 不重复拼接当前输入，不解析模型策略，不新增 Loop 次数、模型调用或工具调用上限。

## 上下文与配置

只有唯一合法的 Engine `execution_end` 且迭代确认 EOF/完成清理后，任务才能结算。`COMPLETED` 且 `loopResult.updatedContext` 存在时，先原子替换**完整**上下文，再 resolve `result`，然后放行下一项。成功但没有更新时保留旧上下文；`FAILED`、`CANCELLED` 和 Loop stopped 的更新均不提交。不依赖 `Engine.getSnapshot()`，兼容终态快照保留量为 0 的 Engine。

创建输入、默认配置、提交配置、Loop 工作上下文、观察事件、最终结果和 `getContext()` 各有独立副本。已知消息、ToolCall、上下文及结果字段校验类型并单次物化；不把 DefaultAgentLoop 的历史配对、模型名或工具参数规则施加给自定义 Loop。

配置按“本次提交覆盖 > Session 默认值”解析：

1. `model.name` 覆盖或继承；`model.parameters` 按参数键合并。
2. `tools.allowedNames` 显式提供时整组替换，`[]` 保持为空名单。
3. `extensions` 按命名空间键合并，覆盖的命名空间值整体替换。
4. 未提供的字段继承默认值；每次执行的有效配置再次复制，不改变默认值或提交对象。

自定义 Loop 可以完全省略 model。创建级 `config.model` 沿用 `AgentLoopContext` 的必需 name 形状；提交级 `model: {}` 表示无变化。提交若仅提供 parameters，却无可继承或显式提供的 model name，会同步安全拒绝，避免构造不符合既有契约的上下文。默认 Loop 的模型名和专属扩展校验仍由 Loop 负责。

快照延续既有 Engine 的 unknown 值边界：普通对象/数组、循环与别名、Date、Map、Set、RegExp、ArrayBuffer 和 typed view 复制数据图，保留 BigInt、Symbol、undefined 等值。函数、闭包、带未知内部状态的实例和 Proxy 保留为外部能力引用；未知 accessor 按描述符保留，不主动调用 getter 或 `toJSON`。这些 opaque 能力的内部可变状态无法通用隔离，调用方须自行管理。此边界保留已有 CustomLoop 契约语义，不要求 JSON 化。上下文 `data`、结果 `details` 的不透明数据不因 Agent 调度而被删减。

## 观察流与缓冲

`SessionExecution.events` 是单消费者、只允许遍历一次的 Agent 观察流，不是 Engine 的原始迭代器。可晚读容量内的历史事件；正常结算后仍可读完缓冲，再收到 EOF。重复遍历和并发 `next()` 明确拒绝。

观察者 `break`/`return()` 仅关闭观察流、兑现待处理 reader 并释放缓冲；不取消任务、不阻塞结果。缓冲按未消费**事件条数**计，发布不等待 reader。超过上限时清空缓冲并停止后续缓存，后续读取抛出可识别的 `SessionEventBufferOverflowError`；任务、上下文提交和下一项仍继续。退出后无需显式读取剩余事件。

事件按 Engine 实际顺序发布，不补造 Engine 未产生的 start/end。Engine 抛错、无终止事件、重复终止、终止后额外事件、错误 executionId 或非法结果形状时，观察流仅保留已收到的实际事件并关闭，`result` resolve 固定的 `FAILED/internal_error`。结果顶层仅物化公开 union 字段，额外根 `then` 无法接管 Promise；嵌套不透明数据保持原有语义。

## 取消、清理与故障

- 排队取消原子移除任务，立即 resolve `{ status: 'CANCELLED', reason: 'cancelled_while_queued' }`；空事件流正常完成，不启动 Engine。
- 运行中取消首先 abort 每提交独立的控制器，再 best effort 调用 `Engine.cancel()`。即使 Engine 尚未惰性注册或暂时返回 `false`，signal 仍能传达取消。
- `true` 表示已受理；活动任务重复取消可返回 `true`，非本 Session/未知/已结算 ID 返回 `false`。最后结果以 Engine 真实终态为准；晚到的取消不覆写 Engine 已确定的成功。
- 流异常时请求取消并等待迭代器 `return()`/实际 EOF 清理确认，之后才能结算和启动同 Session 下一项。无 return hook 时继续驱动至 EOF。清理不合作时任务仍活动、删除仍被拒绝，不添加隐藏超时或提前假装结束。

`result` 的“总是 resolve”指运行失败映射成标准 `ExecutionResult`，不把正常失败变成 Promise rejection；不是对不合作依赖的强制终止承诺。内部调度和诊断异步结果均接管拒绝，不泄露原始异常。诊断仅经统一 Logger 输出固定文本及 `internal_error` 代码，不记录输入、历史、参数、结果内容或原始错误；Logger 初始化/写入故障不改变结果和清理。

## 文件与验证

- [`default-agent-manager.ts`](default-agent-manager.ts)：Session 注册、ID、列表与删除。
- [`default-session-agent.ts`](default-session-agent.ts)：FIFO、上下文提交、取消、Engine 消费与结果收敛。
- [`session-event-buffer.ts`](session-event-buffer.ts)：有界单消费者观察流。
- [`session-config.ts`](session-config.ts)、[`session-protocol.ts`](session-protocol.ts)、[`snapshots.ts`](snapshots.ts)：配置解析、Engine 结果验证及本模块快照边界。

离线基础测试为 [`tests/default-agent-manager.test.ts`](../../tests/default-agent-manager.test.ts)，独立集成与控制回归见项目 tests 目录。可执行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run build`。实际验收记录见 [changes.md](changes.md)。

本阶段不实现 Session Event Log、Transaction Journal、Write Coordinator、Recovery、Memory、Inbox、Steer/Follow-up、Workspace、复杂调度或 CLI/HTTP/UI；后续由授权阶段逐步装配，不自动进入 Phase 1.6。
