# Runtime Model — 变更记录

> 当前设计见 [README.md](README.md)。按真实日期追加，保留同主题时间线；项目级只保留关联摘要。

## 2026-11-21 — Phase 1.1 Model System 实现基线

- 主题 ID：`runtime.model-system`
- 变更前：Runtime 已有统一 Logging 基础设施，没有 Model 能力源码。
- 变更后：实现独立可复用的 OpenAI-compatible Chat Completions 客户端、请求/响应/参数映射、SSE 与流式工具组装、Usage、统一错误、AbortSignal 和整次调用超时；所有请求级状态隔离，并通过既有 Logger 门面记录安全的请求生命周期元数据。
- 修改原因：用户确认 Phase 1.1 V1.1 方案，需要能由后续 Loop 通过公共 ModelClient 契约调用的模型基础能力。
- 实现取舍：使用 Node.js 内置 fetch；最小配置增加可选 fetch 注入和 maxTokensField，以支持离线集成与旧兼容服务。统一 maxOutputTokens 默认映射 max_completion_tokens；原生扩展参数保留 JSON 名称和值，冲突明确拒绝。ToolResult 错误使用明确文本标记。可注入 Logger；缺省建立模块 Logger，开始/完成/取消/失败各按统一等级输出，日志异常不改变模型调用结果。
- 流式基线：必须收到 finish_reason 与 [DONE] 后正常结束，允许尾部 Usage 块；id/name 不按片段猜测修复，参数保留原文；正常结束先释放资源并记录成功再交付 message_end；未消费的流不发请求或日志，提前 return 只记录取消终态。
- 影响范围：本能力域、Runtime 父模块、Harness Model 契约、公开入口和模型与生命周期日志离线测试；不改变 Logging 契约，不引入 Agent、Session 或工具执行。
- 验证：类型检查、Lint、格式检查、构建及完整离线测试全部通过，整仓 75 项通过、0 失败、0 跳过；其中模型单元/协议 19 项、模型集成/并发 15 项、模型生命周期日志 16 项。覆盖参数映射/冲突、四类消息、工具增量、资源释放、请求快照、独立日志关联、安全元数据与日志后端故障隔离；完整构成见 [Phase 1.1 验收](../../../docs/phase-1.1.md)。
- 关联：[Harness Model](../../harness/contracts/model/changes.md)、[项目级记录](../../../docs/changes.md)、[Phase 1.1](../../../docs/phase-1.1.md)。

## 2026-11-22 — 流式工具片段的空白标识不构成协议错误

- 主题 ID：`runtime.model-system`
- 变更前：流式 `tool_calls` 片段只要带有 `id` 或 `function.name`，就必须是非空且与已确定值一致；`null`、空字符串或空白字符串会立即返回 `invalid_response`。
- 变更后：这类空白标识视为该片段尚未提供字段，不写入增量事件，也不覆盖同一 index 上已确定的 id/name。非空白冲突、结束时缺少有效 id/name/arguments，以及重复调用 ID 仍返回 `invalid_response`。
- 修改原因：兼容服务在后续工具片段中重复 `id: ""` 和 `name: ""`，真实 `qwen-max` 流式工具调用因此在参数拼接前失败。
- 影响范围：`stream-state.ts` 的单请求工具组装、模型流式测试和模块说明；Harness Model 公共契约、非流式响应映射和日志字段不变。
- 现行说明：[README.md](README.md)、[Phase 1.1 流式协议](../../../docs/phase-1.1.md)。

- 审查验证（2026-11-22）：修复后全仓 `npm test` 147 项通过；此前 Phase 1.3 交付时的 146 项验收继续作为独立历史保留。

### 2026-11-23 — 补充固定回归用例与 Runtime/Loop 链路验证

- 验证范围：沿用上述空白标识修复，不新增协议或生产功能。单元回归补充仅空白标识直到结束、先空白后有效标识、空白片段不覆盖已确定值，以及非空 name 冲突仍拒绝等边界。
- 集成策略：注入兼容服务形式的 SSE 字节流，使用真实 OpenAICompatibleModelClient、ToolRegistry/ToolExecutor 和 DefaultAgentLoop；验证空白标识被忽略、原始参数片段完整拼接、工具真实执行、结果回填、再次模型调用及正常 loop_end。
- 执行方式：用例写入现有单元/集成测试文件，离线执行，不依赖真实 API Key 或外部服务；不以此前内存检查替代仓库固定回归用例。
- 已执行定向验证（2026-11-23）：`node --test tests/model-runtime.test.ts` 23 项通过；`node --test tests/agent-loop-integration.test.ts` 8 项通过。新增 3 项顶层单元用例与 1 项顶层链路用例，并扩展既有最终缺失字段的负例表。
- 最终验证（2026-11-23）：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test` 均成功退出；全仓 151 项通过、0 失败、0 跳过（既有审查基线 147 项 + 新增单元 3 项 + 链路集成 1 项）。本轮仅补验证；2026-11-22 的 147 项审查及 Phase 1.3 的 146 项交付验收分别保留，不覆盖历史数字。

## 2026-11-24 — 兼容流式工具片段中的 null 占位

- 主题 ID：`runtime.model-system`
- 变更前：增量或完整消息中的 `tool_calls: null`、工具片段的非 `function` 空 `type`、`function: null` 和 `arguments: null` 都会返回 `invalid_response`。
- 变更后：这些 `null` 或空白类型视为该片段尚未提供对应字段。空字符串 arguments 仍计入参数片段；对象形式的 arguments、非数组 `tool_calls` 和结束时缺少有效工具字段仍拒绝。
- 修改原因：通义兼容流在工具调用过程中用 `null` 表示“本段没有该字段”。真实 `qwen-max` 因此在进入 `add` 工具执行前被判为非法响应。
- 影响范围：OpenAI-compatible 的流式组装和非流式消息映射、模型离线测试及现行说明；Harness Model 公共契约不变。
- 现行说明：[README.md](README.md)、[Phase 1.1 流式协议](../../../docs/phase-1.1.md)。
