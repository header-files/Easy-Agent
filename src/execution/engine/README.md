# Execution Engine — 前台内存执行机制

## 定位与当前实现

Phase 1.4 的唯一设计依据是 [Execution Engine 技术方案](../../../docs/phase-1.4.md)。`DefaultExecutionEngine` 实现 [Harness ExecutionEngine](../../harness/contracts/execution/README.md)，通过任意 AgentLoop 的 `run(context)` 驱动执行，负责生命周期、事件包装、结果映射、内存快照和取消。

Engine 不依赖 DefaultAgentLoop 的算法或配置，不解析工具 JSON、不重组模型输出、不决定何时调用工具。Phase 1.1–1.3 的源码和公共契约保持原状。

当前只实现前台、单消费者、内存执行；没有后台消费者、多订阅者、Session 队列、Event Bus、SSE、事件持久化、Session Event Log JSONL 读写、Transaction Journal、Recovery、Steer 或审批。不自动进入 Phase 1.5。

## 入口与初始化

```typescript
import { DefaultExecutionEngine } from './src/execution/engine/index.ts';

const engine = new DefaultExecutionEngine({ maxRetainedSnapshots: 1000 });
const events = engine.execute({
  executionId: 'execution_001',
  loop, // 调用方已创建的 DefaultAgentLoop 或任意符合 Harness 的自定义 Loop
  context,
});

for await (const event of events) {
  if (event.type === 'execution_end') {
    const result = event.result;
    // result 与 getSnapshot('execution_001') 的终态一致。
  }
}
```

构造选项属于默认实现，不加入 Harness 强制接口：

| 选项                            | 行为                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `maxRetainedSnapshots?: number` | 默认 1000，非负安全整数；0 表示不保留终态快照              |
| `logger?: Logger`               | 可注入统一 Logger；否则创建 `execution.engine` 模块 Logger |

Logger 只记录必要的固定安全诊断码，例如清理失败；不记录 Context、事件数据、结果正文、原始异常、路径或认证信息。日志创建、child、同步写入抛错及写入 Promise 拒绝不改变执行结果或清理时序。默认输出 stderr，Engine 不写 stdout。

## 惰性启动与单消费者

`execute(request)` 只创建单次消费 Iterable，不注册状态、读取 Loop 或启动模型/工具。首次 next 时才验证请求、检查重复 ID、复制 Context、注册 RUNNING 并输出 execution_start。

每个 Iterable 只能取得一个消费者，即使首次迭代尚未 next，第二次遍历也明确拒绝。同一个 Iterator 的并发 next 明确拒绝，不取消或破坏已有 pending next。正常事件按消费需求产生，没有内部无限事件队列。每轮 next 只登记一个当前取消 waiter，兑现、拒绝或取消后解除，不向一个长期 pending Promise 累积逐事件回调。

在首次启动前直接 return 不注册 Execution。启动前错误在首次迭代抛出，没有 execution_start、execution_end 或新快照：

- executionId 不是非空字符串。
- 请求、Loop.run 或 Context 不符合公共形状。
- metadata.executionId 与请求 ID 不一致。
- ID 已在运行或仍有终态保留快照。

Engine 仅验证公共 Context 字段，不要求自定义 Loop 配置 model 或 tools，也不使用默认 Loop 的策略限制。输入对象不被修改；传给 Loop 的独立 Context 补齐 metadata.executionId，并使用本次私有取消信号。metadata.sessionId 可选，无 Session ID 也可以执行。

## 事件与唯一终态

正常流为：

```text
execution_start
loop_event(loop_start)
loop_event(模型 / 工具 / 展示 / custom_event ...)
loop_event(loop_end(result))
execution_end(result)
```

原 Loop 事件作为 event 原样包装，不转为另一套模型/工具流或重复拼接正文；这里“原样”表示结构值保持，不要求对象 identity 相同。自定义 data 可以是 undefined、null、循环、函数等非 JSON 数据，不会被脱敏器或 JSON 序列化改写。

Engine 校验 loop_start 恰好首个且一次、loop_end 恰好一次且之后无事件，正常 EOF 必须已有 loop_end。收到 loop_end 后仍读取迭代器确认结束，后续异常或额外事件不能被误判成功。

AgentLoopResult 按公共字段做运行时校验，包括 completed.output、stopped.reason、可选完整 updatedContext 的消息形状，以及 details/data 容器。只检查既有字段类型，不施加默认 Loop 的工具名单、历史配对、名称正则或参数策略。已验证的生命周期类型和结果字段物化后保存，避免 getter 后续变值使对外 loop_end 与终态不一致；任意未知 payload accessor 则保留为外部能力。

| 情况                                                | 最终 ExecutionResult                      |
| --------------------------------------------------- | ----------------------------------------- |
| Loop completed 且 EOF 已确认                        | COMPLETED，保留完整 LoopResult            |
| Loop stopped 且 EOF 已确认                          | FAILED，loop_stopped，保留完整 LoopResult |
| Loop 抛错（包括在 loop_start 前或 loop_end 后抛错） | FAILED，loop_error                        |
| 缺失/重复/乱序生命周期或结果字段无效                | FAILED，loop_protocol_error               |
| Engine 自身无法按正常流程完成                       | 尽可能 FAILED，internal_error             |
| 终态提交前已接受取消，并完成收尾                    | CANCELLED                                 |

Loop 抛任意值都被转换为稳定安全描述，不向持续消费的调用方重复抛出运行中异常而丢失 execution_end。Engine 不根据 Error 名称或单次 Model/Tool timeout 猜测 Execution 取消；没有实际取消请求时，这些仍是 loop_error。原异常对象不进入快照或公开错误字段。

成功启动及持续消费至终点时，execution_start/end 各一次，end 最后。已提交终态不会再改变；消费者拿到 end 后 break/return 不会反向取消已完成的 Loop。

## 取消请求、清理与提前退出

每次 Execution 使用独立 AbortController，联动输入 Context 的上层 signal；不修改上层 signal，不影响其他 Execution。

`cancel(id)` 对活跃 ID 返回 true，表示已接受请求并立即通知私有 signal；重复请求幂等。不存在、未启动或终态已提交的 ID 返回 false，不创建记录。已预先 aborted 的合法请求允许先输出 execution_start，再直接 CANCELLED，不调用 Loop。

取消请求和终态分开：清理未确认时快照保持 RUNNING，没有虚构 CANCELLING 状态。终态提交前已接受的取消优先，即使 Loop 在竞争窗口给出 completed，最终仍为 CANCELLED；终态之后 cancel 返回 false。

消费者 break/return 会立即发出取消，并等待底层 Loop Iterator 的协作收尾。正在等待 next 时也会发取消并请求 return；但**必须等 Loop 清理确认后才提交 CANCELLED**。等待期间不向主动退出消费者补发 execution_end，之后可用 getSnapshot 查询。

Loop.return 若 yield 收尾事件，或没有 return 钩子，Engine 会继续驱动至真正 EOF，丢弃这些清理阶段事件。没有默认清理 timeout；不响应 signal 或最终不结束的 Loop 可以让当前 Execution 保持 RUNNING，Engine 不假装资源已释放，也不强制中断任意 JavaScript、网络请求或回滚副作用。其他 ID 仍可并发正常执行。

清理本身抛错会通过统一 Logger 记录固定诊断码，不覆盖原 Loop/协议错误，也不能把失败改为成功。所有可完成的收尾会移除外部 signal 监听并释放活动记录。对原始 Loop.next 迟到的拒绝有 Promise 观察，不泄漏未处理拒绝。

Phase 1.3 DefaultAgentLoop 对其底层 Model finalizer 有自身的尽力清理边界；Engine 确认的是 **AgentLoop Iterator 的收尾**，不能据此宣称任意不合作底层能力已经物理停止。这不修改既有 Loop 行为。

## 快照、未知数据与保留

RUNNING 快照只有 executionId、status、startedAt；终态具有 endedAt、result 和基于 performance.now 的 durationMs。时间戳为 ISO 8601 UTC；单调耗时不依赖墙上时钟调整。

getSnapshot 每次提供独立数据快照；内部状态、事件结果、Loop 原始结果和多次查询之间不会共享 Engine 创建的可变数据容器。完整 LoopResult 未 JSON 化，数据图中的共享别名和循环会保留。

**用户已确认的隔离边界**：

- 普通对象/数组、循环、Date、Map、Set、RegExp、ArrayBuffer/SharedArrayBuffer、Buffer 和标准 typed view 进行数据图复制；二进制 backing buffer 与 view 之间的别名也保留。
- BigInt、Symbol、undefined、非有限数等合法非 JSON 值保持原语义；不调用未知对象 getter、toJSON 或自定义序列化函数。
- 函数/闭包、自定义类的私有状态、未知 native slots、accessor 函数及 Proxy 属于**外部 opaque 能力引用**，原样保留，不假称能通用深拷贝或隔离其闭包/private state。未知 Proxy 不触发反射 traps。
- 这类外部能力自身的可变状态不属于 Engine 能隔离的数据，使用方应继续遵守 readonly 语义。它们不会变成 Engine 私有 record/controller/iterator 的公开引用；Engine 的状态和已验证结果字段仍被隔离。

这一取舍保持 Phase 1.3 的 unknown 数据能力，不收窄公共契约、不拒绝本来合法的自定义 Loop，也不以字符串占位丢弃内容。

终态按**提交顺序 FIFO**保留，最多 maxRetainedSnapshots 条；RUNNING 存储独立，不会被淘汰。getSnapshot 对不存在或被淘汰的 ID 返回 undefined。仍有保留快照的 ID 禁止重用；淘汰后当前进程内不再记住它，上层仍应分配全局唯一 ID。此机制不是持久化历史或跨进程去重。

## 文件与离线验证

| 文件                          | 职责                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `default-execution-engine.ts` | 惰性单消费者、内存记录、结果/状态、取消、协作清理与保留 |
| `protocol.ts`                 | 启动校验、Loop 生命周期及结果公共形状验证               |
| `snapshots.ts`                | 保留别名与循环的数据图副本和 opaque 能力边界            |
| `index.ts`                    | 默认实现及构造选项导出                                  |

`node --test tests/default-execution-engine.test.ts tests/execution-engine-control.test.ts tests/execution-engine-boundaries.test.ts tests/execution-engine-snapshots.test.ts tests/execution-engine-integration.test.ts` 验证默认/自定义 Loop、状态、协议、取消、并发、清理与快照；完整质量命令见 [工程规范](../../../docs/conventions.md)。所有常规测试离线，不需要模型 Key 或外部服务。

本阶段不读写 Session Event Log，不创建 JSONL、持久化接口、事务日志或事件分发器。未来 Runtime/Persistence 负责物理读写，Runtime/Event 负责实时广播；本阶段 ExecutionEvent 仅为内存实时通知。相关说明：[Execution](../README.md)、[Loop](../loops/README.md)、[本地时间线](changes.md)。
