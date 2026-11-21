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
