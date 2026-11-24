# Runtime Model — OpenAI-compatible 模型访问

## 定位与当前实现

Phase 1.1 已提供 `OpenAICompatibleModelClient`，实现 [Harness ModelClient](../../harness/contracts/model/README.md) 的 `generate()` / `stream()` 契约。使用 Node.js 内置 `fetch` 和标准 Web Streams，复用已完成的 [Logging 基础设施](../logging/README.md)。模型认证配置由调用方显式传入，默认 Logger 在自身初始化边界读取 `LOG_LEVEL`。

本模块负责模型请求、协议映射、流式组装、错误归一和请求资源生命周期。它不管理历史消息，不执行 ToolCall，不提供 Agent Loop、Execution Engine、Session、CLI、模型路由、队列、重试或 Fallback。

## 对外入口与配置

从 `src/runtime/model/index.ts` 导入实现和配置类型；项目根入口也导出这些接口。

```typescript
import { OpenAICompatibleModelClient } from './src/runtime/model/index.ts';

const apiKey = process.env.OPENAI_API_KEY;
const client = new OpenAICompatibleModelClient({
  ...(apiKey === undefined ? {} : { apiKey }),
  baseURL: 'https://api.openai.com/v1',
});

const response = await client.generate({
  model: 'example-model',
  messages: [{ role: 'user', content: '你好' }],
  parameters: { temperature: 0.7, maxOutputTokens: 256, top_p: 0.9 },
});

console.log(response.message.content);
```

模型配置由调用方在初始化边界传入，Adapter 不读取模型密钥环境变量。示例仅在存在密钥时添加 `apiKey`；无密钥的本地服务可以省略该字段。

| 配置                                                       | 规则                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey?: string`                                          | 可选；提供非空值时使用 `Authorization: Bearer ...`；拒绝换行                                                                        |
| `baseURL?: string`                                         | 默认 `https://api.openai.com/v1`；指向 API 根路径；追加 `/chat/completions`；只接受无用户名、密码、query 和 fragment 的 HTTP(S) URL |
| `logger?: Logger`                                          | 可选的供应商无关 Logger；通过 child 建立 `runtime.model.openai-compatible` 模块；不提供时创建默认 Logger                            |
| `fetch?: typeof globalThis.fetch`                          | 默认 Node.js 内置 fetch；允许调用方注入测试或自定义 transport                                                                       |
| `maxTokensField?: 'max_completion_tokens' \| 'max_tokens'` | 默认 `max_completion_tokens`；旧兼容服务可以选择 `max_tokens`                                                                       |

`fetch`、`maxTokensField` 和 `logger` 是方案中最小配置的可选扩展，分别支持可替换传输、Token 字段差异和统一日志注入。配置在创建实例时复制，不提供热更新。

## 请求与参数映射

- `model` / `messages` 按当前调用传入；模型不固定在实例上。System、User 是文本；Assistant 支持文本与 ToolCall；ToolResult 通过 `tool_call_id` 关联。
- Assistant 工具调用映射为 `{ type: 'function', function: { name, arguments } }`；`argumentsJson` 始终作为原始字符串保留，不解析或修复。
- Tool Definition 的参数 Schema 保持 JSON 对象。工具名称为 1–64 个字母、数字、下划线或连字符；同一列表名称唯一。
- Chat Completions 没有独立 `isError` 字段。`isError: true` 将 ToolResult 文本映射为 `[Tool execution error]\n` 加原始文本，不会把工具执行失败当作模型请求失败。
- `toolChoice` 映射为 `tool_choice`；`required` 需要至少一个工具定义。
- `parameters.temperature` 保留同名协议字段，要求有限数且在 `[0, 2]`。
- `parameters.maxOutputTokens` 必须是正安全整数，映射到配置选定的 Token 字段。它不能与 `max_tokens` / `max_completion_tokens` 同时出现；两个原生 Token 字段也不能同时出现。
- 扩展参数保留名称和值，包括嵌套 JSON 对象。无法原样表达为 JSON 的值（循环、`undefined`、非有限数、BigInt、函数、非普通对象等）返回 `invalid_request`，避免序列化静默改写。
- 扩展参数不能覆盖 `model`、`messages`、`tools`、`tool_choice`、`stream`。
- `n: 1` / `n: null` 可以透传，多个响应候选返回 `unsupported_capability`；旧 `functions` / `function_call`、`audio` / `modalities` 返回 `unsupported_capability`。其他扩展字段交给 Provider 判断，并归一其错误。
- 流请求默认附加 `stream_options: { include_usage: true }`；可以用原生 `stream_options` 明确选择该服务支持的行为。非 null 的 `stream_options` 只适用于流式请求，`include_usage` 如提供必须是 boolean；原生 `stream_options: null` 可在两种模式下原样透传，流式模式下不会被默认 Usage 配置覆盖。

映射生成独立的 Provider 请求对象，不改写调用方的请求、消息、Schema 或参数。模型 fallback 使用实际发送时的请求快照。Provider 返回 `model` 时优先保留实际标识；缺少该字段时使用请求标识，这不代表已确认后端版本。

## 响应与流式协议

`generate()` 返回完整 `ModelResponse`，Usage 仅映射 Provider 实际提供的 `prompt_tokens` / `completion_tokens` / `total_tokens`，不补零、不推算。结束原因映射为 `stop`、`tool_calls`、`length`、`content_filter` 或 `other`。缺少必需字段、无效工具调用或 `tool_calls` 结束却没有工具，返回 `invalid_response`。

```typescript
for await (const event of client.stream({
  model: 'example-model',
  messages: [{ role: 'user', content: '你好' }],
})) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'message_end') console.log(event.response.usage);
}
```

SSE 按 UTF-8 增量解码，支持任意字节分片、LF/CRLF/CR 行结束、注释和多行 `data`。正常流只产生一次 `message_start`，随后按观察顺序产生文本/工具增量；要求有效 `finish_reason` 和 `[DONE]` 才能正常完成，EOF 截断不会被当作成功。`choices: []` 的最终 Usage 块可以位于 finish 块和 `[DONE]` 之间。

每个 ToolCall 按当前请求的 `index` 独立组装；id/name 可以后到，但已确定的值不能被不同值覆盖。片段中的 `null` 或空白 id/name 视为尚未提供：不写入对应增量，也不覆盖已确定值。消息或增量中的 `tool_calls: null` 表示这一段没有工具调用；工具片段里的 `null` 或空白 `type`、`function: null` 和 `arguments: null` 也表示尚未提供，不写入参数增量。参数片段按顺序连接，最终工具列表按 index 排列且不暴露 index。最终必须实际收到有效 id/name 和 arguments 字符串（允许原始字符串不是合法 JSON）；空白片段不能代替这些必需字段，也不能伪造缺失工具字段或重复调用 ID。

正常完成后先释放 reader、超时与取消资源，再发送最后且唯一的 `message_end`。失败、取消和超时以 `ModelError` 抛出，不产生成功结束事件。流内错误帧也会归一为异常。未正常结束的 ToolCall 不能作为已完成调用执行。

## 并发与生命周期

实例仅保留固定配置、fetch 和模块 Logger；所有请求对象、文本、工具 Map、AbortController、timer、Usage 和错误状态均在调用内独立创建。多个 generate、多个 stream 及混合调用可以自然重叠，不使用全局锁或请求队列。

`stream()` 是惰性的：开始消费迭代器时才发请求并启动计时。

- `signal` 主动取消返回 `aborted`，不暴露取消原因；预先取消不会访问 transport。
- `timeoutMs` 为 `1..2147483647` 的整数，覆盖当前请求完整生命周期，包括响应体和流式消费；不提供时不设置客户端超时。
- 请求各自拥有取消控制；取消或超时不会关闭共享客户端，不影响其他请求或后续复用。
- HTTP 调用与每次 body read 同时观察取消，即使注入的 fetch 不响应 signal，调用也可终止；reader 尽可能取消，迟到的 HTTP body 也会被释放。
- `break` / 迭代器 `return()` 释放 reader 与底层请求。取消不能保证 Provider 服务端立即停止计算。

## 统一生命周期日志

Model System 基于已完成的 Logger 门面记录运行诊断，不在消息、ToolCall 或流式事件中插入日志。可以复用项目 logger：

```typescript
import { createLogger } from './src/runtime/logging/index.ts';

const logger = createLogger({ module: 'easy-agent', level: 'debug' });
const client = new OpenAICompatibleModelClient({ logger });
```

注入 Logger 通过 `child('runtime.model.openai-compatible')` 创建模块视图；默认 Logger 也使用该模块，沿用 Logging 的 stderr、JSON 和级别配置，并把当前 API Key 加入已知敏感值列表。创建客户端本身不产生日志。

每次调用拥有独立 UUID `requestId`，并记录 `operation`（generate/stream）和可用的请求模型快照。Logger 收到的字段已先经过安全序列化与已知密钥脱敏，不能假设注入的实现具备脱敏能力；Provider 返回的 model/id 不写入日志。

| 等级  | event                     | 诊断字段                                                 |
| ----- | ------------------------- | -------------------------------------------------------- |
| debug | `model.request.started`   | requestId、operation、请求 model（可用时）               |
| info  | `model.request.completed` | durationMs、finishReason、Provider 实际给出的统一 usage  |
| warn  | `model.request.cancelled` | durationMs、code：aborted / timeout / consumer_return    |
| error | `model.request.failed`    | durationMs、code、retryable、可用 status、重建的安全 err |

每个已消费调用只产生一次开始和一个终态。输入或调用选项校验失败也记录统一错误码；不会把底层错误消息、堆栈或 cause 直接转发。失败日志的 err 是用固定安全消息和统一错误字段重新构造的 ModelError，结构化保存类型和错误码，避免 Provider 原始异常穿透。

成功日志不包含响应文本，完成字段只来自已验证的结束原因与数值 usage；不记录 messages、工具参数、生成参数、API Key、Base URL、Header 或 Provider 原始异常，也不逐 chunk 记录日志。当前本地 requestId 仅用于关联一次模型调用，未引入 Session 或完整 tracing。

流式开始消费时才创建调用日志。正常结束先释放 reader、取消监听与 timer，再记录成功并发送 message_end；提前 break/return 释放资源并以 consumer_return 记录 warn，不产生成功日志；若消费暂停期间已经收到取消或超时，则保留其 aborted/timeout 原因。失败、主动取消和超时分别记录一次对应终态。

日志采用尽力写入语义：Logger 的创建、child 或写入异常不会改变模型结果、ModelError、取消/超时或资源清理。写入方法意外返回 Promise 时也接管其拒绝，但不等待日志完成或提供 flush 承诺。若模块 Logger 初始化失败，该客户端继续工作并跳过日志；不增加备用输出渠道或把日志错误塞入模型响应。

## 错误语义与敏感信息

所有错误使用 Harness 的 `ModelError`。HTTP 401/403 对应 `authentication`，429 对应 `rate_limit`，400/404/405/409/413/422 对应 `invalid_request`，408/504 对应 `timeout`，其余 HTTP 失败对应 `provider_error`。连接/读取失败为 `network`，协议不完整为 `invalid_response`，可识别的不支持能力为 `unsupported_capability`。

公开错误仅使用固定文本、错误码与 HTTP 状态，不附加 Provider 正文、Header、URL、密钥、原始网络异常或取消原因。`retryable` 是提示，不会触发自动重试。

## 关键文件与离线验证

| 文件                                    | 职责                                |
| --------------------------------------- | ----------------------------------- |
| `providers/openai-compatible/client.ts` | 可复用客户端、HTTP 调用和流生命周期 |
| `request.ts`                            | 请求校验、参数和消息映射            |
| `response.ts`                           | 响应、结束原因和 Usage 映射         |
| `stream-state.ts`                       | 单请求文本和 ToolCall 组装          |
| `sse.ts`                                | UTF-8 / SSE 增量解码和 reader 释放  |
| `lifecycle-log.ts`                      | 请求级日志关联、终态与安全元数据    |
| `call-context.ts` / `errors.ts`         | 单请求取消、超时、统一错误          |

在仓库根目录运行 `node --test tests/model-runtime.test.ts tests/model-integration.test.ts tests/model-logging.test.ts`。单元测试覆盖真实转换逻辑；集成测试注入 fetch 和标准 Response/ReadableStream，覆盖交错并发、逐字节 SSE、取消、超时、提前退出与异常隔离，不需要真实 Key 或外部服务。`npm test` 包含契约和构建导入检查。项目完整质量命令见 [工程规范](../../../docs/conventions.md)。

空白工具标识的仓库固定回归用例位于 `tests/model-runtime.test.ts`：覆盖 null、空字符串、空格、制表/换行及 Unicode 空白片段不覆盖既有标识，初始占位的 id/name 可分别后补，最终缺失或非空冲突仍被拒绝，参数按原始片段拼接。`tests/agent-loop-integration.test.ts` 使用真实 Model/Tool Runtime 与 DefaultAgentLoop，验证两个工具 index 交错分片、占位标识不进入增量字段、按 index 执行工具、完整结果回填及最终回答，且不触发重试。

真实服务调用未作为本次验收条件，尚未验证全部第三方非标准扩展。完整非目标见 [Phase 1.1](../../../docs/phase-1.1.md)，历史见 [changes.md](changes.md)。协议依据：[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。
