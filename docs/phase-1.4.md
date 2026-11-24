# Easy Agent — Phase 1.4 Execution Engine 技术方案与 Coding Agent 开发任务书

> 版本：V1.0（2026-11-23）\
> 阶段：Phase 1.4\
> 前置依赖：Phase 1.1 Model System、Phase 1.2 Tool Runtime、**Phase 1.3 Agent Loop（已完成编码）**\
> 性质：**Phase 1.4 当前唯一有效的开发依据**；既有 Phase 1.1–1.3 的实际公共契约与已确认设计保持权威性，不能被本任务书静默覆盖。

> **交付状态：2026-11-23 已完成 Phase 1.4 验收；五项工程检查全部通过，187 项测试通过、0 失败、0 跳过。** 本阶段成果与验证边界见 [实际验收记录](#103-实际验收记录)，不自动进入 Phase 1.5。

> 本文件保留 Phase 1.4 的设计基线与 187 项历史验收；当前阶段依据见 [Phase 1.5 Agent Management](phase-1.5.md)。以下 Session 调度等非目标针对 Engine 职责及当时阶段。

## 1. 目标与范围

Phase 1.4 在 Harness 中定义 Execution 的通用运行契约，在 Execution 模块中实现可复用的 `DefaultExecutionEngine`，统一驱动任意符合 Harness `AgentLoop` 契约的 Loop；负责生命周期状态、实时事件转发、最终结果、取消、错误隔离和运行快照。

**本阶段必须完成**：

1. `ExecutionEngine`、`ExecutionRequest`、`ExecutionEvent`、`ExecutionResult`、`ExecutionSnapshot` 等契约。
2. 通过 `AgentLoop.run(context)` 启动并消费异步迭代事件。
3. 将 Loop 事件原样包装为 Execution 事件，管理 `execution_start` 与 `execution_end`。
4. 维护内存中的运行状态及可查询的最终结果。
5. 按 Execution ID 取消任务，合并上层已有 AbortSignal，协作式清理资源。
6. 对 Loop 协议违例、异常、提前退出事件消费和多 Execution 并发给出确定行为。
7. 完成离线自动化测试及各模块 README / changes.md 维护。

**本阶段明确不做**：

- Session Event Log 的 JSONL **读取或写入**、Session Write Coordinator、Transaction Journal、持久化事件投影、事件重放或崩溃恢复。
- Runtime / Event Bus、SSE、后台任务与多订阅者事件广播。
- Session 创建、Session 内 Execution 队列与串行调度（Phase 1.5）。
- 完整 Turn / Step / Attempt 状态机、Steer / Follow-up、Pause / Resume、Approval / HITL。
- 修改 Phase 1.3 Loop 策略，修改 Phase 1.1/1.2 Model / Tool 公共接口。

本阶段的 `ExecutionEvent` **是内存中的实时通知，不是已持久化的事实记录**。未来事实写入由 Runtime / Persistence 实现，实时分发由 Runtime / Event 实现。Engine 不直接调用文件系统操作 Session Event Log。

## 2. 架构与职责边界

```text
Application / Agent Layer（后续负责 Session 管理、创建 Execution、调度）
                               │
                        ExecutionRequest
                               │
                               ▼
                 Harness ExecutionEngine Contract
                               ▲
                               │ implements
                    DefaultExecutionEngine
                       │             │
             Execution state      execution events
                 / control         (AsyncIterable)
                       │
                       ▼
             Harness AgentLoop.run(context)
                       ▲
                       │
            DefaultAgentLoop / CustomAgentLoop
                       │
                Runtime Model / Tool

          Runtime / Persistence：未来接入，不在 Phase 1.4 实现
```

- **Harness**：规范 Execution 对外接口和状态/事件/结果的形状，不依赖默认 Loop 的内部算法。
- **Execution Engine**：负责本次 Execution 的运行机制与内存状态；不负责决定模型如何思考、是否调用工具。
- **Agent Loop**：Phase 1.3 已提供模型→串行工具→模型的默认策略与可替换契约。
- **Agent Layer**：后续负责 Execution ID、Session 关联和同 Session 串行调度。
- **Runtime / Persistence**：未来负责 Session Event Log 的物理读写、序列、事务和历史读取，**不是本阶段交付内容**。

## 3. Harness 核心契约（1.4-A）

### 3.1 ExecutionEngine

```typescript
export interface ExecutionEngine {
  execute(request: ExecutionRequest): AsyncIterable<ExecutionEvent>;
  cancel(executionId: string): boolean;
  getSnapshot(executionId: string): ExecutionSnapshot | undefined;
}
```

- `execute()` 返回**单消费者、单次消费、惰性启动**的事件流；仅创建 Iterable 不启动 Execution，不创建 RUNNING 快照。
- 首次开始消费 Iterable 时执行输入校验、唯一性检查、注册和运行。再次遍历同一 Iterable 必须明确拒绝，不得启动第二次 Execution。
- `cancel(id)` 是**发出取消请求**；`true` 不代表终态已确定；不为不存在或已结束的 ID 创建任务。
- `getSnapshot(id)` 读取运行中或保留的终态快照，返回对象不得直接暴露可变的内部存储引用。
- 同一 `DefaultExecutionEngine` 实例可以并发运行多个不同 Execution；每次执行必须隔离可变状态。

### 3.2 ExecutionRequest

```typescript
export interface ExecutionRequest {
  executionId: string;
  loop: AgentLoop;
  context: AgentLoopContext;
}
```

约束：

1. Execution ID 由上层分配，不由 Engine 生成；必须是非空有效字符串。
2. `loop` 是 Harness `AgentLoop`，**不能依赖 DefaultAgentLoop 的专有属性或构造方式**。
3. `context` 复用 Phase 1.3 的 `AgentLoopContext`；不重新定义 input/context/config/control 等字段。
4. `context.metadata?.executionId` 如存在，必须与 `executionId` 一致；如不存在，Engine 可在传给 Loop 的**新对象**中补充，不得修改传入对象。
5. 未提供 Session ID 不阻碍本阶段内存执行；Session 关联的持久化事务留给后续阶段。
6. 已在运行中或仍有保留快照的同名 ID 再次启动时拒绝；上层应持续使用全局唯一 ID。当前内存实现不承诺跨进程去重。
7. 校验失败或重复 ID 属于**启动前错误**，首次迭代时抛出，不发出 `execution_start` / `execution_end`，不注册运行快照。

### 3.3 ExecutionEvent

```typescript
export type ExecutionEvent =
  | {
      type: 'execution_start';
      executionId: string;
      timestamp: string;
    }
  | {
      type: 'loop_event';
      executionId: string;
      event: AgentLoopEvent;
    }
  | {
      type: 'execution_end';
      executionId: string;
      timestamp: string;
      result: ExecutionResult;
    };
```

正常事件序列：

```text
execution_start
  loop_event(loop_start)
  loop_event(model_event / output_delta / tool_start / tool_result / custom_event ...)
  loop_event(loop_end(result))
execution_end(COMPLETED 或 FAILED[Loop stopped])
```

异常序列：

```text
execution_start
  loop_event(loop_start / 其他合法前序事件...)
  [Loop 抛异常、协议错误或收到取消]
execution_end(FAILED 或 CANCELLED)
```

- Engine **原样**透传 `AgentLoopEvent`，不重组模型或工具流，也不把 `model_event.text_delta` 与 `output_delta` 重复作为正文处理。
- `execution_start` 每次成功启动恰好一次；正常消费至终点时 `execution_end` 恰好一次并且是最后一个事件。
- Loop 出错或取消不必有 `loop_end`；但在调用方持续消费且 Engine 自身能够收尾时，仍要输出 `execution_end`。
- 调用方提前退出或被断开的情况下，**不能承诺该消费者能收到终止事件**；Engine 应清理和维护内部终态。
- `timestamp` 使用 ISO 8601 UTC 字符串。事件由 Engine 产生的时间与未来持久化提交时间是不同概念。

### 3.4 ExecutionResult 与错误信息

```typescript
export type ExecutionErrorCode =
  'loop_stopped' | 'loop_protocol_error' | 'loop_error' | 'internal_error';

export interface ExecutionErrorInfo {
  code: ExecutionErrorCode;
  message: string;
}

export type ExecutionResult =
  | {
      status: 'COMPLETED';
      loopResult: AgentLoopResult;
    }
  | {
      status: 'FAILED';
      error: ExecutionErrorInfo;
      loopResult?: AgentLoopResult;
    }
  | {
      status: 'CANCELLED';
      reason?: string;
    };
```

状态映射：

| Loop / Engine 情况                                     | Execution 结果                   | 说明                                |
| ------------------------------------------------------ | -------------------------------- | ----------------------------------- |
| `loop_end({status:"completed"})` 且迭代正常结束        | `COMPLETED`                      | 保留完整 LoopResult                 |
| `loop_end({status:"stopped", reason})` 且迭代正常结束  | `FAILED` + `loop_stopped`        | 保留 LoopResult，便于区分非完成终止 |
| Loop 抛普通异常                                        | `FAILED` + `loop_error`          | 不捏造 LoopResult                   |
| Loop 违反生命周期协议                                  | `FAILED` + `loop_protocol_error` | 包括未提供终止事件                  |
| Engine 自身内部错误                                    | `FAILED` + `internal_error`      | 不隐藏真实失败，内部可维护原始诊断  |
| Engine 或调用方显式取消且执行已收尾                    | `CANCELLED`                      | 不将取消伪装成 FAILED               |
| Loop 内部单次模型或工具超时，且没有 Execution 取消请求 | `FAILED`                         | 单次超时≠主动取消                   |

`ExecutionErrorInfo` 对外给出稳定代码与安全描述；不原样公开可能含密钥、路径机密或外部响应体的异常对象。无需在本阶段构建复杂的错误分类框架。

**重要**：`AgentLoopResult.status="stopped"` 表示 Loop 以非完成结果正常终止；`ExecutionResult.status="FAILED"` 表示 Execution 未达成成功条件。二者不是互相覆盖的状态机。

### 3.5 ExecutionStatus、ExecutionSnapshot

```typescript
export type ExecutionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ExecutionSnapshot {
  executionId: string;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: ExecutionResult;
}
```

- 成功启动即 RUNNING；进入终态后结果不可再次改变。
- RUNNING 状态没有 `endedAt`/`result`；终态必须有 `endedAt` 和 `result`。
- `startedAt` / `endedAt` 使用 ISO UTC；`durationMs` 使用适当的单调耗时来源，而非简单依赖墙上时钟跳变。
- 本阶段不引入新的 `CANCELLING`、`QUEUED`、`WAITING_APPROVAL` 状态。`QUEUED` 归 Agent Layer 排队；已讨论过的未来完整状态机仍保留，不在 Phase 1.4 强行实现。
- 正在运行的 Execution 状态在内存中维护；终态快照也保留用于查询。
- 为避免长期运行的 Engine 无限积累终态快照，默认实现应采用**有界保留策略**（例如可配置的终态快照最大条数、先进先出淘汰；运行中快照不能被淘汰）；具体实现参数属于 `DefaultExecutionEngine`，不是 Harness 的强制接口。快照可能淘汰，`getSnapshot()` 因此可返回 `undefined`；未来持久化接入后由历史查询能力补齐。

## 4. Engine 内部流程（1.4-B）

```text
execute(request) → 返回单次消费 Iterable（此时尚未运行）
        │ 首次 next()
        ▼
校验 request / executionId / 元数据 / 检查重复 ID
        │
        ▼
创建执行私有运行记录、AbortController、快照，注册 RUNNING
        │
        ▼
yield execution_start
        │
        ▼
AgentLoop.run(增强后的 context)
        │
        ├── 校验每个 AgentLoopEvent 的协议顺序
        │      └── yield loop_event(原始事件)
        │
        ├── Loop 返回 completed / stopped
        │      └── 只有迭代真正结束后才确定结果
        │
        ├── Loop 抛错或协议违例
        │      └── 转换 FAILED；请求关闭 Loop iterator
        │
        └── 收到有效取消请求
               └── 协作式关闭 / 清理，再转换 CANCELLED
        │
        ▼
确定唯一终态、更新快照、移除活动记录
        │
        ▼
yield execution_end(result)
        │
        ▼
清理信号监听器、底层迭代器及临时引用
```

### 4.1 Loop 生命周期协议校验

Engine 不关心 Loop 的内部算法，但必须约束其对外生命周期：

1. `loop_start` 必须是首个 Loop 事件，且只能出现一次。
2. `loop_end` 只能出现一次，且之后不得再出现事件。
3. **自然迭代结束**必须已经收到 `loop_end`。
4. `loop_end.result` 必须符合已约定的 `AgentLoopResult` 形状；不得因为 TypeScript 编译通过就信任第三方运行时代码。
5. 在 `loop_end` 到达后，Engine **仍需完成一次迭代终止确认**，不能立刻把 Execution 标记为 COMPLETED，以免自定义 Loop 在 `loop_end` 后继续发事件或抛异常。
6. 协议违例一律 FAILED (`loop_protocol_error`)，尽力关闭底层 Iterator。
7. 如果 Loop 在 `loop_start` 前主动抛异常，属于 `loop_error`；不能因为未观察到 `loop_start` 就把所有真实异常误判成协议违例。

### 4.2 状态决议与竞态规则

- `cancel()` 成功只设置「取消已请求」和触发 AbortSignal；此时 `getSnapshot()` 可仍显示 RUNNING。
- Engine 记录是否已接受取消请求；**在终态确定之前已接受取消的执行，收尾后判为 CANCELLED**，即使底层 Loop 在竞争窗口内返回普通完成事件。已经提交终态后到达的 `cancel()` 返回 false，不倒转状态。
- 单次工具/模型自身 timeout 不等于 Engine cancel。不能只依据错误名 `AbortError` 就一律判 CANCELLED；应结合 Engine 的实际取消状态和调用方原始 AbortSignal。
- 自定义 Loop 忽略 AbortSignal 时只能尽力取消；不得宣称能强制中断不可取消的同步工作、网络操作或回滚工具副作用。
- 同一 Execution 只能有一个最终 `ExecutionResult`；最终事件与 `getSnapshot()` 应相互一致。

### 4.3 AbortSignal 合并与清理

- Engine 为每个运行中 Execution 创建一个私有 `AbortController`。
- 将 `request.context.control.signal` 与私有控制信号关联；任意一个被取消，都应终止对应 Execution。
- 生成传给 Loop 的新 `AgentLoopContext`，保留原本 input/context/config/metadata，不修改调用方传入的对象；避免重写原始引用。
- 监听器在终态或清理时必须移除，避免跨 Execution 内存泄露。
- 为减小运行时版本依赖，可在 Engine 内使用明确的信号联动与监听清理；如采用 `AbortSignal.any()`，须符合本项目当前 Node.js 版本和类型配置。
- 传入 Context 预先已经 aborted：在输入合法且首次消费后，允许发出 `execution_start`，随后结束为 CANCELLED，不调用 Loop 的模型/工具执行。

### 4.4 惰性启动、事件背压与消费退出

- `execute()` 返回单次消费的 `AsyncIterable`；不依赖后台消费者或额外调度线程。
- 一次迭代只允许一个消费者；不支持对同一 Iterable 的并发 `next()`（可明确拒绝或序列化，需有离线测试覆盖）。
- 事件自然通过 AsyncIterable 按需消费，不能积累无限制的内部事件队列。
- 消费者通过 `break` / `return()` 提前退出时：发出取消信号、关闭底层 Loop Iterator、释放监听器；**最终状态在清理完成后更新为 CANCELLED**。
- 提前退出时不能再向已退出消费者强行 `yield execution_end`；使用 `getSnapshot()` 查询内部终态。
- 如果底层 Loop 不配合取消或其清理阶段挂起，本阶段无法保证即时终止；不要为了满足表面终态而假装清理已完成。
- 当前前台单消费者模型下，「消费退出 → 取消 Execution」是明确约束；未来后台独立运行、多客户端 SSE 订阅时再分离事件订阅与任务执行。

### 4.5 异常归属与收尾

- **启动前验证错误**：直接在首次迭代抛出，不生成执行事件和快照。
- **运行中的 Loop 异常**：转换为 `execution_end(FAILED)`；运行中业务异常不向已正常消费的上层重复抛出而导致丢失终止事件。
- **运行中的 Engine 异常**：尽可能转换为 `execution_end(FAILED)`，保留安全错误码；对无法安全恢复的宿主级故障不做无法兑现的保证。
- **主动取消**：转换为 `execution_end(CANCELLED)`（继续消费时）；与模型自身请求超时区分。
- **清理失败**：不得悄悄覆盖已经存在的更关键错误；尽力记录或传播可诊断信息，不得将失败执行标为成功。
- 自定义 Loop 执行时可能抛出任意错误（甚至非 Error 值），错误转换需稳健。

### 4.6 并发与快照

- 一个 Engine 实例同时执行多个不同 ID 的 Execution，私有记录不得共享。
- `cancel(A)` 不能取消 B；A 的 Loop 协议错误不能破坏 B。
- 保留快照必须是数据快照，不包含 AbortController、Iterator、底层 Error 对象或可变内部引用。
- 若结果的 `updatedContext` 包含对象引用，公开快照应做必要的拷贝或不可变处理，避免上层意外修改已完成记录；不需要引入复杂通用深拷贝框架。
- Engine 不执行 Session 内串行调度，也不跨不同 Execution 施加全局锁。

## 5. 未来 Session Event Log 的对接边界（本阶段只定义责任，不开发）

```text
Agent Layer / Execution Engine
        │ 提供领域事件事实
        ▼
Harness Persistence Contract（未来）
        │
        ▼
Runtime / Persistence（未来）
        ├── Session Write Coordinator
        ├── Transaction Journal
        └── Session Event Log（每 Session 一个 JSONL）
        │ 已提交的可靠事实
        ▼
Runtime / Event（未来）
        └── SSE / CLI / 其他订阅者
```

重要规则：

1. **Session Event Log 唯一的物理读写实现者是 Runtime / Persistence**。
2. Agent Layer、Execution Engine 是业务事实的提交发起者；Context Manager / 恢复机制是历史读取的使用者，物理读取仍由 Persistence 完成。
3. 并非所有 `ExecutionEvent` / `AgentLoopEvent` 都要持久化；例如 `text_delta`、`output_delta` 通常只需要实时展示，而完整 LLM 请求/响应、工具调用/结果、Execution 生命周期等应作为执行事实保存。
4. **不能直接把本阶段 `AsyncIterable` 接到 JSONL 写入器上就声称具有可靠的事件溯源语义**：未来要明确 Session ID、Sequence、事务提交、幂等以及「先可靠提交、再发布对应事实」的时序。
5. Phase 1.4 不要创建 `SessionEventStore` 的假实现、不创建 `events.jsonl` 文件、不引入尚未明确的持久化接口。保持 Engine 对持久化技术无依赖，后续在执行事实提交边界引入可注入的机制。

## 6. 推荐目录（以仓库现状为准）

```text
src/
├── harness/
│   ├── README.md
│   ├── changes.md
│   └── contracts/
│       ├── agent-loop/            # Phase 1.3，直接引用
│       └── execution/
│           ├── README.md
│           ├── changes.md
│           ├── execution-engine.ts
│           ├── execution-request.ts
│           ├── execution-event.ts
│           ├── execution-result.ts
│           ├── execution-snapshot.ts
│           └── index.ts
└── execution/
    ├── README.md
    ├── changes.md
    ├── loops/                 # Phase 1.3，不改既有契约
    └── engine/
        ├── README.md
        ├── changes.md
        ├── default-execution-engine.ts
        └── index.ts
```

文件拆分只作参考，不为了形式创建冗余层次或空文件。适配仓库现有导出与测试规范。Harness 是横向契约，不是强制中转运行时层。

## 7. Coding Agent 开发任务（1.4-A 至 1.4-D）

### 开发前检查

1. 阅读 `AGENTS.md`、`docs/AGENT.md`、`docs/architecture.md`、`docs/conventions.md`、`docs/phase-1.md`、`docs/roadmap.md`，以及 Harness、Execution、Runtime 的 README/changes.md。
2. **核对仓库中 Phase 1.3 已编码的真实接口**：`AgentLoop.run()`、`AgentLoopContext`、`AgentLoopEvent`、`AgentLoopResult`，不要依据记忆重写类型。
3. 确认 Node.js / TypeScript 版本、项目现有错误类型、测试框架、导出路径和工程脚本。
4. 本文是 Phase 1.4 唯一有效的开发基线；若与已完成的 1.1–1.3 代码存在重大不兼容，先说明实际差异与最小兼容方案，**不得擅自重构已完成模块**。

### Phase 1.4-A：Harness Contracts

- 实现第 3 节契约，统一导出，保持独立于 DefaultAgentLoop。
- 明确惰性启动、单消费者、结果映射、快照生命周期及取消接口的公开注释。
- 类型测试：自定义 Loop 可直接作为 Engine 请求输入，无需 ModelClient 或 ToolExecutor。

### Phase 1.4-B：DefaultExecutionEngine

- 实现真正的惰性 `AsyncIterable` 启动与单次消费保护。
- 校验输入、Execution ID 与 metadata 一致性，注册运行记录，输出 execution_start。
- 创建受控的 LoopContext，消费 `AgentLoop.run(context)`，正确透传包装事件。
- 校验 Loop 事件协议，只有正常迭代结束后才决定完成结果。
- 实现 completed/stopped/异常/协议错误映射；发布 execution_end 并更新可查询快照。
- 仅使用内存，不访问 Session Event Log。

### Phase 1.4-C：取消、清理与并发

- 实现 Engine 主动取消与外部 AbortSignal 协同；取消请求与最终 CANCELLED 分离。
- 实现消费者提前退出（`break` / `return`）后的取消与资源收尾，避免泄露监听器。
- 实现多 Execution 并发隔离、重复 ID 拒绝及安全快照返回。
- 实现有界终态快照保留，默认策略合理且测试可验证；不得淘汰 RUNNING 执行。
- 不添加后台调度或 Session 层队列。

### Phase 1.4-D：测试、文档、验收

- 完成第 8 节离线测试，不需要真实 Provider 或网络。
- 执行项目已有的 `typecheck`、`lint`、`format:check`、`build`、`test`，或等价实际脚本。
- 更新 Harness Execution 与 Execution Engine 模块 `README.md`、`changes.md`；同步其父模块和阶段文档。
- 对实质性实现或设计调整，`changes.md` **按时间线记录日期、变更前后、调整原因、影响范围、验证情况**，不要覆盖旧记录；跨模块变更同步 `docs/changes.md`。
- 完成 Phase 1.4 后停止，**不自动进入 Phase 1.5**。

## 8. 离线测试与验收标准

使用 Fake / Stub AgentLoop、可控的异步生成器、Deferred Promise、AbortController 测试，**不需要真实模型和工具执行**。

以下 28 项已按实际测试及差异/文档检查验收；快照隔离按 [用户确认的数据与能力引用边界](#101-快照隔离与不透明能力值2026-11-23-用户确认) 判断，不包含外部 opaque 能力自身的内部状态。

### 8.1 接口与启动语义

- [x] `execute(request)` 本身无副作用：尚未 RUNNING，尚未调用 Loop。
- [x] 首次消费产生 `execution_start`；第二次消费相同 Iterable 被拒绝。
- [x] 无效 ID、重复 ID、metadata.executionId 冲突在启动前报错，未生成开始/结束事件及新快照。
- [x] 任意符合 Harness 契约的 CustomAgentLoop 都能运行。

### 8.2 事件与结果

- [x] completed：`execution_start → loop_event(loop_start...) → loop_event(loop_end) → execution_end(COMPLETED)`。
- [x] stopped：`execution_end(FAILED)` 且 `error.code = loop_stopped`、保留 `loopResult`。
- [x] 普通 Loop 抛错：仍能得到 `execution_end(FAILED)`，对外描述不泄露敏感错误细节。
- [x] 缺少 loop_start、重复 loop_start、缺少 loop_end、重复 loop_end、loop_end 后继续发事件，都被正确判断为协议违例。
- [x] Loop 在 loop_end 后抛错不会错误地发布 COMPLETED。
- [x] 事件的 loop_event 原样承载 1.3 的 Model / Tool / Custom 等事件。
- [x] 正常结束必有且只有一个 execution_end；不会额外补发 loop_end。

### 8.3 取消及边界

- [x] `cancel(id)` 对运行中的 ID 返回 true，非活动 / 未启动 / 已结束返回 false；重复取消保持幂等。
- [x] 取消已发出但尚未收尾时，快照可仍为 RUNNING，最终才转 CANCELLED。
- [x] 上层原有 `context.control.signal` 取消也能触发 CANCELLED；输入对象不被修改。
- [x] 已预先 aborted 的输入信号不触发 Loop 的实际模型/工具动作。
- [x] 单次模型/工具 timeout 且没有 Engine 取消请求映射 FAILED，不误标 CANCELLED。
- [x] 消费者 `break` / `return()` 提前退出，Signal 被取消，底层迭代器关闭，完成清理后 Snapshot 为 CANCELLED。
- [x] 已经完成后才来的取消返回 false，不反转终态。
- [x] 恶意或不配合取消的 CustomLoop 不导致 Engine 谎称已清理；测试可通过可控 Promise 验证协作式边界。

### 8.4 并发与内存

- [x] 同一 Engine 实例的不同 Execution 可并发运行，互不影响。
- [x] `cancel(A)` 不会影响 B；A 的协议错误不影响 B。
- [x] 快照返回不能被外部修改从而影响 Engine 内部数据。
- [x] 终态快照按有界策略淘汰，RUNNING 不被淘汰；`getSnapshot` 的生命周期行为有文档说明。
- [x] 无 Session Event Log JSONL 文件写入、无事务日志或持久化依赖。

### 8.5 文档与工程检查

- [x] TypeScript 类型检查、Lint、格式检查、构建和测试通过。
- [x] 不修改 Phase 1.1/1.2/1.3 既定公共协议，除非先报告阻断并得到批准。
- [x] 新模块及受影响父模块 README/changes.md 保持与当前实现一致。
- [x] `docs/phase-1.md` / roadmap 正确标记 Phase 1.4 当前范围与后续 Persistence、Phase 1.5 的分工。

## 9. 交付报告模板

Coding Agent 最终按以下顺序汇报：

1. **修改文件清单**：Harness Contracts、Execution Engine、测试、文档。
2. **接口说明**：Execute / Cancel / Snapshot 入口，事件及结果协议。
3. **关键语义**：惰性启动、单次消费、协议校验、取消与提前退出、内存保留策略。
4. **测试证据**：实际命令及结果，正常、stopped、错误、取消、并发、事件顺序测试。
5. **文档变更记录**：模块 README、changes.md、阶段文档更新情况。
6. **差异及风险**：与本方案不同之处、发现的 Phase 1.3 兼容问题、已知协作式取消限制。
7. **明确未开发**：Session Event Log、Transaction Journal、Session 调度、Approval、Steer、Recovery 等。

> **验收原则**：Engine 可以可靠驱动独立的 AgentLoop、流式提供执行事件、维护正确的内存生命周期与取消状态，并通过离线测试。完成后仅提交 Phase 1.4 的成果，不开始 Phase 1.5。

## 10. 已确认的实现取舍与实际验收

### 10.1 快照隔离与不透明能力值（2026-11-23 用户确认）

Phase 1.3 的 data/details/custom_event.data 可包含外部能力值，本阶段不收窄既有公共类型，也不通过 JSON 序列化或无条件 structuredClone 丢弃合法值。

Engine 对自身状态和可复制数据图提供强隔离：普通对象、数组及循环引用，以及 Date、Map、Set、RegExp、buffer 等受支持数据值，通过必要的复制保持独立。函数/闭包/带私有状态的外部对象，以及未知 native slots、accessor 与 Proxy 保留能力引用；不调用未知 getter 或 Proxy traps，不冻结或改造外部对象，**不承诺隔离这些能力的内部状态**。这部分限制需在模块 README 对调用方明确说明，不能将“不透明引用原样保留”描述为整个对象图完全隔离。

快照不包含 Engine 的 AbortController、Iterator 或原始 Error 对象；内部生命周期记录与公开可复制数据保持独立。具体类型支持和处理边界以 [Execution Engine README](../src/execution/engine/README.md) 为准。

### 10.2 公开清理边界与终态保留

Engine 的清理边界是自身资源与公开 Loop Iterator 的收尾，不承诺任意更底层模型/工具资源被强制终止。已有 DefaultAgentLoop 的 best-effort 清理语义保持不变；若 CustomLoop 的 return 本身未完成，Engine 不为表面终态而假称清理完成。

Loop 迭代器没有 return 钩子，或 return/finalizer 仍 yield 事件时，也必须继续驱动至真正 EOF 才确认清理完成；清理阶段事件不再向已退出消费者发布。

默认实现的专属选项为 maxRetainedSnapshots，默认 1000，允许 0；仅限制保留的终态条数，不淘汰运行中快照，不形成 Loop 次数限制或 Session 调度队列。可选 Logger 复用既有门面，不改变 Harness Execution 公共契约。

### 10.3 实际验收记录

2026-11-23，在 Node.js `v26.8.2` / npm `11.19.1` 环境完成全仓验收：

| 命令                   | 结果                       |
| ---------------------- | -------------------------- |
| `npm run typecheck`    | 通过                       |
| `npm run lint`         | 通过                       |
| `npm run format:check` | 通过                       |
| `npm run build`        | 通过                       |
| `npm test`             | 187 项通过，0 失败，0 跳过 |

187 项由既有 151 项 + 新增 36 项组成：Execution 契约 5 项、默认 Engine 主流程 8 项、独立控制/并发/背压 11 项、协议边界 5 项、快照 4 项、既有 DefaultAgentLoop 实际离线集成 3 项。Phase 1.3 的 146 项阶段验收及后续 Model 修复的 147/151 项记录作为历史保留。

回归覆盖没有 return 钩子时的真正 EOF、finalizer 继续 yield、清理未完成仍为 RUNNING、终态前取消优先、RUNNING 不被终态 FIFO 淘汰，以及普通数据图/循环/二进制别名与 opaque 能力引用。每次等待 next 的 cancelWaiter 在兑现、拒绝或取消后移除；512 个事件的背压用例验证暂停消费不预读、取消监听保持有界并在终态释放，未引入后台事件队列或隐藏清理超时。

差异检查确认 Phase 1.1–1.3 的生产源码与公共契约 TypeScript 文件均未修改；两个新能力域及 Harness/Execution 父模块的 README 和 changes.md 已同步。测试通过可控离线 Loop 和既有 DefaultAgentLoop 验证 Engine，不依赖真实 Provider、API Key 或网络服务，不将协作式清理结果解释为任意底层能力已强制停止。

本阶段未实现 Session Event Log JSONL 读写、事务日志、事件重放/恢复、Session 调度、Event Bus/SSE 或 Phase 1.5。
