# Execution Contracts — 变更记录

> 记录 Execution 公共契约基线及后续调整；现行说明见 [README.md](README.md)。同一主题后续修改只追加历史。

## 设计基线

### 2026-11-23 — Phase 1.4 内存执行生命周期契约

- 主题 ID：`harness.execution-contracts`
- 修改前后：首次建立本能力域。此前 AgentLoop 只有自身运行协议；本次按唯一阶段方案第 3 节定义 ExecutionEngine、ExecutionRequest、ExecutionEvent、ExecutionResult、ExecutionSnapshot 及状态/错误信息。
- 原因：为任意自定义或默认 Loop 提供统一 Engine 驱动边界，分离 Loop 策略与内存 Execution 生命周期机制。
- 决策：execute 惰性、单消费者、单次消费；启动前校验错误不产生记录；取消请求和最终 CANCELLED 分离；确认 Loop 自然结束后才提交正常终态；公开快照不得暴露可变内部存储。
- 兼容边界：直接引用既有 AgentLoop/Context/Event/Result，model/tools 对自定义 Loop 仍非必需，不修改 Phase 1.1–1.3 契约；stopped 到 FAILED 仅是 Engine 结果映射。
- 影响范围：本模块类型、统一导出、独立契约测试和 Harness 父模块文档；不引入 DefaultExecutionEngine 专属选项、Session 调度、持久化或事件文件接口。
- 验证：独立严格类型检查通过，`node --test tests/execution-contracts.test.ts` 5 项通过，定向 ESLint 和格式检查通过；之后由 Execution 模块实现具体行为。
- 关联：[Harness 时间线](../../changes.md)、[唯一阶段设计](../../../../docs/phase-1.4.md)、[项目级记录](../../../../docs/changes.md)。
