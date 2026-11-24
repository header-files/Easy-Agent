# Runtime Model — 多 Provider 模型访问

## 定位与当前实现

本模块提供：

1. **OpenAI-compatible Chat Completions** Adapter（Phase 1.1）
2. **OpenAI Responses** 原生 Adapter（Phase 2.1）
3. **Model Registry / Model Router**（Phase 2.1）：显式模型登记与按完整模型标识路由

统一实现 [Harness ModelClient](../../harness/contracts/model/README.md) 的 `generate()` / `stream()`。使用 Node.js 内置 `fetch` 和标准 Web Streams，复用已完成的 [Logging 基础设施](../logging/README.md)。模型认证配置由调用方/Composition 显式传入。

本模块负责模型请求、协议映射、流式组装、错误归一、请求资源生命周期以及启动期模型路由。它不管理 Session 当前模型，不执行 ToolCall，不提供 Agent Loop、Execution Engine、CLI、自动 Fallback 或热更新。

## 对外入口

从 `src/runtime/model/index.ts` 导入：

| 导出                                    | 职责                                         |
| --------------------------------------- | -------------------------------------------- |
| `OpenAICompatibleModelClient`           | Chat Completions `/chat/completions`         |
| `OpenAIResponsesModelClient`            | Responses `/responses`                       |
| `DefaultModelRegistry` / `parseModelId` | 显式模型登记与 `providerId/modelId` 解析     |
| `ModelRouter`                           | 实现 `ModelClient`，按已注册完整模型标识转发 |

### Registry / Router

- 模型标识按**第一个 `/`** 拆分；Provider ID 与上游 Model ID 均不得为空；上游 Model ID 可继续含 `/`。
- Registry 只接受启动时显式模型列表；提供 `has()` / `list()`，不联网发现模型。
- Router 收到完整标识后校验并选择 Provider，向 Provider 发送去掉 Provider ID 后的上游 Model ID；响应/事件中的 `model` 会重新加上 Provider 前缀以保留路由身份。
- 未注册模型立即抛出 `ModelError(invalid_request)`，不发上游请求。
- Router **不保存** Session 当前模型；当前模型由 Application / Session 在提交 Execution 时固化。

Composition 通过静态 `Provider Type → Factory` 创建 Provider 实例，再注入 Registry/Router。详见 [Composition README](../../composition/README.md)。

Composition 的 `type` 只区分协议实现（`openai-compatible` / `openai-responses`），**不**内置厂商名或默认 `baseURL`；端点由调用方 / 配置显式传入。

## OpenAI-compatible

```typescript
import { OpenAICompatibleModelClient } from './src/runtime/model/index.ts';

const client = new OpenAICompatibleModelClient({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.openai.com/v1',
});
```

| 配置              | 规则                                            |
| ----------------- | ----------------------------------------------- |
| `baseURL: string` | **必填**；追加 `/chat/completions`              |
| `apiKey?: string` | 可选；提供时使用 `Authorization: Bearer ...`    |
| `logger?: Logger` | 模块名 `runtime.model.openai-compatible`        |
| `fetch?`          | 默认可注入；便于离线测试                        |
| `maxTokensField?` | 默认 `max_completion_tokens`，可选 `max_tokens` |

请求映射、流式 SSE、工具增量、Usage、取消/超时与生命周期日志规则与 Phase 1.1 保持一致；详见本文件历史说明与 [Phase 1.1](../../../docs/phase-1.1.md)。

## OpenAI Responses

```typescript
import { OpenAIResponsesModelClient } from './src/runtime/model/index.ts';

const client = new OpenAIResponsesModelClient({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.openai.com/v1',
});
```

| 配置              | 规则                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `baseURL: string` | **必填**；追加 `/responses`                                                    |
| `apiKey?: string` | Composition 配置要求 Responses Provider 必填；客户端本身允许省略以兼容测试注入 |
| `logger?: Logger` | 模块名 `runtime.model.openai-responses`                                        |
| `fetch?`          | 默认可注入                                                                     |

协议边界：

- 完整本地历史映射为 Responses `input`；assistant tool call → `function_call`；tool result → `function_call_output`。
- 工具声明映射为扁平 `type: function` schema；`maxOutputTokens` → `max_output_tokens`。
- **明确拒绝** `previous_response_id`、`conversation`、多模态与多候选参数；上下文由 Easy Agent 本地管理。
- 流式支持 `response.created`、`response.output_text.delta`、`response.output_item.added/done`、`response.function_call_arguments.delta/done`、`response.completed/incomplete/failed` 与 `error`。
- 工具调用 ID 使用上游 `call_id`；Usage 映射 `input_tokens` / `output_tokens` / `total_tokens`。

## 错误与日志

所有错误使用 Harness `ModelError`。公开错误不含密钥、URL、Provider 正文或原始异常。生命周期日志只记录白名单诊断字段；Responses 与 Compatible 共用同一套安全日志门面，仅模块名不同。

## 关键文件与离线验证

| 路径                                    | 职责                     |
| --------------------------------------- | ------------------------ |
| `model-registry.ts` / `model-router.ts` | 显式登记与路由           |
| `providers/openai-compatible/`          | Chat Completions Adapter |
| `providers/openai-responses/`           | Responses Adapter        |

```bash
node --test tests/model-routing.test.ts tests/openai-responses.test.ts \
  tests/model-runtime.test.ts tests/model-integration.test.ts tests/model-logging.test.ts
```

真实远程 API 调用不是自动验收前置条件。阶段依据见 [Phase 2.1](../../../docs/phase-2.1.md)，历史见 [changes.md](changes.md)。
