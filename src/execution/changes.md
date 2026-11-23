# Execution — 执行机制与策略层 — 变更记录

> 本文件仅记录 **`src/execution/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`execution.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

Phase 0 创建职责文档建立基线；实际实现按时间追加如下。

### 2026-11-22 — 新增 DefaultAgentLoop 策略能力

- 主题 ID：`execution.default-agent-loop`
- 变更前：本模块只有职责说明，尚无模型与工具循环策略。
- 变更后：新增 loops 子模块及就近 README/changes，实现统一 AgentLoop 契约，支持模型流式事件、串行工具执行、完整结果回填、受限模型重试、取消清理和同实例并发；正常终态为唯一 loop_end。
- 修改原因：用户确认 Phase 1.3 唯一方案，以已完成 Model/Tool Runtime 为基础实现默认策略，保持 Loop 与 Engine 分离。
- 影响范围：`src/execution/loops`、Harness AgentLoop 使用与离线验证；不创建 Engine、Session 或新的 Runtime 公共协议。
- 兼容边界：Context timeout 校验沿用现有 Runtime 整数范围；ModelRequest 副本局部处理无工具 null assistant，内部权威历史保持原值。详情见 [Loop 时间线](loops/changes.md)。
- 验证依据：基础算法、独立控制/并发、协议边界和真实 Runtime 的离线链路；最终整仓结果见阶段记录。
- 现行说明：[README.md](README.md)、[Loop README](loops/README.md)；跨模块摘要见 [项目级记录](../../docs/changes.md)。

### 2026-11-23 — 新增前台内存 Execution Engine

- 主题 ID：`execution.engine`
- 变更前：Execution 只有可替换 Loop 策略，没有统一执行生命周期、取消入口和可查询快照。
- 变更后：新增 Engine 子模块与就近 README/changes，实现 Harness ExecutionEngine，统一驱动任意 AgentLoop；管理内存 RUNNING/COMPLETED/FAILED/CANCELLED、惰性事件流、协议校验与终态有界保留。
- 修改原因：用户授权 Phase 1.4，在既有策略层之上建立运行机制，保持 Loop/Engine 分离，不重新实现模型或工具。
- 关键决定：清理确认前不提前提交取消终态；可复制数据图强隔离，用户确认 opaque 外部能力保留引用并说明限制。详细决策见 [Engine 时间线](engine/changes.md)。
- 影响范围：`src/execution/engine`、Harness Execution 契约使用与离线测试；原 Loop 源码和 1.1–1.3 公共协议不变。旧 Loop 文档链接随用户迁移到 phase-1.3.md 更新，没有恢复已删除文件。
- 验证依据：主流程、自定义 Loop、取消/清理、并发隔离、快照与保留、真实 DefaultAgentLoop 集成测试；最终完整结果见 Phase 1.4 验收。
- 现行说明：[Engine README](engine/README.md)、[README.md](README.md)；全局记录见 [项目变更时间线](../../docs/changes.md)。
