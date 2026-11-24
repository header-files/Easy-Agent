# Model Contracts — 模型调用公共契约

## 定位与实现状态

**Phase 1.1 已实现公共契约。** 本模块为调用方和 Runtime Model Adapter 定义统一、可替换的模型访问边界；不依赖任何 Provider SDK，不提供网络传输，也不作为请求必经代理。

调用方使用可复用的 `ModelClient` 实例，通过 `generate(request, options?)` 获取 `Promise<ModelResponse>`，或通过 `stream(request, options?)` 获取 `AsyncIterable<ModelStreamEvent>`。同一实例必须支持 generate/generate、stream/stream 与两者混合并发；不要求每次调用重新创建实例。

## 公共入口与类型

唯一公共导出入口为 [`index.ts`](index.ts)。

| 文件                                     | 主要类型及职责                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| [`model-client.ts`](model-client.ts)     | ModelClient、ModelCallOptions：方法与调用控制                                 |
| [`model-catalog.ts`](model-catalog.ts)   | ModelDescriptor、ModelCatalog：已注册模型的只读查询与列表                     |
| [`model-message.ts`](model-message.ts)   | SystemMessage、UserMessage、AssistantMessage、ToolResultMessage、ModelMessage |
| [`model-request.ts`](model-request.ts)   | ModelRequest、ModelParameters：模型标识、完整消息历史、工具和参数             |
| [`model-tool.ts`](model-tool.ts)         | ModelToolDefinition、ModelToolCall、ModelToolChoice                           |
| [`model-response.ts`](model-response.ts) | ModelResponse、ModelFinishReason、ModelUsage                                  |
| [`model-stream.ts`](model-stream.ts)     | ModelStreamEvent：有序的流式事件联合                                          |
| [`model-error.ts`](model-error.ts)       | ModelErrorCode、ModelErrorInfo、ModelError                                    |

`ModelCatalog` 只表达显式注册模型的只读视图，不承担路由或网络发现；路由由 Runtime `ModelRouter` 实现现有 `ModelClient` 完成。

`ModelMessage` 通过 `role` 区分 system、user、assistant 和 tool。System/User 只接收文本；Assistant 的 `content` 为 `string | null`，可包含 `toolCalls`；ToolResult 使用 `toolCallId` 关联调用。历史消息由调用方组织，Model System 不持有 Session、Turn 或 Execution。

## 参数约定

`model` 在每次请求中指定。同一实例可调用不同模型。所有生成参数统一位于 `request.parameters`，其中 `temperature` 与 `maxOutputTokens` 为标准字段，索引签名允许 `top_p`、`seed` 或 Provider 原生参数。取消和超时属于 `ModelCallOptions`，不属于生成参数。

Runtime 负责校验请求并映射标准字段，保留扩展字段的原始名称和值；扩展参数不能覆盖 `model`、`messages`、`tools`、`tool_choice`、`stream` 等核心协议字段。标准参数与等价原生参数冲突时返回 `invalid_request`，明确不支持的能力返回 `unsupported_capability`。Provider 具体限制与映射见 [Runtime Model](../../../runtime/model/README.md)。

## Tool Calling 协议

`ModelToolDefinition` 仅描述名称、说明和参数 JSON Schema，不包含执行函数。`toolChoice` 为 auto、none 或 required；required 搭配空工具列表是无效请求。

`ModelToolCall` 保留 `id`、`name` 与原始 `argumentsJson` 字符串。即使模型返回不完整或不合法 JSON，也不解析、修复或重写；工具参数校验和实际执行不属于本模块。ToolResult 的 `isError` 表示工具失败，不是模型调用失败；Adapter 应显式保留此语义。

流式工具增量通过当前请求内的 `index` 关联，参数片段按顺序追加，id/name 可以稍后出现但不得被不一致值覆盖。最终工具调用必须字段完整，index 不进入最终 ModelToolCall。

## 流式与响应语义

成功流的顺序为一次 `message_start`、零个或多个 `text_delta` / `tool_call_delta`、最后一次 `message_end`。结束事件携带完整 ModelResponse，其文本和工具参数必须与增量组装一致；id/model 以 Provider 提供的标识为准，缺少 model 时才使用请求标识。Usage 中未提供的值保持缺省，不补造 Token 数。

失败、取消或超时通过异步迭代抛出 ModelError，不产生成功的 `message_end`。完整 ModelResponse 形成前，工具调用只是未确认增量，后续 Agent Loop 不能据此提前执行工具。

## 并发、取消与错误

实现可共享固定 Provider 配置和 HTTP 客户端；消息转换、文本/ToolCall 缓存、取消控制、超时和错误上下文必须属于单次调用，不得修改调用方请求。取消或失败一个请求不能影响其他调用，不使用全局锁将请求串行化。

`signal` 表示调用方主动取消，错误码为 `aborted`；`timeoutMs` 表示整个调用允许的最长时间，错误码为 `timeout`。懒执行的流从实际开始消费时计时，提前结束迭代时实现应释放底层资源。接口不承担请求队列、Session 调度或并发限额。

`ModelError` 继承 Error，构造方式为 `new ModelError(info, options?)`；info 包括 code、message、retryable 和可选 status，options 支持标准 Error cause。公开错误消息必须不含密钥或认证头。retryable 只是提示，不触发自动重试。

## 验证方式与未实现能力

`tests/model-contracts.test.ts` 结合 TypeScript 编译检查与 Node.js 内置测试运行器，验证角色收窄、错误消息形态不可赋值、工具关联、原始参数、扩展字段、class/工厂替代实现和 ModelError。

```bash
npm run typecheck
node --test tests/model-contracts.test.ts
```

Runtime 的调用、流式组装与并发测试见 [Runtime Model](../../../runtime/model/README.md)。本模块不实现 Agent Loop、Tool Runtime、工具实际执行、Session、Engine、CLI、多模态、模型路由、重试、Context 或 Token Budget。

## 相关文档

- [Harness](../../README.md)
- [阶段范围](../../../../docs/phase-1.1.md)
- [架构](../../../../docs/architecture.md)
- [本模块变更记录](changes.md)
