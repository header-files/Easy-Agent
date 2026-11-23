# Phase 1.2 — Tool Runtime

> 基线：用户于 **2026-11-22** 确认的《Phase 1.2 Tool Runtime 开发任务书》。Phase 0、Logging 与 [Phase 1.1 Model System](phase-1.1.md) 已完成；本阶段只实施 Tool Runtime，不自动进入 Phase 1.3。
>
> 交付状态：**2026-11-22 已完成 Phase 1.2 实现与离线工程验收**。109 项测试通过、0 失败、0 跳过；仅交付 Tool Runtime，不自动进入 Phase 1.3。

> 本文件保留 **Phase 1.2 的实现基线与 109 项历史验收**。当前阶段已转为 [Phase 1.4 Execution Engine](phase-1.4.md)；以下“不实现循环”等限制针对 Tool Runtime 自身与当时阶段，Tool 公共契约继续作为该能力的权威定义。

## 1. 目标与职责

建立独立可用、可替换且支持并发的本地 TypeScript 工具组件，为后续 Agent Loop 提供 ToolExecutor：

- **Harness**：`src/harness/contracts/tool/` 定义工具声明、Handler、Registry、Executor、结果、执行上下文与取消/超时异常。
- **Runtime**：`src/runtime/tool/` 实现 DefaultToolRegistry、DefaultToolExecutor、JSON Schema 校验与两个轻量 Model Bridge。
- **Logging**：沿用既有 Logger 门面，记录必要生命周期元数据，避免参数、工具结果、Schema 或原始异常进入日志。
- **后续 Loop/Composition**：决定何时调用模型与工具、组织消息与装配依赖；本阶段不实现这些职责。

Model System 生成工具调用数据，Tool Runtime 解析、校验并执行工具。数据桥接不构成模型—工具—模型循环，不修改 Phase 1.1 的 ModelClient 公共协议。

## 2. 公共契约

公共入口为 `src/harness/contracts/tool/index.ts`，不依赖 Provider SDK、具体工具实现或 Agent Loop。

| 契约                 | 当前字段与行为                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| ToolSpec             | name、description、parameters；工具元数据及对象型 JSON Schema，不含执行函数或来源字段                |
| ToolHandler          | 接收校验后的 `Record<string, unknown>` 与 ToolExecutionContext；同步或异步返回 `{ content: string }` |
| ToolExecutionContext | toolCallId 与当前调用有效的 AbortSignal                                                              |
| ToolRegistry         | register(spec, handler)、unregister(name)、get(name)、list()；不静默覆盖重复名称                     |
| ToolCall             | id、name、argumentsJson；与已有 ModelToolCall 结构兼容                                               |
| ToolExecutor         | 可复用实例的 execute(call, options?)，返回 Promise<ToolResult>；不调用模型、不自动重试               |
| ToolExecutionOptions | 可选 signal、timeoutMs；控制单次调用                                                                 |
| ToolResult           | status 为 success/error 的联合类型，保留 toolCallId/name/content；失败包含 error.code/message        |
| ToolExecutionError   | 仅 aborted/timeout，通过异常表达控制终止，与普通业务错误区分                                         |

ToolErrorCode 为 tool_not_found、invalid_arguments、execution_failed。成功和普通业务失败均返回 ToolResult；取消/超时不能伪装为成功或普通错误结果。

## 3. Registry、参数校验与执行

### 注册快照

Registry 使用进程内 Map，不引入持久化或版本管理。注册时校验 ToolSpec、Handler 和 Schema；重复名称明确报错。调用方修改原始 spec、get/list 返回的数据，不应改变内部声明。

execute 只获取一次当前注册信息，固定本次 spec 与 Handler。注销后新调用找不到工具，但已开始的调用继续使用其快照；重新注册同名工具也不能改变在途调用。

### 严格输入

- 注册时校验参数 Schema；执行时先解析 argumentsJson，再校验实际参数。
- 解析结果必须是非 null、非数组的对象，不能仅凭 JSON.parse 成功执行 Handler。
- 无效 JSON、缺少必填字段、类型错误或 Schema 拒绝的额外字段返回 invalid_arguments，Handler 不执行。
- **不填默认值、不强制转换类型、不删除未知字段**；是否允许额外字段由工具 Schema 决定。
- 当前采用 Ajv 8 / JSON Schema draft-07，同步、严格校验，不加载远端 Schema。支持范围与拒绝策略以 [Runtime Tool](../src/runtime/tool/README.md) 为准；不承诺所有 JSON Schema 方言或异步校验。
- Schema 和参数数据不通过校验器静默修改；每次调用解析出独立参数对象。

### 结果与失败

| 情况                       | 对调用方的行为                                          |
| -------------------------- | ------------------------------------------------------- |
| 工具不存在                 | ToolResult(error, tool_not_found)                       |
| 调用参数或工具参数无效     | ToolResult(error, invalid_arguments)，不调用 Handler    |
| Handler 返回有效文本输出   | ToolResult(success)，保留调用 ID 和工具名               |
| Handler 抛出异常或输出无效 | ToolResult(error, execution_failed)，不暴露原始异常内容 |
| 主动取消                   | 抛出 ToolExecutionError(aborted)                        |
| 超时                       | 抛出 ToolExecutionError(timeout)                        |

注册配置错误与执行期的 ToolResult/控制异常分开；具体校验范围、固定错误文本和选项限制由模块 README 维护。

## 4. 执行控制与并发

同一个 Registry/Executor 可复用，不为每次调用重新实例化。单实例允许相同或不同工具自然并发；参数、结果、AbortController、定时器和上下文逐调用隔离，不用全局锁串行化。

signal 和 timeoutMs 应及时结束调用方等待，将有效 AbortSignal 传给 Handler，并清理定时器/监听器。取消、超时或失败不能影响其他调用或后续复用。

取消是**协作式机制**：未响应信号的 Handler 可能继续运行。Executor 不承诺强制终止任意 JavaScript、撤回已发生副作用或执行事务补偿。具体 Handler 若访问共享资源，仍需自行遵守其并发约束；Executor 不自动提供资源锁或重试。

## 5. Model Bridge 与使用

- `toModelToolDefinition(spec)` 复用 Phase 1.1 的 ModelToolDefinition，转换工具声明。
- `toToolResultMessage(result)` 复用 ToolResultMessage，传递 toolCallId/content，status=error 时 isError=true。
- ModelToolCall 可以直接作为 execute 输入；不重复定义已有模型类型，不调用 ModelClient，不改变原始数据。

```typescript
const registry = new DefaultToolRegistry();
registry.register(
  {
    name: 'greet',
    description: 'Return a greeting',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  (args) => ({ content: `Hello, ${String(args.name)}` }),
);

const executor = new DefaultToolExecutor(registry);
const result = await executor.execute({
  id: 'call_001',
  name: 'greet',
  argumentsJson: '{"name":"Easy Agent"}',
});
const message = toToolResultMessage(result);
```

入口、完整 import、Logger 注入与使用示例以 [Runtime Tool README](../src/runtime/tool/README.md) 为准。该示例只做一次工具调用及结果转换，没有 Agent Loop。

## 6. 非目标与实现取舍

不实现 Agent Loop、Execution Engine、Session、完整 Tool Calling 循环、MCP、Skill、Sandbox、Approval、工具持久化、复杂调度器、全局并发队列、自动重试框架、优先级/资源锁、HTTP API、CLI 或 Web UI；不增加工具插件容器、复杂 DI 或 trace 系统。

默认实现采用简单进程内注册及稳定执行快照，使用成熟 Schema 库而非手写校验器。已有 Model 契约在本阶段保持不变。任务书中 ToolExecutionError 的构造参数属性按现有 `erasableSyntaxOnly` 约束改为显式 readonly 字段与赋值，保留原有签名和行为；阶段顺序按用户确认调整，不存在需要修改 Phase 1.1 公共协议的冲突。

## 7. 验收要求

- [x] 五组核心契约及执行上下文/选项/异常正确导出，不依赖 Provider、Loop 或具体工具。
- [x] Registry 正常注册/查询/列举/注销，拒绝重复与无效声明，外部修改不能污染内部状态。
- [x] 严格 JSON/Schema 校验有效，不补默认值、不转换类型、不删除字段；校验失败不执行 Handler。
- [x] 同步/异步 Handler、成功与业务失败正确转换，无自动重试且错误内容安全。
- [x] 取消与超时使用独立异常；有效信号传递、及时结束等待、定时器/监听器清理正确。
- [x] 单实例真实交错并发，失败/取消隔离，注销或重注册不破坏在途快照。
- [x] 两个 Model Bridge 正确保留错误语义、复用实际 Model 类型且不修改输入。
- [x] 统一 Logger 的行为与安全边界经过验证，不引入后续业务能力。
- [x] 类型检查、lint、格式检查、构建及全部离线单元/必要集成测试通过。
- [x] 模块现行文档、变更时间线、项目决策与 Phase 1 顺序一致，完成后停止于本阶段。

### 实际验收记录

**2026-11-22** 实际验收环境：Node.js `v26.8.2`、npm `11.19.1`。本次完整工程验收覆盖既有 76 项回归与新增 33 项 Tool 测试；Phase 1.1 的独立历史结果继续保留。

| 命令                   | 结果                                           |
| ---------------------- | ---------------------------------------------- |
| `npm run typecheck`    | 通过；源码和测试严格类型检查                   |
| `npm run lint`         | 通过；0 错误、0 警告                           |
| `npm run format:check` | 通过；全仓格式检查                             |
| `npm run build`        | 通过；源码构建到 `dist/`                       |
| `npm test`             | 通过；109 项通过、0 失败、0 跳过（含自动构建） |

测试构成：既有 Model/Logging/工程回归 76 项，加 Tool Contracts 6 项、Runtime Tool 14 项、工具集成 13 项，共 109 项。`git diff --check` 通过；`git diff --quiet -- src/harness/contracts/model src/runtime/model` 通过，确认 Phase 1.1 源码与公共模型契约未改。

常规验证不依赖真实模型、API Key 或外部服务，本次未进行真实模型/API 调用。并发/注销隔离使用可控异步屏障等方式验证实际交错；取消测试区分“Executor 已停止等待”和“Handler 底层工作仍可能继续”。

## 8. 关联文档

- [Tool Contracts](../src/harness/contracts/tool/README.md) / [契约时间线](../src/harness/contracts/tool/changes.md)
- [Runtime Tool](../src/runtime/tool/README.md) / [实现时间线](../src/runtime/tool/changes.md)
- [Model System 历史验收](phase-1.1.md)、[Phase 1 索引](phase-1.md)、[路线图](roadmap.md)
- [架构](architecture.md)、[工程规范](conventions.md)、[项目决策](changes.md)
