# Agent Contracts — 变更记录

> 记录 Agent Management 公共契约基线及后续调整。现行说明见 [README.md](README.md)，同一主题后续修改只追加历史。

## 设计基线

### 2026-11-24 — Phase 1.5 Session 管理与提交句柄

- 主题 ID：`harness.agent-management-contracts`
- 修改前后：首次建立本能力域。此前只有独立 Loop/Engine 协议；本次按唯一阶段设计第 4 节新增 AgentManager、SessionAgent、SessionExecution、CreateSessionOptions、SessionSubmitOptions 和 SessionSummary。
- 原因：为多轮 Session、同步 FIFO 提交和与执行解耦的事件观察提供可替换公共边界。
- 决策：submit 同步入队；外部观察流单消费者且单次遍历，退出观察不取消执行；result 独立且始终 resolve 为旧 ExecutionResult；排队取消不伪造 Engine 生命周期事件；删除不隐式丢弃任务。
- 兼容边界：引用现有 AgentLoop/Context、ExecutionEvent/Result、ModelParameters，不修改 Phase 1.1–1.4 契约，不向 Engine 引入 QUEUED；模型配置仍对自定义 Loop 可选。
- 影响范围：本模块类型和导出、独立契约测试、Harness 父模块文档；事件缓存上限、ID/时间注入等默认实现配置不提升为 Harness 必需能力。
- 验证：独立严格类型检查、6 项契约测试、定向 ESLint 和格式检查通过，之后交接 Agent 实现阶段。
- 非目标：不引入持久化、Session Event Log、Inbox/Recovery 或 Phase 1.6 装配接口。
- 关联：[Harness 时间线](../../changes.md)、[唯一阶段设计](../../../../docs/phase-1.5.md)、[项目级记录](../../../../docs/changes.md)。
