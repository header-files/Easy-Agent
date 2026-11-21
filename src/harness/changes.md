# Harness — 横向契约与通用支撑 — 变更记录

> 本文件仅记录 **`src/harness/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`harness.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

当前尚无本模块的实质性设计或实现变更记录。Phase 0 创建说明文档只是建立现行基线，不虚构模块演进历史。

### 2026-11-21 — 引入 Phase 1.1 模型公共契约

- 主题 ID：`harness.model-contracts`
- 变更前：Harness 仅有模块说明与目录归属，没有可供模型实现和调用方共同依赖的契约。
- 变更后：新增 `contracts/model`，定义消息、Tool Calling、统一 `parameters`、ModelClient 的 `generate` / `stream` 方法、流式事件、Usage、取消/超时选项和 ModelError；公共类型不依赖 Provider SDK。实例可复用，所有请求状态由实现按调用隔离。
- 修改原因：用户明确授权实施 Phase 1.1 V1.1 Model System，需要为 Runtime Adapter 以及后续 Agent Loop 提供统一边界。
- 影响范围：本模块公共接口、契约测试和模块文档；不引入 AgentLoop、Session 或 Harness 请求代理。
- 依据/验证：用户提供的 Phase 1.1 技术方案；`tests/model-contracts.test.ts` 验证联合类型、工具参数保真、统一/扩展参数、替代实现、返回值及 ModelError，类型检查覆盖静态约束。
- 现行说明：[Model Contracts](contracts/model/README.md)；跨模块摘要见 [项目变更记录](../../docs/changes.md)。
