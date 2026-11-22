# Phase 1.1 — Model System

> 基线：用户于 **2026-11-21** 确认的《Phase 1.1 Model System 技术方案 V1.1》。Phase 0 与统一 Logging 基线已完成，本阶段在既有 Logger 上实施 Model System，不自动进入 Phase 1.2。
>
> 交付状态：**2026-11-21 已完成 Phase 1.1 实现与离线工程验收**。76 项测试通过、0 失败、0 跳过；未进行真实 Provider/API 调用验证，不自动接续 Phase 1.2。

> 本文件保留 **Phase 1.1 的实现基线与 76 项历史验收**。Phase 1.2 Tool Runtime 已完成，当前阶段见 [Phase 1.3 Agent Loop](phase-1.3-agent-loop.md)；以下非目标针对 Model System 的职责和当时阶段，不表示独立 Tool Runtime 仍属未实现能力。Model 不执行工具，Tool Runtime 通过桥接复用其数据类型；完整循环由当前 Phase 1.3 的 DefaultAgentLoop 实现。

## 1. 目标与职责

建立能够由后续 Agent Loop 稳定依赖、可替换 Provider、支持并发的统一模型组件：

- **Harness**：`src/harness/contracts/model/` 定义公共消息、请求、生成参数、响应、工具调用、流式事件、调用选项、错误与 ModelClient。
- **Runtime**：`src/runtime/model/` 实现 OpenAI-compatible **Chat Completions** Adapter，处理协议映射、HTTP/SSE、工具增量组装、错误转换及统一生命周期日志。
- **Composition / Bootstrap（后续）**：创建、配置和注入 ModelClient。当前允许调用方直接实例化 Adapter，不引入完整 Agent 装配。

不改变四个运行职责层、横向 Harness 和 Composition 的整体架构。Harness 提供契约，模型请求不要求经过 Harness 中间转发。

## 2. 公共契约与行为要求

公共入口为 `src/harness/contracts/model/index.ts`；不直接依赖 OpenAI SDK 类型。

| 契约                                | 要求                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| ModelMessage                        | system、user、assistant、tool 以 role 区分；文本输入，assistant 支持 null 文本及 toolCalls |
| ModelToolDefinition / ModelToolCall | 工具只含定义；参数输出保留原始 argumentsJson，不解析、修复或校验 JSON                      |
| ModelRequest                        | 每次请求提供 model、完整 messages、可选 tools/toolChoice/parameters；不维护历史            |
| ModelParameters                     | temperature、maxOutputTokens 统一参数及 `[key: string]: unknown` 扩展参数                  |
| ModelCallOptions                    | AbortSignal 与 timeoutMs 控制单次调用，不属于生成参数                                      |
| ModelResponse                       | 完整 assistant 消息、统一 finishReason、可选 id/usage；不伪造 Provider 缺失字段            |
| ModelClient                         | generate 返回 Promise<ModelResponse>；stream 返回 AsyncIterable<ModelStreamEvent>          |
| ModelError                          | code、message、retryable、可选 status 的统一异常，不泄露配置或认证信息                     |

finishReason 为 stop、tool_calls、length、content_filter 或 other。Usage 的 inputTokens/outputTokens/totalTokens 均可选；优先使用 Provider 返回的 model，缺失时回退到请求 model，该回退不代表确认后端版本。

ToolResult 通过 toolCallId 关联调用；isError 表示工具执行错误。Chat Completions 缺少独立错误标志时，Adapter 将其转为明确的错误文本，保留语义。

### 参数映射和校验

- 所有生成参数只放在 `parameters`。temperature 映射同名字段；maxOutputTokens 默认映射 max_completion_tokens，可通过 Adapter 固定配置 maxTokensField 选择 max_tokens。
- top_p、seed 等扩展字段保留原名和值；不穷举 Provider 全部参数。只有 Provider 能判断的支持情况由其响应决定，再归一为 ModelError。
- 拒绝扩展字段覆盖 model、messages、tools、tool_choice、stream 等核心协议控制字段。
- 同时提供 maxOutputTokens 与等价原生 token 限制字段时拒绝歧义配置，不按对象覆盖顺序选值。
- 检查非空 model/messages、消息结构、工具名称及 toolCallId、标准参数、toolChoice 与 tools 一致性。required 与空工具列表返回 invalid_request。
- 已明确不支持的能力返回 unsupported_capability，不能静默忽略。Runtime 不修改调用方的请求、消息或参数。

### 流式生命周期

成功顺序为 `message_start` → 零个或多个 `text_delta` / `tool_call_delta` → `message_end`。开始/结束各一次；结束事件带完整响应，文本和工具参数与增量拼接一致。

每次请求按工具 index 独立组装，可交错接收多个工具调用，id/name 可晚于参数出现。片段中的 `null` 或空白 id/name 视为尚未提供，不覆盖已确定值；已确定 id/name 的冲突或结束时缺少必要字段返回 invalid_response。index 不进入最终 ModelToolCall。失败、超时或取消通过迭代抛出 ModelError，不能产生成功结束事件。

流在实际开始消费时才发请求并启动计时。timeoutMs 覆盖完整响应读取或完整流消费；提前停止迭代应取消请求并释放连接。模型请求取消不保证服务端立即停止计算。

### 实例复用与并发

单个 ModelClient 实例支持 generate/generate、stream/stream 和 generate/stream 并发，不通过全局锁或队列串行执行。固定配置与 HTTP 能力可以共享；请求对象、响应状态、文本、ToolCall 缓存、AbortController 和计时器必须逐调用隔离。

取消、超时或失败的请求不得影响同实例其他调用，实例此后仍可复用。ModelClient 不负责 Session 串行性、Execution 调度、全局限流或负载均衡。

### 统一生命周期日志

ModelClient 从实现基线起依赖 [Runtime Logging](../src/runtime/logging/README.md) 门面，默认使用 createLogger，也可通过固定配置 `logger` 注入自定义实现。日志使用 stderr 和结构化字段；调用开始、正常完成、归一失败与提前结束按真实生命周期记录，不把失败或未完整消费记成成功。

只记录诊断元数据，避免将消息、工具定义/参数、请求/响应正文、认证头、URL、密钥或原始底层异常传入日志。并发请求的日志关联与状态跟随各自调用，不能污染其他请求；日志事件也不进入 ModelStreamEvent 或消息历史。默认模块为 `runtime.model.openai-compatible`，每次实际调用使用独立 requestId。开始使用 debug、完成使用 info；取消/超时或调用方提前结束使用 warn，其他归一失败使用 error。日志初始化或写入故障不能改变模型调用的结果。具体事件、字段与测试以 [Runtime Model README](../src/runtime/model/README.md) 为准。

## 3. 实现取舍与方案差异

- 使用 Node.js 内置 fetch 和 Web Streams 处理 HTTP/SSE，日志复用已完成的 Pino 10.4.0 / Logger 基础设施，不增加模型 SDK 运行时依赖。
- 在方案的 apiKey/baseURL 配置之外增加可选 `fetch` 注入，支持离线集成测试或调用方提供 HTTP 能力；增加可选 `maxTokensField` 固定配置，以显式适配两种 token 限制字段；`logger?: Logger` 支持注入既有统一门面，未提供时使用 createLogger。公共 ModelClient/ModelRequest 契约保持方案定义。
- 参数 JSON 不被 Model System 解析；工具执行、Schema 校验与纠错由后续组件负责。
- 不引入自动环境变量读取、配置热更新、自动重试或 fallback；错误的 retryable 只表示可重试性质。
- 不承诺兼容所有非标准 OpenAI-compatible 扩展；明确不支持的输入或响应形态不能被当作完整文本响应接受。

具体配置、字段限制、SSE 完成条件和错误映射以 [Runtime Model README](../src/runtime/model/README.md) 为准。

## 4. 非目标

不实现 Agent Loop、Execution Engine、Session、CLI、Tool Runtime/实际工具执行、多模态、Reasoning Content 专用协议、Responses API、Anthropic/Gemini 原生协议、Model Registry、路由/负载均衡、全局并发控制/队列、自动重试/Fallback、上下文管理/Token Budget 或完整插件框架。

后续阶段仍需用户明确授权；完成本阶段不自动接续 Phase 1.2。

## 5. 验收要求

- [x] 公共契约与类型导出完整，支持替换实现且不依赖 Provider SDK。
- [x] 非流式/流式文本、多轮消息、Tool Definition/Calling/Result、多个工具交错组装正确。
- [x] 标准参数映射、扩展参数透传、保留字段与等价参数冲突处理正确，不修改原请求。
- [x] finishReason/usage/model 映射符合实际数据，不伪造缺失字段或成功状态。
- [x] 九类 ModelError 均有相应验证；错误消息不泄露 API Key 或 Authorization 信息。
- [x] 取消与超时可区分；超时覆盖完整调用；懒消费与提前结束释放资源。
- [x] 单实例 generate、stream、混合并发实际重叠；相同工具 index、不同模型/参数、取消/失败均相互隔离。
- [x] 生命周期日志覆盖调用开始/完成/失败/提前结束，元数据安全、单请求关联及注入 Logger 行为正确。
- [x] 类型检查、lint、格式检查、构建及全部离线测试通过，不依赖真实密钥或外部模型服务。
- [x] 项目级与模块级现行文档准确，变更记录按层级追加，未实现能力明确标记。

### 实际验收记录

**2026-11-21** 实际验收环境：Node.js `v26.8.2`、npm `11.19.1`。Phase 0 与统一 Logging 基线继续适用；Logging 的独立 20 项历史验收保留在 [项目级时间线](changes.md)。以下结果覆盖当前完整工程、Model System 及生命周期日志。

| 命令                   | 结果                                          |
| ---------------------- | --------------------------------------------- |
| `npm run typecheck`    | 通过；源码和测试的严格类型检查                |
| `npm run lint`         | 通过；0 错误、0 警告                          |
| `npm run format:check` | 通过；全仓格式检查                            |
| `npm run build`        | 通过；源码构建到 `dist/`                      |
| `npm test`             | 通过；76 项通过、0 失败、0 跳过（含自动构建） |

测试构成：日志行为 11 项、脱敏 8 项、Harness 契约 5 项、Model Runtime 19 项、模型集成/并发 15 项、模型生命周期日志 16 项、源码/构建 smoke 2 项，共 76 项。契约类型约束同时通过 typecheck 验证。

常规测试通过注入 fetch 传输、真实 Response/ReadableStream 字节流，覆盖真实 Adapter 的请求/响应/SSE 转换、工具组装和可控并发，而不只验证模拟返回值。当前执行环境禁止绑定本地监听端口（listen 返回 EPERM），因此集成测试不启动本地 HTTP 服务，也不访问外部模型。真实 Provider 烟测为可选，不作为离线验收前提；本次未进行真实模型调用。

## 6. 文档与关联记录

- [公共契约与行为语义](../src/harness/contracts/model/README.md) / [契约时间线](../src/harness/contracts/model/changes.md)
- [Adapter 使用与实现](../src/runtime/model/README.md) / [Runtime Model 时间线](../src/runtime/model/changes.md)
- [Harness 模块](../src/harness/README.md) / [Harness 时间线](../src/harness/changes.md)
- [Logging 基础设施](../src/runtime/logging/README.md) / [Logging 时间线](../src/runtime/logging/changes.md)
- [Runtime 模块](../src/runtime/README.md) / [Runtime 时间线](../src/runtime/changes.md)
- [全局架构](architecture.md)、[工程规范](conventions.md)、[项目级决策](changes.md)、[路线图](roadmap.md)
