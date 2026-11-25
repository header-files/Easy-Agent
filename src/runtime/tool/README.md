# Runtime Tool — 本地 TypeScript 工具执行

## 定位与当前实现

Phase 1.2 实现 [Harness Tool Contracts](../../harness/contracts/tool/README.md)，为后续 Agent Loop 提供可复用的 `DefaultToolRegistry` 与 `DefaultToolExecutor`。Registry 保存声明和本地函数，Executor 负责解析、Schema 校验、执行控制和结果归一。桥接函数复用 Phase 1.1 Model 类型，不请求模型，也不改变模型契约。

当前只执行调用方明确注册的本地 TypeScript Handler。没有 Agent Loop、模型—工具—模型循环、执行引擎、Session、MCP、Skill、Sandbox、Approval、工具发现、持久化、队列、全局并发限制、自动重试或副作用补偿。

## 公共入口与使用

从 `src/runtime/tool/index.ts` 导入 Registry、Executor、两个转换函数和 `DefaultToolExecutorOptions`；公共 Tool 类型从 Harness Tool Contracts 导入。

```typescript
import {
  DefaultToolExecutor,
  DefaultToolRegistry,
  toModelToolDefinition,
  toToolResultMessage,
} from './src/runtime/tool/index.ts';

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
  (args, context) => ({
    content: `Hello ${args.name}, call ${context.toolCallId}`,
  }),
);

const executor = new DefaultToolExecutor(registry);
const definitions = registry.list().map(toModelToolDefinition);
const result = await executor.execute(
  {
    id: 'call_001',
    name: 'greet',
    argumentsJson: '{"name":"Easy Agent"}',
  },
  { timeoutMs: 1000 },
);
const message = toToolResultMessage(result);
```

`definitions` 可由未来调用方传入 ModelRequest；`message` 可加入后续模型请求历史。上例仅做数据转换，不自动调用模型。

`new DefaultToolExecutor(registry, { logger? })` 接受统一 Logger 门面，默认建立 `runtime.tool.executor` 模块；注入时使用同名子 logger。Registry 和 Executor 可以长期复用，不需要每次调用重新创建，也不依赖全局容器。

## 注册、查询与快照

`DefaultToolRegistry` 使用进程内 Map，支持 `register`、`get`、`list` 和 `unregister`。

- 名称为 1–64 个英文字母、数字、下划线或连字符，与 Model Adapter 的工具名称规则一致；description 必须是字符串。
- 注册声明为普通数据对象，name/description/parameters 必须是自身的数据属性，拒绝 accessor 和继承字段，避免校验与保存之间发生值变化。
- Handler 必须是函数，重复名称明确抛出安全的普通 Error，不静默覆盖。注册失败不留下部分记录。
- parameters 和整个声明在注册时防御性深拷贝。只接受可表达为 JSON 的有限数、字符串、boolean、null、数组与普通对象，不执行自定义 getter / toJSON；循环或非 JSON 值拒绝。
- `get()` 和 `list()` 每次返回独立声明，外部修改嵌套 Schema 不影响内部状态。Handler 保留函数引用；具体函数访问的共享资源仍由 Handler 自行管理。
- `unregister()` 只影响后续查询；返回是否移除了记录。可以在注销后显式注册同名新工具。

注册错误不新建公共异常协议；消息固定且不包含原始 Schema、名称或其他敏感配置。

## JSON Schema 与严格输入

使用直接生产依赖 **Ajv 8.20.0**，采用 draft-07 的同步 JSON Schema。parameters 根必须是普通 JSON 对象，不能是 boolean 或数组；可使用 `{}`、对象 Schema、组合约束和当前 Schema 内可解析的 `$ref`。若根显式声明 type，则必须允许 object；不额外计算复杂组合的可满足性。

注册时实际编译 Schema，错误的 Schema、未知关键字、未支持的 format、无法解析的引用、其他未支持的草案和异步 `$async` Schema 均被明确拒绝。当前不安装 formats/keywords 插件，不加载远端 Schema、不配置 `loadSchema`，不建立跨工具 Schema 注册表。每份 Schema 使用独立 Ajv 实例，相同 `$id` 不会污染其他工具。

执行时只有一次 Registry 查询。Executor 立即复制返回声明和 Handler 引用，并为该快照编译校验器；当前小规模本地工具不引入跨调用校验器缓存协议。这也支持任意满足公共 ToolRegistry 的替代实现。

`argumentsJson` 先由 JSON.parse 解析，再强制要求非 null、非数组的对象，最后通过对应 Schema。即使 `{}` Schema 不限制类型，数组或标量也不能进入 Handler。解析失败、缺少必填字段、类型/范围不符或 Schema 禁止的未知字段均返回 `invalid_arguments`，不调用 Handler。

校验明确禁用 `useDefaults`、`coerceTypes` 和 `removeAdditional`：不补默认值、不强制转换类型、不删除未知字段。额外字段由工具自己的 `additionalProperties` 等约束决定。每次解析产生独立参数对象，原始 ToolCall 和 argumentsJson 不被改写。

## 执行结果与错误

| 情况                                            | 行为                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| 合法 Handler 返回 `{ content: string }`         | `ToolResult.status = 'success'`，保留原字符串    |
| 工具不存在                                      | error，`tool_not_found`                          |
| ToolCall、执行选项、JSON 或参数不合法           | error，`invalid_arguments`                       |
| Handler 抛错、拒绝或返回非法输出                | error，`execution_failed`，不重试                |
| Registry 提供不合法的注册记录或执行基础步骤失败 | error，`execution_failed`                        |
| 调用方取消 / 调用超时                           | 抛出 `ToolExecutionError('aborted' / 'timeout')` |

调用身份、参数文本与控制选项在执行前各读取一次，Handler 返回的 content 也只读取一次再校验。结果始终保留本次调用的 toolCallId 与 name。非法输入缺失或不是字符串的身份字段使用空字符串，已有字符串原样保留；这只是无效输入的诊断回传，不能据此视为有效 ToolCall，不虚构调用 ID。

普通失败的 content 和 error.message 使用固定、可理解的文本，不回传 Handler 原始异常、堆栈、Schema、参数或取消原因。Handler 自行抛出的 ToolExecutionError 也属于 `execution_failed`；只有当前 Executor 的取消/超时控制能产生对应的控制异常。

## 取消、超时与并发

`signal` 和 `timeoutMs` 属于单次调用选项。timeoutMs 如提供，要求 `1..2147483647` 的整数；非法选项归为 invalid_arguments。先校验调用与选项，再检查预先取消状态；有效且预先取消的调用不会查询工具或执行 Handler。

每次调用创建独立 AbortController、超时 timer、deadline 和拒绝竞态。Handler 接收当前 toolCallId 和独立 signal。取消或超时会立即通知该 signal，并及时停止 Executor 的等待，即使 Handler 忽略 signal；迟到的 Promise 拒绝会被接管，不产生未处理拒绝。正常结束或失败会清理 timer 和外部监听；成功不会额外向 Handler 发取消信号。

timeout 覆盖整次执行，包括本地校验和 Handler。同步 JavaScript 阻塞期间无法被 timer 强制打断；控制会在后续边界检查 deadline。AbortSignal 是协作式机制，停止等待不表示 Handler 底层操作已停止，也不表示副作用被回滚；没有进程隔离、事务补偿或强杀功能。

同一 Executor 允许不同工具及同一工具的多调用重叠，各自参数、结果、信号和控制状态独立。不使用全局锁串行调用；一个调用失败或取消不影响其他调用。Registry 在途快照在首次 await 前确定，之后注销/重注册只改变新调用，不能替换正在执行的 Handler。

## Model Bridge

`toModelToolDefinition(spec)` 返回同字段模型声明并深拷贝 Schema。`toToolResultMessage(result)` 返回 role=tool、toolCallId、content，并将 status=error 映射为 isError=true。原始对象均不被修改。

`ToolCall` 与 `ModelToolCall` 结构兼容，可直接作为 Executor 输入；没有重复定义模型协议，没有 Provider SDK 依赖。工具失败通过 Model Adapter 既有的 ToolResult 错误文本映射进入后续模型请求，取消/超时异常不能伪装成普通工具结果。

## 统一日志

Executor 通过既有 Logger 记录安全生命周期：debug 开始，success 为 info，普通输入/缺失工具失败为 warn，execution_failed 为 error，取消/超时为 warn。字段只含本地 UUID executionId、事件、可用合法工具名、durationMs、status 和统一错误码，不记录原始 ToolCall ID、argumentsJson、解析参数、Schema、结果内容或 Handler 异常。

元数据在传入任意 Logger 实现前安全序列化；创建、child、写入抛错及写入 Promise 拒绝不会改变工具结果或控制异常。默认输出 stderr，不写 stdout，不创建完整 tracing 或额外业务事件系统。

## 文件与离线验证

| 文件                       | 职责                                         |
| -------------------------- | -------------------------------------------- |
| `default-tool-registry.ts` | Map 注册、去重、查询与声明快照               |
| `default-tool-executor.ts` | 单次执行流程、固定结果和安全日志             |
| `tool-validator.ts`        | 声明 JSON 复制、Schema 编译与参数对象约束    |
| `execution-control.ts`     | 单调用选项快照、取消、deadline、timer 与竞态 |
| `model-bridge.ts`          | 复用 Model 类型的两个数据转换函数            |
| `index.ts`                 | Runtime Tool 公共导出                        |

运行 `node --test tests/tool-runtime.test.ts tests/tool-integration.test.ts` 验证注册、Schema、Handler、错误、快照、并发、控制和桥接；`npm test` 还包含公共契约及已有 Model/Logging 回归。所有常规验证均离线，不访问模型、网络服务、数据库或真实 API Key。完整工程命令见 [工程规范](../../../docs/conventions.md)，当前范围见 [Phase 1.2](../../../docs/phase-1.2.md)，历史见 [changes.md](changes.md)。

Schema 行为依据：[Ajv options](https://ajv.js.org/options.html)、[Schema management](https://ajv.js.org/guide/managing-schemas.html)、[JSON Schema](https://ajv.js.org/json-schema.html)。

## Phase 2.2：Guarded 与内置 FileSystem

- `GuardedToolExecutor`：校验 → 审批（不持锁、不计工具超时）→ Workspace 锁 → Handler；批准后使用审批快照中的 `arguments`，不以调用方可变对象为准。
- `builtins/safe-fs.ts`：读写打开尽量带 `O_NOFOLLOW`；无该标志时对 Workspace 根到目标做逐组件 `lstat`，无法证明无链接则拒绝。新建用 `O_EXCL`；覆盖/编辑先写同目录临时文件再 `rename`，rename 前失败保留原文件。
- `list_directory`：Node 无法按目录 fd `scandir`，故 `openDirRead` 持句柄，`readdir(path)` 前后及每个子项 `lstat` 前后用 `dev`/`ino` 校验路径仍指向同一目录；替换为区外符号链接则失败关闭。无 `openat` 时子项检查—使用仍有残留 TOCTOU；Windows Junction 需原生再验。
- `TerminalExecutor`（POSIX）：`detached` 自有进程组；Shell `exit` 后轮询组内是否仍有成员，空闲后才返回；超时/取消则杀组，仍存活则 UNSAFE。脱离进程组的 daemon 仍无法保证。Windows 树检测为 best-effort。
- 详见 [Phase 2.2](../../../docs/phase-2.2.md) 与 [changes.md](changes.md)。
