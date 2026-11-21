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
