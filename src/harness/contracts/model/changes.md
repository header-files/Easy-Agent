# Model Contracts — 变更记录

> 记录本能力域的契约和行为约定。现行说明见 [README.md](README.md)；同一主题后续修改只追加历史。

## 设计基线

### 2026-11-21 — Phase 1.1 V1.1 模型契约基线

- 主题 ID：`harness.model-contracts`
- 修改前后：首次建立本能力域；Phase 0 尚无模型契约。采用用户确认的 V1.1 类型定义，没有沿用顶层 temperature/maxOutputTokens 请求字段。
- 原因：为 OpenAI-compatible Runtime 与后续可替换实现建立统一边界。
- 决策：生成参数统一置于 ModelParameters，标准参数需映射、扩展参数允许透传且不得覆盖协议核心字段；ModelClient 以可复用组件实例提供 generate/stream，请求上下文与取消状态必须隔离。
- 影响：四种消息角色、原始 ToolCall JSON 参数、流式增量及完整结束响应、Usage、ModelError、请求取消和全程超时语义。
- 验证依据：`tests/model-contracts.test.ts` 覆盖静态结构、class/工厂替代实现及 ModelError；Runtime 行为由 Adapter 测试验证。
- 非目标：不引入 Session、Loop、Engine、工具执行、请求队列或全局并发治理。
- 关联：[Harness 记录](../../changes.md)、[项目级记录](../../../../docs/changes.md)。

### 2026-11-24 — 增加 ModelCatalog 只读契约

- 主题 ID：`harness.model-contracts`
- 变更前：仅有 ModelClient 调用契约，无显式模型目录类型。
- 变更后：新增 `ModelDescriptor` / `ModelCatalog`（`has` / `list`），供 Application 与 Registry 共享只读视图；既有 ModelClient 请求/响应/流式契约不变。
- 修改原因：Phase 2.1 需要跨层表达已注册模型，而不把路由状态放进 ModelClient。
- 影响范围：本契约导出、Application、Runtime Registry。
- 验证：类型检查与模型路由/应用测试通过。
