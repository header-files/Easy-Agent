# Runtime — 实际能力运行时层 — 变更记录

> 本文件仅记录 **`src/runtime/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`runtime.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

Phase 0 创建说明文档建立了职责基线；实际能力变更按时间追加如下。

### 2026-11-21 — 新增 Logging 基础设施

- 主题 ID：`runtime.logging`
- 变更前：Runtime 只有职责文档，没有基础设施或业务实现。
- 变更后：新增 Logging 子能力域与本地 README/changes，提供统一 Logger、Pino 适配、四级结构化日志、Error 序列化、子 logger、环境阈值、stderr 和脱敏。
- 修改原因：用户要求在 Phase 0 基线上先实现 Logging，供后续模块共享。
- 影响范围：`src/runtime/logging` 与 Logging 测试；未实现 Model、Agent、Loop、Session 或 Tool。
- 依据/验证：按公共接口、输出行为和安全边界执行离线测试；详情见 [Logging 时间线](logging/changes.md)，最终结果见项目验收记录。
- 现行说明：[README.md](README.md)、[Logging README](logging/README.md)。

### 2026-11-21 — 落地复用统一 Logging 的 Model 能力域

- 主题 ID：`runtime.model-system`
- 变更前：Runtime 已有统一 Logging 基础设施，尚无 Model 能力实现。
- 变更后：新增 Model 子能力域及本地 README/changes，提供实现 Harness ModelClient 的 OpenAI-compatible 客户端；支持非流式、SSE、工具调用、参数映射、错误、取消、超时与多请求并发，并复用 Logger 记录每次请求的开始、完成、取消和失败。
- 修改原因：用户授权 Phase 1.1，模型访问能力遵循已建立的工程与日志规范。
- 影响范围：`src/runtime/model`、模型及日志集成测试；既有 Logging 契约保持不变，其余 Runtime 能力等待后续授权。
- 设计边界：请求级关联 ID 和状态独立，日志仅包含安全元数据；logger 初始化和写入故障不能改变模型结果。
- 依据/验证：公共契约、协议转换、并发隔离和日志生命周期的离线测试；详情见 [Model 时间线](model/changes.md)，跨模块摘要见 [项目级日志](../../docs/changes.md)。
- 现行说明：[README.md](README.md)、[Model README](model/README.md)。
